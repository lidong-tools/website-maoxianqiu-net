-- ============================================================
-- 20260810000066_purchase_orders.sql
-- Agent-05: 采购订单 header + items
--   - purchase_orders(门店级)/ purchase_order_items
--   - 状态机:draft → submitted → approved → received → posted;draft/submitted 可取消
--   - 写入一律走 service role RPC(状态机 + 幂等),禁止浏览器直连写;
--   - select 开放浏览器直连(RLS 按 can_access_store)
--   - 权限码:purchase.view / create / submit / approve / receive / post
-- 幂等,可重复应用
-- ============================================================

-- 采购单号序列(PO + 日期 + 序号)
create sequence if not exists public.purchase_order_no_seq;

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  po_no text not null,
  supplier_id uuid references public.suppliers(id) on delete restrict,
  status text not null default 'draft',
  expected_at date,
  total_cost numeric(12,2) not null default 0,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  received_by uuid references auth.users(id) on delete set null,
  received_at timestamptz,
  posted_by uuid references auth.users(id) on delete set null,
  posted_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_orders_status_check check (
    status in ('draft', 'submitted', 'approved', 'received', 'posted', 'cancelled')
  )
);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  catalog_item_id uuid not null,
  ordered_qty numeric not null default 0,
  received_qty numeric not null default 0,
  unit_cost numeric(12,2) not null default 0,
  batch_no text,
  expires_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_order_items_qty_check check (ordered_qty > 0 and received_qty >= 0 and received_qty <= ordered_qty)
);

create unique index if not exists idx_purchase_orders_tenant_no on public.purchase_orders (tenant_id, po_no);
create index if not exists idx_purchase_orders_tenant_status on public.purchase_orders (tenant_id, status, created_at desc);
create index if not exists idx_purchase_orders_store on public.purchase_orders (tenant_id, store_id);
create index if not exists idx_purchase_orders_supplier on public.purchase_orders (tenant_id, supplier_id);
create index if not exists idx_po_items_po on public.purchase_order_items (purchase_order_id);

drop trigger if exists trg_purchase_orders_updated_at on public.purchase_orders;
create trigger trg_purchase_orders_updated_at
  before update on public.purchase_orders
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_purchase_order_items_updated_at on public.purchase_order_items;
create trigger trg_purchase_order_items_updated_at
  before update on public.purchase_order_items
  for each row execute procedure public.touch_updated_at();

-- ===== RLS =====
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;

-- 门店级数据:租户成员 + 门店访问
drop policy if exists "purchase_orders_select" on public.purchase_orders;
create policy "purchase_orders_select" on public.purchase_orders
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "purchase_order_items_select" on public.purchase_order_items;
create policy "purchase_order_items_select" on public.purchase_order_items
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_order_items.purchase_order_id
        and public.can_access_store(po.tenant_id, po.store_id)
    )
  );

-- 写入只允许 service role RPC;不建 insert/update/delete 策略

-- ===== 权限码 =====
insert into public.permissions (code, name, module) values
  ('purchase.view', '查看采购单', 'inventory'),
  ('purchase.create', '新建采购单', 'inventory'),
  ('purchase.submit', '提交采购单', 'inventory'),
  ('purchase.approve', '审核采购单', 'inventory'),
  ('purchase.receive', '采购收货', 'inventory'),
  ('purchase.post', '采购过账', 'inventory')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin / store_manager 授予全部采购权限(幂等;现有角色,不新增角色)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'store_manager')
  and p.code in (
    'purchase.view', 'purchase.create', 'purchase.submit',
    'purchase.approve', 'purchase.receive', 'purchase.post'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(RLS has_permission 读取该数组)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'purchase.view', 'purchase.create', 'purchase.submit',
    'purchase.approve', 'purchase.receive', 'purchase.post'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;
