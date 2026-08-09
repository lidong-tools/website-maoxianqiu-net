-- ============================================================
-- Agent-09(Stage-04 Final Integrator) 集成修复 migration 285
-- 修复 appointments.source CHECK 约束缺少 customer_portal
-- ------------------------------------------------------------
-- 背景(跨域集成五/Portal ↔ Business):
--   migration 19(20260806000019_clinical.sql)定义:
--     appointments_source_check check (source in ('walk_in', 'phone', 'online'))
--   Agent-08 migration 266 的 create_portal_appointment RPC 以
--     source = 'customer_portal' 写入 appointments;
--   若不放开约束,C 端预约首次执行将抛 CHECK violation → Portal 预约功能不可用。
-- 本 migration 为 Forward Fix(禁止改历史 migration):
--   drop + add 同一约束,幂等(不存在约束时跳过 drop)。
-- ============================================================
set search_path = public;

do $$
begin
  -- 幂等:仅当约束存在时先 drop,再统一 add(含 customer_portal)
  if exists (
    select 1 from pg_constraint
    where conname = 'appointments_source_check'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments drop constraint appointments_source_check;
  end if;
end;
$$;

-- 新约束:原值 + customer_portal
alter table public.appointments
  add constraint appointments_source_check
  check (source in ('walk_in', 'phone', 'online', 'customer_portal'));

-- ============================================================
-- 集成修复审计(可追溯)
-- ============================================================
insert into public.audit_logs (action, entity_type, entity_id, metadata, created_at)
values (
  'migration.fix',
  'migration',
  '20260810000285',
  jsonb_build_object(
    'reason', 'appointments.source CHECK 增加 customer_portal(Agent-08 migration 266 C 端预约依赖)',
    'integrator', 'agent-09'
  ),
  now()
);
