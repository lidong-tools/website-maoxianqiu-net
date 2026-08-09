-- ============================================================
-- 20260810000251_purchase_return.sql
-- Agent-07 (Stage-04): 采购退货(Purchase Return)
--   - purchase_returns / purchase_return_items
--   - 状态机:draft → submitted → approved → posted;draft/submitted 可取消
--   - 过账(post_purchase_return)走正式库存 Command:
--     SELECT batch FOR UPDATE → 校验可退量 → 扣批次/余额 →
--     写不可变流水 movement_type='return'(负数) → 标记 posted
--     禁止任何直接 update inventory_batches/inventory_balances 绕过流水
--   - 财务边界(RETURN_FINANCE_BOUNDARY):仅记录 return_amount_snapshot /
--     supplier_id / source_po_id 快照,不引入总账;退款/应付冲销留待后续阶段
--   - 幂等:post 以 p_idempotency_key 写入 idempotency_records,
--     movements 唯一索引 (tenant_id, idempotency_key) 防重放
--   - 写入一律走 service role RPC;select 开放浏览器直连(RLS 按 can_access_store)
--   - 权限码:purchase_return.view / create / submit / approve / post
-- 幂等,可重复应用
-- ============================================================
set search_path = public;

-- 退货单号序列(RN + 日期 + 序号)
create sequence if not exists public.purchase_return_no_seq;

-- ===== 1. purchase_returns(采购退货头) =====
create table if not exists public.purchase_returns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  supplier_id uuid references public.suppliers(id) on delete restrict,   -- 退货供应商(可空)
  source_po_id uuid references public.purchase_orders(id) on delete set null, -- 来源采购单(溯源)
  return_no text not null,
  reason text,
  status text not null default 'draft',
  version integer not null default 0,                                     -- 乐观并发版本(流转时递增)
  return_amount_snapshot numeric(12,2) not null default 0,               -- 退货金额快照(财务边界)
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  posted_by uuid references auth.users(id) on delete set null,
  posted_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_returns_status_check check (
    status in ('draft', 'submitted', 'approved', 'posted', 'cancelled')
  )
);

create table if not exists public.purchase_return_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  purchase_return_id uuid not null references public.purchase_returns(id) on delete cascade,
  catalog_item_id uuid not null,                                          -- 商品 id,跨 migration 不加 FK
  batch_id uuid references public.inventory_batches(id) on delete restrict, -- 退出的批次
  source_po_item_id uuid,                                                 -- 来源采购单明细(溯源,可空)
  quantity numeric not null default 0,                                    -- 退货数量(>0)
  unit_cost numeric(12,2) not null default 0,                             -- 单价快照
  amount numeric(12,2) not null default 0,                                -- 金额快照 = quantity * unit_cost
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_return_items_qty_check check (quantity > 0),
  constraint purchase_return_items_amount_check check (amount >= 0)
);

create unique index if not exists idx_purchase_returns_tenant_no on public.purchase_returns (tenant_id, return_no);
create index if not exists idx_purchase_returns_tenant_status on public.purchase_returns (tenant_id, status, created_at desc);
create index if not exists idx_purchase_returns_store on public.purchase_returns (tenant_id, store_id);
create index if not exists idx_pr_return_items_return on public.purchase_return_items (purchase_return_id);
create index if not exists idx_pr_return_items_batch on public.purchase_return_items (batch_id);

drop trigger if exists trg_purchase_returns_updated_at on public.purchase_returns;
create trigger trg_purchase_returns_updated_at
  before update on public.purchase_returns
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_purchase_return_items_updated_at on public.purchase_return_items;
create trigger trg_purchase_return_items_updated_at
  before update on public.purchase_return_items
  for each row execute procedure public.touch_updated_at();

-- ===== 2. RLS(仅读开放;写入 service role) =====
alter table public.purchase_returns enable row level security;
alter table public.purchase_return_items enable row level security;

drop policy if exists "purchase_returns_select" on public.purchase_returns;
create policy "purchase_returns_select" on public.purchase_returns
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "purchase_return_items_select" on public.purchase_return_items;
create policy "purchase_return_items_select" on public.purchase_return_items
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.purchase_returns r
      where r.id = purchase_return_items.purchase_return_id
        and public.can_access_store(r.tenant_id, r.store_id)
    )
  );

