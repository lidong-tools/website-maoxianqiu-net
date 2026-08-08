-- ============================================================
-- MXQ-S31-PARALLEL-B: 日结与对账(员工 B / 并发任务 B)
--
-- Migration 42: 对账 Command RPC(service-role-only)
--   1) save_reconciliation_actual  录入渠道实际金额(自动推导 system_expected)
--   2) confirm_reconciliation      确认对账(无差异 -> confirmed;有差异 -> difference_confirmed)
--
-- 安全模型(遵循 AGENTS.md):
--   * SECURITY DEFINER + set search_path = public;
--   * revoke public/anon/authenticated + grant service_role;
--   * 同步登记到 api/lib/service-rpc-manifest.ts;
--   * 权限码校验在 Hono 层(requireScopedPermission),RPC 校验租户/归属/状态机;
--   * system_expected 一律从日结快照推导,不信任客户端;
--   * 差异确认必须有 reason + actor + timestamp + request_id(审计);
--   * 并发:unique 约束 + SELECT FOR UPDATE。
-- ============================================================

-- ============================================================
-- 1. save_reconciliation_actual 录入渠道实际金额
--    * 日结必须已关闭(closed/adjusted),否则 CLOSING_REQUIRED;
--    * system_expected 从 closing.snapshot->payment_method_breakdown 推导;
--    * difference = actual - expected;0 -> matched,否则 pending;
--    * 已确认(confirmed/difference_confirmed)的记录不可再改。
-- ============================================================
create or replace function public.save_reconciliation_actual(
  p_tenant_id uuid,
  p_store_id uuid,
  p_business_date date,
  p_channel text,
  p_actual_amount numeric,
  p_closing_id uuid default null,
  p_operator_employee_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_ok boolean;
  v_operator_ok boolean;
  v_closing public.daily_closings;
  v_expected numeric(12,2);
  v_difference numeric(12,2);
  v_record public.reconciliation_records;
  v_new_status text;
begin
  -- 参数校验
  if p_channel not in ('cash', 'card', 'wechat', 'alipay', 'stored_value', 'other') then
    raise exception 'INVALID_RECONCILIATION_CHANNEL' using errcode = 'P0003';
  end if;
  if p_actual_amount is null or p_actual_amount < 0 then
    raise exception 'INVALID_ACTUAL_AMOUNT' using errcode = 'P0003';
  end if;

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

  -- 取日结:必须已关闭/已调整;p_closing_id 提供时校验匹配
  select * into v_closing
  from public.daily_closings
  where tenant_id = p_tenant_id and store_id = p_store_id and business_date = p_business_date;
  if v_closing.id is null then
    raise exception 'CLOSING_REQUIRED' using errcode = 'P0003';
  end if;
  if v_closing.status not in ('closed', 'adjusted') then
    raise exception 'CLOSING_REQUIRED' using errcode = 'P0003';
  end if;
  if p_closing_id is not null and p_closing_id <> v_closing.id then
    raise exception 'CLOSING_MISMATCH' using errcode = 'P0003';
  end if;

  -- system_expected 一律从日结快照推导(不信任客户端)
  v_expected := coalesce(
    (v_closing.snapshot -> 'payment_method_breakdown' ->> p_channel)::numeric,
    0
  );

  -- 行锁 + 占位(unique tenant+store+business_date+channel)
  select * into v_record
  from public.reconciliation_records
  where tenant_id = p_tenant_id and store_id = p_store_id
    and business_date = p_business_date and channel = p_channel
  for update;
  if not found then
    insert into public.reconciliation_records (
      tenant_id, store_id, business_date, closing_id, channel,
      system_expected, actual_amount, difference, status, created_by
    )
    values (
      p_tenant_id, p_store_id, p_business_date, v_closing.id, p_channel,
      v_expected, p_actual_amount, p_actual_amount - v_expected,
      case when p_actual_amount - v_expected = 0 then 'matched' else 'pending' end,
      p_operator_employee_id
    )
    on conflict (tenant_id, store_id, business_date, channel) do nothing;
    select * into v_record
    from public.reconciliation_records
    where tenant_id = p_tenant_id and store_id = p_store_id
      and business_date = p_business_date and channel = p_channel
    for update;
    if not found then
      raise exception 'RECONCILIATION_LOCK_FAILED' using errcode = 'P0003';
    end if;
  end if;

  -- 已确认记录不可修改
  if v_record.status in ('confirmed', 'difference_confirmed') then
    raise exception 'RECONCILIATION_LOCKED' using errcode = 'P0003';
  end if;

  -- 更新实际金额与差异
  v_difference := p_actual_amount - v_expected;
  v_new_status := case when v_difference = 0 then 'matched' else 'pending' end;

  update public.reconciliation_records
  set actual_amount = p_actual_amount,
      difference = v_difference,
      status = v_new_status,
      difference_reason = null,
      confirmed_by = null,
      confirmed_at = null,
      updated_by = p_operator_employee_id
  where id = v_record.id
  returning * into v_record;

  -- 审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, p_store_id, null, 'reconciliation.actual_update', 'reconciliation_record', v_record.id,
          jsonb_build_object('channel', p_channel, 'business_date', p_business_date,
                             'system_expected', v_expected, 'actual_amount', p_actual_amount,
                             'difference', v_difference, 'operator_employee_id', p_operator_employee_id));

  return jsonb_build_object(
    'recordId', v_record.id,
    'channel', v_record.channel,
    'businessDate', v_record.business_date,
    'systemExpected', v_record.system_expected,
    'actualAmount', v_record.actual_amount,
    'difference', v_record.difference,
    'status', v_record.status
  );
