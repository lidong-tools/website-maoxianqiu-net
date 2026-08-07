-- ============================================================
-- 20260806000019_clinical.sql
-- MXQ-7001~7011 Clinical 诊疗核心领域数据模型
--   - appointments           预约(MXQ-7001/7002)
--   - encounters             就诊病历(MXQ-7003/7005)
--   - encounter_revisions    病历修订版本(MXQ-7005)
--   - prescriptions          处方(MXQ-7006)
--   - prescription_items     处方明细(MXQ-7006)
--   - nurse_tasks            护士任务(MXQ-7007)
--   - RPC:transition_appointment / sign_encounter / revise_encounter / save_prescription
--   - 权限码:appointment.* / encounter.* / prescription.* / nurse_task.*
-- 幂等,可重复应用
--
-- 设计要点:
--   - 跨表引用 customers/pets/catalog_items 用 uuid,不加 FK 约束(避免跨 migration 依赖)
--   - doctor_id/nurse_id/assigned_to 等 user 引用 auth.users(id) on delete set null
--   - 病历签署/修订/处方保存必须走 RPC(跨表事务)
--   - 已签署病历不可直接修改,必须创建修订版本
--   - RLS:can_access_store 门店级隔离 + 角色权限
-- 状态机:
--   预约:pending→confirmed→checked_in→in_progress→completed;任意非终态→cancelled/no_show
--   就诊:in_progress→completed→signed(终态,需修订)
--   处方:draft→dispensed;draft→cancelled
-- ============================================================

-- ===== 1. appointments 表(MXQ-7001) =====
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  customer_id uuid not null,                          -- 引用 customers.id,不加 FK
  pet_id uuid not null,                               -- 引用 pets.id,不加 FK
  doctor_id uuid references auth.users(id) on delete set null,

  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  reason text,
  status text not null default 'pending',             -- pending/confirmed/checked_in/in_progress/completed/cancelled/no_show
  source text not null default 'walk_in',             -- walk_in/phone/online
  remark text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint appointments_status_check check (status in ('pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show')),
  constraint appointments_source_check check (source in ('walk_in', 'phone', 'online')),
  constraint appointments_time_check check (scheduled_end > scheduled_start)
);

create index if not exists idx_appointments_tenant_store_start on public.appointments (tenant_id, store_id, scheduled_start);
create index if not exists idx_appointments_tenant_pet on public.appointments (tenant_id, pet_id);
create index if not exists idx_appointments_tenant_status on public.appointments (tenant_id, status);
create index if not exists idx_appointments_doctor on public.appointments (doctor_id) where doctor_id is not null;

-- ===== 2. encounters 表(MXQ-7003/7005) =====
create table if not exists public.encounters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  appointment_id uuid,                                -- 引用 appointments.id,不加 FK
  customer_id uuid not null,                          -- 引用 customers.id,不加 FK
  pet_id uuid not null,                               -- 引用 pets.id,不加 FK
  doctor_id uuid references auth.users(id) on delete set null,
  nurse_id uuid references auth.users(id) on delete set null,

  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'in_progress',         -- in_progress/completed/signed

  chief_complaint text,
  history_present text,
  exam_findings text,
  diagnosis_codes text[] not null default '{}',       -- 引用 diagnosis_dict.code
  diagnosis_text text,
  treatment_plan text,
  follow_up_date date,

  signed_by uuid references auth.users(id) on delete set null,
  signed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint encounters_status_check check (status in ('in_progress', 'completed', 'signed'))
);

create index if not exists idx_encounters_tenant_pet_started on public.encounters (tenant_id, pet_id, started_at desc);
create index if not exists idx_encounters_tenant_store_status on public.encounters (tenant_id, store_id, status);
create index if not exists idx_encounters_doctor on public.encounters (doctor_id) where doctor_id is not null;
create index if not exists idx_encounters_appointment on public.encounters (appointment_id) where appointment_id is not null;

-- ===== 3. encounter_revisions 表(MXQ-7005) =====
-- 已签署病历不可直接修改,修订时创建新版本,原文保留
create table if not exists public.encounter_revisions (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  revision_no integer not null,
  content_diff jsonb not null default '{}'::jsonb,    -- 修订字段差异
  revised_by uuid references auth.users(id) on delete set null,
  revised_at timestamptz not null default now(),
  reason text,

  created_at timestamptz not null default now(),

  constraint encounter_revisions_no_check check (revision_no >= 1)
);