-- ===== 3. 权限码 =====
insert into public.permissions (code, name, module) values
  ('purchase_return.view', '查看采购退货', 'inventory'),
  ('purchase_return.create', '新建采购退货', 'inventory'),
  ('purchase_return.submit', '提交采购退货', 'inventory'),
  ('purchase_return.approve', '审核采购退货', 'inventory'),
  ('purchase_return.post', '采购退货过账', 'inventory')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'store_manager')
  and p.code in (
    'purchase_return.view', 'purchase_return.create', 'purchase_return.submit',
    'purchase_return.approve', 'purchase_return.post'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'purchase_return.view', 'purchase_return.create', 'purchase_return.submit',
    'purchase_return.approve', 'purchase_return.post'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;

-- ===== 4. 创建退货草稿 =====
-- p_items: [{catalog_item_id, batch_id, source_po_item_id, quantity, unit_cost, note}]
create or replace function public.create_purchase_return(
  p_tenant_id uuid,
  p_store_id uuid,
  p_warehouse_id uuid,
  p_supplier_id uuid default null,
  p_source_po_id uuid default null,
  p_reason text default null,
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
  v_po_count integer;
  v_ret public.purchase_returns;
  v_item record;
  v_catalog_count integer;
  v_batch_count integer;
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

  -- 来源采购单须属于目标租户
  if p_source_po_id is not null then
    select count(*) into v_po_count
    from public.purchase_orders where id = p_source_po_id and tenant_id = p_tenant_id;
    if v_po_count = 0 then
      raise exception 'PURCHASE_ORDER_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  -- 明细校验:商品归属租户;批次归属仓库且存在
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    select count(*) into v_catalog_count
    from public.catalog_items
    where id = (v_item.item->>'catalog_item_id')::uuid and tenant_id = p_tenant_id;
    if v_catalog_count = 0 then
      raise exception 'CATALOG_ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;
    select count(*) into v_batch_count
    from public.inventory_batches
    where id = (v_item.item->>'batch_id')::uuid
      and tenant_id = p_tenant_id
      and warehouse_id = p_warehouse_id;
    if v_batch_count = 0 then
      raise exception 'BATCH_NOT_FOUND' using errcode = 'P0002';
    end if;
  end loop;

  insert into public.purchase_returns (
    tenant_id, store_id, warehouse_id, supplier_id, source_po_id, return_no, reason, status, created_by
  )
  values (
    p_tenant_id, p_store_id, p_warehouse_id, p_supplier_id, p_source_po_id,
    'RN' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.purchase_return_no_seq')::text, 4, '0'),
    p_reason, 'draft', p_operator_id
  )
  returning * into v_ret;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    declare
      v_qty numeric := (v_item.item->>'quantity')::numeric;
      v_cost numeric := (v_item.item->>'unit_cost')::numeric;
      v_amount numeric;
    begin
      if v_qty is null or v_qty <= 0 then
        raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
      end if;
      v_cost := coalesce(v_cost, 0);
      v_amount := v_qty * v_cost;
      insert into public.purchase_return_items (
        tenant_id, purchase_return_id, catalog_item_id, batch_id, source_po_item_id,
        quantity, unit_cost, amount, note
      )
      values (
        p_tenant_id, v_ret.id, (v_item.item->>'catalog_item_id')::uuid,
        (v_item.item->>'batch_id')::uuid, (v_item.item->>'source_po_item_id')::uuid,
        v_qty, v_cost, v_amount, (v_item.item->>'note')::text
      );
      v_total := v_total + v_amount;
    end;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', it.id,
    'catalogItemId', it.catalog_item_id,
    'batchId', it.batch_id,
    'sourcePoItemId', it.source_po_item_id,
    'quantity', it.quantity,
    'unitCost', it.unit_cost,
    'amount', it.amount,
    'note', it.note
  )), '[]'::jsonb) into v_items_json
  from public.purchase_return_items it where it.purchase_return_id = v_ret.id;

  return jsonb_build_object(
    'id', v_ret.id,
    'tenantId', v_ret.tenant_id,
    'storeId', v_ret.store_id,
    'warehouseId', v_ret.warehouse_id,
    'supplierId', v_ret.supplier_id,
    'sourcePoId', v_ret.source_po_id,
    'returnNo', v_ret.return_no,
    'status', v_ret.status,
    'version', v_ret.version,
    'returnAmountSnapshot', v_total,
    'items', v_items_json
  );
end;
$$;

