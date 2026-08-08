-- ============================================================
-- MXQ-S31-PARALLEL-B: 日结与对账(员工 B / 并发任务 B)
--
-- Migration 43: 支付渠道汇总读取 RPC(service-role-only)
--   get_payment_channel_summary 按业务日期(Asia/Shanghai)从真实
--   payments/refunds 计算各支付渠道的 实收/退款/净额,并附日结快照期望值。
--
-- 设计要点:
--   * 退款按关联支付渠道归并(refunds.payment_id -> payments.method),
--     无关联支付记录的退款归入 other;
--   * 日结已关闭时附带 closingExpected(来自固化快照 payment_method_breakdown),
--     供对账界面与快照期望值比对;
--   * 只读计算不落库,不修改任何表。
-- ============================================================
create or replace function public.get_payment_channel_summary(
  p_tenant_id uuid,
  p_store_id uuid,
  p_business_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closing public.daily_closings;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_channel_code text;
  v_pay numeric(12,2);
  v_refund numeric(12,2);
  v_net numeric(12,2);
  v_channels jsonb := '[]'::jsonb;
  v_total_pay numeric(12,2) := 0;
  v_total_refund numeric(12,2) := 0;
  v_total_net numeric(12,2) := 0;
  v_closing_status text;
  v_closing_expected jsonb;
begin
  -- 业务日期窗口:Asia/Shanghai 时区当日零点 -> 次日零点
  v_day_start := p_business_date::timestamp at time zone 'Asia/Shanghai';
  v_day_end := v_day_start + interval '1 day';

  -- 日结快照期望值(已关闭/已调整才存在)
  select * into v_closing
  from public.daily_closings
  where tenant_id = p_tenant_id and store_id = p_store_id and business_date = p_business_date;
  if v_closing.id is not null and v_closing.status in ('closed', 'adjusted') then
    v_closing_status := v_closing.status;
    v_closing_expected := v_closing.snapshot -> 'payment_method_breakdown';
  else
    v_closing_status := null;
    v_closing_expected := '{}'::jsonb;
  end if;

  -- 固定渠道顺序遍历,逐渠道计算实收/退款/净额
  for v_channel_code in select unnest(array['cash', 'card', 'wechat', 'alipay', 'stored_value', 'other'])
  loop
    -- 实收:payments 按 method 汇总(联表 invoices 收敛门店)
    select coalesce(sum(p.amount), 0) into v_pay
    from public.payments p
    join public.invoices inv on inv.id = p.invoice_id
    where p.tenant_id = p_tenant_id and inv.store_id = p_store_id
      and p.method = v_channel_code
      and p.created_at >= v_day_start and p.created_at < v_day_end;

    -- 退款:按关联支付渠道归并,无关联(payment_id 为空)归 other
    select coalesce(sum(r.amount), 0) into v_refund
    from public.refunds r
    join public.invoices inv on inv.id = r.invoice_id
    left join public.payments pm on pm.id = r.payment_id
    where r.tenant_id = p_tenant_id and inv.store_id = p_store_id
      and coalesce(pm.method, 'other') = v_channel_code
      and r.created_at >= v_day_start and r.created_at < v_day_end;

    v_net := v_pay - v_refund;
    v_total_pay := v_total_pay + v_pay;
    v_total_refund := v_total_refund + v_refund;
    v_total_net := v_total_net + v_net;

    v_channels := v_channels || jsonb_build_object(
      'channel', v_channel_code,
      'payment', v_pay,
      'refund', v_refund,
      'net', v_net,
      'closingExpected', coalesce((v_closing_expected ->> v_channel_code)::numeric, 0)
    );
  end loop;

  return jsonb_build_object(
    'tenantId', p_tenant_id,
    'storeId', p_store_id,
    'businessDate', p_business_date,
    'closingStatus', v_closing_status,
    'channels', v_channels,
    'totals', jsonb_build_object(
      'payment', v_total_pay,
      'refund', v_total_refund,
      'net', v_total_net
    )
  );
end;
$$;

-- ============================================================
-- RPC 权限收紧(service-role-only,manifest 同步登记)
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'get_payment_channel_summary'
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