create unique index if not exists idx_encounter_revisions_enc_no on public.encounter_revisions (encounter_id, revision_no);
create index if not exists idx_encounter_revisions_encounter on public.encounter_revisions (encounter_id);

-- ===== 4. prescriptions 表(MXQ-7006) =====
create table if not exists public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  encounter_id uuid not null references public.encounters(id) on delete cascade,
  customer_id uuid not null,                          -- 引用 customers.id,不加 FK
  pet_id uuid not null,                               -- 引用 pets.id,不加 FK
  doctor_id uuid references auth.users(id) on delete set null,

  status text not null default 'draft',               -- draft/dispensed/cancelled
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint prescriptions_status_check check (status in ('draft', 'dispensed', 'cancelled'))
);

create index if not exists idx_prescriptions_tenant_store on public.prescriptions (tenant_id, store_id);
create index if not exists idx_prescriptions_encounter on public.prescriptions (encounter_id);
create index if not exists idx_prescriptions_tenant_pet on public.prescriptions (tenant_id, pet_id);
create index if not exists idx_prescriptions_status on public.prescriptions (tenant_id, status);

-- ===== 5. prescription_items 表(MXQ-7006) =====
create table if not exists public.prescription_items (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references public.prescriptions(id) on delete cascade,
  catalog_item_id uuid,                               -- 引用 catalog_items.id,不加 FK
  drug_name text not null,
  dosage text,
  frequency text,
  duration_days integer,
  quantity numeric(12,2) not null default 1,
  unit text,
  instructions text,
  sort_order integer not null default 0,

  created_at timestamptz not null default now(),

  constraint prescription_items_qty_check check (quantity >= 0),
  constraint prescription_items_duration_check check (duration_days is null or duration_days >= 0)
);

create index if not exists idx_prescription_items_rx on public.prescription_items (prescription_id);
create index if not exists idx_prescription_items_catalog on public.prescription_items (catalog_item_id) where catalog_item_id is not null;

-- ===== 6. nurse_tasks 表(MXQ-7007) =====
create table if not exists public.nurse_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  encounter_id uuid,                                  -- 引用 encounters.id,不加 FK(可独立任务)
  pet_id uuid not null,                               -- 引用 pets.id,不加 FK
  assigned_to uuid references auth.users(id) on delete set null,

  task_type text not null default 'other',            -- medication/observation/care/sample_collection/other
  description text not null,
  scheduled_at timestamptz,
  status text not null default 'pending',             -- pending/in_progress/done/skipped
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint nurse_tasks_type_check check (task_type in ('medication', 'observation', 'care', 'sample_collection', 'other')),
  constraint nurse_tasks_status_check check (status in ('pending', 'in_progress', 'done', 'skipped'))
);

create index if not exists idx_nurse_tasks_tenant_store_assignee on public.nurse_tasks (tenant_id, store_id, assigned_to, status);
create index if not exists idx_nurse_tasks_tenant_pet on public.nurse_tasks (tenant_id, pet_id);
create index if not exists idx_nurse_tasks_encounter on public.nurse_tasks (encounter_id) where encounter_id is not null;

-- ===== 7. updated_at 触发器(touch_updated_at 已在 000015 创建,此处挂触发器) =====
drop trigger if exists trg_appointments_updated_at on public.appointments;
create trigger trg_appointments_updated_at
  before update on public.appointments
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_encounters_updated_at on public.encounters;
create trigger trg_encounters_updated_at
  before update on public.encounters
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_prescriptions_updated_at on public.prescriptions;
create trigger trg_prescriptions_updated_at
  before update on public.prescriptions
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_nurse_tasks_updated_at on public.nurse_tasks;
create trigger trg_nurse_tasks_updated_at
  before update on public.nurse_tasks
  for each row execute procedure public.touch_updated_at();

-- ===== 8. RLS 策略 =====
alter table public.appointments enable row level security;
alter table public.encounters enable row level security;
alter table public.encounter_revisions enable row level security;
alter table public.prescriptions enable row level security;
alter table public.prescription_items enable row level security;
alter table public.nurse_tasks enable row level security;

