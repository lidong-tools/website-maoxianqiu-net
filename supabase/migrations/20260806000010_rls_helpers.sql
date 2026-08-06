-- ============================================================
-- 20260806000010_rls_helpers.sql
-- MXQ-3006 租户/门店 RLS helper 函数
-- 说明:文档建议 private 前缀,但 Supabase 新版本 private schema 被系统占用,
-- 采用 public 前缀与现有 auth_role_codes 等保持一致(可重复应用)
-- ============================================================

-- 调用者在指定租户的员工 id(无则 null)
create or replace function public.current_employee_id(p_tenant_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.id
  from public.employees e
  where e.tenant_id = p_tenant_id
    and e.user_id = auth.uid()
    and e.status = 'active'
  limit 1;
$$;

-- 是否指定租户成员(超管放行)
create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or exists (
      select 1 from public.tenant_memberships tm
      where tm.tenant_id = p_tenant_id
        and tm.user_id = auth.uid()
        and tm.status = 'active'
    );
$$;

-- 是否有权访问指定门店(超管放行;员工须有该店分配且未到期)
create or replace function public.can_access_store(p_tenant_id uuid, p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or exists (
      select 1
      from public.employee_store_assignments esa
      join public.employees e on e.id = esa.employee_id
      where esa.tenant_id = p_tenant_id
        and esa.store_id = p_store_id
        and e.user_id = auth.uid()
        and e.status = 'active'
        and (esa.ends_at is null or esa.ends_at > now())
    );
$$;

-- 调用者角色码集合:兼容新模型(employee_role_assignments)与旧模型(store_members),去重
create or replace function public.auth_role_codes()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct c), '{}')
  from (
    select r.code
    from public.employee_role_assignments era
    join public.roles r on r.id = era.role_id
    join public.employees e on e.id = era.employee_id
    where e.user_id = auth.uid() and e.status = 'active'
    union
    select r.code
    from public.store_members sm
    join public.roles r on r.id = sm.role_id
    where sm.user_id = auth.uid() and sm.status = 'active'
  ) t(c);
$$;

-- 是否具备权限码(超管放行;租户内角色权限集合包含该码)
create or replace function public.has_permission(p_tenant_id uuid, p_store_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or exists (
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
    );
$$;

-- 权限回收:仅 authenticated 可调用
revoke all on function public.current_employee_id(uuid) from public;
revoke all on function public.is_tenant_member(uuid) from public;
revoke all on function public.can_access_store(uuid, uuid) from public;
revoke all on function public.has_permission(uuid, uuid, text) from public;

grant execute on function public.current_employee_id(uuid) to authenticated;
grant execute on function public.is_tenant_member(uuid) to authenticated;
grant execute on function public.can_access_store(uuid, uuid) to authenticated;
grant execute on function public.has_permission(uuid, uuid, text) to authenticated;
