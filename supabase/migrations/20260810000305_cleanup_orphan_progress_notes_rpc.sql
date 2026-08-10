-- ============================================================
-- 20260810000305_cleanup_orphan_progress_notes_rpc.sql
-- 提供 RPC:清理引用已不存在 admission 的孤儿病程记录
--   - 已签署病程受审计保护(migration 117),RPC 内放行 app.allow_signed_note_delete
--   - 供 seed-inpatient-data.mjs 重跑前调用,保证幂等且无孤儿残留
-- 幂等,可重复应用(create or replace)
-- ============================================================

create or replace function public.cleanup_orphan_progress_notes(p_tenant_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  set local "app.allow_signed_note_delete" = 'true';
  delete from public.inpatient_progress_notes p
  where p.tenant_id = p_tenant_id
    and not exists (
      select 1 from public.admissions a where a.id = p.admission_id
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.cleanup_orphan_progress_notes(uuid) from public;
grant execute on function public.cleanup_orphan_progress_notes(uuid) to service_role;