-- ----- appointments:can_access_store 门店级隔离 -----
drop policy if exists "appointments_select" on public.appointments;
create policy "appointments_select" on public.appointments
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "appointments_insert" on public.appointments;
create policy "appointments_insert" on public.appointments
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'appointment.manage')
    )
  );

drop policy if exists "appointments_update" on public.appointments;
create policy "appointments_update" on public.appointments
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'appointment.manage')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'appointment.manage')
    )
  );

drop policy if exists "appointments_delete" on public.appointments;
create policy "appointments_delete" on public.appointments
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'appointment.manage')
    )
  );

-- ----- encounters:can_access_store + 医生可写 -----
drop policy if exists "encounters_select" on public.encounters;
create policy "encounters_select" on public.encounters
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "encounters_insert" on public.encounters;
create policy "encounters_insert" on public.encounters
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'encounter.work')
    )
  );

-- 已签署病历不可直接 update(RLS 兜底,强制走修订 RPC)
drop policy if exists "encounters_update" on public.encounters;
create policy "encounters_update" on public.encounters
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'encounter.work')
      and status <> 'signed'
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'encounter.work')
    )
  );

drop policy if exists "encounters_delete" on public.encounters;
create policy "encounters_delete" on public.encounters
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'encounter.work')
      and status = 'in_progress'
    )
  );

-- ----- encounter_revisions:跟随 encounters(联表校验) -----
drop policy if exists "encounter_revisions_select" on public.encounter_revisions;
create policy "encounter_revisions_select" on public.encounter_revisions
  for select to authenticated
  using (
    exists (
      select 1 from public.encounters e
      where e.id = encounter_revisions.encounter_id
        and public.is_tenant_member(e.tenant_id)
        and (e.store_id is null or public.can_access_store(e.tenant_id, e.store_id))
    )
  );

drop policy if exists "encounter_revisions_insert" on public.encounter_revisions;
create policy "encounter_revisions_insert" on public.encounter_revisions
  for insert to authenticated
  with check (
    exists (
      select 1 from public.encounters e
      where e.id = encounter_revisions.encounter_id
        and public.is_tenant_member(e.tenant_id)
        and (e.store_id is null or public.can_access_store(e.tenant_id, e.store_id))
        and public.has_permission(e.tenant_id, e.store_id, 'encounter.revise')
    )
  );

-- ----- prescriptions:can_access_store -----
drop policy if exists "prescriptions_select" on public.prescriptions;
create policy "prescriptions_select" on public.prescriptions
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "prescriptions_insert" on public.prescriptions;
create policy "prescriptions_insert" on public.prescriptions
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'prescription.create')
    )
  );

drop policy if exists "prescriptions_update" on public.prescriptions;
create policy "prescriptions_update" on public.prescriptions
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'prescription.create')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'prescription.create')
    )
  );

drop policy if exists "prescriptions_delete" on public.prescriptions;
create policy "prescriptions_delete" on public.prescriptions
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'prescription.create')
    )
  );

-- ----- prescription_items:跟随 prescriptions(联表校验) -----
drop policy if exists "prescription_items_select" on public.prescription_items;
create policy "prescription_items_select" on public.prescription_items
  for select to authenticated
  using (
    exists (
      select 1 from public.prescriptions p
      where p.id = prescription_items.prescription_id
        and public.is_tenant_member(p.tenant_id)
        and (p.store_id is null or public.can_access_store(p.tenant_id, p.store_id))
    )
  );

drop policy if exists "prescription_items_insert" on public.prescription_items;
create policy "prescription_items_insert" on public.prescription_items
  for insert to authenticated
  with check (
    exists (
      select 1 from public.prescriptions p
      where p.id = prescription_items.prescription_id
        and public.is_tenant_member(p.tenant_id)
        and (p.store_id is null or public.can_access_store(p.tenant_id, p.store_id))
        and public.has_permission(p.tenant_id, p.store_id, 'prescription.create')
    )
  );

