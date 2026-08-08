-- ============================================================
-- 20260806000021_inpatient.sql
-- MXQ-11001~11009 Inpatient 住院管理领域
--   - rooms / cages / admissions / nursing_plans / nursing_tasks
--   - shift_handovers / cage_transfers / inpatient_charges
--   - RLS 策略(基于 is_tenant_member / can_access_store / has_permission)
--   - RPC:admit_patient / transfer_cage / discharge_patient
--         create_handover / generate_daily_charges
--   - 房态看板视图:inpatient_cage_status
--   - 权限码:inpatient.view / admit / discharge / transfer
--             nursing.view / nursing.manage / handover.manage
-- 幂等,可重复应用
--
-- 设计要点:
--   - 入院/换房/出院走 Hono Command + PostgreSQL RPC,事务化 + SELECT FOR UPDATE 防房位冲突
--   - 笼位状态机:available → occupied → available(出院);available → maintenance → available
--   - 入院状态机:admitted → discharged;admitted → transferred(换房不改状态,只更新 cage_id)
--   - 护理任务状态机:pending → in_progress → done;pending → skipped
--   - 幂等:idempotency_records 兜底,同 idempotency_key 返回原结果
--   - 跨表引用用 uuid,不加 FK 约束(customer_id / pet_id / doctor_id / catalog_item_id)
-- ============================================================

-- ===== 1. rooms 表(房间) =====
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  code text not null,
  floor text,
  room_type text not null default 'standard',      -- ward / icu / isolation / standard
  capacity integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rooms_room_type_check check (room_type in ('ward', 'icu', 'isolation', 'standard')),
  constraint rooms_capacity_check check (capacity >= 0)
);

-- 同租户同门店下房间编码唯一
create unique index if not exists idx_rooms_tenant_store_code
  on public.rooms (tenant_id, store_id, code);
create index if not exists idx_rooms_tenant_store
  on public.rooms (tenant_id, store_id);
create index if not exists idx_rooms_active
  on public.rooms (tenant_id, store_id, is_active);

-- ===== 2. cages 表(笼位) =====
create table if not exists public.cages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null,
  code text not null,
  cage_type text not null default 'cage',          -- cage / run / tank
  daily_rate numeric(12,2) not null default 0,
  status text not null default 'available',         -- available / occupied / maintenance / cleaning
  current_admission_id uuid,                        -- 跨 migration 不加 FK
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cages_cage_type_check check (cage_type in ('cage', 'run', 'tank')),
  constraint cages_status_check check (status in ('available', 'occupied', 'maintenance', 'cleaning')),
  constraint cages_daily_rate_check check (daily_rate >= 0)
);

create unique index if not exists idx_cages_tenant_store_code
  on public.cages (tenant_id, store_id, code);
create index if not exists idx_cages_tenant_store
  on public.cages (tenant_id, store_id);
create index if not exists idx_cages_room
  on public.cages (room_id);
create index if not exists idx_cages_status
  on public.cages (tenant_id, store_id, status);

-- ===== 3. admissions 表(住院记录) =====
create table if not exists public.admissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  customer_id uuid not null,                        -- 跨 migration 不加 FK
  pet_id uuid not null,                             -- 跨 migration 不加 FK
  cage_id uuid not null,                            -- 同表内引用 cages(id),通过应用层维护
  doctor_id uuid,                                   -- 跨 migration 不加 FK(医生 = employees.id)
  admission_reason text,
  admitted_at timestamptz not null default now(),
  status text not null default 'admitted',           -- admitted / discharged / transferred
  discharged_at timestamptz,
  discharge_reason text,
  discharge_notes text,
  total_charge numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint admissions_status_check check (status in ('admitted', 'discharged', 'transferred')),
  constraint admissions_total_charge_check check (total_charge >= 0)
);

create index if not exists idx_admissions_tenant_store
  on public.admissions (tenant_id, store_id);
create index if not exists idx_admissions_pet
  on public.admissions (pet_id);
create index if not exists idx_admissions_customer
  on public.admissions (customer_id);
create index if not exists idx_admissions_cage
  on public.admissions (cage_id);
create index if not exists idx_admissions_status
  on public.admissions (tenant_id, store_id, status);
create index if not exists idx_admissions_admitted_at
  on public.admissions (tenant_id, admitted_at desc);

