-- ============================================================
-- MXQ-S31-PARALLEL-B: 日结与对账(员工 B / 并发任务 B)
--
-- Migration 40: 日结 Command RPC(service-role-only)
--   1) close_daily_business   执行日结(幂等 + 并发安全)
--   2) adjust_daily_closing   调整日结(追加流水 + 审计)
--
-- 安全模型(遵循 AGENTS.md):
--   * SECURITY DEFINER + set search_path = public;
--   * revoke public/anon/authenticated + grant service_role;
--   * 同步登记到 api/lib/service-rpc-manifest.ts;
--   * 权限码校验在 Hono 层(requireScopedPermission),RPC 校验租户/归属/状态机;
--   * 金额一律 numeric 计算,数据库为账务真值;
--   * 业务日期按 Asia/Shanghai 时区零点开窗(created_at 落入当日窗口);
--   * 幂等:idempotency_key 命中返回原结果;并发:unique 约束 + SELECT FOR UPDATE。
-- ============================================================

-- ============================================================
-- 1. close_daily_business 执行日结
--    * 校验门店/操作人 -> 幂等检查 -> 行锁(占位) -> 计算 -> 固化快照
--    * 硬规则: tenant+store+business_date 唯一;重复执行返回现有快照(不重算)
--    * 金额口径:
--      gross     = sum(invoices.total)       (status <> 'cancelled')
--      paid      = sum(payments.amount)      (created_at 落入当日窗口)
--      refund    = sum(refunds.amount)
--      receivable= gross - paid + refund
--      渠道拆分   = payments 按 method 汇总(cash/card/wechat/alipay/stored_value/other)
-- ============================================================
create or replace function public.close_daily_business(
  p_tenant_id uuid,
  p_store_id uuid,
  p_business_date date,
  p_operator_employee_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_ok boolean;
  v_operator_ok boolean;
  v_existing jsonb;
  v_closing public.daily_closings;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_gross numeric(12,2);
  v_paid numeric(12,2);
  v_refund numeric(12,2);
  v_receivable numeric(12,2);
  v_cash numeric(12,2);
  v_card numeric(12,2);
  v_wechat numeric(12,2);
  v_alipay numeric(12,2);
  v_stored_value numeric(12,2);
  v_other numeric(12,2);
  v_invoice_count integer;
  v_status_breakdown jsonb;
  v_snapshot jsonb;
begin
  -- 门店存在且归属租户
  select exists(
    select 1 from public.stores
    where id = p_store_id and tenant_id = p_tenant_id
  ) into v_store_ok;
  if not v_store_ok then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 操作人在目标租户下为在职员工
  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = p_tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 幂等检查:同一 idempotency_key 命中直接返回原结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 行锁 + 占位:不存在则插入 open 占位行后重取锁(并发安全的唯一性保证)
  select * into v_closing
  from public.daily_closings
  where tenant_id = p_tenant_id and store_id = p_store_id and business_date = p_business_date
  for update;
  if not found then
    insert into public.daily_closings (tenant_id, store_id, business_date, status, created_by)
    values (p_tenant_id, p_store_id, p_business_date, 'open', p_operator_employee_id)
    on conflict (tenant_id, store_id, business_date) do nothing;
    select * into v_closing
    from public.daily_closings
    where tenant_id = p_tenant_id and store_id = p_store_id and business_date = p_business_date
    for update;
    if not found then
      raise exception 'CLOSING_LOCK_FAILED' using errcode = 'P0003',
        message = '日结占位行创建失败,请重试';
    end if;
  end if;

  -- 已关闭/已调整:返回现有快照(重复执行,不重算不覆盖历史)
  if v_closing.status in ('closed', 'adjusted') then
    return jsonb_build_object(
      'duplicate', true,
      'closingId', v_closing.id,
      'status', v_closing.status,
      'snapshot', v_closing.snapshot
    );
  end if;

  -- 业务日期窗口:Asia/Shanghai 时区当日零点 -> 次日零点
  v_day_start := p_business_date at time zone 'Asia/Shanghai';
  v_day_end := v_day_start + interval '1 day';

  -- 应收总额(gross):非取消发票 total 之和
  select coalesce(sum(total), 0) into v_gross
  from public.invoices
  where tenant_id = p_tenant_id and store_id = p_store_id
    and status <> 'cancelled'
    and created_at >= v_day_start and created_at < v_day_end;

  -- 实收总额(paid):当日支付流水之和(payments 无 store_id,联表 invoices 收敛门店)
  select coalesce(sum(p.amount), 0) into v_paid
  from public.payments p
  join public.invoices inv on inv.id = p.invoice_id
  where p.tenant_id = p_tenant_id and inv.store_id = p_store_id
    and p.created_at >= v_day_start and p.created_at < v_day_end;

  -- 退款总额(refund)
  select coalesce(sum(r.amount), 0) into v_refund
  from public.refunds r
  join public.invoices inv on inv.id = r.invoice_id
  where r.tenant_id = p_tenant_id and inv.store_id = p_store_id
    and r.created_at >= v_day_start and r.created_at < v_day_end;

  -- 应收余额(receivable)= gross - paid + refund
  v_receivable := v_gross - v_paid + v_refund;
  if v_receivable < 0 then
    v_receivable := 0;
  end if;

  -- 渠道拆分(按支付方式汇总当日实收)
  select
    coalesce(sum(p.amount) filter (where p.method = 'cash'), 0),
    coalesce(sum(p.amount) filter (where p.method = 'card'), 0),
    coalesce(sum(p.amount) filter (where p.method = 'wechat'), 0),
    coalesce(sum(p.amount) filter (where p.method = 'alipay'), 0),
    coalesce(sum(p.amount) filter (where p.method = 'stored_value'), 0),
    coalesce(sum(p.amount) filter (where p.method = 'other'), 0)
  into v_cash, v_card, v_wechat, v_alipay, v_stored_value, v_other
  from public.payments p
  join public.invoices inv on inv.id = p.invoice_id
  where p.tenant_id = p_tenant_id and inv.store_id = p_store_id
    and p.created_at >= v_day_start and p.created_at < v_day_end;

  -- 发票数量与状态拆分(非取消)
  select count(*), coalesce(jsonb_object_agg(status, cnt), '{}'::jsonb)
  into v_invoice_count, v_status_breakdown
  from (
    select status, count(*) as cnt
    from public.invoices
    where tenant_id = p_tenant_id and store_id = p_store_id
      and status <> 'cancelled'
      and created_at >= v_day_start and created_at < v_day_end
    group by status
  ) t;

  -- 固化快照(关闭后历史读取只读它,不重新实时计算)
  v_snapshot := jsonb_build_object(
    'business_date', p_business_date,
    'computed_at', now(),
    'source', 'live-computed',
    'totals', jsonb_build_object(
      'gross_amount', v_gross,
      'paid_amount', v_paid,
      'refund_amount', v_refund,
      'receivable_amount', v_receivable,
      'invoice_count', v_invoice_count
    ),
    'payment_method_breakdown', jsonb_build_object(
      'cash', v_cash,
      'card', v_card,
      'wechat', v_wechat,
      'alipay', v_alipay,
      'stored_value', v_stored_value,
      'other', v_other
    ),
    'invoice_status_breakdown', v_status_breakdown,
    'adjustment_summary', v_closing.adjustment_summary
  );

  -- 更新为 closed 并固化金额列 + 快照
  update public.daily_closings
  set status = 'closed',
      gross_amount = v_gross,
      paid_amount = v_paid,
      refund_amount = v_refund,
      receivable_amount = v_receivable,
      cash_amount = v_cash,
      card_amount = v_card,
      wechat_amount = v_wechat,
      alipay_amount = v_alipay,
      stored_value_amount = v_stored_value,
      other_amount = v_other,
      invoice_count = v_invoice_count,
      snapshot = v_snapshot,
      closed_at = now(),
      closed_by = p_operator_employee_id,
      updated_by = p_operator_employee_id
  where id = v_closing.id
  returning * into v_closing;

  -- 审计(与主事务原子提交)
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, p_store_id, null, 'daily_closing.close', 'daily_closing', v_closing.id,
          jsonb_build_object('business_date', p_business_date, 'snapshot', v_snapshot,
                             'operator_employee_id', p_operator_employee_id));

  -- 幂等记录
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'close_daily_business', 'daily_closing', v_closing.id,
            jsonb_build_object(
              'duplicate', false,
              'closingId', v_closing.id,
              'status', v_closing.status,
              'snapshot', v_snapshot
            ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'closingId', v_closing.id,
    'status', v_closing.status,
    'snapshot', v_snapshot
  );
