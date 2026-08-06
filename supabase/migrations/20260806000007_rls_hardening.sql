-- ============================================================
-- 20260806000007_rls_hardening.sql
-- 审计修复:
--   F1(严重) 店长可通过 store_members 把成员(或自己)提升为 system_admin → 越权
--   F2(高危) standard_module 允许任意登录用户全量 CRUD → 收紧为需有门店角色
-- ============================================================

-- ===== F1:store_members 角色不可越权到 system_admin =====
drop policy if exists "store_members_insert" on public.store_members;
create policy "store_members_insert" on public.store_members
  for insert to authenticated
  with check (
    public.can_manage_store(store_id)
    and (
      public.is_system_admin()
      or not exists (
        select 1 from public.roles r
        where r.id = store_members.role_id and r.code = 'system_admin'
      )
    )
  );

drop policy if exists "store_members_update" on public.store_members;
create policy "store_members_update" on public.store_members
  for update to authenticated
  using (public.can_manage_store(store_id))
  with check (
    public.can_manage_store(store_id)
    and (
      public.is_system_admin()
      or not exists (
        select 1 from public.roles r
        where r.id = store_members.role_id and r.code = 'system_admin'
      )
    )
  );

-- ===== F2:standard_module 需有门店角色才可读写 =====
drop policy if exists "standard_module_all_authenticated" on public.standard_module;
create policy "standard_module_all_authenticated" on public.standard_module
  for all to authenticated
  using (public.auth_role_codes() <> '{}')
  with check (public.auth_role_codes() <> '{}');
