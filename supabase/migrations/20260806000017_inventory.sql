-- ============================================================
-- 20260806000017_inventory.sql
-- MXQ-9001~9008 Inventory 领域:仓库/批次/余额/不可变流水
--   - warehouses / inventory_batches / inventory_balances / inventory_movements
--   - RLS 策略(基于 warehouses 关联 store_id,使用 can_access_store)
--   - RPC:post_goods_receipt / dispense_inventory / post_stock_count / transfer_inventory
--   - 近效期视图:inventory_near_expiry
--   - 权限码:inventory.view / receive / dispense / count / transfer / manage
-- 幂等,可重复应用
--
-- 设计要点:
--   - inventory_movements 不可变:仅建 select/insert 策略,不建 update/delete
--   - 并发安全:RPC 内 SELECT FOR UPDATE 锁 inventory_balances 行,防止超卖
--   - 幂等:inventory_movements 唯一索引 (tenant_id, idempotency_key) + idempotency_records 兜底
--   - FEFO:发药按 expiry_date 升序扣减批次
--   - catalog_item_id 为 uuid,不加 FK 约束(跨 migration 依赖由应用层保证)
-- ============================================================

-- ===== 1. warehouses 表(仓库) =====
create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  code text not null,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 同租户同门店下仓库编码唯一
create unique index if not exists idx_warehouses_tenant_store_code
  on public.warehouses (tenant_id, store_id, code);
create index if not exists idx_warehouses_tenant_store
  on public.warehouses (tenant_id, store_id);
-- 每个门店仅一个默认仓库(部分唯一索引)
create unique index if not exists idx_warehouses_default_per_store
  on public.warehouses (tenant_id, store_id) where is_default = true;

-- ===== 2. inventory_batches 表(库存批次) =====
create table if not exists public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  catalog_item_id uuid not null,                       -- 商品 id,跨 migration 不加 FK
  batch_no text,                                      -- 批次号
  received_date date not null default current_date,
  expiry_date date,                                   -- 失效日期,可空(无期限商品)
  quantity_received numeric not null default 0,
  quantity_remaining numeric not null default 0,
  unit_cost numeric(12,2) not null default 0,
  supplier text,
  status text not null default 'active',              -- active / exhausted / expired
  created_at timestamptz not null default now(),

  constraint inventory_batches_status_check check (status in ('active', 'exhausted', 'expired')),
  constraint inventory_batches_qty_received_check check (quantity_received >= 0),
  constraint inventory_batches_qty_remaining_check check (quantity_remaining >= 0)
);

create index if not exists idx_batches_warehouse_item
  on public.inventory_batches (warehouse_id, catalog_item_id);
create index if not exists idx_batches_warehouse_item_expiry
  on public.inventory_batches (warehouse_id, catalog_item_id, expiry_date asc nulls last);
create index if not exists idx_batches_status
  on public.inventory_batches (tenant_id, status);
create index if not exists idx_batches_expiry
  on public.inventory_batches (tenant_id, expiry_date) where status = 'active';

-- ===== 3. inventory_balances 表(库存余额) =====
create table if not exists public.inventory_balances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  catalog_item_id uuid not null,
  quantity_on_hand numeric not null default 0,
  quantity_reserved numeric not null default 0,
  updated_at timestamptz not null default now(),

  constraint inventory_balances_on_hand_check check (quantity_on_hand >= 0),
  constraint inventory_balances_reserved_check check (quantity_reserved >= 0)
);

-- 同一仓库同一商品仅一条余额记录
create unique index if not exists idx_balances_warehouse_item
  on public.inventory_balances (warehouse_id, catalog_item_id);
create index if not exists idx_balances_tenant
  on public.inventory_balances (tenant_id);

-- ===== 4. inventory_movements 表(不可变流水) =====
create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  catalog_item_id uuid not null,
  batch_id uuid references public.inventory_batches(id) on delete set null,
  movement_type text not null,                        -- receive/dispense/adjust/transfer_in/transfer_out/return
  quantity numeric not null,                          -- 正数入,负数出
  balance_after numeric not null,                     -- 操作后该仓库该商品的在库量
  reference_type text,                                -- 业务来源类型(purchase_order/dispense/stock_count/transfer/...)
  reference_id text,                                  -- 业务单据 id
  idempotency_key text,                               -- 幂等键
  operator_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint inventory_movements_type_check check (
    movement_type in ('receive', 'dispense', 'adjust', 'transfer_in', 'transfer_out', 'return')
  )
);

