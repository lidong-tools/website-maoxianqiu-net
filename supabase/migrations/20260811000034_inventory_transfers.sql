-- ============================================================
-- 20260811000034_inventory_transfers.sql
-- 库存域修复 R-9/R-10/R-11/R-12/R-13(3.5.5 调拨审核/查询/收货/取消/目录约束)
--   - transfers / transfer_items 单据表(参照 purchase_orders 同构)
--   - 状态机:draft → submitted → approved → outbound → received/partially_received
--     ;draft/submitted 可取消;partially_received 可继续收货
--   - create_transfer 校验(R-13):两仓同租户、两仓不同、商品同租户、
--     调入门店 store_catalog_items 存在且 is_active=true
--   - ship_transfer:approved → outbound,FEFO 扣源仓批次,写 transfer_out 流水
--   - receive_transfer:outbound/partially_received → received 或 partially_received,
--     实收 > 发货拒绝 INVALID_RECEIVED_QTY;写 transfer_in 流水
--   - 权限:inventory.transfer(已有权限码,不再重复插入)
--   - select 开放浏览器直连(RLS 按 can_access_store);写入一律走 service role RPC
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. 调拨单号序列(TF + 日期 + 序号) =====
create sequence if not exists public.transfer_no_seq;

-- ===== 2. transfers 表(header) =====
create table if not exists public.transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  from_warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  to_warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  transfer_no text not null,
  status text not null default 'draft',
  note text,
  created_by uuid references auth.users(id) on delete set null,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  shipped_by uuid references auth.users(id) on delete set null,
  shipped_at timestamptz,
  received_by uuid references auth.users(id) on delete set null,
  received_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint transfers_status_check check (
    status in ('draft', 'submitted', 'approved', 'outbound', 'partially_received', 'received', 'cancelled')
  )
);

-- ===== 3. transfer_items 表(明细:计划/实发/实收) =====
create table if not exists public.transfer_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  transfer_id uuid not null references public.transfers(id) on delete cascade,
  catalog_item_id uuid not null,
  quantity numeric not null default 0,
  shipped_qty numeric not null default 0,
  received_qty numeric not null default 0,
  batch_no text,
  expires_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint transfer_items_qty_check check (quantity > 0),
  constraint transfer_items_shipped_check check (shipped_qty >= 0 and shipped_qty <= quantity),
  constraint transfer_items_received_check check (received_qty >= 0 and received_qty <= shipped_qty)
);

create unique index if not exists idx_transfers_tenant_no on public.transfers (tenant_id, transfer_no);
create index if not exists idx_transfers_tenant_status on public.transfers (tenant_id, status, created_at desc);
create index if not exists idx_transfers_store on public.transfers (tenant_id, store_id);
create index if not exists idx_transfers_from_wh on public.transfers (tenant_id, from_warehouse_id);
create index if not exists idx_transfers_to_wh on public.transfers (tenant_id, to_warehouse_id);
create index if not exists idx_transfer_items_transfer on public.transfer_items (transfer_id);

drop trigger if exists trg_transfers_updated_at on public.transfers;
create trigger trg_transfers_updated_at
  before update on public.transfers
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_transfer_items_updated_at on public.transfer_items;
create trigger trg_transfer_items_updated_at
  before update on public.transfer_items
  for each row execute procedure public.touch_updated_at();

-- ===== 4. RLS(select 开放浏览器直连,写入仅 service role RPC) =====
alter table public.transfers enable row level security;
alter table public.transfer_items enable row level security;

drop policy if exists "transfers_select" on public.transfers;
create policy "transfers_select" on public.transfers
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "transfer_items_select" on public.transfer_items;
create policy "transfer_items_select" on public.transfer_items
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.transfers t
      where t.id = transfer_items.transfer_id
        and public.can_access_store(t.tenant_id, t.store_id)
    )
  );

-- 写入不建 insert/update/delete 策略,默认拒绝;由 service role RPC 落库

