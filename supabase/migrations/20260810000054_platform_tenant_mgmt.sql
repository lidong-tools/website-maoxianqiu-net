-- ============================================================
-- 20260810000054_platform_tenant_mgmt.sql
-- 平台租户管理(Agent-01,S3.1 并发任务)
-- 1) 新增平台权限码并授予 system_admin
-- 2) 停用/恢复 RPC(状态转换走安全函数,禁止前端直连 update)
-- 3) RLS helper 对已停用租户返回 false(浏览器直连路径也被拦截)
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. 新增权限码 =====
insert into public.permissions (code, name, module) values
  ('platform.tenant.list', '平台租户列表', 'platform'),
  ('platform.tenant.read', '查看租户详情', 'platform'),
  ('platform.tenant.suspend', '停用租户', 'platform'),
  ('platform.tenant.resume', '恢复租户', 'platform')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- ===== 2. 授予 system_admin(role_permissions 关联表 + roles.permissions 数组兼容) =====
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'platform.tenant.list', 'platform.tenant.read',
    'platform.tenant.suspend', 'platform.tenant.resume'
  )
  and not exists (
    select 1 from public.role_permissions rp
    where rp.role_id = r.id and rp.permission_id = p.id
  );

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'platform.tenant.list', 'platform.tenant.read',
    'platform.tenant.suspend', 'platform.tenant.resume'
  ])
)
where code = 'system_admin' and is_system = true;

-- ===== 3. 停用/恢复 RPC =====
-- 状态转换必须走安全函数:行锁避免并发双转换,校验合法状态,写入 updated_at。
-- 审计由 Hono Command 层 writeAudit 统一写入(与 archive_store 相同约定)。
-- 授权遵循 S30-F02:revoke public/anon/authenticated + grant service_role,
-- 浏览器(authenticated)不可直连调用;平台管理员判定在 Hono requireScopedPermission 完成。
create or replace function public.suspend_tenant(
  p_tenant_id uuid,
  p_operator_id uuid,
  p_reason text
)
returns public.tenants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
begin
  select * into v_tenant
  from public.tenants
  where id = p_tenant_id
  for update;
  if not found then
    raise exception 'TENANT_NOT_FOUND';
  end if;
  if v_tenant.status = 'suspended' then
    raise exception 'TENANT_ALREADY_SUSPENDED';
  end if;
  update public.tenants
  set status = 'suspended', updated_at = now()
  where id = p_tenant_id;
  select * into v_tenant from public.tenants where id = p_tenant_id;
  return v_tenant;
end;
$$;

create or replace function public.resume_tenant(
  p_tenant_id uuid,
  p_operator_id uuid,
  p_reason text
)
returns public.tenants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
begin
  select * into v_tenant
  from public.tenants
  where id = p_tenant_id
  for update;
  if not found then
    raise exception 'TENANT_NOT_FOUND';
  end if;
  if v_tenant.status = 'active' then
    raise exception 'TENANT_NOT_SUSPENDED';
  end if;
  update public.tenants
  set status = 'active', updated_at = now()
  where id = p_tenant_id;
  select * into v_tenant from public.tenants where id = p_tenant_id;
  return v_tenant;
end;
$$;

-- service-role-only 授权(S30-F02 约定,与 api/lib/service-rpc-manifest.ts 对齐)
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array['suspend_tenant', 'resume_tenant']
  loop
    for v_sig in
      select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_fn
        and p.prokind = 'f'
    loop
      execute format('revoke all on function %s from public', v_sig);
      execute format('revoke all on function %s from anon', v_sig);
      execute format('revoke all on function %s from authenticated', v_sig);
      execute format('grant execute on function %s to service_role', v_sig);
    end loop;
  end loop;
end;
$$;

-- ===== 4. RLS helper 对已停用租户返回 false =====
-- 停用后新业务(含浏览器直连)必须无法继续;平台管理员由 is_system_admin() 短路放行,
-- 不影响其执行停用/恢复管理动作。
create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or (
      exists (
        select 1 from public.tenants t
        where t.id = p_tenant_id and t.status = 'active'
      )
      and exists (
        select 1 from public.tenant_memberships tm
        where tm.tenant_id = p_tenant_id
          and tm.user_id = auth.uid()
          and tm.status = 'active'
      )
    );
$$;

create or replace function public.can_access_store(p_tenant_id uuid, p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or (
      exists (
        select 1 from public.tenants t
        where t.id = p_tenant_id and t.status = 'active'
      )
      and exists (
        select 1
        from public.employee_store_assignments esa
        join public.employees e on e.id = esa.employee_id
        where esa.tenant_id = p_tenant_id
          and esa.store_id = p_store_id
          and e.user_id = auth.uid()
          and e.status = 'active'
          and (esa.ends_at is null or esa.ends_at > now())
      )
    );
$$;

create or replace function public.has_permission(p_tenant_id uuid, p_store_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or (
      exists (
        select 1 from public.tenants t
        where t.id = p_tenant_id and t.status = 'active'
      )
      and exists (
        select 1
        from public.employee_role_assignments era
        join public.employees e on e.id = era.employee_id
        join public.roles r on r.id = era.role_id
        where e.user_id = auth.uid()
          and e.status = 'active'
          and era.tenant_id = p_tenant_id
          and (p_store_id is null or era.store_id = p_store_id or era.store_id is null)
          and r.permissions is not null
          and p_permission = any(r.permissions)
      )
    );
$$;

revoke all on function public.is_tenant_member(uuid) from public;
revoke all on function public.can_access_store(uuid, uuid) from public;
revoke all on function public.has_permission(uuid, uuid, text) from public;
grant execute on function public.is_tenant_member(uuid) to authenticated;
grant execute on function public.can_access_store(uuid, uuid) to authenticated;
grant execute on function public.has_permission(uuid, uuid, text) to authenticated;
