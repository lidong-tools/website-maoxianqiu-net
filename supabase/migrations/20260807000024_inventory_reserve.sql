-- ============================================================
-- 20260807000024_inventory_reserve.sql
-- MXQ-9008 预留(reserve)扣减机制:
--   挂单/下单冻结库存(reserve) → 支付确认正式扣减(confirm) → 取消释放(release)
--   - inventory_balances 增加 quantity_reserved 字段(幂等,已存在则跳过)
--   - inventory_movements.movement_type 扩展 reserve / confirm / release
--   - 新 RPC:reserve_inventory / confirm_inventory_reservation / release_inventory_reservation
--   - dispense_inventory 以同签名重建,可用量校验改为 可用 = on_hand - reserved
--   - 权限码:inventory.reserve / inventory.confirm / inventory.release
-- 幂等,可重复应用
--
-- 设计要点:
--   - 可用量 = quantity_on_hand - quantity_reserved;预留、发药均按可用量校验,防止超卖
--   - 预留不锁定批次:reserve 仅增加 quantity_reserved,不扣批次(confirm 时才正式扣在库量)
--   - 预留凭证 = reserve 流水的 movement id(p_reservation_id),confirm/release 针对该流水操作
--   - 同一预留只能被确认或释放一次(重复操作抛 RESERVATION_ALREADY_PROCESSED)
--   - 流水符号约定:quantity 正数入/释放,负数出/占用;balance_after 始终为操作后该仓库该商品在库量
-- ============================================================

-- ===== 1. inventory_balances 增加预留字段(幂等) =====
alter table public.inventory_balances
  add column if not exists quantity_reserved numeric(12,2) not null default 0;

-- ===== 2. inventory_movements.movement_type 扩展 reserve/confirm/release =====
alter table public.inventory_movements drop constraint if exists inventory_movements_type_check;
alter table public.inventory_movements add constraint inventory_movements_type_check check (
  movement_type in ('receive', 'dispense', 'adjust', 'transfer_in', 'transfer_out', 'return', 'reserve', 'confirm', 'release')
);

