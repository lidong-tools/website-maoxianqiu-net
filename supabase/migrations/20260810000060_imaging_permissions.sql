-- ============================================================
-- 20260810000060_imaging_permissions.sql
-- Agent-03 影像工作流权限码 + attachments 实体关联扩展
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. attachments 实体类型扩展(影像申请单 / 影像报告) =====
-- 影像附件复用现有 files/attachments/R2,不新建 imaging_files
alter table public.attachments
  drop constraint if exists attachments_entity_purpose_check;
alter table public.attachments
  add constraint attachments_entity_purpose_check check (
    entity_type in (
      'customer', 'pet', 'encounter', 'prescription', 'lab_report',
      'inventory', 'store', 'tenant', 'imaging_order', 'imaging_report'
    )
    and purpose in ('attachment', 'avatar', 'consent', 'report', 'image', 'export')
  );

-- ===== 2. imaging.* 权限码 =====
insert into public.permissions (code, name, module) values
  ('imaging.view', '查看影像', 'imaging'),
  ('imaging.order', '申请影像', 'imaging'),
  ('imaging.perform', '执行影像', 'imaging'),
  ('imaging.report', '影像报告', 'imaging'),
  ('imaging.review', '影像审核', 'imaging'),
  ('imaging.publish', '影像发布', 'imaging')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- ===== 3. 角色授权(幂等) =====
-- 影像技师岗位映射到 nurse(perform),报告/审核/发布给 doctor 与管理者
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in ('imaging.view', 'imaging.order', 'imaging.perform', 'imaging.report', 'imaging.review', 'imaging.publish')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('store_manager', 'tenant_owner')
  and p.code in ('imaging.view', 'imaging.order', 'imaging.perform', 'imaging.report', 'imaging.review', 'imaging.publish')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in ('imaging.view', 'imaging.order', 'imaging.report', 'imaging.review', 'imaging.publish')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'nurse'
  and p.code in ('imaging.view', 'imaging.perform')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'cashier'
  and p.code in ('imaging.view')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- ===== 4. 同步 roles.permissions 数组(兼容旧解析) =====
update public.roles
set permissions = array(
  select distinct unnest(
    permissions
    || array['imaging.view', 'imaging.order', 'imaging.perform', 'imaging.report', 'imaging.review', 'imaging.publish']
  )
)
where code in ('system_admin', 'store_manager', 'tenant_owner')
  and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['imaging.view', 'imaging.order', 'imaging.report', 'imaging.review', 'imaging.publish'])
)
where code in ('doctor')
  and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['imaging.view', 'imaging.perform'])
)
where code in ('nurse')
  and is_system = true;
