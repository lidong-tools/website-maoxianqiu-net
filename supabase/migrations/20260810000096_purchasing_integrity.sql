-- ============================================================
-- 20260810000096_purchasing_integrity.sql
-- Agent-07 二轮收口(P0-17A / P0-17B):采购完整性
--
-- 修复:
-- 1. create_purchase_order / update_purchase_order_draft:
--      - warehouse 必须属于目标 store(warehouse.store_id = p_store_id);
--      - 每条 catalog_item_id 必须属于目标 tenant(禁止跨租户引用);
--      - update_draft 用 PO 已存 store_id 重新校验,不假定创建时合法即永远合法。
-- 2. approve_purchase_order: 禁止自审(submitted_by = approved_by 拒绝)。
-- 3. receive_purchase_order: 部分收货不再直接关闭整单——
--      全部明细收齐 → received;未收齐 → partially_received(仍可继续收货)。
-- 4. purchase_orders 状态约束新增 partially_received。
-- ============================================================

-- ===== 0. PO 状态约束增加 partially_received =====
alter table public.purchase_orders drop constraint if exists purchase_orders_status_check;
alter table public.purchase_orders add constraint purchase_orders_status_check check (
  status in ('draft', 'submitted', 'approved', 'received', 'partially_received', 'posted', 'cancelled')
);

-- ===== 1. create_purchase_order =====
create or replace function public.create_purchase_order(
  p_tenant_id uuid,
  p_store_id uuid,
  p_warehouse_id uuid,
  p_supplier_id uuid,
  p_expected_at date default null,
  p_note text default null,
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
  v_po public.purchase_orders;
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

  -- P0-17A:仓库必须属于目标 store
  select count(*) into v_wh_count
  from public.warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id and store_id = p_store_id and is_active = true;
  if v_wh_count = 0 then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select count(*) into v_supplier_count
  from public.suppliers where id = p_supplier_id and tenant_id = p_tenant_id and status = 'active';
  if v_supplier_count = 0 then
    raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- P0-17A:明细 catalog_item 必须属于目标 tenant
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    select count(*) into v_catalog_count
    from public.catalog_items
    where id = (v_item.item->>'catalog_item_id')::uuid and tenant_id = p_tenant_id;
    if v_catalog_count = 0 then
      raise exception 'CATALOG_ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;
  end loop;

  insert into public.purchase_orders (
    tenant_id, store_id, warehouse_id, po_no, supplier_id, status, expected_at, total_cost, note, created_by
  )
  values (
    p_tenant_id, p_store_id, p_warehouse_id,
    'PO' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.purchase_order_no_seq')::text, 4, '0'),
    p_supplier_id, 'draft', p_expected_at, 0, p_note, p_operator_id
  )
  returning * into v_po;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    declare
      v_qty numeric := (v_item.item->>'ordered_qty')::numeric;
      v_cost numeric := (v_item.item->>'unit_cost')::numeric;
    begin
      if v_qty is null or v_qty <= 0 then
        raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
      end if;
      insert into public.purchase_order_items (
        tenant_id, purchase_order_id, catalog_item_id, ordered_qty, received_qty, unit_cost
      )
      values (p_tenant_id, v_po.id, (v_item.item->>'catalog_item_id')::uuid, v_qty, 0, coalesce(v_cost, 0));
      v_total := v_total + v_qty * coalesce(v_cost, 0);
    end;
  end loop;

  update public.purchase_orders set total_cost = v_total where id = v_po.id returning * into v_po;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', it.id,
    'catalogItemId', it.catalog_item_id,
    'orderedQty', it.ordered_qty,
    'receivedQty', it.received_qty,
    'unitCost', it.unit_cost,
    'batchNo', it.batch_no,
    'expiresAt', it.expires_at
  )), '[]'::jsonb) into v_items_json
  from public.purchase_order_items it where it.purchase_order_id = v_po.id;

  return jsonb_build_object(
    'id', v_po.id,
    'tenantId', v_po.tenant_id,
    'storeId', v_po.store_id,
    'warehouseId', v_po.warehouse_id,
    'poNo', v_po.po_no,
    'supplierId', v_po.supplier_id,
    'status', v_po.status,
    'expectedAt', v_po.expected_at,
    'totalCost', v_po.total_cost,
    'note', v_po.note,
    'items', v_items_json
  );
end;
$$;

