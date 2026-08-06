-- ============================================================
-- 0003_rbac.sql
-- 多租户 RBAC:角色 roles、店铺 stores、成员关系 store_members
-- 并扩展 profiles(real_name / phone / status)
-- 应用方式:Supabase SQL Editor 按编号顺序执行
-- ============================================================

-- 角色(可配置权限集合)
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,             -- system_admin / store_manager / staff / cashier ...
  name text not null,
  description text,
  permissions text[] not null default '{}',  -- 权限码集合,可配置
  is_system boolean not null default false,  -- 内置角色禁止删除
  created_at timestamptz not null default now()
);

-- 店铺(租户)
create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text unique,
  address text,
  phone text,
  status text not null default 'active',    -- active / disabled
  created_at timestamptz not null default now()
);

-- 成员关系:user ↔ store ↔ role(多对多,一人多店多角色)
create table if not exists public.store_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (user_id, store_id)
);

create index if not exists idx_store_members_user on public.store_members(user_id);
create index if not exists idx_store_members_store on public.store_members(store_id);

-- 扩展 profiles
alter table public.profiles
  add column if not exists real_name text,
  add column if not exists phone text,
  add column if not exists status text not null default 'active';
