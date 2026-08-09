-- ============================================================
-- 20260810000250_purchase_request.sql
-- Agent-07 (Stage-04): 采购申请(Purchase Request)
--   - purchase_requests / purchase_request_items
--   - 状态机:draft → submitted → approved / rejected → converted_to_po;draft/submitted 可取消
--   - 批准后经 convert_purchase_request_to_po 复用现有 create_purchase_order
--     生成 PO 草稿(重复调用幂等,返回同一个 PO),并在 purchase_orders.source_request_id 溯源
--   - 写入一律走 service role RPC(状态机 + 行锁),禁止浏览器直连写;
--     select 开放浏览器直连(RLS 按 can_access_store)
--   - 权限码:purchase_request.view / create / submit / approve / convert
-- 幂等,可重复应用
-- ============================================================
set search_path = public;

-- 申请单号序列(PR + 日期 + 序号)
create sequence if not exists public.purchase_request_no_seq;

-- ===== 1. purchase_requests(采购申请头) =====
create table if not exists public.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  supplier_id uuid references public.suppliers(id) on delete restrict,   -- 可选:指定供应商
  request_no text not null,
  requester_id uuid references auth.users(id) on delete set null,       -- 申请人
  reason text,
  required_at date,
  status text not null default 'draft',
  version integer not null default 0,                                    -- 乐观并发版本(流转时递增)
  converted_po_id uuid,                                                  -- 转换生成的 PO(溯源)
  reject_reason text,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  rejected_by uuid references auth.users(id) on delete set null,
  rejected_at timestamptz,
  converted_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_requests_status_check check (
    status in ('draft', 'submitted', 'approved', 'rejected', 'converted_to_po', 'cancelled')
  )
);

create table if not exists public.purchase_request_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  purchase_request_id uuid not null references public.purchase_requests(id) on delete cascade,
  catalog_item_id uuid not null,                                          -- 商品 id,跨 migration 不加 FK
  requested_qty numeric not null default 0,
  unit text,
  estimated_unit_cost numeric(12,2) not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_request_items_qty_check check (requested_qty > 0)
);

create unique index if not exists idx_purchase_requests_tenant_no on public.purchase_requests (tenant_id, request_no);
create index if not exists idx_purchase_requests_tenant_status on public.purchase_requests (tenant_id, status, created_at desc);
create index if not exists idx_purchase_requests_store on public.purchase_requests (tenant_id, store_id);
create index if not exists idx_purchase_requests_requester on public.purchase_requests (tenant_id, requester_id);
create index if not exists idx_pr_items_request on public.purchase_request_items (purchase_request_id);

drop trigger if exists trg_purchase_requests_updated_at on public.purchase_requests;
create trigger trg_purchase_requests_updated_at
  before update on public.purchase_requests
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_purchase_request_items_updated_at on public.purchase_request_items;
create trigger trg_purchase_request_items_updated_at
  before update on public.purchase_request_items
  for each row execute procedure public.touch_updated_at();

-- purchase_orders 增加申请溯源列(前向迁移,不改动历史 migration 文件)
alter table public.purchase_orders add column if not exists source_request_id uuid;

-- ===== 2. RLS(仅读开放;写入 service role) =====
alter table public.purchase_requests enable row level security;
alter table public.purchase_request_items enable row level security;

drop policy if exists "purchase_requests_select" on public.purchase_requests;
create policy "purchase_requests_select" on public.purchase_requests
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "purchase_request_items_select" on public.purchase_request_items;
create policy "purchase_request_items_select" on public.purchase_request_items
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.purchase_requests pr
      where pr.id = purchase_request_items.purchase_request_id
        and public.can_access_store(pr.tenant_id, pr.store_id)
    )
  );