-- ===== 2. update_purchase_order_draft(用 PO 已存 store_id 重新校验) =====
create or replace function public.update_purchase_order_draft(
  p_tenant_id uuid,
  p_po_id uuid,
  p_warehouse_id uuid,
  p_supplier_id uuid,
  p_expected_at date default null,
  p_note text default null,
  p_items jsonb default '[]'::jsonb,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.purchase_orders;
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

  select * into v_po from public.purchase_orders
  where id = p_po_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_po.status <> 'draft' then
    raise exception 'NOT_DRAFT' using errcode = 'P0003';
  end if;

  -- P0-17A:仓库必须属于 PO 所属 store
  select count(*) into v_wh_count
  from public.warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id and store_id = v_po.store_id and is_active = true;
  if v_wh_count = 0 then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select count(*) into v_supplier_count
  from public.suppliers where id = p_supplier_id and tenant_id = p_tenant_id and status = 'active';
  if v_supplier_count = 0 then
    raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- P0-17A:明细 catalog_item 必须属于目标 tenant
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    select count(*) into v_catalog_count
    from public.catalog_items
    where id = (v_item.item->>'catalog_item_id')::uuid and tenant_id = p_tenant_id;
    if v_catalog_count = 0 then
      raise exception 'CATALOG_ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;
  end loop;

  -- 替换明细
  delete from public.purchase_order_items where purchase_order_id = p_po_id;
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    declare
      v_qty numeric := (v_item.item->>'ordered_qty')::numeric;
      v_cost numeric := (v_item.item->>'unit_cost')::numeric;
    begin
      if v_qty is null or v_qty <= 0 then
        raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
      end if;
      insert into public.purchase_order_items (
        tenant_id, purchase_order_id, catalog_item_id, ordered_qty, received_qty, unit_cost
      )
      values (p_tenant_id, p_po_id, (v_item.item->>'catalog_item_id')::uuid, v_qty, 0, coalesce(v_cost, 0));
      v_total := v_total + v_qty * coalesce(v_cost, 0);
    end;
  end loop;

  update public.purchase_orders
  set warehouse_id = p_warehouse_id, supplier_id = p_supplier_id,
      expected_at = p_expected_at, note = p_note, total_cost = v_total, updated_at = now()
  where id = p_po_id
  returning * into v_po;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', it.id,
    'catalogItemId', it.catalog_item_id,
    'orderedQty', it.ordered_qty,
    'receivedQty', it.received_qty,
    'unitCost', it.unit_cost,
    'batchNo', it.batch_no,
    'expiresAt', it.expires_at
  )), '[]'::jsonb) into v_items_json
  from public.purchase_order_items it where it.purchase_order_id = p_po_id;

  return jsonb_build_object(
    'id', v_po.id,
    'tenantId', v_po.tenant_id,
    'storeId', v_po.store_id,
    'warehouseId', v_po.warehouse_id,
    'poNo', v_po.po_no,
    'supplierId', v_po.supplier_id,
    'status', v_po.status,
    'expectedAt', v_po.expected_at,
    'totalCost', v_po.total_cost,
    'note', v_po.note,
    'items', v_items_json
  );
end;
$$;

-- ===== 3. approve_purchase_order(禁止自审) =====
create or replace function public.approve_purchase_order(
  p_tenant_id uuid,
  p_po_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.purchase_orders;
begin
  select * into v_po from public.purchase_orders
  where id = p_po_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_po.status <> 'submitted' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;
  if p_operator_id is not null and v_po.submitted_by = p_operator_id then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0003';
  end if;

  update public.purchase_orders
  set status = 'approved', approved_by = p_operator_id, approved_at = now()
  where id = p_po_id
  returning * into v_po;

  return jsonb_build_object('id', v_po.id, 'status', v_po.status, 'approvedAt', v_po.approved_at);
end;
$$;

-- ===== 4. receive_purchase_order(部分收货 → partially_received,不整单关闭) =====
create or replace function public.receive_purchase_order(
  p_tenant_id uuid,
  p_po_id uuid,
  p_items jsonb default '[]'::jsonb,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.purchase_orders;
  v_item record;
  v_oi public.purchase_order_items;
  v_rqty numeric;
  v_all_received boolean;
  v_records jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  select * into v_po from public.purchase_orders
  where id = p_po_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_po.status not in ('approved', 'partially_received') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    select * into v_oi from public.purchase_order_items
    where id = (v_item.item->>'id')::uuid and purchase_order_id = p_po_id
    for update;
    if not found then
      raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;

    v_rqty := (v_item.item->>'received_qty')::numeric;
    if v_rqty is null or v_rqty < 0 or v_rqty > v_oi.ordered_qty then
      raise exception 'INVALID_RECEIVED_QTY' using errcode = 'P0003';
    end if;

    update public.purchase_order_items
    set received_qty = v_rqty,
        batch_no = (v_item.item->>'batch_no')::text,
        expires_at = (v_item.item->>'expires_at')::date,
        updated_at = now()
    where id = v_oi.id;

    v_records := v_records || jsonb_build_object(
      'id', v_oi.id,
      'receivedQty', v_rqty,
      'orderedQty', v_oi.ordered_qty
    );
  end loop;

  -- P0-17B:全部明细收齐 → received;否则 partially_received(仍可继续收货)
  select bool_and(received_qty >= ordered_qty) into v_all_received
  from public.purchase_order_items where purchase_order_id = p_po_id;

  update public.purchase_orders
  set status = case when coalesce(v_all_received, false) then 'received' else 'partially_received' end,
      received_by = p_operator_id,
      received_at = now()
  where id = p_po_id
  returning * into v_po;

  return jsonb_build_object(
    'id', v_po.id,
    'status', v_po.status,
    'receivedAt', v_po.received_at,
    'items', v_records
  );
end;
$$;

-- ===== 5. service-role-only 授权(自包含,幂等;与 migration 92 对齐) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'create_purchase_order', 'update_purchase_order_draft',
    'approve_purchase_order', 'receive_purchase_order'
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