end;
$$;

-- ============================================================
-- 2. adjust_daily_closing 调整日结
--    * 仅 closed/adjusted 状态可调整(未关账不能调整)
--    * 追加 closing_adjustments 流水,更新 adjustment_summary(追加式,不覆盖)
--    * amount 不可为 0,reason 必填;调整后 status = adjusted
-- ============================================================
create or replace function public.adjust_daily_closing(
  p_closing_id uuid,
  p_adjustment_type text,
  p_amount numeric,
  p_reason text,
  p_operator_employee_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closing public.daily_closings;
  v_operator_ok boolean;
  v_adjustment public.closing_adjustments;
  v_summary jsonb;
  v_items jsonb;
  v_count integer;
  v_total numeric(12,2);
begin
  -- 参数校验
  if p_adjustment_type not in ('cash_over', 'cash_short', 'manual_correction', 'other') then
    raise exception 'INVALID_ADJUSTMENT_TYPE' using errcode = 'P0003';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'INVALID_ADJUSTMENT_AMOUNT' using errcode = 'P0003',
      message = '调整金额不可为 0';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'ADJUSTMENT_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  -- 行锁日结
  select * into v_closing from public.daily_closings where id = p_closing_id for update;
  if not found then
    raise exception 'CLOSING_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_closing.status not in ('closed', 'adjusted') then
    raise exception 'CLOSING_NOT_CLOSED' using errcode = 'P0003',
      message = '仅已关闭/已调整的日结可执行调整';
  end if;

  -- 操作人校验
  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_closing.tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 追加调整流水
  insert into public.closing_adjustments (
    tenant_id, store_id, business_date, closing_id,
    adjustment_type, amount, reason, operator_employee_id
  )
  values (
    v_closing.tenant_id, v_closing.store_id, v_closing.business_date, v_closing.id,
    p_adjustment_type, p_amount, p_reason, p_operator_employee_id
  )
  returning * into v_adjustment;

  -- 更新 adjustment_summary(追加式)
  v_items := coalesce(v_closing.adjustment_summary -> 'items', '[]'::jsonb)
    || jsonb_build_array(jsonb_build_object(
         'id', v_adjustment.id,
         'type', p_adjustment_type,
         'amount', p_amount,
         'reason', p_reason,
         'operator_employee_id', p_operator_employee_id,
         'created_at', v_adjustment.created_at
       ));
  v_count := coalesce((v_closing.adjustment_summary ->> 'count')::integer, 0) + 1;
  v_total := coalesce((v_closing.adjustment_summary ->> 'total')::numeric, 0) + p_amount;
  v_summary := jsonb_build_object('count', v_count, 'total', v_total, 'items', v_items);

  -- 状态流转 adjusted
  update public.daily_closings
  set status = 'adjusted',
      adjustment_summary = v_summary,
      adjusted_at = now(),
      adjusted_by = p_operator_employee_id,
      updated_by = p_operator_employee_id,
      snapshot = jsonb_set(
        jsonb_set(v_closing.snapshot, '{adjustment_summary}', v_summary),
        '{totals, receivable_amount}',
        to_jsonb(greatest(coalesce(v_closing.receivable_amount, 0) + p_amount, 0))
      )
  where id = p_closing_id
  returning * into v_closing;

  -- 审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_closing.tenant_id, v_closing.store_id, null, 'daily_closing.adjust', 'daily_closing', v_closing.id,
          jsonb_build_object('adjustment_id', v_adjustment.id, 'adjustment_type', p_adjustment_type,
                             'amount', p_amount, 'reason', p_reason,
                             'operator_employee_id', p_operator_employee_id));

  return jsonb_build_object(
    'closingId', v_closing.id,
    'status', v_closing.status,
    'adjustmentId', v_adjustment.id,
    'adjustment_summary', v_closing.adjustment_summary,
    'snapshot', v_closing.snapshot
  );
end;
$$;

-- ============================================================
-- 3. RPC 权限收紧(service-role-only,manifest 同步登记)
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'close_daily_business',
    'adjust_daily_closing'
  ]
  loop
    for v_sig in
      select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_fn
        and p.prokind = 'f'
    loop
      execute format('revoke all on function %s from public', v_sig);
      execute format('revoke all on function %s from anon', v_sig);
      execute format('revoke all on function %s from authenticated', v_sig);
      execute format('grant execute on function %s to service_role', v_sig);
    end loop;
  end loop;
end;
$$;