-- ===== 5. 编辑草稿(仅 draft,替换全部明细) =====
create or replace function public.update_purchase_return_draft(
  p_tenant_id uuid,
  p_return_id uuid,
  p_warehouse_id uuid,
  p_supplier_id uuid default null,
  p_source_po_id uuid default null,
  p_reason text default null,
  p_items jsonb default '[]'::jsonb,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret public.purchase_returns;
  v_wh_count integer;
  v_supplier_count integer;
  v_po_count integer;
  v_item record;
  v_catalog_count integer;
  v_batch_count integer;
  v_total numeric(12,2) := 0;
  v_items_json jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  select * into v_ret from public.purchase_returns
  where id = p_return_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_RETURN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_ret.status <> 'draft' then
    raise exception 'NOT_DRAFT' using errcode = 'P0003';
  end if;

  select count(*) into v_wh_count
  from public.warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id and store_id = v_ret.store_id and is_active = true;
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

  if p_source_po_id is not null then
    select count(*) into v_po_count
    from public.purchase_orders where id = p_source_po_id and tenant_id = p_tenant_id;
    if v_po_count = 0 then
      raise exception 'PURCHASE_ORDER_NOT_FOUND' using errcode = 'P0002';
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
    select count(*) into v_batch_count
    from public.inventory_batches
    where id = (v_item.item->>'batch_id')::uuid
      and tenant_id = p_tenant_id
      and warehouse_id = p_warehouse_id;
    if v_batch_count = 0 then
      raise exception 'BATCH_NOT_FOUND' using errcode = 'P0002';
    end if;
  end loop;

  delete from public.purchase_return_items where purchase_return_id = p_return_id;
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    declare
      v_qty numeric := (v_item.item->>'quantity')::numeric;
      v_cost numeric := (v_item.item->>'unit_cost')::numeric;
      v_amount numeric;
    begin
      if v_qty is null or v_qty <= 0 then
        raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
      end if;
      v_cost := coalesce(v_cost, 0);
      v_amount := v_qty * v_cost;
      insert into public.purchase_return_items (
        tenant_id, purchase_return_id, catalog_item_id, batch_id, source_po_item_id,
        quantity, unit_cost, amount, note
      )
      values (
        p_tenant_id, p_return_id, (v_item.item->>'catalog_item_id')::uuid,
        (v_item.item->>'batch_id')::uuid, (v_item.item->>'source_po_item_id')::uuid,
        v_qty, v_cost, v_amount, (v_item.item->>'note')::text
      );
      v_total := v_total + v_amount;
    end;
  end loop;

  update public.purchase_returns
  set warehouse_id = p_warehouse_id, supplier_id = p_supplier_id, source_po_id = p_source_po_id,
      reason = p_reason, updated_at = now()
  where id = p_return_id
  returning * into v_ret;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', it.id,
    'catalogItemId', it.catalog_item_id,
    'batchId', it.batch_id,
    'sourcePoItemId', it.source_po_item_id,
    'quantity', it.quantity,
    'unitCost', it.unit_cost,
    'amount', it.amount,
    'note', it.note
  )), '[]'::jsonb) into v_items_json
  from public.purchase_return_items it where it.purchase_return_id = p_return_id;

  return jsonb_build_object(
    'id', v_ret.id,
    'tenantId', v_ret.tenant_id,
    'storeId', v_ret.store_id,
    'warehouseId', v_ret.warehouse_id,
    'supplierId', v_ret.supplier_id,
    'sourcePoId', v_ret.source_po_id,
    'returnNo', v_ret.return_no,
    'status', v_ret.status,
    'version', v_ret.version,
    'returnAmountSnapshot', v_total,
    'items', v_items_json
  );
end;
$$;