-- ===== 4. nursing_plans 表(护理计划) =====
create table if not exists public.nursing_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  admission_id uuid not null,                       -- 跨 migration 不加 FK
  pet_id uuid not null,                             -- 跨 migration 不加 FK
  plan_name text not null,
  frequency text not null default 'daily',           -- q4h / q6h / q8h / q12h / daily / twice_daily
  start_date date not null default current_date,
  end_date date,
  is_active boolean not null default true,
  created_by uuid,                                  -- 跨 migration 不加 FK(auth.users.id)
  created_at timestamptz not null default now(),

  constraint nursing_plans_frequency_check check (
    frequency in ('q4h', 'q6h', 'q8h', 'q12h', 'daily', 'twice_daily')
  )
);

create index if not exists idx_nursing_plans_tenant_store
  on public.nursing_plans (tenant_id, store_id);
create index if not exists idx_nursing_plans_admission
  on public.nursing_plans (admission_id);
create index if not exists idx_nursing_plans_active
  on public.nursing_plans (tenant_id, store_id, is_active);

-- ===== 5. nursing_tasks 表(护理任务) =====
create table if not exists public.nursing_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  admission_id uuid not null,                       -- 跨 migration 不加 FK
  pet_id uuid not null,                             -- 跨 migration 不加 FK
  plan_id uuid,                                     -- 跨 migration 不加 FK(nursing_plans.id)
  task_type text not null default 'other',          -- medication / feeding / walking / observation / wound_care / fluid / other
  description text,
  scheduled_at timestamptz not null,
  assigned_to uuid,                                 -- 跨 migration 不加 FK(auth.users.id)
  status text not null default 'pending',           -- pending / in_progress / done / skipped
  completed_at timestamptz,
  completed_by uuid,                                -- 跨 migration 不加 FK
  note text,
  created_at timestamptz not null default now(),

  constraint nursing_tasks_task_type_check check (
    task_type in ('medication', 'feeding', 'walking', 'observation', 'wound_care', 'fluid', 'other')
  ),
  constraint nursing_tasks_status_check check (status in ('pending', 'in_progress', 'done', 'skipped'))
);

create index if not exists idx_nursing_tasks_tenant_store_scheduled_status
  on public.nursing_tasks (tenant_id, store_id, scheduled_at, status);
create index if not exists idx_nursing_tasks_admission
  on public.nursing_tasks (tenant_id, admission_id);
create index if not exists idx_nursing_tasks_assigned
  on public.nursing_tasks (assigned_to, scheduled_at);

-- ===== 6. shift_handovers 表(交接班) =====
create table if not exists public.shift_handovers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  shift_date date not null default current_date,
  shift_type text not null default 'morning',        -- morning / evening / night
  outgoing_user uuid,                                -- 跨 migration 不加 FK
  incoming_user uuid,                                -- 跨 migration 不加 FK
  summary jsonb not null default '{}'::jsonb,        -- 按宠物汇总
  acknowledged_at timestamptz,
  acknowledged_by uuid,                               -- 跨 migration 不加 FK
  created_at timestamptz not null default now(),

  constraint shift_handovers_shift_type_check check (shift_type in ('morning', 'evening', 'night'))
);

create index if not exists idx_shift_handovers_tenant_store_date
  on public.shift_handovers (tenant_id, store_id, shift_date desc);
create index if not exists idx_shift_handovers_outgoing
  on public.shift_handovers (outgoing_user, shift_date desc);

-- ===== 7. cage_transfers 表(换房历史) =====
create table if not exists public.cage_transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  admission_id uuid not null,                       -- 跨 migration 不加 FK
  from_cage_id uuid not null,                       -- 跨 migration 不加 FK
  to_cage_id uuid not null,                         -- 跨 migration 不加 FK
  reason text,
  operator_id uuid,                                 -- 跨 migration 不加 FK
  created_at timestamptz not null default now()
);

create index if not exists idx_cage_transfers_admission
  on public.cage_transfers (admission_id, created_at desc);
create index if not exists idx_cage_transfers_tenant_store
  on public.cage_transfers (tenant_id, store_id, created_at desc);

