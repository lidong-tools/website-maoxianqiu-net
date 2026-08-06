-- ============================================================
-- 20260806000012_tenant_rls_policies.sql
-- MXQ-3006 配套:组织表 RLS 策略(基于 tenant/store helper)
-- 原则:
--   - 跨租户不可读/写:所有策略先校验 is_tenant_member(tenant_id)
--   - 无权门店不可读/写:门店级表校验 can_access_store / store 范围
--   - 系统级目录(permissions/role_permissions)仅可读
--   - audit_logs / idempotency_records 默认拒绝(service role 写入)
-- ============================================================

-- ===== tenants =====
drop policy if exists "tenants_select_member" on public.tenants;
create policy "tenants_select_member" on public.tenants
  for select to authenticated using (public.is_tenant_member(id));

drop policy if exists "tenants_admin_write" on public.tenants;
create policy "tenants_admin_write" on public.tenants
  for all to authenticated
  using (public.is_system_admin())
  with check (public.is_system_admin());

-- ===== tenant_memberships =====
drop policy if exists "tenant_memberships_select" on public.tenant_memberships;
create policy "tenant_memberships_select" on public.tenant_memberships
  for select to authenticated
  using (auth.uid() = user_id or public.is_tenant_member(tenant_id));

drop policy if exists "tenant_memberships_insert" on public.tenant_memberships;
create policy "tenant_memberships_insert" on public.tenant_memberships
  for insert to authenticated
  with check (public.is_system_admin() or public.has_permission(tenant_id, null, 'tenant.membership.create'));

drop policy if exists "tenant_memberships_update" on public.tenant_memberships;
create policy "tenant_memberships_update" on public.tenant_memberships
  for update to authenticated
  using (public.is_system_admin() or public.has_permission(tenant_id, null, 'tenant.membership.update'))
  with check (public.is_system_admin() or public.has_permission(tenant_id, null, 'tenant.membership.update'));

-- ===== employees =====
drop policy if exists "employees_select" on public.employees;
create policy "employees_select" on public.employees
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "employees_insert" on public.employees;
create policy "employees_insert" on public.employees
  for insert to authenticated
  with check (public.is_system_admin() or public.has_permission(tenant_id, null, 'employee.create'));

drop policy if exists "employees_update" on public.employees;
create policy "employees_update" on public.employees
  for update to authenticated
  using (public.is_system_admin() or public.has_permission(tenant_id, null, 'employee.update'))
  with check (public.is_system_admin() or public.has_permission(tenant_id, null, 'employee.update'));

-- ===== employee_store_assignments(门店级敏感数据:仅可访问该店的用户可见) =====
drop policy if exists "esa_select" on public.employee_store_assignments;
create policy "esa_select" on public.employee_store_assignments
  for select to authenticated
  using (public.can_access_store(tenant_id, store_id));

drop policy if exists "esa_write" on public.employee_store_assignments;
create policy "esa_write" on public.employee_store_assignments
  for all to authenticated
  using (public.is_system_admin() or public.has_permission(tenant_id, null, 'employee.assignStore'))
  with check (public.is_system_admin() or public.has_permission(tenant_id, null, 'employee.assignStore'));

-- ===== roles(租户化:系统模板可读;租户角色仅本租户成员可见) =====
drop policy if exists "roles_read_authenticated" on public.roles;
drop policy if exists "roles_read" on public.roles;
drop policy if exists "roles_tenant_read" on public.roles;
create policy "roles_tenant_read" on public.roles
  for select to authenticated
  using (public.is_system_admin() or tenant_id is null or public.is_tenant_member(tenant_id));

drop policy if exists "roles_insert" on public.roles;
create policy "roles_insert" on public.roles
  for insert to authenticated
  with check (public.is_system_admin() or (tenant_id is not null and public.has_permission(tenant_id, null, 'role.create')));

drop policy if exists "roles_update" on public.roles;
create policy "roles_update" on public.roles
  for update to authenticated
  using (public.is_system_admin() or (tenant_id is not null and public.has_permission(tenant_id, null, 'role.update')))
  with check (public.is_system_admin() or (tenant_id is not null and public.has_permission(tenant_id, null, 'role.update')));

drop policy if exists "roles_delete" on public.roles;
create policy "roles_delete" on public.roles
  for delete to authenticated
  using (public.is_system_admin() and not is_system);

-- ===== stores(仅本租户可见;超管全量) =====
drop policy if exists "stores_read" on public.stores;
drop policy if exists "stores_read_authenticated" on public.stores;
create policy "stores_tenant_read" on public.stores
  for select to authenticated
  using (public.is_system_admin() or public.is_tenant_member(tenant_id));

drop policy if exists "stores_insert" on public.stores;
create policy "stores_insert" on public.stores
  for insert to authenticated
  with check (public.is_system_admin() or (tenant_id is not null and public.has_permission(tenant_id, null, 'store.create')));

drop policy if exists "stores_update" on public.stores;
create policy "stores_update" on public.stores
  for update to authenticated
  using (public.is_system_admin() or (tenant_id is not null and public.has_permission(tenant_id, null, 'store.update')))
  with check (public.is_system_admin() or (tenant_id is not null and public.has_permission(tenant_id, null, 'store.update')));

drop policy if exists "stores_delete" on public.stores;
create policy "stores_delete" on public.stores
  for delete to authenticated
  using (public.is_system_admin());

-- ===== permissions / role_permissions(系统目录,只读) =====
drop policy if exists "permissions_read" on public.permissions;
create policy "permissions_read" on public.permissions
  for select to authenticated using (true);

drop policy if exists "role_permissions_read" on public.role_permissions;
create policy "role_permissions_read" on public.role_permissions
  for select to authenticated using (true);

-- ===== employee_role_assignments =====
drop policy if exists "era_select" on public.employee_role_assignments;
create policy "era_select" on public.employee_role_assignments
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "era_write" on public.employee_role_assignments;
create policy "era_write" on public.employee_role_assignments
  for all to authenticated
  using (public.is_system_admin() or public.has_permission(tenant_id, null, 'employee.changeRole'))
  with check (public.is_system_admin() or public.has_permission(tenant_id, null, 'employee.changeRole'));

-- ===== audit_logs:普通角色不可读/改/删,仅 service role 写入 =====
-- 超管可读审计(审计后台)
drop policy if exists "audit_logs_select_admin" on public.audit_logs;
create policy "audit_logs_select_admin" on public.audit_logs
  for select to authenticated using (public.is_system_admin());

-- ===== idempotency_records:全部拒绝(仅 service role) =====
-- 不加任何策略即默认拒绝