-- ===== 6. 提交(draft → submitted) =====
create or replace function public.submit_purchase_return(
  p_tenant_id uuid,
  p_return_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret public.purchase_returns;
  v_item_count integer;
begin
  select * into v_ret from public.purchase_returns
  where id = p_return_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_RETURN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_ret.status <> 'draft' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  select count(*) into v_item_count
  from public.purchase_return_items where purchase_return_id = p_return_id and quantity > 0;
  if v_item_count = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  update public.purchase_returns
  set status = 'submitted', submitted_by = p_operator_id, submitted_at = now(), version = version + 1
  where id = p_return_id
  returning * into v_ret;

  return jsonb_build_object('id', v_ret.id, 'status', v_ret.status, 'submittedAt', v_ret.submitted_at, 'version', v_ret.version);
end;
$$;

-- ===== 7. 审核(submitted → approved) =====
create or replace function public.approve_purchase_return(
  p_tenant_id uuid,
  p_return_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret public.purchase_returns;
begin
  select * into v_ret from public.purchase_returns
  where id = p_return_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_RETURN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_ret.status <> 'submitted' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  update public.purchase_returns
  set status = 'approved', approved_by = p_operator_id, approved_at = now(), version = version + 1
  where id = p_return_id
  returning * into v_ret;

  return jsonb_build_object('id', v_ret.id, 'status', v_ret.status, 'approvedAt', v_ret.approved_at, 'version', v_ret.version);
end;
$$;

-- ===== 8. 取消(draft / submitted → cancelled) =====
create or replace function public.cancel_purchase_return(
  p_tenant_id uuid,
  p_return_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret public.purchase_returns;
begin
  select * into v_ret from public.purchase_returns
  where id = p_return_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_RETURN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_ret.status not in ('draft', 'submitted') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  update public.purchase_returns
  set status = 'cancelled', cancelled_by = p_operator_id, cancelled_at = now(), version = version + 1
  where id = p_return_id
  returning * into v_ret;

  return jsonb_build_object('id', v_ret.id, 'status', v_ret.status, 'cancelledAt', v_ret.cancelled_at);
end;
$$;

-- ===== 9. 过账(approved → posted;正式库存 Command,幂等) =====
-- 事务:逐条锁 batch FOR UPDATE → 校验可退量 → 扣批次/余额 →
--      写不可变流水 movement_type='return'(负数,reference_type='purchase_return')
-- 并发:同批次两笔退货同时过账,后到者按扣减后余额校验,库存不足抛 INSUFFICIENT_STOCK
create or replace function public.post_purchase_return(
  p_tenant_id uuid,
  p_return_id uuid,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret public.purchase_returns;
  v_existing jsonb;
  v_item record;
  v_batch public.inventory_batches;
  v_balance public.inventory_balances;
  v_movement public.inventory_movements;
  v_total numeric(12,2) := 0;
  v_results jsonb := '[]'::jsonb;
begin
  -- 幂等检查:整体过账键命中 → 直接返回原结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  select * into v_ret from public.purchase_returns
  where id = p_return_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PURCHASE_RETURN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_ret.status <> 'approved' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  -- 逐条过账:锁批次行,校验可退量,扣批次/余额,写 return 流水
  for v_item in
    select it.id as item_id, it.catalog_item_id, it.batch_id, it.quantity, it.unit_cost, it.amount
    from public.purchase_return_items it
    where it.purchase_return_id = p_return_id
    order by it.id
  loop
    select * into v_batch from public.inventory_batches
    where id = v_item.batch_id and tenant_id = p_tenant_id
    for update;
    if not found then
      raise exception 'BATCH_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_batch.quantity_remaining < v_item.quantity then
      raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0003';
    end if;

    -- 扣批次剩余量(耗尽则标记 exhausted)
    if v_item.quantity >= v_batch.quantity_remaining then
      update public.inventory_batches
      set quantity_remaining = 0, status = 'exhausted', updated_at = now()
      where id = v_batch.id;
    else
      update public.inventory_batches
      set quantity_remaining = quantity_remaining - v_item.quantity, updated_at = now()
      where id = v_batch.id;
    end if;

    -- 扣余额(excluded.quantity_on_hand 为负值,相加即扣减;无余额行则新建为负后回退,
    -- 正常流程下收货必先建余额行,此处兜底防新行负余额)
    insert into public.inventory_balances (tenant_id, warehouse_id, catalog_item_id, quantity_on_hand, quantity_reserved)
    values (p_tenant_id, v_batch.warehouse_id, v_item.catalog_item_id, -v_item.quantity, 0)
    on conflict (warehouse_id, catalog_item_id)
    do update set quantity_on_hand = inventory_balances.quantity_on_hand + excluded.quantity_on_hand,
                   updated_at = now()
    returning * into v_balance;

    -- 写不可变流水(return,负数;幂等键唯一)
    insert into public.inventory_movements (
      tenant_id, warehouse_id, catalog_item_id, batch_id,
      movement_type, quantity, balance_after,
      reference_type, reference_id, idempotency_key, operator_id
    )
    values (
      p_tenant_id, v_batch.warehouse_id, v_item.catalog_item_id, v_batch.id,
      'return', -v_item.quantity, v_balance.quantity_on_hand,
      'purchase_return', p_return_id::text,
      case when p_idempotency_key is not null and p_idempotency_key <> ''
           then p_idempotency_key || ':' || v_item.item_id end,
      p_operator_id
    )
    returning * into v_movement;

    v_total := v_total + v_item.amount;
    v_results := v_results || jsonb_build_object(
      'itemId', v_item.item_id,
      'batchId', v_batch.id,
      'movementId', v_movement.id,
      'quantity', v_item.quantity,
      'balanceAfter', v_balance.quantity_on_hand
    );
  end loop;

  -- 标记退货已过账,快照退货金额(财务边界:仅快照,不引入总账)
  update public.purchase_returns
  set status = 'posted', posted_by = p_operator_id, posted_at = now(),
      return_amount_snapshot = v_total, version = version + 1
  where id = p_return_id
  returning * into v_ret;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'post_purchase_return', 'purchase_return', v_ret.id, jsonb_build_object(
      'id', v_ret.id,
      'returnNo', v_ret.return_no,
      'status', v_ret.status,
      'returnAmountSnapshot', v_total,
      'items', v_results
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'id', v_ret.id,
    'returnNo', v_ret.return_no,
    'status', v_ret.status,
    'postedAt', v_ret.posted_at,
    'returnAmountSnapshot', v_total,
    'items', v_results
  );
end;
$$;

-- ===== 10. service-role-only 授权(自包含,幂等) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'create_purchase_return', 'update_purchase_return_draft', 'submit_purchase_return',
    'approve_purchase_return', 'cancel_purchase_return', 'post_purchase_return'
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