-- ===== 8. inpatient_charges 表(住院费用) =====
create table if not exists public.inpatient_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  admission_id uuid not null,                       -- 跨 migration 不加 FK
  charge_date date not null default current_date,
  catalog_item_id uuid,                             -- 跨 migration 不加 FK(引用住院服务项目)
  description text,
  quantity numeric not null default 1,
  unit_price numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0,
  is_auto boolean not null default false,
  created_at timestamptz not null default now(),

  constraint inpatient_charges_quantity_check check (quantity <> 0),
  constraint inpatient_charges_amount_check check (amount >= 0)
);

create index if not exists idx_inpatient_charges_admission_date
  on public.inpatient_charges (admission_id, charge_date);
create index if not exists idx_inpatient_charges_tenant_store_date
  on public.inpatient_charges (tenant_id, store_id, charge_date);
-- 幂等键:同一天同一入院同一服务项目不重复生成
create unique index if not exists idx_inpatient_charges_admission_date_catalog
  on public.inpatient_charges (admission_id, charge_date, catalog_item_id)
  where catalog_item_id is not null;

-- ===== 9. updated_at 触发器 =====
drop trigger if exists trg_rooms_updated_at on public.rooms;
create trigger trg_rooms_updated_at
  before update on public.rooms
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_cages_updated_at on public.cages;
create trigger trg_cages_updated_at
  before update on public.cages
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_admissions_updated_at on public.admissions;
create trigger trg_admissions_updated_at
  before update on public.admissions
  for each row execute procedure public.touch_updated_at();

-- ===== 10. RLS 策略 =====
alter table public.rooms enable row level security;
alter table public.cages enable row level security;
alter table public.admissions enable row level security;
alter table public.nursing_plans enable row level security;
alter table public.nursing_tasks enable row level security;
alter table public.shift_handovers enable row level security;
alter table public.cage_transfers enable row level security;
alter table public.inpatient_charges enable row level security;

-- rooms:租户成员 + 门店访问权限
drop policy if exists "rooms_select" on public.rooms;
create policy "rooms_select" on public.rooms
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "rooms_insert" on public.rooms;
create policy "rooms_insert" on public.rooms
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.admit')
  );

drop policy if exists "rooms_update" on public.rooms;
create policy "rooms_update" on public.rooms
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.admit')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.admit')
  );

drop policy if exists "rooms_delete" on public.rooms;
create policy "rooms_delete" on public.rooms
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- cages:同 rooms
drop policy if exists "cages_select" on public.cages;
create policy "cages_select" on public.cages
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "cages_insert" on public.cages;
create policy "cages_insert" on public.cages
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.admit')
  );

drop policy if exists "cages_update" on public.cages;
create policy "cages_update" on public.cages
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "cages_delete" on public.cages;
create policy "cages_delete" on public.cages
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- admissions:租户成员 + 门店访问权限,读须 inpatient.view
drop policy if exists "admissions_select" on public.admissions;
create policy "admissions_select" on public.admissions
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.view')
  );

-- admissions 写入由 RPC(security definer) 完成,直连写入需 inpatient.admit 权限
drop policy if exists "admissions_insert" on public.admissions;
create policy "admissions_insert" on public.admissions
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.admit')
  );

drop policy if exists "admissions_update" on public.admissions;
create policy "admissions_update" on public.admissions
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.admit')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.admit')
  );

drop policy if exists "admissions_delete" on public.admissions;
create policy "admissions_delete" on public.admissions
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- nursing_plans:护理计划读写,读须 nursing.view,写须 nursing.manage
drop policy if exists "nursing_plans_select" on public.nursing_plans;
create policy "nursing_plans_select" on public.nursing_plans
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'nursing.view')
  );

drop policy if exists "nursing_plans_insert" on public.nursing_plans;
create policy "nursing_plans_insert" on public.nursing_plans
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'nursing.manage')
  );

drop policy if exists "nursing_plans_update" on public.nursing_plans;
create policy "nursing_plans_update" on public.nursing_plans
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'nursing.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'nursing.manage')
  );

drop policy if exists "nursing_plans_delete" on public.nursing_plans;
create policy "nursing_plans_delete" on public.nursing_plans
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'nursing.manage')
  );

-- nursing_tasks:护理任务读写,读须 nursing.view,写须 nursing.manage(完成/跳过同权)
drop policy if exists "nursing_tasks_select" on public.nursing_tasks;
create policy "nursing_tasks_select" on public.nursing_tasks
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'nursing.view')
  );