drop policy if exists "prescription_items_update" on public.prescription_items;
create policy "prescription_items_update" on public.prescription_items
  for update to authenticated
  using (
    exists (
      select 1 from public.prescriptions p
      where p.id = prescription_items.prescription_id
        and public.is_tenant_member(p.tenant_id)
        and (p.store_id is null or public.can_access_store(p.tenant_id, p.store_id))
        and public.has_permission(p.tenant_id, p.store_id, 'prescription.create')
    )
  )
  with check (
    exists (
      select 1 from public.prescriptions p
      where p.id = prescription_items.prescription_id
        and public.is_tenant_member(p.tenant_id)
        and (p.store_id is null or public.can_access_store(p.tenant_id, p.store_id))
        and public.has_permission(p.tenant_id, p.store_id, 'prescription.create')
    )
  );

drop policy if exists "prescription_items_delete" on public.prescription_items;
create policy "prescription_items_delete" on public.prescription_items
  for delete to authenticated
  using (
    exists (
      select 1 from public.prescriptions p
      where p.id = prescription_items.prescription_id
        and public.is_tenant_member(p.tenant_id)
        and (p.store_id is null or public.can_access_store(p.tenant_id, p.store_id))
        and public.has_permission(p.tenant_id, p.store_id, 'prescription.create')
    )
  );

-- ----- nurse_tasks:can_access_store -----
drop policy if exists "nurse_tasks_select" on public.nurse_tasks;
create policy "nurse_tasks_select" on public.nurse_tasks
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "nurse_tasks_insert" on public.nurse_tasks;
create policy "nurse_tasks_insert" on public.nurse_tasks
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'nurse_task.manage')
    )
  );

drop policy if exists "nurse_tasks_update" on public.nurse_tasks;
create policy "nurse_tasks_update" on public.nurse_tasks
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'nurse_task.manage')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'nurse_task.manage')
    )
  );

drop policy if exists "nurse_tasks_delete" on public.nurse_tasks;
create policy "nurse_tasks_delete" on public.nurse_tasks
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'nurse_task.manage')
    )
  );

-- ===== 9. 新增权限码(MXQ-7001~7011) =====
insert into public.permissions (code, name, module) values
  ('appointment.view', '查看预约', 'appointment'),
  ('appointment.manage', '管理预约', 'appointment'),
  ('encounter.view', '查看病历', 'encounter'),
  ('encounter.work', '接诊编辑', 'encounter'),
  ('encounter.sign', '签署病历', 'encounter'),
  ('encounter.revise', '修订病历', 'encounter'),
  ('prescription.view', '查看处方', 'prescription'),
  ('prescription.create', '开具处方', 'prescription'),
  ('prescription.dispense', '发药', 'prescription'),
  ('nurse_task.view', '查看护士任务', 'nurse_task'),
  ('nurse_task.manage', '管理护士任务', 'nurse_task')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 系统角色补 Clinical 权限(幂等)
-- system_admin:全部 clinical 权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'appointment.view', 'appointment.manage',
    'encounter.view', 'encounter.work', 'encounter.sign', 'encounter.revise',
    'prescription.view', 'prescription.create', 'prescription.dispense',
    'nurse_task.view', 'nurse_task.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:全部 clinical 权限(店长可全权诊疗管理)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'appointment.view', 'appointment.manage',
    'encounter.view', 'encounter.work', 'encounter.sign', 'encounter.revise',
    'prescription.view', 'prescription.create', 'prescription.dispense',
    'nurse_task.view', 'nurse_task.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- doctor:诊疗核心权限(不含发药,发药由药师/库存岗执行)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in (
    'appointment.view', 'appointment.manage',
    'encounter.view', 'encounter.work', 'encounter.sign', 'encounter.revise',
    'prescription.view', 'prescription.create',
    'nurse_task.view', 'nurse_task.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'appointment.view', 'appointment.manage',
    'encounter.view', 'encounter.work', 'encounter.sign', 'encounter.revise',
    'prescription.view', 'prescription.create', 'prescription.dispense',
    'nurse_task.view', 'nurse_task.manage'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'appointment.view', 'appointment.manage',
    'encounter.view', 'encounter.work', 'encounter.sign', 'encounter.revise',
    'prescription.view', 'prescription.create',
    'nurse_task.view', 'nurse_task.manage'
  ])
)
where code in ('doctor') and is_system = true;

