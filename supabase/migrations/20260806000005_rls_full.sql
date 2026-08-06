-- ============================================================
-- 0004_rls_full.sql
-- 全量直连所需的 RLS:helper 函数 + 各表策略
-- 前端浏览器用 anon key 直连,RLS 是唯一数据边界
-- ============================================================

-- ===== helper 函数(security definer,按 auth.uid() 判定调用者角色) =====

-- 调用者的角色码集合(去重)
create or replace function public.auth_role_codes()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct r.code), '{}')
  from store_members sm
  join roles r on r.id = sm.role_id
  where sm.user_id = auth.uid() and sm.status = 'active';
$$;

-- 是否超管
create or replace function public.is_system_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select 'system_admin' = any (public.auth_role_codes());
$$;

-- 调用者作为店长所管理的店铺 id 集合
create or replace function public.managed_store_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct sm.store_id), '{}')
  from store_members sm
  join roles r on r.id = sm.role_id
  where sm.user_id = auth.uid() and sm.status = 'active' and r.code = 'store_manager';
$$;

-- 调用者能否管理某店铺(超管 ∨ 该店店长)
create or replace function public.can_manage_store(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin() or target = any (public.managed_store_ids());
$$;

-- 调用者能否管理某用户(超管 ∨ 目标用户在调用者管理的店铺有成员关系)
create or replace function public.can_manage_user(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or exists (
      select 1 from store_members tgt
      where tgt.user_id = public.can_manage_user.target
        and public.can_manage_store(tgt.store_id)
    );
$$;

-- ===== roles =====
drop policy if exists "roles_read_authenticated" on public.roles;
drop policy if exists "roles_read" on public.roles;
create policy "roles_read" on public.roles
  for select to authenticated using (true);

drop policy if exists "roles_insert" on public.roles;
create policy "roles_insert" on public.roles
  for insert to authenticated with check (public.is_system_admin());

drop policy if exists "roles_update" on public.roles;
create policy "roles_update" on public.roles
  for update to authenticated using (public.is_system_admin()) with check (public.is_system_admin());

drop policy if exists "roles_delete" on public.roles;
create policy "roles_delete" on public.roles
  for delete to authenticated using (public.is_system_admin() and not is_system);

-- ===== stores =====
drop policy if exists "stores_read_authenticated" on public.stores;
drop policy if exists "stores_read" on public.stores;
create policy "stores_read" on public.stores
  for select to authenticated using (true);

drop policy if exists "stores_insert" on public.stores;
create policy "stores_insert" on public.stores
  for insert to authenticated with check (public.is_system_admin());

drop policy if exists "stores_update" on public.stores;
create policy "stores_update" on public.stores
  for update to authenticated using (public.is_system_admin()) with check (public.is_system_admin());

drop policy if exists "stores_delete" on public.stores;
create policy "stores_delete" on public.stores
  for delete to authenticated using (public.is_system_admin());

-- ===== store_members =====
drop policy if exists "store_members_read_own" on public.store_members;
drop policy if exists "store_members_read" on public.store_members;
create policy "store_members_read" on public.store_members
  for select using (auth.uid() = user_id or public.can_manage_store(store_id));

drop policy if exists "store_members_insert" on public.store_members;
create policy "store_members_insert" on public.store_members
  for insert to authenticated with check (public.can_manage_store(store_id));

drop policy if exists "store_members_update" on public.store_members;
create policy "store_members_update" on public.store_members
  for update to authenticated using (public.can_manage_store(store_id)) with check (public.can_manage_store(store_id));

drop policy if exists "store_members_delete" on public.store_members;
create policy "store_members_delete" on public.store_members
  for delete to authenticated using (public.can_manage_store(store_id));

-- ===== profiles =====
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_read" on public.profiles;
create policy "profiles_read" on public.profiles
  for select using (auth.uid() = id or public.can_manage_user(id));

drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update using (auth.uid() = id or public.can_manage_user(id))
  with check (auth.uid() = id or public.can_manage_user(id));

-- standard_module 维持 0002 的 authenticated 读写,无需改动