-- ===== 5. create_transfer RPC(创建草稿,R-13 目录约束) =====
-- p_items: [{catalog_item_id, quantity}]
-- 校验:两仓同租户且活跃、两仓不同、每项商品属于租户、调入门店目录存在该商品且 is_active
create or replace function public.create_transfer(
  p_tenant_id uuid,
  p_store_id uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
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
  v_from_wh_count integer;
  v_to_wh_count integer;
  v_catalog_count integer;
  v_store_item_count integer;
  v_tf public.transfers;
  v_item record;
  v_qty numeric;
  v_total_qty numeric := 0;
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

  -- 两仓必须同租户且活跃(对齐现有 transfer_inventory 校验)
  select count(*) into v_from_wh_count
  from public.warehouses
  where id = p_from_warehouse_id and tenant_id = p_tenant_id and is_active = true;
  if v_from_wh_count = 0 then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select count(*) into v_to_wh_count
  from public.warehouses
  where id = p_to_warehouse_id and tenant_id = p_tenant_id and is_active = true;
  if v_to_wh_count = 0 then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 两仓不同
  if p_from_warehouse_id = p_to_warehouse_id then
    raise exception 'SAME_WAREHOUSE' using errcode = 'P0003';
  end if;

  -- 明细校验(R-13):商品属于租户 + 调入门店目录存在且 is_active
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    select count(*) into v_catalog_count
    from public.catalog_items
    where id = (v_item.item->>'catalog_item_id')::uuid and tenant_id = p_tenant_id;
    if v_catalog_count = 0 then
      raise exception 'CATALOG_ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;

    -- 调入门店 store_catalog_items 必须存在该商品且 is_active=true
    select count(*) into v_store_item_count
    from public.store_catalog_items
    where store_id = p_store_id and catalog_item_id = (v_item.item->>'catalog_item_id')::uuid and is_active = true;
    if v_store_item_count = 0 then
      raise exception 'STORE_ITEM_INACTIVE' using errcode = 'P0003';
    end if;
  end loop;

  insert into public.transfers (
    tenant_id, store_id, from_warehouse_id, to_warehouse_id, transfer_no, status, note, created_by
  )
  values (
    p_tenant_id, p_store_id, p_from_warehouse_id, p_to_warehouse_id,
    'TF' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.transfer_no_seq')::text, 4, '0'),
    'draft', p_note, p_operator_id
  )
  returning * into v_tf;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    v_qty := (v_item.item->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
    end if;
    insert into public.transfer_items (tenant_id, transfer_id, catalog_item_id, quantity)
    values (p_tenant_id, v_tf.id, (v_item.item->>'catalog_item_id')::uuid, v_qty);
    v_total_qty := v_total_qty + v_qty;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', it.id,
    'catalogItemId', it.catalog_item_id,
    'quantity', it.quantity,
    'shippedQty', it.shipped_qty,
    'receivedQty', it.received_qty
  )), '[]'::jsonb) into v_items_json
  from public.transfer_items it where it.transfer_id = v_tf.id;

  return jsonb_build_object(
    'id', v_tf.id,
    'tenantId', v_tf.tenant_id,
    'storeId', v_tf.store_id,
    'fromWarehouseId', v_tf.from_warehouse_id,
    'toWarehouseId', v_tf.to_warehouse_id,
    'transferNo', v_tf.transfer_no,
    'status', v_tf.status,
    'totalQty', v_total_qty,
    'items', v_items_json
  );
end;
$$;