end;
$$;

-- ============================================================
-- 2. confirm_reconciliation 确认对账
--    * difference = 0 -> confirmed;difference <> 0 -> difference_confirmed
--    * 有差异必须填写 difference_reason(DIFFERENCE_REASON_REQUIRED)
--    * 已确认不可重复确认(RECONCILIATION_ALREADY_CONFIRMED)
--    * 审计记录 reason + actor + timestamp + request_id
-- ============================================================
create or replace function public.confirm_reconciliation(
  p_record_id uuid,
  p_difference_reason text default null,
  p_request_id text default null,
  p_operator_employee_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.reconciliation_records;
  v_operator_ok boolean;
  v_new_status text;
begin
  -- 行锁对账记录
  select * into v_record from public.reconciliation_records where id = p_record_id for update;
  if not found then
    raise exception 'RECONCILIATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 已确认不可重复确认
  if v_record.status in ('confirmed', 'difference_confirmed') then
    raise exception 'RECONCILIATION_ALREADY_CONFIRMED' using errcode = 'P0003';
  end if;

  -- 操作人校验
  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_record.tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 有差异必须填写原因
  if v_record.difference <> 0
    and (p_difference_reason is null or btrim(p_difference_reason) = '') then
    raise exception 'DIFFERENCE_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  -- 状态流转
  v_new_status := case when v_record.difference = 0 then 'confirmed' else 'difference_confirmed' end;

  update public.reconciliation_records
  set status = v_new_status,
      difference_reason = case
        when v_record.difference = 0 then null
        else btrim(p_difference_reason)
      end,
      confirmed_by = p_operator_employee_id,
      confirmed_at = now(),
      updated_by = p_operator_employee_id
  where id = p_record_id
  returning * into v_record;

  -- 审计:差异确认必须有 reason + actor + timestamp + request_id
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_record.tenant_id, v_record.store_id, null, 'reconciliation.confirm', 'reconciliation_record', v_record.id,
          jsonb_build_object(
            'channel', v_record.channel,
            'business_date', v_record.business_date,
            'system_expected', v_record.system_expected,
            'actual_amount', v_record.actual_amount,
            'difference', v_record.difference,
            'difference_reason', v_record.difference_reason,
            'operator_employee_id', p_operator_employee_id,
            'request_id', p_request_id
          ));

  return jsonb_build_object(
    'recordId', v_record.id,
    'channel', v_record.channel,
    'businessDate', v_record.business_date,
    'difference', v_record.difference,
    'differenceReason', v_record.difference_reason,
    'status', v_record.status,
    'confirmedAt', v_record.confirmed_at
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
    'save_reconciliation_actual',
    'confirm_reconciliation'
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
