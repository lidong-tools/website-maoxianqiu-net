-- ============================================================
-- 0003_rls.sql
-- RBAC 表 RLS:成员关系用户可读自己的;管理类操作由后端代码级校验 + service role
-- ============================================================

alter table public.roles enable row level security;
alter table public.stores enable row level security;
alter table public.store_members enable row level security;

-- roles:登录用户可读(角色下拉需要),变更走后端 service role
create policy "roles_read_authenticated" on public.roles
  for select to authenticated using (true);

-- stores:登录用户可读(店铺下拉需要),变更走后端 service role
create policy "stores_read_authenticated" on public.stores
  for select to authenticated using (true);

-- store_members:用户可读自己的成员记录
create policy "store_members_read_own" on public.store_members
  for select using (auth.uid() = user_id);
