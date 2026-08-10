-- ============================================================
-- 99999999999999_cleanup_orphan_progress_notes.sql
-- 一次性清理:删除引用已不存在 admission 的孤儿病程记录
-- (历史 seed-demo-data / 早期 seed-inpatient-data 运行残留,
--  已签署记录受审计保护,需在事务内放行 app.allow_signed_note_delete)
-- ============================================================
set local "app.allow_signed_note_delete" = 'true';

delete from public.inpatient_progress_notes p
where p.tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and not exists (
    select 1 from public.admissions a where a.id = p.admission_id
  );