-- ===== 3. 权限码 =====
insert into public.permissions (code, name, module) values
  ('purchase_request.view', '查看采购申请', 'inventory'),
  ('purchase_request.create', '新建采购申请', 'inventory'),
  ('purchase_request.submit', '提交采购申请', 'inventory'),
  ('purchase_request.approve', '审核采购申请', 'inventory'),
  ('purchase_request.convert', '转采购单', 'inventory')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'store_manager')
  and p.code in (
    'purchase_request.view', 'purchase_request.create', 'purchase_request.submit',
    'purchase_request.approve', 'purchase_request.convert'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'purchase_request.view', 'purchase_request.create', 'purchase_request.submit',
    'purchase_request.approve', 'purchase_request.convert'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;

-- ===== 4. 创建申请草稿 =====
-- p_items: [{catalog_item_id, requested_qty, unit, estimated_unit_cost, note}]
create or replace function public.create_purchase_request(
  p_tenant_id uuid,
  p_store_id uuid,
  p_warehouse_id uuid,
  p_supplier_id uuid default null,
  p_requester_id uuid default null,
  p_reason text default null,
  p_required_at date default null,
  p_items jsonb default '[]'::jsonb,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_count integer;
  v_wh_count integer;
  v_supplier_count integer;
  v_req public.purchase_requests;
  v_item record;
  v_catalog_count integer;
  v_total numeric(12,2) := 0;
  v_items_json jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  select count(*) into v_store_count
  from public.stores where id = p_store_id and tenant_id = p_tenant_id and archived_at is null;
  if v_store_count = 0 then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 仓库必须属于目标 store 且启用
  select count(*) into v_wh_count
  from public.warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id and store_id = p_store_id and is_active = true;
  if v_wh_count = 0 then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_supplier_id is not null then
    select count(*) into v_supplier_count
    from public.suppliers where id = p_supplier_id and tenant_id = p_tenant_id and status = 'active';
    if v_supplier_count = 0 then
      raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  -- 明细 catalog_item 必须属于目标 tenant
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    select count(*) into v_catalog_count
    from public.catalog_items
    where id = (v_item.item->>'catalog_item_id')::uuid and tenant_id = p_tenant_id;
    if v_catalog_count = 0 then
      raise exception 'CATALOG_ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;
  end loop;

  insert into public.purchase_requests (
    tenant_id, store_id, warehouse_id, supplier_id, request_no, requester_id, reason, required_at, status, created_by
  )
  values (
    p_tenant_id, p_store_id, p_warehouse_id, p_supplier_id,
    'PR' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.purchase_request_no_seq')::text, 4, '0'),
    p_requester_id, p_reason, p_required_at, 'draft', p_operator_id
  )
  returning * into v_req;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    declare
      v_qty numeric := (v_item.item->>'requested_qty')::numeric;
      v_cost numeric := (v_item.item->>'estimated_unit_cost')::numeric;
    begin
      if v_qty is null or v_qty <= 0 then
        raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
      end if;
      insert into public.purchase_request_items (
        tenant_id, purchase_request_id, catalog_item_id, requested_qty, unit, estimated_unit_cost, note
      )
      values (
        p_tenant_id, v_req.id, (v_item.item->>'catalog_item_id')::uuid, v_qty,
        (v_item.item->>'unit')::text, coalesce(v_cost, 0),
        (v_item.item->>'note')::text
      );
      v_total := v_total + v_qty * coalesce(v_cost, 0);
    end;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', it.id,
    'catalogItemId', it.catalog_item_id,
    'requestedQty', it.requested_qty,
    'unit', it.unit,
    'estimatedUnitCost', it.estimated_unit_cost,
    'note', it.note
  )), '[]'::jsonb) into v_items_json
  from public.purchase_request_items it where it.purchase_request_id = v_req.id;

  return jsonb_build_object(
    'id', v_req.id,
    'tenantId', v_req.tenant_id,
    'storeId', v_req.store_id,
    'warehouseId', v_req.warehouse_id,
    'supplierId', v_req.supplier_id,
    'requestNo', v_req.request_no,
    'requesterId', v_req.requester_id,
    'requiredAt', v_req.required_at,
    'status', v_req.status,
    'version', v_req.version,
    'estimatedTotal', v_total,
    'items', v_items_json
  );
end;
$$;