-- 幂等键唯一(同租户内不可重复),防止重复过账
create unique index if not exists idx_movements_tenant_idem
  on public.inventory_movements (tenant_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_movements_warehouse_item_time
  on public.inventory_movements (warehouse_id, catalog_item_id, created_at desc);
create index if not exists idx_movements_tenant_time
  on public.inventory_movements (tenant_id, created_at desc);
create index if not exists idx_movements_reference
  on public.inventory_movements (tenant_id, reference_type, reference_id);

-- ===== 5. updated_at 触发器(warehouses / inventory_balances) =====
drop trigger if exists trg_warehouses_updated_at on public.warehouses;
create trigger trg_warehouses_updated_at
  before update on public.warehouses
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_balances_updated_at on public.inventory_balances;
create trigger trg_balances_updated_at
  before update on public.inventory_balances
  for each row execute procedure public.touch_updated_at();

-- ===== 6. RLS 策略 =====
alter table public.warehouses enable row level security;
alter table public.inventory_batches enable row level security;
alter table public.inventory_balances enable row level security;
alter table public.inventory_movements enable row level security;

-- warehouses:租户成员可读;门店级数据须有该门店权限
drop policy if exists "warehouses_select" on public.warehouses;
create policy "warehouses_select" on public.warehouses
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "warehouses_insert" on public.warehouses;
create policy "warehouses_insert" on public.warehouses
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inventory.manage')
  );

drop policy if exists "warehouses_update" on public.warehouses;
create policy "warehouses_update" on public.warehouses
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inventory.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'inventory.manage')
  );

drop policy if exists "warehouses_delete" on public.warehouses;
create policy "warehouses_delete" on public.warehouses
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- inventory_batches:通过 warehouse 关联校验门店归属
drop policy if exists "inventory_batches_select" on public.inventory_batches;
create policy "inventory_batches_select" on public.inventory_batches
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.warehouses w
      where w.id = inventory_batches.warehouse_id
        and public.can_access_store(w.tenant_id, w.store_id)
    )
  );

drop policy if exists "inventory_batches_insert" on public.inventory_batches;
create policy "inventory_batches_insert" on public.inventory_batches
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.warehouses w
      where w.id = inventory_batches.warehouse_id
        and public.can_access_store(w.tenant_id, w.store_id)
    )
    and public.has_permission(tenant_id, null, 'inventory.receive')
  );

drop policy if exists "inventory_batches_update" on public.inventory_batches;
create policy "inventory_batches_update" on public.inventory_batches
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.warehouses w
      where w.id = inventory_batches.warehouse_id
        and public.can_access_store(w.tenant_id, w.store_id)
    )
    and public.has_permission(tenant_id, null, 'inventory.receive')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.warehouses w
      where w.id = inventory_batches.warehouse_id
        and public.can_access_store(w.tenant_id, w.store_id)
    )
    and public.has_permission(tenant_id, null, 'inventory.receive')
  );

drop policy if exists "inventory_batches_delete" on public.inventory_batches;
create policy "inventory_batches_delete" on public.inventory_batches
  for delete to authenticated
  using (public.is_system_admin());

-- inventory_balances:通过 warehouse 关联校验门店归属
drop policy if exists "inventory_balances_select" on public.inventory_balances;
create policy "inventory_balances_select" on public.inventory_balances
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.warehouses w
      where w.id = inventory_balances.warehouse_id
        and public.can_access_store(w.tenant_id, w.store_id)
    )
  );

drop policy if exists "inventory_balances_insert" on public.inventory_balances;
create policy "inventory_balances_insert" on public.inventory_balances
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.warehouses w
      where w.id = inventory_balances.warehouse_id
        and public.can_access_store(w.tenant_id, w.store_id)
    )
  );

drop policy if exists "inventory_balances_update" on public.inventory_balances;
create policy "inventory_balances_update" on public.inventory_balances
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.warehouses w
      where w.id = inventory_balances.warehouse_id
        and public.can_access_store(w.tenant_id, w.store_id)
    )
  )
  with check (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.warehouses w
      where w.id = inventory_balances.warehouse_id
        and public.can_access_store(w.tenant_id, w.store_id)
    )
  );

drop policy if exists "inventory_balances_delete" on public.inventory_balances;
create policy "inventory_balances_delete" on public.inventory_balances
  for delete to authenticated
  using (public.is_system_admin());

-- inventory_movements:不可变,仅 select/insert,无 update/delete(默认拒绝即不可变)
drop policy if exists "inventory_movements_select" on public.inventory_movements;
create policy "inventory_movements_select" on public.inventory_movements
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.warehouses w
      where w.id = inventory_movements.warehouse_id
        and public.can_access_store(w.tenant_id, w.store_id)
    )
  );