drop policy if exists "nursing_tasks_insert" on public.nursing_tasks;
create policy "nursing_tasks_insert" on public.nursing_tasks
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'nursing.manage')
  );

drop policy if exists "nursing_tasks_update" on public.nursing_tasks;
create policy "nursing_tasks_update" on public.nursing_tasks
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'nursing.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'nursing.manage')
  );

drop policy if exists "nursing_tasks_delete" on public.nursing_tasks;
create policy "nursing_tasks_delete" on public.nursing_tasks
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'nursing.manage')
  );

-- shift_handovers:交接班读写,须 handover.manage
drop policy if exists "shift_handovers_select" on public.shift_handovers;
create policy "shift_handovers_select" on public.shift_handovers
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'handover.manage')
  );

drop policy if exists "shift_handovers_insert" on public.shift_handovers;
create policy "shift_handovers_insert" on public.shift_handovers
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'handover.manage')
  );

drop policy if exists "shift_handovers_update" on public.shift_handovers;
create policy "shift_handovers_update" on public.shift_handovers
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'handover.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'handover.manage')
  );

drop policy if exists "shift_handovers_delete" on public.shift_handovers;
create policy "shift_handovers_delete" on public.shift_handovers
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- cage_transfers:换房历史,读须 inpatient.view,写入由 RPC(security definer)完成
drop policy if exists "cage_transfers_select" on public.cage_transfers;
create policy "cage_transfers_select" on public.cage_transfers
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.view')
  );

drop policy if exists "cage_transfers_insert" on public.cage_transfers;
create policy "cage_transfers_insert" on public.cage_transfers
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.transfer')
  );

-- inpatient_charges:住院费用,读须 inpatient.view,写须 inpatient.admit(或自动计费任务由 service role 调 RPC)
drop policy if exists "inpatient_charges_select" on public.inpatient_charges;
create policy "inpatient_charges_select" on public.inpatient_charges
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.view')
  );

drop policy if exists "inpatient_charges_insert" on public.inpatient_charges;
create policy "inpatient_charges_insert" on public.inpatient_charges
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inpatient.admit')
  );

drop policy if exists "inpatient_charges_delete" on public.inpatient_charges;
create policy "inpatient_charges_delete" on public.inpatient_charges
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- ===== 11. 新增权限码 =====
insert into public.permissions (code, name, module) values
  ('inpatient.view', '查看住院', 'inpatient'),
  ('inpatient.admit', '办理入院', 'inpatient'),
  ('inpatient.discharge', '办理出院', 'inpatient'),
  ('inpatient.transfer', '换房', 'inpatient'),
  ('nursing.view', '查看护理', 'nursing'),
  ('nursing.manage', '管理护理', 'nursing'),
  ('handover.manage', '交接班', 'handover')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 系统角色补 inpatient.* / nursing.* / handover.* 权限(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'inpatient.view', 'inpatient.admit', 'inpatient.discharge',
    'inpatient.transfer', 'nursing.view', 'nursing.manage', 'handover.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:管理住院全流程 + 护理 + 交接班
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'inpatient.view', 'inpatient.admit', 'inpatient.discharge',
    'inpatient.transfer', 'nursing.view', 'nursing.manage', 'handover.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- doctor:查看/办理入院/出院/换房 + 护理管理
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in (
    'inpatient.view', 'inpatient.admit', 'inpatient.discharge',
    'inpatient.transfer', 'nursing.view', 'nursing.manage', 'handover.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- nurse:查看住院 + 护理管理 + 交接班
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'nurse'
  and p.code in (
    'inpatient.view', 'nursing.view', 'nursing.manage', 'handover.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'inpatient.view', 'inpatient.admit', 'inpatient.discharge',
    'inpatient.transfer', 'nursing.view', 'nursing.manage', 'handover.manage'
  ])
)
where code = 'system_admin' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'inpatient.view', 'inpatient.admit', 'inpatient.discharge',
    'inpatient.transfer', 'nursing.view', 'nursing.manage', 'handover.manage'
  ])
)
where code = 'store_manager' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'inpatient.view', 'inpatient.admit', 'inpatient.discharge',
    'inpatient.transfer', 'nursing.view', 'nursing.manage', 'handover.manage'
  ])
)
where code = 'doctor' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'inpatient.view', 'nursing.view', 'nursing.manage', 'handover.manage'
  ])
)
where code = 'nurse' and is_system = true;