-- ===== 5. 编辑草稿(仅 draft,替换全部明细) =====
create or replace function public.update_purchase_request_draft(
  p_tenant_id uuid,
  p_request_id uuid,
  p_warehouse_id uuid,
  p_supplier_id uuid default null,
  p_requester_id uuid default null,
  p_reason text default null,
  p_required_at date default null,
  p_items jsonb default '[]'::jsonb,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.purchase_requests;
  v_wh_count integer;
  v_supplier_count integer;
  v_item record;
  v_catalog_count integer;
  v_total numeric(12,2) := 0;
  v_items_json jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  select * into v_req from public.purchase_requests
  where id = p_request_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_req.status <> 'draft' then
    raise exception 'NOT_DRAFT' using errcode = 'P0003';
  end if;

  select count(*) into v_wh_count
  from public.warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id and store_id = v_req.store_id and is_active = true;
  if v_wh_count = 0 then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_supplier_id is not null then
    select count(*) into v_supplier_count
    from public.suppliers where id = p_supplier_id and tenant_id = p_tenant_id and status = 'active';
    if v_supplier_count = 0 then
      raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    select count(*) into v_catalog_count
    from public.catalog_items
    where id = (v_item.item->>'catalog_item_id')::uuid and tenant_id = p_tenant_id;
    if v_catalog_count = 0 then
      raise exception 'CATALOG_ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;
  end loop;

  delete from public.purchase_request_items where purchase_request_id = p_request_id;
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    declare
      v_qty numeric := (v_item.item->>'requested_qty')::numeric;
      v_cost numeric := (v_item.item->>'estimated_unit_cost')::numeric;
    begin
      if v_qty is null or v_qty <= 0 then
        raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
      end if;
      insert into public.purchase_request_items (
        tenant_id, purchase_request_id, catalog_item_id, requested_qty, unit, estimated_unit_cost, note
      )
      values (
        p_tenant_id, p_request_id, (v_item.item->>'catalog_item_id')::uuid, v_qty,
        (v_item.item->>'unit')::text, coalesce(v_cost, 0),
        (v_item.item->>'note')::text
      );
      v_total := v_total + v_qty * coalesce(v_cost, 0);
    end;
  end loop;

  update public.purchase_requests
  set warehouse_id = p_warehouse_id, supplier_id = p_supplier_id, requester_id = p_requester_id,
      reason = p_reason, required_at = p_required_at, updated_at = now()
  where id = p_request_id
  returning * into v_req;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', it.id,
    'catalogItemId', it.catalog_item_id,
    'requestedQty', it.requested_qty,
    'unit', it.unit,
    'estimatedUnitCost', it.estimated_unit_cost,
    'note', it.note
  )), '[]'::jsonb) into v_items_json
  from public.purchase_request_items it where it.purchase_request_id = p_request_id;

  return jsonb_build_object(
    'id', v_req.id,
    'tenantId', v_req.tenant_id,
    'storeId', v_req.store_id,
    'warehouseId', v_req.warehouse_id,
    'supplierId', v_req.supplier_id,
    'requestNo', v_req.request_no,
    'requesterId', v_req.requester_id,
    'requiredAt', v_req.required_at,
    'status', v_req.status,
    'version', v_req.version,
    'estimatedTotal', v_total,
    'items', v_items_json
  );
end;
$$;

