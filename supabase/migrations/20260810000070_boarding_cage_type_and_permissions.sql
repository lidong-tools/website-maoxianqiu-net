-- ============================================================
-- 20260810000070_boarding_cage_type_and_permissions.sql
-- S3.1 寄养(Boarding)基础扩展(Agent-06)
--   - rooms.room_type 扩展支持 boarding(寄养房)
--   - cages 新增 current_boarding_stay_id + 单占用约束(住院/寄养互斥)
--   - 新增寄养权限码 boarding.view / manage / care / checkout
--   - 与医疗住院权限( inpatient.* )完全分离
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. rooms.room_type 扩展:增加 boarding =====
alter table public.rooms drop constraint if exists rooms_room_type_check;
alter table public.rooms
  add constraint rooms_room_type_check
  check (room_type in ('ward', 'icu', 'isolation', 'standard', 'boarding'));

-- ===== 2. cages 新增寄养占用字段 =====
alter table public.cages
  add column if not exists current_boarding_stay_id uuid;

-- 住院与寄养不能同时占用同一笼位
alter table public.cages drop constraint if exists cages_single_occupancy_check;
alter table public.cages
  add constraint cages_single_occupancy_check
  check (not (current_admission_id is not null and current_boarding_stay_id is not null));

create index if not exists idx_cages_current_boarding_stay
  on public.cages (tenant_id, store_id, current_boarding_stay_id)
  where current_boarding_stay_id is not null;

-- ===== 3. 新增寄养权限码(与医疗住院分离) =====
insert into public.permissions (code, name, module) values
  ('boarding.view', '查看寄养', 'boarding'),
  ('boarding.manage', '管理寄养', 'boarding'),
  ('boarding.care', '寄养照护', 'boarding'),
  ('boarding.checkout', '寄养离店', 'boarding')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 系统角色补 boarding.* 权限(幂等)
-- system_admin:全部
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in ('boarding.view', 'boarding.manage', 'boarding.care', 'boarding.checkout')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- tenant_owner:全部
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'tenant_owner'
  and p.code in ('boarding.view', 'boarding.manage', 'boarding.care', 'boarding.checkout')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:全部
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in ('boarding.view', 'boarding.manage', 'boarding.care', 'boarding.checkout')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- nurse:查看 + 照护(可记录每日饲养/遛宠/用药)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'nurse'
  and p.code in ('boarding.view', 'boarding.care')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- doctor:仅查看(诊疗需要了解寄养状态)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in ('boarding.view')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- cashier:查看 + 离店收款
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'cashier'
  and p.code in ('boarding.view', 'boarding.checkout')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- ===== 4. 同步 roles.permissions 数组(兼容旧代码读取) =====
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'boarding.view', 'boarding.manage', 'boarding.care', 'boarding.checkout'
  ])
)
where code in ('system_admin', 'tenant_owner', 'store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['boarding.view', 'boarding.care'])
)
where code = 'nurse' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['boarding.view'])
)
where code = 'doctor' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['boarding.view', 'boarding.checkout'])
)
where code = 'cashier' and is_system = true;

-- ===== 5. 结束 =====
