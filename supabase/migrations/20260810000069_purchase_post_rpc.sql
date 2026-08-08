-- ============================================================
-- 20260810000069_purchase_post_rpc.sql
-- Agent-05: 采购过账 RPC(received → posted)
--   post_purchase_order:
--     - 复用既有 post_goods_receipt,为每条实收明细生成 inventory_batches /
--       inventory_balances / inventory_movements(不复制库存算法)
--     - 同一事务:任一条失败整体回滚,PO 状态不残留
--     - 幂等:idempotency_records + PO 行锁,重复点击只产生一次入库
--     - posted 后不可再改
-- security definer;由 Hono Command 在 requireScopedPermission 后调用
-- 幂等,可重复应用
-- ============================================================

create or replace function public.post_purchase_order(
  p_tenant_id uuid,
  p_po_id uuid,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_po public.purchase_orders;
  v_supplier public.suppliers;
  v_item record;
  v_result jsonb;
  v_posted_total numeric(12,2) := 0;
  v_created_items jsonb := '[]'::jsonb;
begin
  -- 幂等检查:命中已存在记录直接返回原结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  select * into v_po from public.purchase_orders
  where id = p_po_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_po.status <> 'received' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  select * into v_supplier from public.suppliers where id = v_po.supplier_id;

  -- 复用 post_goods_receipt:每条实收明细生成批次/余额/流水(同一事务)
  for v_item in
    select it.* from public.purchase_order_items it
    where it.purchase_order_id = p_po_id and it.received_qty > 0
  loop
    v_result := public.post_goods_receipt(
      p_tenant_id,
      v_po.warehouse_id,
      v_item.catalog_item_id,
      v_item.batch_no,
      v_item.received_qty,
      v_item.unit_cost,
      v_item.expires_at,
      v_supplier.name,
      v_po.po_no,
      p_operator_id,
      p_idempotency_key || ':' || v_item.id
    );
    v_posted_total := v_posted_total + v_item.received_qty * v_item.unit_cost;
    v_created_items := v_created_items || jsonb_build_object(
      'itemId', v_item.id,
      'catalogItemId', v_item.catalog_item_id,
      'batchId', v_result->>'batchId',
      'balanceId', v_result->>'balanceId',
      'movementId', v_result->>'movementId',
      'quantityOnHand', v_result->>'quantityOnHand'
    );
  end loop;

  update public.purchase_orders
  set status = 'posted', posted_by = p_operator_id, posted_at = now(), total_cost = v_posted_total
  where id = p_po_id
  returning * into v_po;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'post_purchase_order', 'purchase_order', p_po_id, jsonb_build_object(
      'id', v_po.id,
      'poNo', v_po.po_no,
      'status', v_po.status,
      'postedAt', v_po.posted_at,
      'postedTotal', v_posted_total,
      'items', v_created_items
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'id', v_po.id,
    'poNo', v_po.po_no,
    'status', v_po.status,
    'postedAt', v_po.posted_at,
    'postedTotal', v_posted_total,
    'items', v_created_items
  );
end;
$$;

revoke all on function public.post_purchase_order(uuid, uuid, uuid, text) from public;
grant execute on function public.post_purchase_order(uuid, uuid, uuid, text) to authenticated;