-- ===== 10. transition_appointment RPC(MXQ-7010) =====
-- 预约状态机校验:pending→confirmed→checked_in→in_progress→completed;任意非终态→cancelled/no_show
-- 终态:completed / cancelled / no_show
create or replace function public.transition_appointment(
  p_appointment_id uuid,
  p_target_status text,
  p_operator_id uuid default null
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.appointments;
  v_allowed text[];
begin
  if p_target_status not in ('pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show') then
    raise exception 'INVALID_APPOINTMENT_STATUS' using errcode = 'P0003';
  end if;

  select * into v_row from public.appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 状态机转换矩阵
  v_allowed := case v_row.status
    when 'pending' then array['confirmed', 'cancelled', 'no_show']
    when 'confirmed' then array['checked_in', 'cancelled', 'no_show']
    when 'checked_in' then array['in_progress', 'cancelled', 'no_show']
    when 'in_progress' then array['completed', 'cancelled', 'no_show']
    else array[]::text[]  -- 终态不可变更
  end case;

  if not (p_target_status = any(v_allowed)) then
    raise exception 'APPOINTMENT_INVALID_TRANSITION' using errcode = 'P0003',
      detail = 'from ' || v_row.status || ' to ' || p_target_status;
  end if;

  -- 进入 in_progress 时同步开启就诊(appointment_id 关联的 encounter 状态由调用方处理)
  update public.appointments
  set status = p_target_status, updated_at = now()
  where id = p_appointment_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.transition_appointment(uuid, text, uuid) from public;
grant execute on function public.transition_appointment(uuid, text, uuid) to authenticated;

-- ===== 11. sign_encounter RPC(MXQ-7005) =====
-- 跨表事务:校验医生签名权限(主治医生) + 标记 signed_by/signed_at + 写入审计
-- 校验:status in ('in_progress','completed') 且 doctor_id 匹配 p_doctor_id
-- 签署后 status=signed(终态),不可直接修改,必须走 revise_encounter
create or replace function public.sign_encounter(
  p_encounter_id uuid,
  p_doctor_id uuid
)
returns public.encounters
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.encounters;
begin
  select * into v_row from public.encounters where id = p_encounter_id for update;
  if not found then
    raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- 必须是主治医生本人签署
  if v_row.doctor_id is null or v_row.doctor_id <> p_doctor_id then
    raise exception 'ENCOUNTER_NOT_OWNER' using errcode = 'P0003';
  end if;
  -- 仅 in_progress / completed 可签署(状态机:in_progress→completed→signed,允许直接 in_progress→signed)
  if v_row.status not in ('in_progress', 'completed') then
    raise exception 'ENCOUNTER_NOT_SIGNABLE' using errcode = 'P0003';
  end if;

  update public.encounters
  set status = 'signed',
      signed_by = p_doctor_id,
      signed_at = now(),
      ended_at = coalesce(ended_at, now()),
      updated_at = now()
  where id = p_encounter_id
  returning * into v_row;

  -- 事务内写入审计(原子保证)
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, p_doctor_id, 'encounter.sign', 'encounter', p_encounter_id,
          jsonb_build_object('status', 'signed'));

  return v_row;
end;
$$;

revoke all on function public.sign_encounter(uuid, uuid) from public;
grant execute on function public.sign_encounter(uuid, uuid) to authenticated;

-- ===== 12. revise_encounter RPC(MXQ-7005) =====
-- 已签署病历修订:创建修订版本,原文保留(不动 encounters 行的业务字段,只追加 encounter_revisions)
-- 校验:encounter 必须已签署(status=signed)
-- p_content 为修订后的完整内容(jsonb),写入 content_diff 记录
create or replace function public.revise_encounter(
  p_encounter_id uuid,
  p_content jsonb,
  p_reason text,
  p_operator_id uuid
)
returns public.encounter_revisions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_encounter public.encounters;
  v_next_no integer;
  v_revision public.encounter_revisions;
begin
  select * into v_encounter from public.encounters where id = p_encounter_id for update;
  if not found then
    raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_encounter.status <> 'signed' then
    raise exception 'ENCOUNTER_NOT_SIGNED' using errcode = 'P0003';
  end if;

  -- 计算下一修订号
  select coalesce(max(revision_no), 0) + 1 into v_next_no
  from public.encounter_revisions
  where encounter_id = p_encounter_id;

  insert into public.encounter_revisions (encounter_id, revision_no, content_diff, revised_by, reason)
  values (p_encounter_id, v_next_no, p_content, p_operator_id, p_reason)
  returning * into v_revision;

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_encounter.tenant_id, v_encounter.store_id, p_operator_id, 'encounter.revise', 'encounter', p_encounter_id,
          jsonb_build_object('revision_no', v_next_no, 'reason', p_reason));

  return v_revision;
