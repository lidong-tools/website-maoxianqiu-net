-- ============================================================
-- 20260810000061_imaging_report_publish_rpc.sql
-- Agent-03 影像报告发布跨表事务 RPC
--   reviewed → published:报告状态推进 + 申请单状态推进 + 审计 原子完成
-- 幂等,可重复应用
-- ============================================================

-- ===== publish_imaging_report(MXQ-10031) =====
-- 校验:
--   - 报告存在且状态为 reviewed(必须先审核)
--   - 申请单未取消
-- 行为:
--   - 报告 status → published,写入 published_at
--   - 申请单 status → published(同步推进)
--   - 事务内审计
create or replace function public.publish_imaging_report(
  p_report_id uuid,
  p_operator_id uuid default null
)
returns public.imaging_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.imaging_reports;
  v_order public.imaging_orders;
begin
  select * into v_report from public.imaging_reports where id = p_report_id for update;
  if not found then
    raise exception 'IMAGING_REPORT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_report.status != 'reviewed' then
    raise exception 'IMAGING_REPORT_NOT_REVIEWED' using errcode = 'P0003';
  end if;

  select * into v_order from public.imaging_orders where id = v_report.imaging_order_id for update;
  if not found then
    raise exception 'IMAGING_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'IMAGING_ORDER_CANCELLED' using errcode = 'P0003';
  end if;

  update public.imaging_reports
  set status = 'published',
      published_at = coalesce(published_at, now()),
      updated_at = now()
  where id = p_report_id
  returning * into v_report;

  -- 申请单同步推进到 published
  update public.imaging_orders
  set status = 'published', updated_at = now()
  where id = v_report.imaging_order_id
    and status not in ('published', 'cancelled');

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (
    v_order.tenant_id, v_order.store_id, p_operator_id,
    'imaging.publish', 'imaging_report', p_report_id,
    jsonb_build_object('imaging_order_id', v_order.id, 'version', v_report.version)
  );

  return v_report;
end;
$$;

revoke all on function public.publish_imaging_report(uuid, uuid) from public;
grant execute on function public.publish_imaging_report(uuid, uuid) to authenticated;

-- ===== 补充索引:报告按申请单查询 =====
create index if not exists idx_imaging_reports_order_status
  on public.imaging_reports (imaging_order_id, status, version);