-- ===== 6. 提交(draft → submitted) =====
create or replace function public.submit_purchase_request(
  p_tenant_id uuid,
  p_request_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.purchase_requests;
  v_item_count integer;
begin
  select * into v_req from public.purchase_requests
  where id = p_request_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_req.status <> 'draft' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  select count(*) into v_item_count
  from public.purchase_request_items where purchase_request_id = p_request_id and requested_qty > 0;
  if v_item_count = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  update public.purchase_requests
  set status = 'submitted', submitted_by = p_operator_id, submitted_at = now(), version = version + 1
  where id = p_request_id
  returning * into v_req;

  return jsonb_build_object('id', v_req.id, 'status', v_req.status, 'submittedAt', v_req.submitted_at, 'version', v_req.version);
end;
$$;

-- ===== 7. 审核(submitted → approved;禁止自审) =====
create or replace function public.approve_purchase_request(
  p_tenant_id uuid,
  p_request_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.purchase_requests;
begin
  select * into v_req from public.purchase_requests
  where id = p_request_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_req.status <> 'submitted' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;
  if p_operator_id is not null and v_req.requester_id = p_operator_id then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0003';
  end if;

  update public.purchase_requests
  set status = 'approved', approved_by = p_operator_id, approved_at = now(), version = version + 1
  where id = p_request_id
  returning * into v_req;

  return jsonb_build_object('id', v_req.id, 'status', v_req.status, 'approvedAt', v_req.approved_at, 'version', v_req.version);
end;
$$;

-- ===== 8. 驳回(submitted → rejected) =====
create or replace function public.reject_purchase_request(
  p_tenant_id uuid,
  p_request_id uuid,
  p_reject_reason text default null,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.purchase_requests;
begin
  select * into v_req from public.purchase_requests
  where id = p_request_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_req.status <> 'submitted' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  update public.purchase_requests
  set status = 'rejected', reject_reason = p_reject_reason, rejected_by = p_operator_id,
      rejected_at = now(), version = version + 1
  where id = p_request_id
  returning * into v_req;

  return jsonb_build_object('id', v_req.id, 'status', v_req.status, 'rejectedAt', v_req.rejected_at, 'rejectReason', v_req.reject_reason);
end;
$$;

-- ===== 9. 取消(draft / submitted → cancelled) =====
create or replace function public.cancel_purchase_request(
  p_tenant_id uuid,
  p_request_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.purchase_requests;
begin
  select * into v_req from public.purchase_requests
  where id = p_request_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_req.status not in ('draft', 'submitted') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  update public.purchase_requests
  set status = 'cancelled', cancelled_by = p_operator_id, cancelled_at = now(), version = version + 1
  where id = p_request_id
  returning * into v_req;

  return jsonb_build_object('id', v_req.id, 'status', v_req.status, 'cancelledAt', v_req.cancelled_at);
end;
$$;

-- ===== 10. 转采购单(approved → converted_to_po;幂等) =====
-- 复用 create_purchase_order 生成 PO 草稿;重复调用返回同一个 PO
create or replace function public.convert_purchase_request_to_po(
  p_tenant_id uuid,
  p_request_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.purchase_requests;
  v_supplier_count integer;
  v_po_result jsonb;
  v_items_json jsonb := '[]'::jsonb;
  v_po_id uuid;
begin
  select * into v_req from public.purchase_requests
  where id = p_request_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 幂等:已转换则返回既有 PO
  if v_req.status = 'converted_to_po' and v_req.converted_po_id is not null then
    return jsonb_build_object(
      'requestId', v_req.id,
      'requestNo', v_req.request_no,
      'poId', v_req.converted_po_id,
      'poNo', (select po_no from public.purchase_orders where id = v_req.converted_po_id),
      'status', 'converted_to_po',
      'idempotent', true
    );
  end if;
  if v_req.status <> 'approved' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  -- 转换必须指定供应商
  if v_req.supplier_id is null then
    raise exception 'SUPPLIER_REQUIRED_FOR_CONVERT' using errcode = 'P0003';
  end if;
  select count(*) into v_supplier_count
  from public.suppliers where id = v_req.supplier_id and tenant_id = p_tenant_id and status = 'active';
  if v_supplier_count = 0 then
    raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'catalog_item_id', it.catalog_item_id,
    'ordered_qty', it.requested_qty,
    'unit_cost', it.estimated_unit_cost
  )), '[]'::jsonb) into v_items_json
  from public.purchase_request_items it where it.purchase_request_id = p_request_id;
  if jsonb_array_length(v_items_json) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  -- 复用既有采购领域创建 PO 草稿
  v_po_result := public.create_purchase_order(
    p_tenant_id,
    v_req.store_id,
    v_req.warehouse_id,
    v_req.supplier_id,
    v_req.required_at,
    '源自采购申请 ' || v_req.request_no || coalesce('：' || v_req.reason, ''),
    v_items_json,
    p_operator_id
  );
  v_po_id := (v_po_result->>'id')::uuid;

  -- 写申请溯源,标记已转换
  update public.purchase_orders set source_request_id = p_request_id where id = v_po_id;
  update public.purchase_requests
  set status = 'converted_to_po', converted_po_id = v_po_id, converted_at = now(), version = version + 1
  where id = p_request_id
  returning * into v_req;

  return jsonb_build_object(
    'requestId', v_req.id,
    'requestNo', v_req.request_no,
    'poId', v_po_id,
    'poNo', v_po_result->>'poNo',
    'status', v_req.status,
    'idempotent', false
  );
end;
$$;

-- ===== 11. service-role-only 授权(自包含,幂等) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'create_purchase_request', 'update_purchase_request_draft', 'submit_purchase_request',
    'approve_purchase_request', 'reject_purchase_request', 'cancel_purchase_request',
    'convert_purchase_request_to_po'
  ]
  loop
    for v_sig in
      select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_fn
        and p.prokind = 'f'
    loop
      execute format('revoke all on function %s from public', v_sig);
      execute format('revoke all on function %s from anon', v_sig);
      execute format('revoke all on function %s from authenticated', v_sig);
      execute format('grant execute on function %s to service_role', v_sig);
    end loop;
  end loop;
end;
$$;