drop policy if exists "inventory_movements_insert" on public.inventory_movements;
create policy "inventory_movements_insert" on public.inventory_movements
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.warehouses w
      where w.id = inventory_movements.warehouse_id
        and public.can_access_store(w.tenant_id, w.store_id)
    )
  );
-- 显式声明:不创建 update/delete policy,RLS 默认拒绝,确保流水不可变

-- ===== 7. 新增权限码 =====
insert into public.permissions (code, name, module) values
  ('inventory.view', '查看库存', 'inventory'),
  ('inventory.receive', '入库', 'inventory'),
  ('inventory.dispense', '发药', 'inventory'),
  ('inventory.count', '盘点', 'inventory'),
  ('inventory.transfer', '调拨', 'inventory'),
  ('inventory.manage', '仓库管理', 'inventory')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 系统角色补 inventory.* 权限(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'inventory.view', 'inventory.receive', 'inventory.dispense',
    'inventory.count', 'inventory.transfer', 'inventory.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'inventory.view', 'inventory.receive', 'inventory.dispense',
    'inventory.count', 'inventory.transfer'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'inventory.view', 'inventory.receive', 'inventory.dispense',
    'inventory.count', 'inventory.transfer', 'inventory.manage'
  ])
)
where code = 'system_admin' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'inventory.view', 'inventory.receive', 'inventory.dispense',
    'inventory.count', 'inventory.transfer'
  ])
)
where code = 'store_manager' and is_system = true;

-- ===== 8. post_goods_receipt RPC(MXQ-9003 入库) =====
-- 事务:创建 batch → 增加余额 → 写 movement(receive)
-- 幂等:先查 idempotency_records,命中返回原结果
-- 并发:SELECT FOR UPDATE 锁余额行
create or replace function public.post_goods_receipt(
  p_tenant_id uuid,
  p_warehouse_id uuid,
  p_catalog_item_id uuid,
  p_batch_no text default null,
  p_quantity numeric default 0,
  p_unit_cost numeric(12,2) default 0,
  p_expiry_date date default null,
  p_supplier text default null,
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
  v_batch public.inventory_batches;
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
  if p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
  end if;

  -- 1) 创建批次
  insert into public.inventory_batches (
    tenant_id, warehouse_id, catalog_item_id, batch_no,
    received_date, expiry_date,
    quantity_received, quantity_remaining, unit_cost, supplier, status
  )
  values (
    p_tenant_id, p_warehouse_id, p_catalog_item_id, p_batch_no,
    current_date, p_expiry_date,
    p_quantity, p_quantity, p_unit_cost, p_supplier, 'active'
  )
  returning * into v_batch;

  -- 2) 增加余额(SELECT FOR UPDATE 锁行,无则新建)
  insert into public.inventory_balances (tenant_id, warehouse_id, catalog_item_id, quantity_on_hand, quantity_reserved)
  values (p_tenant_id, p_warehouse_id, p_catalog_item_id, p_quantity, 0)
  on conflict (warehouse_id, catalog_item_id)
  do update set quantity_on_hand = inventory_balances.quantity_on_hand + excluded.quantity_on_hand,
                 updated_at = now()
  returning * into v_balance;

  -- 3) 写不可变流水(receive,正数)
  insert into public.inventory_movements (
    tenant_id, warehouse_id, catalog_item_id, batch_id,
    movement_type, quantity, balance_after,
    reference_type, reference_id, idempotency_key, operator_id
  )
  values (
    p_tenant_id, p_warehouse_id, p_catalog_item_id, v_batch.id,
    'receive', p_quantity, v_balance.quantity_on_hand,
    'goods_receipt', p_reference_id, p_idempotency_key, p_operator_id
  )
  returning * into v_movement;

  -- 4) 记录幂等结果(service role 绕过 RLS 写入)
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'post_goods_receipt', 'inventory_batch', v_batch.id, jsonb_build_object(
      'batchId', v_batch.id,
      'balanceId', v_balance.id,
      'movementId', v_movement.id,
      'quantityOnHand', v_balance.quantity_on_hand
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'batchId', v_batch.id,
    'balanceId', v_balance.id,
    'movementId', v_movement.id,
    'quantityOnHand', v_balance.quantity_on_hand
  );
end;
$$;

