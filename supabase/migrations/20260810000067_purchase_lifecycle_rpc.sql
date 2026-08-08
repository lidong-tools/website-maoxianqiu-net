-- ============================================================
-- 20260810000067_purchase_lifecycle_rpc.sql
-- Agent-05: 采购单生命周期 RPC
--   create_purchase_order / update_purchase_order_draft
--   submit_purchase_order / approve_purchase_order / cancel_purchase_order
-- 状态机:draft → submitted → approved;draft/submitted 可取消
-- 全部 security definer;由 Hono Command 在 requireScopedPermission 后调用
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. 创建采购单草稿 =====
-- p_items: [{catalog_item_id, ordered_qty, unit_cost}]
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

  select count(*) into v_wh_count
  from public.warehouses where id = p_warehouse_id and tenant_id = p_tenant_id and is_active = true;
  if v_wh_count = 0 then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select count(*) into v_supplier_count
  from public.suppliers where id = p_supplier_id and tenant_id = p_tenant_id and status = 'active';
  if v_supplier_count = 0 then
    raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
  end if;

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

revoke all on function public.create_purchase_order(uuid, uuid, uuid, uuid, date, text, jsonb, uuid) from public;
grant execute on function public.create_purchase_order(uuid, uuid, uuid, uuid, date, text, jsonb, uuid) to authenticated;

-- ===== 2. 更新草稿(仅 draft;替换全部明细) =====
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
  v_supplier_count integer;
  v_item record;
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

  select count(*) into v_supplier_count
  from public.suppliers where id = p_supplier_id and tenant_id = p_tenant_id and status = 'active';
  if v_supplier_count = 0 then
    raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
  end if;

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

revoke all on function public.update_purchase_order_draft(uuid, uuid, uuid, uuid, date, text, jsonb, uuid) from public;
grant execute on function public.update_purchase_order_draft(uuid, uuid, uuid, uuid, date, text, jsonb, uuid) to authenticated;

-- ===== 3. 提交(draft → submitted) =====
create or replace function public.submit_purchase_order(
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
  v_item_count integer;
begin
  select * into v_po from public.purchase_orders
  where id = p_po_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_po.status <> 'draft' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  select count(*) into v_item_count
  from public.purchase_order_items where purchase_order_id = p_po_id and ordered_qty > 0;
  if v_item_count = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  update public.purchase_orders
  set status = 'submitted', submitted_by = p_operator_id, submitted_at = now()
  where id = p_po_id
  returning * into v_po;

  return jsonb_build_object('id', v_po.id, 'status', v_po.status, 'submittedAt', v_po.submitted_at);
end;
$$;

revoke all on function public.submit_purchase_order(uuid, uuid, uuid) from public;
grant execute on function public.submit_purchase_order(uuid, uuid, uuid) to authenticated;

-- ===== 4. 审核(submitted → approved) =====
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

  update public.purchase_orders
  set status = 'approved', approved_by = p_operator_id, approved_at = now()
  where id = p_po_id
  returning * into v_po;

  return jsonb_build_object('id', v_po.id, 'status', v_po.status, 'approvedAt', v_po.approved_at);
end;
$$;

revoke all on function public.approve_purchase_order(uuid, uuid, uuid) from public;
grant execute on function public.approve_purchase_order(uuid, uuid, uuid) to authenticated;

-- ===== 5. 取消(draft / submitted → cancelled) =====
create or replace function public.cancel_purchase_order(
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
  if v_po.status not in ('draft', 'submitted') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  update public.purchase_orders
  set status = 'cancelled', cancelled_by = p_operator_id, cancelled_at = now()
  where id = p_po_id
  returning * into v_po;

  return jsonb_build_object('id', v_po.id, 'status', v_po.status, 'cancelledAt', v_po.cancelled_at);
end;
$$;

revoke all on function public.cancel_purchase_order(uuid, uuid, uuid) from public;
grant execute on function public.cancel_purchase_order(uuid, uuid, uuid) to authenticated;
