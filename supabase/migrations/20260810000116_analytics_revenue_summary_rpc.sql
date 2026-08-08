-- ============================================================
-- S32-B FIX: 收入汇总 DB 侧聚合(Analytics Data Quality, P0-B)
-- ------------------------------------------------------------
-- 审计问题(S3.2-Final-Full-Code-Audit #14~#16):
--   Analytics 把原始行拉到 JS 内存做核心财务聚合,在数据量超过
--   PostgREST 单次返回上限(默认 1000 行)时静默截断,
--   出现"数字看起来正常但其实少算"的 BI 风险。
--
-- 修复:
--   新增 service-role-only RPC get_analytics_revenue_summary,
--   在 PostgreSQL 内完成 Gross/Refund/Net/InvoiceCount 聚合;
--   Node 只负责权限/参数/DTO,不再搬运全量事实行。
--   (维度/趋势明细行仍在路由层按需分页拉取,见 revenue.ts)
-- ============================================================

set search_path = public;

-- ===== 1. 收入汇总 RPC(DB 侧聚合) =====
create or replace function public.get_analytics_revenue_summary(
  p_tenant_id uuid,
  p_store_ids uuid[],
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gross numeric(12,2) := 0;
  v_refund numeric(12,2) := 0;
  v_count integer := 0;
begin
  -- 有效发票(排除 draft / cancelled),应收合计与发票数在库内一次聚合
  select coalesce(sum(total), 0)::numeric(12,2), count(*)
  into v_gross, v_count
  from public.invoices
  where tenant_id = p_tenant_id
    and store_id = any(p_store_ids)
    and status in ('confirmed', 'paid', 'partially_paid', 'refunded')
    and created_at >= p_start
    and created_at <= p_end;

  -- 退款合计(经 invoices 收敛门店范围,与 JS 侧口径一致)
  select coalesce(sum(r.amount), 0)::numeric(12,2)
  into v_refund
  from public.refunds r
  join public.invoices inv on inv.id = r.invoice_id
  where r.tenant_id = p_tenant_id
    and inv.store_id = any(p_store_ids)
    and r.created_at >= p_start
    and r.created_at <= p_end;

  return jsonb_build_object(
    'gross', v_gross,
    'refund', v_refund,
    'net', v_gross - v_refund,
    'invoiceCount', v_count
  );
end;
$$;

-- ===== 2. RPC 权限收紧(service-role-only,manifest 同步登记) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'get_analytics_revenue_summary'
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
