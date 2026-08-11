-- ============================================================
-- 20260811000035_inventory_writeoff.sql
-- 库存域修复 B-R-2/R-15(3.3 报损/报废/过期 + 3.5 补充项)
--   - inventory_movements.movement_type 扩展 write_off / scrap / expired
--     (注意:迁移 33 已含 count_gain/count_loss,此处全量重建约束)
--   - 新 RPC post_inventory_writeoff:按 FEFO 扣减批次、扣余额、写负向流水,
--     余额为 0 时批次置 exhausted;幂等键强制
--   - 权限:inventory.write_off(新权限码,幂等插入)
--   - 流水不可变;报损不可撤销(如需冲正,另行正向 adjust)
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. inventory_movements.movement_type 扩展 write_off/scrap/expired =====
alter table public.inventory_movements drop constraint if exists inventory_movements_type_check;
alter table public.inventory_movements add constraint inventory_movements_type_check check (
  movement_type in ('receive', 'dispense', 'adjust', 'transfer_in', 'transfer_out', 'return', 'reserve', 'confirm', 'release', 'count_gain', 'count_loss', 'write_off', 'scrap', 'expired')
);

-- ===== 2. 权限码 inventory.write_off(幂等插入) =====
-- 注意:permissions 表结构(migration 09)仅含 code/name/module,无 description 列
insert into public.permissions (code, name, module)
values ('inventory.write_off', '库存报损', 'inventory')
on conflict (code) do nothing;

-- ===== 3. post_inventory_writeoff RPC(报损扣减,FEFO) =====
-- p_items: [{catalog_item_id, quantity, reason_type, reason, batch_id?}]
--   reason_type: 'write_off' | 'scrap' | 'expired'(决定流水类型)
-- 校验:数量 > 0;批次可选(指定则只扣该批次,须属于仓库且未耗尽);
--       不指定批次则 FEFO 扣减(参照 dispense_inventory)
-- 并发:SELECT FOR UPDATE 锁余额行与批次行;幂等:同 idempotency_key 返回原结果
create or replace function public.post_inventory_writeoff(
  p_tenant_id uuid,
  p_warehouse_id uuid,
  p_items jsonb default '[]'::jsonb,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_warehouse public.warehouses;
  v_existing jsonb;
  v_item record;
  v_catalog_id uuid;
  v_qty numeric;
  v_rtype text;
  v_reason text;
  v_batch_id uuid;
  v_balance public.inventory_balances;
  v_remaining numeric;
  v_batch record;
  v_take numeric;
  v_movement public.inventory_movements;
  v_results jsonb := '[]'::jsonb;
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

  -- 校验仓库归属与有效性
  select * into v_warehouse from public.warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_warehouse.is_active is false then
    raise exception 'WAREHOUSE_INACTIVE' using errcode = 'P0003';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    v_catalog_id := (v_item.item->>'catalog_item_id')::uuid;
    v_qty := (v_item.item->>'quantity')::numeric;
    v_rtype := coalesce((v_item.item->>'reason_type')::text, 'write_off');
    v_reason := (v_item.item->>'reason')::text;
    v_batch_id := (v_item.item->>'batch_id')::uuid;

    if v_rtype not in ('write_off', 'scrap', 'expired') then
      raise exception 'INVALID_REASON_TYPE' using errcode = 'P0003';
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
    end if;

    -- 锁余额行,校验可用量(可用 = on_hand - reserved)
    select * into v_balance from public.inventory_balances
    where warehouse_id = p_warehouse_id and catalog_item_id = v_catalog_id
    for update;
    if not found or v_balance.quantity_on_hand - v_balance.quantity_reserved < v_qty then
      raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0003';
    end if;

    v_remaining := v_qty;

    -- 指定批次:仅扣该批次(须属于仓库、active、未耗尽、未过期)
    if v_batch_id is not null then
      select b.id, b.quantity_remaining, b.expiry_date into v_batch
      from public.inventory_batches b
      where b.id = v_batch_id
        and b.warehouse_id = p_warehouse_id
        and b.catalog_item_id = v_catalog_id
        and b.status = 'active'
      for update;
      if not found then
        raise exception 'BATCH_NOT_FOUND' using errcode = 'P0002';
      end if;
      if v_batch.quantity_remaining < v_qty then
        raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0003';
      end if;
      if v_qty >= v_batch.quantity_remaining then
        update public.inventory_batches
        set quantity_remaining = 0, status = 'exhausted'
        where id = v_batch.id;
      else
        update public.inventory_batches
        set quantity_remaining = quantity_remaining - v_qty
        where id = v_batch.id;
      end if;
      v_remaining := 0;
    else
      -- FEFO:按 expiry_date 升序锁定可用批次
      for v_batch in
        select b.id, b.quantity_remaining, b.expiry_date
        from public.inventory_batches b
        where b.warehouse_id = p_warehouse_id
          and b.catalog_item_id = v_catalog_id
          and b.status = 'active'
          and b.quantity_remaining > 0
          and (b.expiry_date is null or b.expiry_date >= current_date)
        order by b.expiry_date asc nulls last, b.received_date asc
        for update
      loop
        exit when v_remaining <= 0;
        v_take := least(v_batch.quantity_remaining, v_remaining);

        if v_take >= v_batch.quantity_remaining then
          update public.inventory_batches
          set quantity_remaining = 0, status = 'exhausted'
          where id = v_batch.id;
        else
          update public.inventory_batches
          set quantity_remaining = quantity_remaining - v_take
          where id = v_batch.id;
        end if;

        v_remaining := v_remaining - v_take;
      end loop;

      if v_remaining > 0 then
        raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0003';
      end if;
    end if;

    -- 扣余额
    update public.inventory_balances
    set quantity_on_hand = quantity_on_hand - v_qty,
        updated_at = now()
    where warehouse_id = p_warehouse_id and catalog_item_id = v_catalog_id
    returning * into v_balance;

    -- 写负向流水(reason_type 决定 movement_type)
    insert into public.inventory_movements (
      tenant_id, warehouse_id, catalog_item_id, batch_id,
      movement_type, quantity, balance_after,
      reference_type, reference_id, idempotency_key, operator_id
    )
    values (
      p_tenant_id, p_warehouse_id, v_catalog_id, v_batch_id,
      v_rtype, -v_qty, v_balance.quantity_on_hand,
      'write_off', coalesce(v_reason, v_rtype), p_idempotency_key || ':' || v_catalog_id, p_operator_id
    )
    returning * into v_movement;

    v_results := v_results || jsonb_build_object(
      'catalogItemId', v_catalog_id,
      'movementType', v_rtype,
      'quantity', -v_qty,
      'movementId', v_movement.id,
      'quantityOnHand', v_balance.quantity_on_hand
    );
  end loop;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'post_inventory_writeoff', 'inventory_balance', p_warehouse_id, jsonb_build_object(
      'warehouseId', p_warehouse_id,
      'items', v_results
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'warehouseId', p_warehouse_id,
    'items', v_results
  );
end;
$$;

-- ===== 4. service-role-only 授权(自包含,幂等;与 migration 96 对齐) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'post_inventory_writeoff'
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
