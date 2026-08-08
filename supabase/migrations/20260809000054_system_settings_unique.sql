-- ============================================================
-- 20260809000054_system_settings_unique.sql
-- P0-09:system_settings 唯一约束修复
-- 问题:store_id IS NULL 表示租户默认,但 PostgreSQL 的普通 UNIQUE
--   视 NULL != NULL,允许同一 (tenant_id, namespace, key) 的
--   租户默认记录重复存在,导致生效配置合并时取哪条不可预测。
-- 修复:升级为 UNIQUE NULLS NOT DISTINCT(PG15+),并先清理存量重复。
-- 应用方式:Supabase SQL Editor 按编号顺序执行(幂等)
-- ============================================================

-- ===== 1. 清理重复记录,保留 updated_at 最新(同时间戳取 id 更大) =====
with ranked as (
  select id,
         row_number() over (
           partition by tenant_id, store_id, namespace, key
           order by updated_at desc, id desc
         ) as rn
  from public.system_settings
)
delete from public.system_settings
where id in (select id from ranked where rn > 1);

-- ===== 2. 删除旧唯一约束(不报错若不存在) =====
alter table public.system_settings drop constraint if exists system_settings_scope_unique;

-- ===== 3. 新建 NULLS NOT DISTINCT 唯一约束 =====
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'system_settings_scope_unique'
      and connamespace = 'public'::regnamespace
  ) then
    alter table public.system_settings
      add constraint system_settings_scope_unique
      unique nulls not distinct (tenant_id, store_id, namespace, key);
  end if;
end;
$$;
