-- ============================================================
-- 20260810000068_purchase_receive_rpc.sql
-- Agent-05: 收货 RPC(approved / received → received)
--   receive_purchase_order:按明细记录实收数量/批次/效期(仅过账前可调整)
--   - 校验 received_qty ∈ [0, ordered_qty]
--   - 明细行 for update 防并发改
--   - 状态置 received;过账(post)前可重复收货调整
-- security definer;由 Hono Command 在 requireScopedPermission 后调用
-- 幂等,可重复应用
-- ============================================================

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
  if v_po.status not in ('approved', 'received') then
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
      'batchNo', (v_item.item->>'batch_no')::text,
      'expiresAt', (v_item.item->>'expires_at')::date
    );
  end loop;

  update public.purchase_orders
  set status = 'received', received_by = p_operator_id, received_at = now()
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

revoke all on function public.receive_purchase_order(uuid, uuid, jsonb, uuid) from public;
grant execute on function public.receive_purchase_order(uuid, uuid, jsonb, uuid) to authenticated;
