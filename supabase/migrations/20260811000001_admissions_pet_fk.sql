-- ============================================================
-- 20260811000001_admissions_pet_fk.sql
-- 补齐 admissions.pet_id → pets.id 外键
--
-- 背景:admissions 表在 migration 21 定义时,pet_id 为"跨 migration 不加 FK",
-- 导致 PostgREST 无法解析 admissions → pets 的嵌套关系,
-- 前端所有 .select('..., pet:pets(name)') / pets(name) 查询报
-- PGRST200 "Could not find a relationship between 'admissions' and 'pets'"
-- (AdmissionPicker 住院记录选择器 / 护理管理 / 出院文书选择器均受影响)。
--
-- 本迁移补建外键(幂等,可重复应用),使 PostgREST 嵌套查询恢复工作。
-- on delete restrict:有在院/历史住院记录的宠物不允许直接删除。
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'admissions_pet_id_fkey'
      and conrelid = 'public.admissions'::regclass
  ) then
    alter table public.admissions
      add constraint admissions_pet_id_fkey
      foreign key (pet_id) references public.pets(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_admissions_pet_id
  on public.admissions (pet_id);
