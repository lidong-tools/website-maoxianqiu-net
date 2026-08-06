-- ============================================================
-- 0001_init.sql
-- 核心表:profiles(用户资料 + 权限)、standard_module(标准模块示例)
-- 应用方式:Supabase SQL Editor 按编号顺序执行
-- ============================================================

create extension if not exists "pgcrypto";

-- 用户资料:注册后由下方触发器自动创建
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  account text unique,
  avatar text,
  permissions text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_profiles_account on public.profiles(account);

-- 标准模块示例表(对应前端 standard_module_example)
create table if not exists public.standard_module (
  id bigserial primary key,
  title text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_standard_module_title on public.standard_module(title);

-- 新用户注册 → 自动创建 profiles
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, account, avatar)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'account', new.email),
    new.raw_user_meta_data ->> 'avatar'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