-- ===== 12. admit_patient RPC(MXQ-11003 入院房位锁) =====
-- 事务:SELECT FOR UPDATE cages → 校验 status=available → 创建 admission → 更新 cage.status=occupied, current_admission_id
-- 幂等:同 idempotency_key 返回原结果
-- 并发安全:FOR UPDATE 防止同一笼位被两个入院同时占用
create or replace function public.admit_patient(
  p_tenant_id uuid,
  p_store_id uuid,
  p_customer_id uuid,
  p_pet_id uuid,
  p_cage_id uuid,
  p_doctor_id uuid default null,
  p_admission_reason text default null,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cage public.cages;
  v_existing jsonb;
  v_admission public.admissions;
begin
  -- 幂等检查:同 idempotency_key 命中返回原结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 校验笼位归属与状态,SELECT FOR UPDATE 锁行防并发占用
  select * into v_cage from public.cages
  where id = p_cage_id and tenant_id = p_tenant_id and store_id = p_store_id
  for update;
  if not found then
    raise exception 'CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_cage.status <> 'available' then
    raise exception 'CAGE_NOT_AVAILABLE' using errcode = 'P0003';
  end if;

  -- 创建住院记录
  insert into public.admissions (
    tenant_id, store_id, customer_id, pet_id, cage_id,
    doctor_id, admission_reason, status, admitted_at
  )
  values (
    p_tenant_id, p_store_id, p_customer_id, p_pet_id, p_cage_id,
    p_doctor_id, p_admission_reason, 'admitted', now()
  )
  returning * into v_admission;

  -- 更新笼位状态为 occupied,记录当前入院 id
  update public.cages
  set status = 'occupied',
      current_admission_id = v_admission.id,
      updated_at = now()
  where id = p_cage_id;

  -- 记录幂等结果(service role 绕过 RLS 写入)
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'admit_patient', 'admission', v_admission.id, jsonb_build_object(
      'admissionId', v_admission.id,
      'cageId', p_cage_id,
      'status', v_admission.status,
      'admittedAt', v_admission.admitted_at
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'admissionId', v_admission.id,
    'cageId', p_cage_id,
    'status', v_admission.status,
    'admittedAt', v_admission.admitted_at
  );
end;
$$;

revoke all on function public.admit_patient(uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text) from public;
grant execute on function public.admit_patient(uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text) to authenticated;

-- ===== 13. transfer_cage RPC(MXQ-11006 换房) =====
-- 事务:SELECT FOR UPDATE 旧笼 + 新笼 → 校验新笼 status=available → 更新 admission.cage_id
--       → 旧笼 status=available, current_admission_id=null → 新笼 status=occupied, current_admission_id=admission_id
-- 记录换房历史到 cage_transfers
-- 幂等:同 idempotency_key 返回原结果
create or replace function public.transfer_cage(
  p_admission_id uuid,
  p_new_cage_id uuid,
  p_reason text default null,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admission public.admissions;
  v_old_cage public.cages;
  v_new_cage public.cages;
  v_existing jsonb;
  v_transfer public.cage_transfers;
begin
  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 锁定住院记录
  select * into v_admission from public.admissions
  where id = p_admission_id
  for update;
  if not found then
    raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_admission.status <> 'admitted' then
    raise exception 'ADMISSION_NOT_ADMITTED' using errcode = 'P0003';
  end if;

  -- 锁定旧笼位
  select * into v_old_cage from public.cages
  where id = v_admission.cage_id
  for update;
  if not found then
    raise exception 'OLD_CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 锁定新笼位
  select * into v_new_cage from public.cages
  where id = p_new_cage_id and tenant_id = v_admission.tenant_id and store_id = v_admission.store_id
  for update;
  if not found then
    raise exception 'NEW_CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_new_cage.status <> 'available' then
    raise exception 'NEW_CAGE_NOT_AVAILABLE' using errcode = 'P0003';
  end if;
  if v_new_cage.id = v_old_cage.id then
    raise exception 'SAME_CAGE' using errcode = 'P0003';
  end if;

  -- 更新住院记录的笼位
  update public.admissions
  set cage_id = p_new_cage_id,
      updated_at = now()
  where id = p_admission_id;

  -- 释放旧笼位
  update public.cages
  set status = 'available',
      current_admission_id = null,
      updated_at = now()
  where id = v_old_cage.id;

  -- 占用新笼位
  update public.cages
  set status = 'occupied',
      current_admission_id = p_admission_id,
      updated_at = now()
  where id = p_new_cage_id;

  -- 写入换房历史
  insert into public.cage_transfers (
    tenant_id, store_id, admission_id, from_cage_id, to_cage_id, reason, operator_id
  )
  values (
    v_admission.tenant_id, v_admission.store_id, p_admission_id,
    v_old_cage.id, p_new_cage_id, p_reason, p_operator_id
  )
  returning * into v_transfer;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_admission.tenant_id, p_idempotency_key, 'transfer_cage', 'cage_transfer', v_transfer.id, jsonb_build_object(
      'transferId', v_transfer.id,
      'admissionId', p_admission_id,
      'fromCageId', v_old_cage.id,
      'toCageId', p_new_cage_id
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'transferId', v_transfer.id,
    'admissionId', p_admission_id,
    'fromCageId', v_old_cage.id,
    'toCageId', p_new_cage_id
  );
end;
$$;

revoke all on function public.transfer_cage(uuid, uuid, text, uuid, text) from public;
grant execute on function public.transfer_cage(uuid, uuid, text, uuid, text) to authenticated;

-- ===== 14. discharge_patient RPC(MXQ-11008 出院) =====
-- 事务:校验 status=admitted → 汇总 total_charge → 更新 admission.status=discharged, discharged_at
--       → 更新 cage.status=available, current_admission_id=null
-- 幂等:同 idempotency_key 返回原结果
create or replace function public.discharge_patient(
  p_admission_id uuid,
  p_discharge_reason text default null,
  p_discharge_notes text default null,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admission public.admissions;
  v_cage public.cages;
  v_existing jsonb;
  v_total_charge numeric(12,2) := 0;
begin
  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 锁定住院记录
  select * into v_admission from public.admissions
  where id = p_admission_id
  for update;
  if not found then
    raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_admission.status <> 'admitted' then
    raise exception 'ADMISSION_NOT_ADMITTED' using errcode = 'P0003';
  end if;

  -- 汇总费用
  select coalesce(sum(amount), 0) into v_total_charge
  from public.inpatient_charges
  where admission_id = p_admission_id;

  -- 锁定笼位并释放
  select * into v_cage from public.cages
  where id = v_admission.cage_id
  for update;

  -- 更新住院记录为已出院
  update public.admissions
  set status = 'discharged',
      discharged_at = now(),
      discharge_reason = p_discharge_reason,
      discharge_notes = p_discharge_notes,
      total_charge = v_total_charge,
      updated_at = now()
  where id = p_admission_id
  returning * into v_admission;

  -- 释放笼位
  if v_cage is not null then
    update public.cages
    set status = 'available',
        current_admission_id = null,
        updated_at = now()
    where id = v_cage.id;
  end if;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_admission.tenant_id, p_idempotency_key, 'discharge_patient', 'admission', p_admission_id, jsonb_build_object(
      'admissionId', p_admission_id,
      'status', 'discharged',
      'totalCharge', v_total_charge,
      'dischargedAt', v_admission.discharged_at
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'admissionId', p_admission_id,
    'status', 'discharged',
    'totalCharge', v_total_charge,
    'dischargedAt', v_admission.discharged_at
  );
end;
$$;

revoke all on function public.discharge_patient(uuid, text, text, uuid, text) from public;
grant execute on function public.discharge_patient(uuid, text, text, uuid, text) to authenticated;

-- ===== 15. create_handover RPC(MXQ-11005 交接班) =====
-- 创建交接班记录,同一班次(同 tenant+store+date+shift_type)幂等:已存在则更新 summary
create or replace function public.create_handover(
  p_tenant_id uuid,
  p_store_id uuid,
  p_shift_date date,
  p_shift_type text,
  p_outgoing_user uuid default null,
  p_incoming_user uuid default null,
  p_summary jsonb default '{}'::jsonb,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_handover public.shift_handovers;
begin
  if p_shift_type not in ('morning', 'evening', 'night') then
    raise exception 'INVALID_SHIFT_TYPE' using errcode = 'P0003';
  end if;

  -- 同班次已存在则更新 summary 与交接人(便于多次保存草稿)
  select * into v_handover from public.shift_handovers
  where tenant_id = p_tenant_id and store_id = p_store_id
    and shift_date = p_shift_date and shift_type = p_shift_type
  for update;

  if found then
    update public.shift_handovers
    set outgoing_user = coalesce(p_outgoing_user, outgoing_user),
        incoming_user = coalesce(p_incoming_user, incoming_user),
        summary = p_summary
    where id = v_handover.id
    returning * into v_handover;
  else
    insert into public.shift_handovers (
      tenant_id, store_id, shift_date, shift_type,
      outgoing_user, incoming_user, summary
    )
    values (
      p_tenant_id, p_store_id, p_shift_date, p_shift_type,
      p_outgoing_user, p_incoming_user, p_summary
    )
    returning * into v_handover;
  end if;

  return jsonb_build_object(
    'handoverId', v_handover.id,
    'shiftDate', v_handover.shift_date,
    'shiftType', v_handover.shift_type
  );
end;
$$;

revoke all on function public.create_handover(uuid, uuid, date, text, uuid, uuid, jsonb, uuid) from public;
grant execute on function public.create_handover(uuid, uuid, date, text, uuid, uuid, jsonb, uuid) to authenticated;

-- ===== 16. generate_daily_charges RPC(MXQ-11007 自动计费) =====
-- 扫描所有 admitted admission,生成当日笼位费(幂等:同 charge_date+admission_id+catalog_item_id 不重复)
-- 入参 p_target_date:目标计费日期;返回新生成的费用条数
create or replace function public.generate_daily_charges(
  p_target_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_date date := coalesce(p_target_date, current_date);
  v_admission record;
  v_cage public.cages;
  v_count integer := 0;
begin
  for v_admission in
    select a.id, a.tenant_id, a.store_id, a.cage_id
    from public.admissions a
    where a.status = 'admitted'
  loop
    -- 取笼位费率
    select * into v_cage from public.cages where id = v_admission.cage_id for update;
    if v_cage is null then
      continue;
    end if;

    -- 跳过费率为 0 的笼位(无需计费)
    if v_cage.daily_rate = 0 then
      continue;
    end if;

    -- 幂等插入:同 admission + 同 charge_date + 同 catalog_item_id 不重复
    -- catalog_item_id 固定使用笼位 id 派生的占位 uuid(此处用 cage.id 兼容唯一索引)
    insert into public.inpatient_charges (
      tenant_id, store_id, admission_id, charge_date,
      catalog_item_id, description, quantity, unit_price, amount, is_auto
    )
    values (
      v_admission.tenant_id, v_admission.store_id, v_admission.id, v_target_date,
      v_cage.id, '笼位费 - ' || coalesce(v_cage.name, v_cage.code),
      1, v_cage.daily_rate, v_cage.daily_rate, true
    )
    on conflict (admission_id, charge_date, catalog_item_id)
    where catalog_item_id is not null
    do nothing;

    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'targetDate', v_target_date,
    'generatedCount', v_count
  );
end;
$$;

revoke all on function public.generate_daily_charges(date) from public;
grant execute on function public.generate_daily_charges(date) to authenticated;

-- ===== 17. inpatient_cage_status 视图(MXQ-11002 房态看板) =====
-- 关联 cages + rooms + current_admission,展示房态
create or replace view public.inpatient_cage_status as
  select
    c.id as cage_id,
    c.tenant_id,
    c.store_id,
    c.room_id,
    r.name as room_name,
    r.code as room_code,
    r.floor as room_floor,
    r.room_type,
    c.name as cage_name,
    c.code as cage_code,
    c.cage_type,
    c.daily_rate,
    c.status as cage_status,
    c.current_admission_id,
    a.pet_id,
    a.customer_id,
    a.doctor_id,
    a.admitted_at,
    a.admission_reason
  from public.cages c
  left join public.rooms r on r.id = c.room_id
  left join public.admissions a on a.id = c.current_admission_id;

grant select on public.inpatient_cage_status to authenticated;

-- ===== 18. 结束 =====
-- 该 migration 可重复应用,所有对象均使用 if not exists / create or replace / on conflict