-- ===== 3. 重建 dispense_inventory(签名与返回字段不变,可用量纳入预留) =====
-- 硬约束:rls_inventory.sql 以位置参数调用本函数(8 参),签名绝对不能改;
-- 返回字段(quantityOnHand 等)保持不变,仅将可用量校验改为 on_hand - reserved。
create or replace function public.dispense_inventory(
  p_tenant_id uuid,
  p_warehouse_id uuid,
  p_catalog_item_id uuid,
  p_quantity numeric,
  p_reference_type text default null,
  p_reference_id text default null,
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
  v_balance public.inventory_balances;
  v_remaining_to_dispense numeric := p_quantity;
  v_batch record;
  v_take numeric;
  v_movement public.inventory_movements;
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

  if p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
  end if;

  -- 校验仓库
  select * into v_warehouse from public.warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_warehouse.is_active is false then
    raise exception 'WAREHOUSE_INACTIVE' using errcode = 'P0003';
  end if;

  -- 锁余额行(并发安全:同时只有一个事务能扣减该商品余额)
  -- 可用量 = on_hand - reserved:已预留数量同样视为不可发,防止与预留叠加超卖
  select * into v_balance from public.inventory_balances
  where warehouse_id = p_warehouse_id and catalog_item_id = p_catalog_item_id
  for update;
  if not found or v_balance.quantity_on_hand - v_balance.quantity_reserved < p_quantity then
    raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0003';
  end if;

  -- FEFO:按 expiry_date 升序锁定可用批次
  for v_batch in
    select b.id, b.quantity_remaining, b.expiry_date
    from public.inventory_batches b
    where b.warehouse_id = p_warehouse_id
      and b.catalog_item_id = p_catalog_item_id
      and b.status = 'active'
      and b.quantity_remaining > 0
      and (b.expiry_date is null or b.expiry_date >= current_date)
    order by b.expiry_date asc nulls last, b.received_date asc
    for update
  loop
    exit when v_remaining_to_dispense <= 0;
    v_take := least(v_batch.quantity_remaining, v_remaining_to_dispense);

    -- 扣减批次剩余量,耗尽则标记 exhausted
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
    -- 批次可用量不足(理论上余额检查已拦截,此处兜底)
    raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0003';
  end if;

  -- 扣减余额
  update public.inventory_balances
  set quantity_on_hand = quantity_on_hand - p_quantity,
      updated_at = now()
  where warehouse_id = p_warehouse_id and catalog_item_id = p_catalog_item_id
  returning * into v_balance;

  -- 写不可变流水(dispense,负数)
  insert into public.inventory_movements (
    tenant_id, warehouse_id, catalog_item_id, batch_id,
    movement_type, quantity, balance_after,
    reference_type, reference_id, idempotency_key, operator_id
  )
  values (
    p_tenant_id, p_warehouse_id, p_catalog_item_id, null,
    'dispense', -p_quantity, v_balance.quantity_on_hand,
    p_reference_type, p_reference_id, p_idempotency_key, p_operator_id
  )
  returning * into v_movement;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'dispense_inventory', 'inventory_balance', v_balance.id, jsonb_build_object(
      'balanceId', v_balance.id,
      'movementId', v_movement.id,
      'quantityOnHand', v_balance.quantity_on_hand,
      'dispensed', p_quantity
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'balanceId', v_balance.id,
    'movementId', v_movement.id,
    'quantityOnHand', v_balance.quantity_on_hand,
    'dispensed', p_quantity
  );
end;
$$;

revoke all on function public.dispense_inventory(uuid, uuid, uuid, numeric, text, text, uuid, text) from public;
grant execute on function public.dispense_inventory(uuid, uuid, uuid, numeric, text, text, uuid, text) to authenticated;

-- ===== 4. reserve_inventory RPC(MXQ-9008 预留冻结) =====
-- 业务动作:挂单/下单冻结库存,仅增加 quantity_reserved,不扣在库量与批次
-- 校验:可用量 = on_hand - reserved >= 需求量,不足抛 INSUFFICIENT_STOCK
-- 并发:SELECT FOR UPDATE 锁余额行;幂等:同 idempotency_key 返回原结果
create or replace function public.reserve_inventory(
  p_tenant_id uuid,
  p_warehouse_id uuid,
  p_catalog_item_id uuid,
  p_quantity numeric,
  p_reference_type text default null,   -- 业务来源类型(挂单/订单/...)
  p_reference_id text default null,     -- 业务单据 id(挂单号/订单号等)
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
  v_balance public.inventory_balances;
  v_movement public.inventory_movements;
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

  -- 增加预留量(在库量不变)
  update public.inventory_balances
  set quantity_reserved = quantity_reserved + p_quantity,
      updated_at = now()
  where warehouse_id = p_warehouse_id and catalog_item_id = p_catalog_item_id
  returning * into v_balance;

  -- 写不可变流水(reserve,负数:占用可用库存;在库量不变)
  insert into public.inventory_movements (
    tenant_id, warehouse_id, catalog_item_id, batch_id,
    movement_type, quantity, balance_after,
    reference_type, reference_id, idempotency_key, operator_id
  )
  values (
    p_tenant_id, p_warehouse_id, p_catalog_item_id, null,
    'reserve', -p_quantity, v_balance.quantity_on_hand,
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
      'reserved', p_quantity
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'balanceId', v_balance.id,
    'movementId', v_movement.id,
    'quantityOnHand', v_balance.quantity_on_hand,
    'quantityReserved', v_balance.quantity_reserved,
    'reserved', p_quantity
  );
end;
$$;

revoke all on function public.reserve_inventory(uuid, uuid, uuid, numeric, text, text, uuid, text) from public;
grant execute on function public.reserve_inventory(uuid, uuid, uuid, numeric, text, text, uuid, text) to authenticated;

-- ===== 5. confirm_inventory_reservation RPC(MXQ-9008 支付确认) =====
-- 业务动作:订单支付成功,将预留转正式扣减(quantity_on_hand 减、quantity_reserved 减),写 confirm 流水
-- 凭证:p_reservation_id 为 reserve 流水的 movement id;同一预留只能被确认或释放一次
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

-- ===== 6. release_inventory_reservation RPC(MXQ-9008 取消释放) =====
-- 业务动作:订单取消,释放预留,仅减 quantity_reserved(不得为负),写 release 流水
-- 凭证:同 confirm,p_reservation_id 为 reserve 流水的 movement id
create or replace function public.release_inventory_reservation(
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

  -- 锁定预留流水
  select * into v_reserve from public.inventory_movements
  where id = p_reservation_id
    and tenant_id = p_tenant_id
    and movement_type = 'reserve'
  for update;
  if not found then
    raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 防重复处理
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

  -- 锁余额行,仅减预留量(不得为负)
  select * into v_balance from public.inventory_balances
  where warehouse_id = v_reserve.warehouse_id and catalog_item_id = v_reserve.catalog_item_id
  for update;
  if not found or v_balance.quantity_reserved < v_amount then
    raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 释放预留:仅 quantity_reserved 减少,在库量不变
  update public.inventory_balances
  set quantity_reserved = quantity_reserved - v_amount,
      updated_at = now()
  where id = v_balance.id
  returning * into v_balance;

  -- 写不可变流水(release,正数:释放占用;在库量不变)
  insert into public.inventory_movements (
    tenant_id, warehouse_id, catalog_item_id, batch_id,
    movement_type, quantity, balance_after,
    reference_type, reference_id, idempotency_key, operator_id
  )
  values (
    p_tenant_id, v_reserve.warehouse_id, v_reserve.catalog_item_id, null,
    'release', v_amount, v_balance.quantity_on_hand,
    'inventory_reservation', v_reserve.id::text, p_idempotency_key, p_operator_id
  )
  returning * into v_movement;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'release_inventory_reservation', 'inventory_balance', v_balance.id, jsonb_build_object(
      'balanceId', v_balance.id,
      'movementId', v_movement.id,
      'quantityOnHand', v_balance.quantity_on_hand,
      'quantityReserved', v_balance.quantity_reserved,
      'released', v_amount
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'balanceId', v_balance.id,
    'movementId', v_movement.id,
    'quantityOnHand', v_balance.quantity_on_hand,
    'quantityReserved', v_balance.quantity_reserved,
    'released', v_amount
  );
end;
$$;

revoke all on function public.release_inventory_reservation(uuid, uuid, uuid, text) from public;
grant execute on function public.release_inventory_reservation(uuid, uuid, uuid, text) to authenticated;

-- ===== 7. 新增权限码 =====
insert into public.permissions (code, name, module) values
  ('inventory.reserve', '预留库存', 'inventory'),
  ('inventory.confirm', '确认预留', 'inventory'),
  ('inventory.release', '释放预留', 'inventory')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 系统角色补 inventory.reserve/confirm/release 权限(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in ('inventory.reserve', 'inventory.confirm', 'inventory.release')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in ('inventory.reserve', 'inventory.confirm', 'inventory.release')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'inventory.reserve', 'inventory.confirm', 'inventory.release'
  ])
)
where code = 'system_admin' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'inventory.reserve', 'inventory.confirm', 'inventory.release'
  ])
)
where code = 'store_manager' and is_system = true;
