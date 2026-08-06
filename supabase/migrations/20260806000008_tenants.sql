-- ============================================================
-- 20260806000008_tenants.sql
-- MXQ-3001 tenants 表
-- MXQ-3002 stores.tenant_id + 归档字段
-- 幂等,可重复应用
-- ============================================================

-- 租户
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  short_name text,
  logo_file_id uuid,
  timezone text not null default 'Asia/Shanghai',
  currency text not null default 'CNY',
  locale text not null default 'zh-CN',
  status text not null default 'active',      -- active / trial / suspended
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- stores 增加 tenant_id 与归档字段
alter table public.stores
  add column if not exists tenant_id uuid references public.tenants(id) on delete restrict,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id);

-- 默认租户(用于现有数据回填,不参与业务)
insert into public.tenants (slug, name, short_name)
values ('default', '默认租户', '默认')
on conflict (slug) do nothing;

-- 现有 stores 回填到默认租户
update public.stores
set tenant_id = (select id from public.tenants where slug = 'default')
where tenant_id is null;

-- 回填后强制非空
alter table public.stores alter column tenant_id set not null;

-- 租户内店铺 code 唯一
create unique index if not exists idx_stores_tenant_code
  on public.stores (tenant_id, code)
  where archived_at is null;

create index if not exists idx_stores_tenant_id on public.stores (tenant_id);
create index if not exists idx_stores_archived on public.stores (tenant_id, archived_at);

-- RLS
alter table public.tenants enable row level security;
