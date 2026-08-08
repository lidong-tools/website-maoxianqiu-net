-- ============================================================
-- 20260810000065_suppliers.sql
-- Agent-05: 供应商主数据(suppliers,租户级)
--   - 仅 select 开放浏览器直连(RLS 按 is_tenant_member);
--   - 写入一律走 Hono Command(service role)+ audit_logs,禁止浏览器直连写;
--   - 权限码:supplier.view / supplier.manage
-- 幂等,可重复应用
-- ============================================================

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  supplier_no text not null,
  name text not null,
  contact_name text,
  phone text,
  address text,
  unified_credit_code text,
  payment_terms text,
  status text not null default 'active',
  categories text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint suppliers_status_check check (status in ('active', 'inactive'))
);

-- 同租户下供应商编码唯一(应用层生成,唯一索引兜底)
create unique index if not exists idx_suppliers_tenant_no on public.suppliers (tenant_id, supplier_no);
create index if not exists idx_suppliers_tenant on public.suppliers (tenant_id);

drop trigger if exists trg_suppliers_updated_at on public.suppliers;
create trigger trg_suppliers_updated_at
  before update on public.suppliers
  for each row execute procedure public.touch_updated_at();

-- ===== RLS =====
alter table public.suppliers enable row level security;

-- 供应商为租户级主数据:租户成员可读
drop policy if exists "suppliers_select" on public.suppliers;
create policy "suppliers_select" on public.suppliers
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- 写入只允许 service role(经 Hono Command + 审计);不建 insert/update/delete 策略

-- ===== 权限码 =====
insert into public.permissions (code, name, module) values
  ('supplier.view', '查看供应商', 'inventory'),
  ('supplier.manage', '管理供应商', 'inventory')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin / store_manager 授予(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'store_manager')
  and p.code in ('supplier.view', 'supplier.manage')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(RLS has_permission 读取该数组)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array['supplier.view', 'supplier.manage'])
)
where code in ('system_admin', 'store_manager') and is_system = true;