end;
$$;

revoke all on function public.revise_encounter(uuid, jsonb, text, uuid) from public;
grant execute on function public.revise_encounter(uuid, jsonb, text, uuid) to authenticated;

-- ===== 13. save_prescription RPC(MXQ-7006) =====
-- 事务化创建/更新处方 + 明细:p_encounter_id 关联的处方若存在 draft 则覆盖明细,否则新建
-- p_items_json 为明细数组 json,字段:catalog_item_id/drug_name/dosage/frequency/duration_days/quantity/unit/instructions/sort_order
-- 返回处方记录(明细由前端查 prescription_items 获取)
create or replace function public.save_prescription(
  p_encounter_id uuid,
  p_items_json jsonb,
  p_doctor_id uuid
)
returns public.prescriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_encounter public.encounters;
  v_rx public.prescriptions;
  v_item jsonb;
begin
  select * into v_encounter from public.encounters where id = p_encounter_id for update;
  if not found then
    raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 查找该就诊下已有的 draft 处方(一个就诊一个活跃处方)
  select * into v_rx
  from public.prescriptions
  where encounter_id = p_encounter_id and status = 'draft'
  for update;

  if not found then
    -- 新建处方
    insert into public.prescriptions (tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
    values (v_encounter.tenant_id, v_encounter.store_id, p_encounter_id, v_encounter.customer_id, v_encounter.pet_id, p_doctor_id, 'draft')
    returning * into v_rx;
  else
    -- 清空旧明细(覆盖式更新)
    delete from public.prescription_items where prescription_id = v_rx.id;
  end if;

  -- 写入明细
  for v_item in select * from jsonb_array_elements(p_items_json)
  loop
    insert into public.prescription_items (
      prescription_id, catalog_item_id, drug_name, dosage, frequency,
      duration_days, quantity, unit, instructions, sort_order
    )
    values (
      v_rx.id,
      nullif(v_item->>'catalog_item_id', '')::uuid,
      v_item->>'drug_name',
      v_item->>'dosage',
      v_item->>'frequency',
      nullif(v_item->>'duration_days', '')::integer,
      coalesce(nullif(v_item->>'quantity', '')::numeric, 1),
      v_item->>'unit',
      v_item->>'instructions',
      coalesce(nullif(v_item->>'sort_order', '')::integer, 0)
    );
  end loop;

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_encounter.tenant_id, v_encounter.store_id, p_doctor_id, 'prescription.save', 'prescription', v_rx.id,
          jsonb_build_object('encounter_id', p_encounter_id, 'items_count', jsonb_array_length(p_items_json)));

  return v_rx;
end;
$$;

revoke all on function public.save_prescription(uuid, jsonb, uuid) from public;
grant execute on function public.save_prescription(uuid, jsonb, uuid) to authenticated;

-- ===== 14. dispense_prescription RPC(MXQ-7006,发药联动) =====
-- 处方状态:draft→dispensed(由库存发药触发,此处提供状态转换入口)
-- 实际库存扣减由 Inventory dispense RPC 完成,本函数仅转换处方状态
create or replace function public.dispense_prescription(
  p_prescription_id uuid,
  p_operator_id uuid default null
)
returns public.prescriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.prescriptions;
begin
  select * into v_row from public.prescriptions where id = p_prescription_id for update;
  if not found then
    raise exception 'PRESCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status <> 'draft' then
    raise exception 'PRESCRIPTION_NOT_DRAFT' using errcode = 'P0003';
  end if;

  update public.prescriptions
  set status = 'dispensed', updated_at = now()
  where id = p_prescription_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, p_operator_id, 'prescription.dispense', 'prescription', p_prescription_id,
          jsonb_build_object('status', 'dispensed'));

  return v_row;
end;
$$;

revoke all on function public.dispense_prescription(uuid, uuid) from public;
grant execute on function public.dispense_prescription(uuid, uuid) to authenticated;