revoke all on function public.post_goods_receipt(uuid, uuid, uuid, text, numeric, numeric, date, text, text, uuid, text) from public;
grant execute on function public.post_goods_receipt(uuid, uuid, uuid, text, numeric, numeric, date, text, text, uuid, text) to authenticated;

-- ===== 9. dispense_inventory RPC(MXQ-9004 发药,FEFO) =====
-- 事务:FEFO 选 batch → 扣减 balance → 扣减 batch → 写 movement(dispense,负数)
-- 库存不足抛 INSUFFICIENT_STOCK
-- 并发:SELECT FOR UPDATE 锁余额行与批次行
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
  select * into v_balance from public.inventory_balances
  where warehouse_id = p_warehouse_id and catalog_item_id = p_catalog_item_id
  for update;
  if not found or v_balance.quantity_on_hand < p_quantity then
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

-- ===== 10. post_stock_count RPC(MXQ-9005 盘点) =====
-- 逐项对比 balance,写 adjust movement(差值正负)
-- p_items: jsonb 数组 [{catalog_item_id, counted_quantity}]
create or replace function public.post_stock_count(
  p_tenant_id uuid,
  p_warehouse_id uuid,
  p_items jsonb,
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
  v_balance public.inventory_balances;
  v_diff numeric;
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

  -- 校验仓库
  select * into v_warehouse from public.warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  -- 逐项盘点
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    select * into v_balance from public.inventory_balances
    where warehouse_id = p_warehouse_id and catalog_item_id = (v_item.item->>'catalog_item_id')::uuid
    for update;

    if not found then
      -- 无余额记录,视为 0
      v_balance := null;
      v_diff := (v_item.item->>'counted_quantity')::numeric;
    else
      v_diff := (v_item.item->>'counted_quantity')::numeric - v_balance.quantity_on_hand;
    end if;

    -- 跳过无差异项
    if v_diff = 0 then
      v_results := v_results || jsonb_build_object(
        'catalogItemId', v_item.item->>'catalog_item_id',
        'adjusted', false
      );
      continue;
    end if;

    -- 更新余额(无记录则新建)
    if v_balance is null then
      insert into public.inventory_balances (tenant_id, warehouse_id, catalog_item_id, quantity_on_hand, quantity_reserved)
      values (p_tenant_id, p_warehouse_id, (v_item.item->>'catalog_item_id')::uuid, (v_item.item->>'counted_quantity')::numeric, 0)
      returning * into v_balance;
    else
      update public.inventory_balances
      set quantity_on_hand = (v_item.item->>'counted_quantity')::numeric,
          updated_at = now()
      where id = v_balance.id
      returning * into v_balance;
    end if;

    -- 写 adjust 流水(正数加,负数减)
    insert into public.inventory_movements (
      tenant_id, warehouse_id, catalog_item_id, batch_id,
      movement_type, quantity, balance_after,
      reference_type, reference_id, idempotency_key, operator_id
    )
    values (
      p_tenant_id, p_warehouse_id, (v_item.item->>'catalog_item_id')::uuid, null,
      'adjust', v_diff, v_balance.quantity_on_hand,
      'stock_count', p_warehouse_id, p_idempotency_key || ':' || (v_item.item->>'catalog_item_id'), p_operator_id
    )
    returning * into v_movement;

    v_results := v_results || jsonb_build_object(
      'catalogItemId', v_item.item->>'catalog_item_id',
      'adjusted', true,
      'diff', v_diff,
      'movementId', v_movement.id
    );
  end loop;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'post_stock_count', 'inventory_balance', p_warehouse_id, jsonb_build_object(
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

revoke all on function public.post_stock_count(uuid, uuid, jsonb, uuid, text) from public;
grant execute on function public.post_stock_count(uuid, uuid, jsonb, uuid, text) to authenticated;

-- ===== 11. transfer_inventory RPC(MXQ-9006 调拨) =====
-- 事务:扣源 balance → 增目标 balance → 写两条 movement(transfer_out 负数 + transfer_in 正数)
-- 并发:SELECT FOR UPDATE 锁源余额行
create or replace function public.transfer_inventory(
  p_tenant_id uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_catalog_item_id uuid,
  p_quantity numeric,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_wh public.warehouses;
  v_to_wh public.warehouses;
  v_existing jsonb;
  v_from_balance public.inventory_balances;
  v_to_balance public.inventory_balances;
  v_out_movement public.inventory_movements;
  v_in_movement public.inventory_movements;
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
  if p_from_warehouse_id = p_to_warehouse_id then
    raise exception 'SAME_WAREHOUSE' using errcode = 'P0003';
  end if;

  -- 校验两端仓库同租户且活跃
  select * into v_from_wh from public.warehouses
  where id = p_from_warehouse_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'FROM_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_from_wh.is_active is false then
    raise exception 'FROM_WAREHOUSE_INACTIVE' using errcode = 'P0003';
  end if;

  select * into v_to_wh from public.warehouses
  where id = p_to_warehouse_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'TO_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_to_wh.is_active is false then
    raise exception 'TO_WAREHOUSE_INACTIVE' using errcode = 'P0003';
  end if;

  -- 锁源余额行,校验库存充足
  select * into v_from_balance from public.inventory_balances
  where warehouse_id = p_from_warehouse_id and catalog_item_id = p_catalog_item_id
  for update;
  if not found or v_from_balance.quantity_on_hand < p_quantity then
    raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0003';
  end if;

  -- 扣源余额
  update public.inventory_balances
  set quantity_on_hand = quantity_on_hand - p_quantity,
      updated_at = now()
  where warehouse_id = p_from_warehouse_id and catalog_item_id = p_catalog_item_id
  returning * into v_from_balance;

  -- 写 transfer_out 流水(负数)
  insert into public.inventory_movements (
    tenant_id, warehouse_id, catalog_item_id, batch_id,
    movement_type, quantity, balance_after,
    reference_type, reference_id, idempotency_key, operator_id
  )
  values (
    p_tenant_id, p_from_warehouse_id, p_catalog_item_id, null,
    'transfer_out', -p_quantity, v_from_balance.quantity_on_hand,
    'transfer', p_idempotency_key, p_idempotency_key || ':out', p_operator_id
  )
  returning * into v_out_movement;

  -- 增目标余额(无则新建)
  insert into public.inventory_balances (tenant_id, warehouse_id, catalog_item_id, quantity_on_hand, quantity_reserved)
  values (p_tenant_id, p_to_warehouse_id, p_catalog_item_id, p_quantity, 0)
  on conflict (warehouse_id, catalog_item_id)
  do update set quantity_on_hand = inventory_balances.quantity_on_hand + excluded.quantity_on_hand,
                 updated_at = now()
  returning * into v_to_balance;

  -- 写 transfer_in 流水(正数)
  insert into public.inventory_movements (
    tenant_id, warehouse_id, catalog_item_id, batch_id,
    movement_type, quantity, balance_after,
    reference_type, reference_id, idempotency_key, operator_id
  )
  values (
    p_tenant_id, p_to_warehouse_id, p_catalog_item_id, null,
    'transfer_in', p_quantity, v_to_balance.quantity_on_hand,
    'transfer', p_idempotency_key, p_idempotency_key || ':in', p_operator_id
  )
  returning * into v_in_movement;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'transfer_inventory', 'inventory_balance', p_catalog_item_id, jsonb_build_object(
      'fromBalanceId', v_from_balance.id,
      'toBalanceId', v_to_balance.id,
      'outMovementId', v_out_movement.id,
      'inMovementId', v_in_movement.id,
      'fromOnHand', v_from_balance.quantity_on_hand,
      'toOnHand', v_to_balance.quantity_on_hand
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'fromBalanceId', v_from_balance.id,
    'toBalanceId', v_to_balance.id,
    'outMovementId', v_out_movement.id,
    'inMovementId', v_in_movement.id,
    'fromOnHand', v_from_balance.quantity_on_hand,
    'toOnHand', v_to_balance.quantity_on_hand
  );
end;
$$;

revoke all on function public.transfer_inventory(uuid, uuid, uuid, uuid, numeric, uuid, text) from public;
grant execute on function public.transfer_inventory(uuid, uuid, uuid, uuid, numeric, uuid, text) to authenticated;

-- ===== 12. 近效期预警视图(MXQ-9007) =====
-- 30 天内到期且仍有余量的 active 批次
create or replace view public.inventory_near_expiry as
  select
    b.id as batch_id,
    b.tenant_id,
    b.warehouse_id,
    w.store_id,
    w.name as warehouse_name,
    b.catalog_item_id,
    b.batch_no,
    b.expiry_date,
    b.quantity_remaining,
    b.unit_cost,
    b.supplier,
    b.status,
    (b.expiry_date - current_date) as days_to_expiry
  from public.inventory_batches b
  join public.warehouses w on w.id = b.warehouse_id
  where b.status = 'active'
    and b.quantity_remaining > 0
    and b.expiry_date is not null
    and b.expiry_date < current_date + interval '30 days'
    and b.expiry_date >= current_date;

grant select on public.inventory_near_expiry to authenticated;
