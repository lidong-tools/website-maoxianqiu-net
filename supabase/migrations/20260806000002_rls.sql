-- ============================================================
-- 0002_rls.sql
-- Row Level Security:按表逐个审阅启用
-- 后端走用户级 anon client(携带用户 token),RLS 的 auth.uid() 生效
-- ============================================================

alter table public.profiles enable row level security;
alter table public.standard_module enable row level security;

-- profiles:用户只能读写自己的资料
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- standard_module:登录用户可读写(demo 阶段放开;上线前按角色收紧)
create policy "standard_module_all_authenticated" on public.standard_module
  for all to authenticated using (true) with check (true);
