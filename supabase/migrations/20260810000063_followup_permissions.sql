-- ============================================================
-- S3.1-AGENT-04: 回访权限种子 + 角色授权
-- followup.view / followup.manage / followup.complete
-- ============================================================

insert into public.permissions (code, name, module) values
  ('followup.view', '查看回访', 'followup'),
  ('followup.manage', '管理回访', 'followup'),
  ('followup.complete', '完成回访', 'followup')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin:全部
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in ('followup.view', 'followup.manage', 'followup.complete')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:全部
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in ('followup.view', 'followup.manage', 'followup.complete')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- doctor / nurse:查看 + 完成
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('doctor', 'nurse')
  and p.code in ('followup.view', 'followup.complete')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- cashier:查看
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'cashier'
  and p.code in ('followup.view')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧模型权限解析)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'followup.view', 'followup.manage', 'followup.complete'
  ])
)
where code in ('system_admin') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'followup.view', 'followup.manage', 'followup.complete'
  ])
)
where code in ('store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'followup.view', 'followup.complete'
  ])
)
where code in ('doctor', 'nurse') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'followup.view'
  ])
)
where code in ('cashier') and is_system = true;