-- ===== 6. submit_transfer RPC(draft → submitted) =====
create or replace function public.submit_transfer(
  p_tenant_id uuid,
  p_transfer_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tf public.transfers;
  v_item_count integer;
begin
  select * into v_tf from public.transfers
  where id = p_transfer_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_tf.status <> 'draft' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  select count(*) into v_item_count
  from public.transfer_items where transfer_id = p_transfer_id;
  if v_item_count = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  update public.transfers
  set status = 'submitted', submitted_by = p_operator_id, submitted_at = now()
  where id = p_transfer_id
  returning * into v_tf;

  return jsonb_build_object('id', v_tf.id, 'transferNo', v_tf.transfer_no, 'status', v_tf.status, 'submittedAt', v_tf.submitted_at);
end;
$$;

-- ===== 7. approve_transfer RPC(submitted → approved,禁止自审) =====
create or replace function public.approve_transfer(
  p_tenant_id uuid,
  p_transfer_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tf public.transfers;
begin
  select * into v_tf from public.transfers
  where id = p_transfer_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_tf.status <> 'submitted' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;
  if p_operator_id is not null and v_tf.submitted_by = p_operator_id then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0003';
  end if;

  update public.transfers
  set status = 'approved', approved_by = p_operator_id, approved_at = now()
  where id = p_transfer_id
  returning * into v_tf;

  return jsonb_build_object('id', v_tf.id, 'transferNo', v_tf.transfer_no, 'status', v_tf.status, 'approvedAt', v_tf.approved_at);
end;
$$;

-- ===== 8. cancel_transfer RPC(draft/submitted → cancelled) =====
-- 已审核/已发货/在途/已收货禁止取消(对应 R-12,以取消替代物理删除)
create or replace function public.cancel_transfer(
  p_tenant_id uuid,
  p_transfer_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tf public.transfers;
begin
  select * into v_tf from public.transfers
  where id = p_transfer_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_tf.status not in ('draft', 'submitted') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  update public.transfers
  set status = 'cancelled', cancelled_by = p_operator_id, cancelled_at = now()
  where id = p_transfer_id
  returning * into v_tf;

  return jsonb_build_object('id', v_tf.id, 'transferNo', v_tf.transfer_no, 'status', v_tf.status, 'cancelledAt', v_tf.cancelled_at);
end;
$$;

-- ===== 9. ship_transfer RPC(approved → outbound,FEFO 扣源仓批次) =====
-- 发货:全部明细 shipped_qty = quantity;按 FEFO 扣源仓批次与余额,写 transfer_out 负流水
-- 幂等:同 idempotency_key 返回原结果;每明细子键 = key || ':' || item_id
create or replace function public.ship_transfer(
  p_tenant_id uuid,
  p_transfer_id uuid,
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
  v_tf public.transfers;
  v_item record;
  v_balance public.inventory_balances;
  v_remaining numeric;
  v_batch record;
  v_take numeric;
  v_movement public.inventory_movements;
  v_results jsonb := '[]'::jsonb;
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

  select * into v_tf from public.transfers
  where id = p_transfer_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_tf.status <> 'approved' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  -- 逐项 FEFO 扣源仓
  for v_item in
    select it.* from public.transfer_items it
    where it.transfer_id = p_transfer_id
  loop
    -- 锁余额行(可用量 = on_hand - reserved)
    select * into v_balance from public.inventory_balances
    where warehouse_id = v_tf.from_warehouse_id and catalog_item_id = v_item.catalog_item_id
    for update;
    if not found or v_balance.quantity_on_hand - v_balance.quantity_reserved < v_item.quantity then
      raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0003';
    end if;

    v_remaining := v_item.quantity;
    -- FEFO:按 expiry_date 升序锁定可用批次
    for v_batch in
      select b.id, b.quantity_remaining, b.expiry_date
      from public.inventory_batches b
      where b.warehouse_id = v_tf.from_warehouse_id
        and b.catalog_item_id = v_item.catalog_item_id
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

    -- 扣源仓余额
    update public.inventory_balances
    set quantity_on_hand = quantity_on_hand - v_item.quantity,
        updated_at = now()
    where warehouse_id = v_tf.from_warehouse_id and catalog_item_id = v_item.catalog_item_id
    returning * into v_balance;

    -- 写 transfer_out 负流水
    insert into public.inventory_movements (
      tenant_id, warehouse_id, catalog_item_id, batch_id,
      movement_type, quantity, balance_after,
      reference_type, reference_id, idempotency_key, operator_id
    )
    values (
      p_tenant_id, v_tf.from_warehouse_id, v_item.catalog_item_id, null,
      'transfer_out', -v_item.quantity, v_balance.quantity_on_hand,
      'transfer', v_tf.transfer_no, p_idempotency_key || ':' || v_item.id, p_operator_id
    )
    returning * into v_movement;

    -- 明细标记已发货
    update public.transfer_items
    set shipped_qty = quantity, updated_at = now()
    where id = v_item.id;

    v_results := v_results || jsonb_build_object(
      'itemId', v_item.id,
      'catalogItemId', v_item.catalog_item_id,
      'shippedQty', v_item.quantity,
      'movementId', v_movement.id
    );
  end loop;

  update public.transfers
  set status = 'outbound', shipped_by = p_operator_id, shipped_at = now()
  where id = p_transfer_id
  returning * into v_tf;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'ship_transfer', 'transfer', p_transfer_id, jsonb_build_object(
      'id', v_tf.id,
      'transferNo', v_tf.transfer_no,
      'status', v_tf.status,
      'shippedAt', v_tf.shipped_at,
      'items', v_results
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'id', v_tf.id,
    'transferNo', v_tf.transfer_no,
    'status', v_tf.status,
    'shippedAt', v_tf.shipped_at,
    'items', v_results
  );
end;
$$;

-- ===== 10. receive_transfer RPC(outbound/partially_received → received/partially_received) =====
-- 收货:按实收增目标仓批次与余额,写 transfer_in 正流水
-- 实收 > 发货 → INVALID_RECEIVED_QTY;部分收货 → partially_received 可继续收货;
-- 全部明细收齐 → received
-- 幂等:同 idempotency_key 返回原结果;每明细子键 = key || ':' || item_id
create or replace function public.receive_transfer(
  p_tenant_id uuid,
  p_transfer_id uuid,
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
  v_existing jsonb;
  v_tf public.transfers;
  v_item record;
  v_ti public.transfer_items;
  v_rqty numeric;
  v_new_received numeric;
  v_batch public.inventory_batches;
  v_balance public.inventory_balances;
  v_movement public.inventory_movements;
  v_all_received boolean;
  v_results jsonb := '[]'::jsonb;
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

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  select * into v_tf from public.transfers
  where id = p_transfer_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_tf.status not in ('outbound', 'partially_received') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    select * into v_ti from public.transfer_items
    where id = (v_item.item->>'id')::uuid and transfer_id = p_transfer_id
    for update;
    if not found then
      raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;

    v_rqty := (v_item.item->>'received_quantity')::numeric;
    if v_rqty is null or v_rqty < 0 then
      raise exception 'INVALID_RECEIVED_QTY' using errcode = 'P0003';
    end if;

    -- 本次实收 + 已累计实收不得超过发货量
    v_new_received := v_ti.received_qty + v_rqty;
    if v_new_received > v_ti.shipped_qty then
      raise exception 'INVALID_RECEIVED_QTY' using errcode = 'P0003';
    end if;

    -- 实收 > 0 才增目标仓
    if v_rqty > 0 then
      -- 1) 目标仓创建批次
      insert into public.inventory_batches (
        tenant_id, warehouse_id, catalog_item_id, batch_no,
        received_date, expiry_date,
        quantity_received, quantity_remaining, unit_cost, supplier, status
      )
      values (
        p_tenant_id, v_tf.to_warehouse_id, v_ti.catalog_item_id, (v_item.item->>'batch_no')::text,
        current_date, (v_item.item->>'expires_at')::date,
        v_rqty, v_rqty, null, null, 'active'
      )
      returning * into v_batch;

      -- 2) 目标仓余额增加
      insert into public.inventory_balances (tenant_id, warehouse_id, catalog_item_id, quantity_on_hand, quantity_reserved)
      values (p_tenant_id, v_tf.to_warehouse_id, v_ti.catalog_item_id, v_rqty, 0)
      on conflict (warehouse_id, catalog_item_id)
      do update set quantity_on_hand = inventory_balances.quantity_on_hand + excluded.quantity_on_hand,
                     updated_at = now()
      returning * into v_balance;

      -- 3) 写 transfer_in 正流水
      insert into public.inventory_movements (
        tenant_id, warehouse_id, catalog_item_id, batch_id,
        movement_type, quantity, balance_after,
        reference_type, reference_id, idempotency_key, operator_id
      )
      values (
        p_tenant_id, v_tf.to_warehouse_id, v_ti.catalog_item_id, v_batch.id,
        'transfer_in', v_rqty, v_balance.quantity_on_hand,
        'transfer', v_tf.transfer_no, p_idempotency_key || ':' || v_ti.id, p_operator_id
      )
      returning * into v_movement;
    end if;

    -- 明细累计实收
    update public.transfer_items
    set received_qty = v_new_received,
        batch_no = coalesce((v_item.item->>'batch_no')::text, batch_no),
        expires_at = coalesce((v_item.item->>'expires_at')::date, expires_at),
        updated_at = now()
    where id = v_ti.id;

    v_results := v_results || jsonb_build_object(
      'itemId', v_ti.id,
      'catalogItemId', v_ti.catalog_item_id,
      'shippedQty', v_ti.shipped_qty,
      'receivedQty', v_new_received
    );
  end loop;

  -- 全部明细收齐 → received;否则 partially_received
  select bool_and(received_qty >= shipped_qty) into v_all_received
  from public.transfer_items where transfer_id = p_transfer_id;

  update public.transfers
  set status = case when coalesce(v_all_received, false) then 'received' else 'partially_received' end,
      received_by = p_operator_id,
      received_at = now()
  where id = p_transfer_id
  returning * into v_tf;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'receive_transfer', 'transfer', p_transfer_id, jsonb_build_object(
      'id', v_tf.id,
      'transferNo', v_tf.transfer_no,
      'status', v_tf.status,
      'receivedAt', v_tf.received_at,
      'items', v_results
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'id', v_tf.id,
    'transferNo', v_tf.transfer_no,
    'status', v_tf.status,
    'receivedAt', v_tf.received_at,
    'items', v_results
  );
end;
$$;

-- ===== 11. service-role-only 授权(自包含,幂等;与 migration 96 对齐) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'create_transfer', 'submit_transfer', 'approve_transfer',
    'cancel_transfer', 'ship_transfer', 'receive_transfer'
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
