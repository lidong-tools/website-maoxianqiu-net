-- ============================================================
-- 0051_approval_inbox.sql
-- CORE-05 审批中心:审批待办权限码
-- 应用方式:Supabase SQL Editor 按编号顺序执行(幂等)
-- ============================================================

-- ===== 1. 审批中心权限码 =====
insert into public.permissions (code, name, module) values
  ('approval.inbox.view', '查看审批中心', 'system')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin / tenant_owner / store_manager:可进入审批中心
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner', 'store_manager')
  and p.code = 'approval.inbox.view'
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array['approval.inbox.view'])
)
where code in ('system_admin', 'tenant_owner', 'store_manager') and is_system = true;
