-- ============================================================
-- 0050_audit_permissions.sql
-- CORE-04 审计与安全:审计权限码 + 审计索引
-- 应用方式:Supabase SQL Editor 按编号顺序执行(幂等)
-- ============================================================

-- ===== 1. 审计权限码 =====
insert into public.permissions (code, name, module) values
  ('audit.view', '查看审计日志', 'system'),
  ('audit.export', '导出审计日志', 'system')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin:审计查看 + 导出
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in ('audit.view', 'audit.export')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- tenant_owner(租户级):审计查看 + 导出
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'tenant_owner'
  and p.code in ('audit.view', 'audit.export')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array['audit.view', 'audit.export'])
)
where code in ('system_admin', 'tenant_owner') and is_system = true;

-- ===== 2. 审计日志索引(数据量增大后按需) =====
create index if not exists idx_audit_logs_tenant_store_time
  on public.audit_logs (tenant_id, store_id, created_at desc);

create index if not exists idx_audit_logs_request_id
  on public.audit_logs (request_id);
