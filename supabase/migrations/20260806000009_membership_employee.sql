-- ============================================================
-- 20260806000009_membership_employee.sql
-- MXQ-3003 memberships / employees / store assignment
-- MXQ-3004 roles/permissions 目录 + 角色分配
-- 附加:audit_logs / idempotency_records(API Foundation 依赖)
-- 幂等,可重复应用
-- ============================================================

-- 用户↔租户成员关系
create table if not exists public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active',      -- active / invited / suspended / left
  joined_at timestamptz not null default now(),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

-- 员工档案
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  employee_no text not null,
  name text not null,
  phone text,
  email text,
  title text,
  status text not null default 'active',      -- active / invited / disabled / resigned
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, employee_no)
);

create index if not exists idx_employees_user on public.employees (user_id);
create index if not exists idx_employees_tenant on public.employees (tenant_id);

-- 员工门店分配(一个员工可在多个门店)
create table if not exists public.employee_store_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  is_primary boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  unique (employee_id, store_id)
);

create index if not exists idx_esa_employee on public.employee_store_assignments (employee_id);
create index if not exists idx_esa_store on public.employee_store_assignments (store_id);
create index if not exists idx_esa_tenant on public.employee_store_assignments (tenant_id);

-- roles 扩展租户作用域
alter table public.roles
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade,
  add column if not exists scope text not null default 'system';   -- system / tenant / store

-- 权限目录(系统级,code 唯一)
create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  module text not null default '',
  created_at timestamptz not null default now()
);

-- 角色↔权限
create table if not exists public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- 员工角色分配(store_id 为空表示租户级)
create table if not exists public.employee_role_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  store_id uuid references public.stores(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists idx_era_employee on public.employee_role_assignments (employee_id);
create index if not exists idx_era_tenant on public.employee_role_assignments (tenant_id);

-- 审计日志(只追加,普通角色不可读/改/删;service role 绕过 RLS 写入)
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  store_id uuid references public.stores(id),
  user_id uuid references auth.users(id),
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}',
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_tenant_time on public.audit_logs (tenant_id, created_at desc);
create index if not exists idx_audit_logs_entity on public.audit_logs (entity_type, entity_id);

-- 幂等记录(唯一约束 (tenant_id, idempotency_key))
create table if not exists public.idempotency_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  idempotency_key text not null,
  action text not null,
  entity_type text,
  entity_id text,
  result_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

-- RLS
alter table public.tenant_memberships enable row level security;
alter table public.employees enable row level security;
alter table public.employee_store_assignments enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.employee_role_assignments enable row level security;
alter table public.audit_logs enable row level security;
alter table public.idempotency_records enable row level security;
