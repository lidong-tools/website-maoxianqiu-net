-- ============================================================
-- 20260807000025_inventory_reserve_consistency.sql
-- P0-08 库存预留与发药一致性修复:
--   1. confirm_inventory_reservation 补 FEFO 批次扣减(与 dispense_inventory 口径一致)
--   2. reserve_inventory 增加预留有效期(p_reserved_until),防止永久占用
--   3. confirm 时自动释放同仓库同商品已过期的预留(状态转换自动释放)
--   4. 新增 release_expired_reservations 批量释放过期预留(运维/定时触发)
--   5. 统一正式发药语义:
--      - 带业务单据(处方/挂单):reserve → confirm(预留转正式扣减,含 FEFO 批次扣减)
--      - 即时发药(无单据):dispense(直接 FEFO 扣减)
--      - confirm/release 针对 reserve 流水操作,同一预留只能被确认或释放一次
-- 幂等,可重复应用(create or replace + add column if not exists)
--
-- 验收映射(文档 12.3):
--   - 并发预留防超卖:SELECT FOR UPDATE 锁余额行(既有)
--   - 重复 confirm 只扣一次:RESERVATION_ALREADY_CONFIRMED + 幂等键(既有)
--   - 取消处方 reserved 正确释放:处方取消联动 release(API 层,见 clinical.ts)
--   - 支付失败/过期不产生永久占用:reserved_until + 自动/批量释放(本文件)
-- ============================================================

-- ===== 1. inventory_movements 增加预留有效期(幂等) =====
alter table public.inventory_movements
  add column if not exists reserved_until timestamptz;

create index if not exists idx_movements_reserved_until
  on public.inventory_movements (tenant_id, movement_type, reserved_until)
  where movement_type = 'reserve' and reserved_until is not null;

-- ============================================================
-- 2. 重建 reserve_inventory(增加 p_reserved_until)
-- 行为:冻结可用库存(仅增 quantity_reserved),写 reserve 流水并记录有效期
-- 签名兼容:新增第 9 参放在末尾,带默认值;既有命名参数调用不受影响
-- ============================================================
create or replace function public.reserve_inventory(
  p_tenant_id uuid,
  p_warehouse_id uuid,
  p_catalog_item_id uuid,
  p_quantity numeric,
  p_reference_type text default null,   -- 业务来源类型(挂单/处方/订单/...)
  p_reference_id text default null,     -- 业务单据 id
  p_operator_id uuid default null,
  p_idempotency_key text default null,
  p_reserved_until timestamptz default null  -- 预留有效期,默认 24 小时
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_warehouse public.warehouses;
  v_existing jsonb;
  v_balance public.inventory_balances;
  v_movement public.inventory_movements;
  v_expires timestamptz;
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

  if p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
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

  -- 锁余额行,校验可用量(可用 = on_hand - reserved)
  select * into v_balance from public.inventory_balances
  where warehouse_id = p_warehouse_id and catalog_item_id = p_catalog_item_id
  for update;
  if not found or v_balance.quantity_on_hand - v_balance.quantity_reserved < p_quantity then
    raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0003';
  end if;

  -- 预留有效期:未指定时默认 24 小时
  v_expires := coalesce(p_reserved_until, now() + interval '24 hours');

  -- 增加预留量(在库量不变)
  update public.inventory_balances
  set quantity_reserved = quantity_reserved + p_quantity,
      updated_at = now()
  where warehouse_id = p_warehouse_id and catalog_item_id = p_catalog_item_id
  returning * into v_balance;

  -- 写不可变流水(reserve,负数:占用可用库存;在库量不变,记录有效期)
  insert into public.inventory_movements (
    tenant_id, warehouse_id, catalog_item_id, batch_id,
    movement_type, quantity, balance_after, reserved_until,
    reference_type, reference_id, idempotency_key, operator_id
  )
  values (
    p_tenant_id, p_warehouse_id, p_catalog_item_id, null,
    'reserve', -p_quantity, v_balance.quantity_on_hand, v_expires,
    p_reference_type, p_reference_id, p_idempotency_key, p_operator_id
  )
  returning * into v_movement;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'reserve_inventory', 'inventory_balance', v_balance.id, jsonb_build_object(
      'balanceId', v_balance.id,
      'movementId', v_movement.id,
      'quantityOnHand', v_balance.quantity_on_hand,
      'quantityReserved', v_balance.quantity_reserved,
      'reserved', p_quantity,
      'reservedUntil', v_expires
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'balanceId', v_balance.id,
    'movementId', v_movement.id,
    'quantityOnHand', v_balance.quantity_on_hand,
    'quantityReserved', v_balance.quantity_reserved,
    'reserved', p_quantity,
    'reservedUntil', v_expires
  );
end;
$$;

revoke all on function public.reserve_inventory(uuid, uuid, uuid, numeric, text, text, uuid, text, timestamptz) from public;
grant execute on function public.reserve_inventory(uuid, uuid, uuid, numeric, text, text, uuid, text, timestamptz) to authenticated;

-- ============================================================
-- 3. 重建 confirm_inventory_reservation(补 FEFO 批次扣减 + 过期预留自动释放)
-- 行为:
--   - 预留转正式扣减:quantity_on_hand 减、quantity_reserved 减
--   - 新增:FEFO(按 expiry_date 升序)扣减批次 quantity_remaining,耗尽标 exhausted
--   - 新增:确认前自动释放同仓库同商品已过期的未处理预留(写 release 流水)
-- 凭证:p_reservation_id 为 reserve 流水的 movement id;同一预留只能被确认或释放一次
-- ============================================================
create or replace function public.confirm_inventory_reservation(
  p_tenant_id uuid,
  p_reservation_id uuid,             -- reserve 产生的 movement id
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
  v_reserve public.inventory_movements;
  v_amount numeric;
  v_balance public.inventory_balances;
  v_movement public.inventory_movements;
  v_already_confirmed boolean;
  v_already_released boolean;
  v_remaining_to_dispense numeric;
  v_batch record;
  v_take numeric;
  v_stale record;
begin
  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 锁定预留流水(并发安全:同一预留的确认/释放在此串行化)
  select * into v_reserve from public.inventory_movements
  where id = p_reservation_id
    and tenant_id = p_tenant_id
    and movement_type = 'reserve'
  for update;
  if not found then
    raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 防重复处理:已确认或已释放则拒绝
  select exists(
    select 1 from public.inventory_movements m
    where m.reference_type = 'inventory_reservation'
      and m.reference_id = v_reserve.id::text
      and m.movement_type = 'confirm'
  ) into v_already_confirmed;
  select exists(
    select 1 from public.inventory_movements m
    where m.reference_type = 'inventory_reservation'
      and m.reference_id = v_reserve.id::text
      and m.movement_type = 'release'
  ) into v_already_released;
  if v_already_confirmed then
    raise exception 'RESERVATION_ALREADY_CONFIRMED' using errcode = 'P0003';
  end if;
  if v_already_released then
    raise exception 'RESERVATION_ALREADY_RELEASED' using errcode = 'P0003';
  end if;

  v_amount := abs(v_reserve.quantity);

  -- 锁余额行,校验预留量充足(防止数据不一致导致扣成负数)
  select * into v_balance from public.inventory_balances
  where warehouse_id = v_reserve.warehouse_id and catalog_item_id = v_reserve.catalog_item_id
  for update;
  if not found or v_balance.quantity_reserved < v_amount then
    raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- P0-08:确认前自动释放同仓库同商品已过期的未处理预留(状态转换自动释放)
  -- 只处理 reserved_until 早于当前时间且未被 confirm/release 的 reserve 流水
  for v_stale in
    select m.id, abs(m.quantity) as amt
    from public.inventory_movements m
    where m.tenant_id = p_tenant_id
      and m.warehouse_id = v_reserve.warehouse_id
      and m.catalog_item_id = v_reserve.catalog_item_id
      and m.movement_type = 'reserve'
      and m.reserved_until is not null
      and m.reserved_until < now()
      and not exists (
        select 1 from public.inventory_movements mm
        where mm.reference_type = 'inventory_reservation'
          and mm.reference_id = m.id::text
          and mm.movement_type in ('confirm', 'release')
      )
    order by m.reserved_until
    for update of m skip locked
  loop
    -- 释放过期预留:仅 quantity_reserved 减少,在库量不变
    update public.inventory_balances
    set quantity_reserved = greatest(quantity_reserved - v_stale.amt, 0),
        updated_at = now()
    where id = v_balance.id;

    insert into public.inventory_movements (
      tenant_id, warehouse_id, catalog_item_id, batch_id,
      movement_type, quantity, balance_after,
      reference_type, reference_id, idempotency_key, operator_id
    )
    values (
      p_tenant_id, v_reserve.warehouse_id, v_reserve.catalog_item_id, null,
      'release', v_stale.amt, v_balance.quantity_on_hand,
      'inventory_reservation', v_stale.id::text, null, p_operator_id
    );
  end loop;

  -- P0-08:FEFO 扣减批次(与 dispense_inventory 口径一致,按 expiry_date 升序)
  -- 预留转正式扣减同样需要把批次剩余量扣掉,否则批次与余额长期不一致
  v_remaining_to_dispense := v_amount;
  for v_batch in
    select b.id, b.quantity_remaining, b.expiry_date
    from public.inventory_batches b
    where b.warehouse_id = v_reserve.warehouse_id
      and b.catalog_item_id = v_reserve.catalog_item_id
      and b.status = 'active'
      and b.quantity_remaining > 0
      and (b.expiry_date is null or b.expiry_date >= current_date)
    order by b.expiry_date asc nulls last, b.received_date asc
    for update
  loop
    exit when v_remaining_to_dispense <= 0;
    v_take := least(v_batch.quantity_remaining, v_remaining_to_dispense);

    if v_take >= v_batch.quantity_remaining then
      update public.inventory_batches
      set quantity_remaining = 0, status = 'exhausted'
      where id = v_batch.id;
    else
      update public.inventory_batches
      set quantity_remaining = quantity_remaining - v_take
      where id = v_batch.id;
    end if;

    v_remaining_to_dispense := v_remaining_to_dispense - v_take;
  end loop;

  if v_remaining_to_dispense > 0 then
    -- 批次可用量不足(余额检查已拦截在库量,此处兜底防批次不一致)
    raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0003';
  end if;

  -- 预留转正式扣减:在库量与预留量同步减少
  update public.inventory_balances
  set quantity_on_hand = quantity_on_hand - v_amount,
      quantity_reserved = quantity_reserved - v_amount,
      updated_at = now()
  where id = v_balance.id
  returning * into v_balance;

  -- 写不可变流水(confirm,负数:正式出库;reference 指向原 reserve 流水)
  insert into public.inventory_movements (
    tenant_id, warehouse_id, catalog_item_id, batch_id,
    movement_type, quantity, balance_after,
    reference_type, reference_id, idempotency_key, operator_id
  )
  values (
    p_tenant_id, v_reserve.warehouse_id, v_reserve.catalog_item_id, null,
    'confirm', -v_amount, v_balance.quantity_on_hand,
    'inventory_reservation', v_reserve.id::text, p_idempotency_key, p_operator_id
  )
  returning * into v_movement;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'confirm_inventory_reservation', 'inventory_balance', v_balance.id, jsonb_build_object(
      'balanceId', v_balance.id,
      'movementId', v_movement.id,
      'quantityOnHand', v_balance.quantity_on_hand,
      'quantityReserved', v_balance.quantity_reserved,
      'confirmed', v_amount
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'balanceId', v_balance.id,
    'movementId', v_movement.id,
    'quantityOnHand', v_balance.quantity_on_hand,
    'quantityReserved', v_balance.quantity_reserved,
    'confirmed', v_amount
  );
end;
$$;

revoke all on function public.confirm_inventory_reservation(uuid, uuid, uuid, text) from public;
grant execute on function public.confirm_inventory_reservation(uuid, uuid, uuid, text) to authenticated;

-- ============================================================
-- 4. 新增 release_expired_reservations RPC(批量释放过期预留)
-- 行为:遍历租户下所有已过期且未处理的 reserve 流水,逐个释放(写 release 流水)
-- 用途:运维/定时任务调用,防止支付失败或业务未取消导致永久占用
-- 权限:inventory.release
-- ============================================================
create or replace function public.release_expired_reservations(
  p_tenant_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_released numeric := 0;
  v_stale record;
  v_balance public.inventory_balances;
begin
  -- 锁定并遍历过期未处理的 reserve 流水
  for v_stale in
    select m.id, m.warehouse_id, m.catalog_item_id, abs(m.quantity) as amt
    from public.inventory_movements m
    where m.tenant_id = p_tenant_id
      and m.movement_type = 'reserve'
      and m.reserved_until is not null
      and m.reserved_until < now()
      and not exists (
        select 1 from public.inventory_movements mm
        where mm.reference_type = 'inventory_reservation'
          and mm.reference_id = m.id::text
          and mm.movement_type in ('confirm', 'release')
      )
    order by m.reserved_until
    for update of m skip locked
  loop
    -- 锁余额行,仅减预留量(不得为负)
    select * into v_balance
    from public.inventory_balances
    where warehouse_id = v_stale.warehouse_id and catalog_item_id = v_stale.catalog_item_id
    for update;

    if found then
      update public.inventory_balances
      set quantity_reserved = greatest(quantity_reserved - v_stale.amt, 0),
          updated_at = now()
      where id = v_balance.id;

      insert into public.inventory_movements (
        tenant_id, warehouse_id, catalog_item_id, batch_id,
        movement_type, quantity, balance_after,
        reference_type, reference_id, idempotency_key, operator_id
      )
      values (
        p_tenant_id, v_stale.warehouse_id, v_stale.catalog_item_id, null,
        'release', v_stale.amt, v_balance.quantity_on_hand,
        'inventory_reservation', v_stale.id::text, null, p_operator_id
      );

      v_count := v_count + 1;
      v_released := v_released + v_stale.amt;
    end if;
  end loop;

  return jsonb_build_object(
    'released_count', v_count,
    'released_quantity', v_released,
    'released_at', now()
  );
end;
$$;

revoke all on function public.release_expired_reservations(uuid, uuid) from public;
grant execute on function public.release_expired_reservations(uuid, uuid) to authenticated;
