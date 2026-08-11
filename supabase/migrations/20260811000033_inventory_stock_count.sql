-- ============================================================
-- 20260811000033_inventory_stock_count.sql
-- 库存域修复 R-5/R-6/R-7/R-8(3.5.4 盘点快照/范围/审核/取消)
--   - stock_counts / stock_count_items 单据表(参照 purchase_orders 同构)
--   - 创建时快照账面余额(book_snapshot/counting_items jsonb 冗余,创建后出入库不影响快照)
--   - 盘点范围 scope: all | category | item + 过滤条件
--   - 状态机:draft → counting → submitted → approved → posted;draft/counting/submitted 可取消
--   - 过账(post_stock_count_doc)才按实盘调整余额,写 count_gain/count_loss 流水(替代统一 adjust)
--   - 权限:inventory.count(已有权限码,不再重复插入)
--   - select 开放浏览器直连(RLS 按 can_access_store);写入一律走 service role RPC
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. 盘点单号序列(SC + 日期 + 序号) =====
create sequence if not exists public.stock_count_no_seq;

-- ===== 2. inventory_movements.movement_type 扩展 count_gain/count_loss =====
alter table public.inventory_movements drop constraint if exists inventory_movements_type_check;
alter table public.inventory_movements add constraint inventory_movements_type_check check (
  movement_type in ('receive', 'dispense', 'adjust', 'transfer_in', 'transfer_out', 'return', 'reserve', 'confirm', 'release', 'count_gain', 'count_loss')
);

-- ===== 3. stock_counts 表(header) =====
create table if not exists public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  count_no text not null,
  status text not null default 'draft',
  scope text not null default 'all',
  category_id uuid references public.catalog_categories(id) on delete set null,
  book_snapshot jsonb not null default '[]'::jsonb,
  counting_items jsonb not null default '[]'::jsonb,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  posted_by uuid references auth.users(id) on delete set null,
  posted_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint stock_counts_status_check check (
    status in ('draft', 'counting', 'submitted', 'approved', 'posted', 'cancelled')
  ),
  constraint stock_counts_scope_check check (scope in ('all', 'category', 'item'))
);

-- ===== 4. stock_count_items 表(明细:快照账面 + 实盘数) =====
create table if not exists public.stock_count_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  stock_count_id uuid not null references public.stock_counts(id) on delete cascade,
  catalog_item_id uuid not null,
  book_quantity numeric not null default 0,
  counted_quantity numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint stock_count_items_book_check check (book_quantity >= 0),
  constraint stock_count_items_counted_check check (counted_quantity is null or counted_quantity >= 0)
);

create unique index if not exists idx_stock_counts_tenant_no on public.stock_counts (tenant_id, count_no);
create index if not exists idx_stock_counts_tenant_status on public.stock_counts (tenant_id, status, created_at desc);
create index if not exists idx_stock_counts_store on public.stock_counts (tenant_id, store_id);
create index if not exists idx_stock_counts_warehouse on public.stock_counts (tenant_id, warehouse_id);
create index if not exists idx_stock_count_items_count on public.stock_count_items (stock_count_id);

drop trigger if exists trg_stock_counts_updated_at on public.stock_counts;
create trigger trg_stock_counts_updated_at
  before update on public.stock_counts
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_stock_count_items_updated_at on public.stock_count_items;
create trigger trg_stock_count_items_updated_at
  before update on public.stock_count_items
  for each row execute procedure public.touch_updated_at();

-- ===== 5. RLS(select 开放浏览器直连,写入仅 service role RPC) =====
alter table public.stock_counts enable row level security;
alter table public.stock_count_items enable row level security;

drop policy if exists "stock_counts_select" on public.stock_counts;
create policy "stock_counts_select" on public.stock_counts
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "stock_count_items_select" on public.stock_count_items;
create policy "stock_count_items_select" on public.stock_count_items
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.stock_counts sc
      where sc.id = stock_count_items.stock_count_id
        and public.can_access_store(sc.tenant_id, sc.store_id)
    )
  );

-- 写入不建 insert/update/delete 策略,默认拒绝;由 service role RPC 落库

-- ===== 6. create_stock_count RPC(创建盘点草稿 + 按范围快照生成盘点行) =====
-- p_scope: 'all' | 'category' | 'item'
--   - all:快照该仓库全部有余额的 SKU
--   - category:p_category_id 指定品类(含该品类下无余额 SKU,便于盘点新品)
--   - item:p_item_ids 指定商品
-- book_snapshot/counting_items 与明细行同时落库,快照后出入库不影响本次盘点
create or replace function public.create_stock_count(
  p_tenant_id uuid,
  p_store_id uuid,
  p_warehouse_id uuid,
  p_scope text default 'all',
  p_category_id uuid default null,
  p_item_ids jsonb default '[]'::jsonb,
  p_note text default null,
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
  v_sc public.stock_counts;
  v_snapshot jsonb := '[]'::jsonb;
  v_catalog_id uuid;
  v_book numeric;
begin
  if p_scope not in ('all', 'category', 'item') then
    raise exception 'INVALID_SCOPE' using errcode = 'P0003';
  end if;

  select count(*) into v_store_count
  from public.stores where id = p_store_id and tenant_id = p_tenant_id and archived_at is null;
  if v_store_count = 0 then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 仓库必须属于目标 store(对齐 20260810000096 P0-17A 约束)
  select count(*) into v_wh_count
  from public.warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id and store_id = p_store_id and is_active = true;
  if v_wh_count = 0 then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 按范围生成快照
  if p_scope = 'all' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'catalog_item_id', b.catalog_item_id,
      'book_quantity', b.quantity_on_hand
    )), '[]'::jsonb) into v_snapshot
    from public.inventory_balances b
    where b.warehouse_id = p_warehouse_id and b.tenant_id = p_tenant_id;
  elsif p_scope = 'category' then
    if p_category_id is null then
      raise exception 'INVALID_CATEGORY' using errcode = 'P0003';
    end if;
    -- 该品类所有商品(含无余额),账面无记录视为 0
    select coalesce(jsonb_agg(jsonb_build_object(
      'catalog_item_id', ci.id,
      'book_quantity', coalesce(b.quantity_on_hand, 0)
    )), '[]'::jsonb) into v_snapshot
    from public.catalog_items ci
    left join public.inventory_balances b
      on b.catalog_item_id = ci.id and b.warehouse_id = p_warehouse_id
    where ci.tenant_id = p_tenant_id and ci.category_id = p_category_id and ci.is_active = true;
  else
    -- item 范围:校验每个商品属于租户
    if p_item_ids is null or jsonb_array_length(p_item_ids) = 0 then
      raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
    end if;
    for v_catalog_id in
      select (t.item->>'catalog_item_id')::uuid
      from jsonb_array_elements(p_item_ids) as t(item)
    loop
      select count(*) into v_wh_count
      from public.catalog_items
      where id = v_catalog_id and tenant_id = p_tenant_id;
      if v_wh_count = 0 then
        raise exception 'CATALOG_ITEM_NOT_FOUND' using errcode = 'P0002';
      end if;
      select coalesce(b.quantity_on_hand, 0) into v_book
      from public.inventory_balances b
      where b.catalog_item_id = v_catalog_id and b.warehouse_id = p_warehouse_id;
      v_snapshot := v_snapshot || jsonb_build_object(
        'catalog_item_id', v_catalog_id,
        'book_quantity', coalesce(v_book, 0)
      );
    end loop;
  end if;

  if jsonb_array_length(v_snapshot) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  insert into public.stock_counts (
    tenant_id, store_id, warehouse_id, count_no, status, scope, category_id,
    book_snapshot, counting_items, note, created_by
  )
  values (
    p_tenant_id, p_store_id, p_warehouse_id,
    'SC' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.stock_count_no_seq')::text, 4, '0'),
    'draft', p_scope, p_category_id, v_snapshot, v_snapshot, p_note, p_operator_id
  )
  returning * into v_sc;

  -- 明细行与快照一致(counted_quantity 为空,待盘点录入)
  insert into public.stock_count_items (tenant_id, stock_count_id, catalog_item_id, book_quantity)
  select p_tenant_id, v_sc.id, (t.item->>'catalog_item_id')::uuid, (t.item->>'book_quantity')::numeric
  from jsonb_array_elements(v_snapshot) as t(item);

  return jsonb_build_object(
    'id', v_sc.id,
    'tenantId', v_sc.tenant_id,
    'storeId', v_sc.store_id,
    'warehouseId', v_sc.warehouse_id,
    'countNo', v_sc.count_no,
    'status', v_sc.status,
    'scope', v_sc.scope,
    'categoryId', v_sc.category_id,
    'itemCount', jsonb_array_length(v_snapshot)
  );
end;
$$;

-- ===== 7. update_stock_count_counting RPC(录入实盘数量,draft → counting) =====
-- p_items: [{catalog_item_id, counted_quantity}]
-- 校验:明细必须属于本盘点单;实盘数 ≥ 0;counted 后仍可重复更新(未提交前)
create or replace function public.update_stock_count_counting(
  p_tenant_id uuid,
  p_count_id uuid,
  p_items jsonb default '[]'::jsonb,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sc public.stock_counts;
  v_item record;
  v_ci uuid;
  v_counted numeric;
  v_updated jsonb := '[]'::jsonb;
  v_any_updated boolean := false;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  select * into v_sc from public.stock_counts
  where id = p_count_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'STOCK_COUNT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_sc.status not in ('draft', 'counting') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    v_ci := (v_item.item->>'catalog_item_id')::uuid;
    v_counted := (v_item.item->>'counted_quantity')::numeric;
    if v_counted is null or v_counted < 0 then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
    end if;
    update public.stock_count_items
    set counted_quantity = v_counted, updated_at = now()
    where stock_count_id = p_count_id and catalog_item_id = v_ci;
    if not found then
      raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;
    v_any_updated := true;
    v_updated := v_updated || jsonb_build_object('catalogItemId', v_ci, 'countedQuantity', v_counted);
  end loop;

  -- 刷新 counting_items 冗余快照(合并实盘数)
  select coalesce(jsonb_agg(jsonb_build_object(
    'catalog_item_id', it.catalog_item_id,
    'book_quantity', it.book_quantity,
    'counted_quantity', it.counted_quantity
  )), '[]'::jsonb) into v_sc.counting_items
  from public.stock_count_items it where it.stock_count_id = p_count_id;

  if v_any_updated then
    update public.stock_counts
    set status = 'counting', counting_items = v_sc.counting_items
    where id = p_count_id
    returning * into v_sc;
  end if;

  return jsonb_build_object(
    'id', v_sc.id,
    'countNo', v_sc.count_no,
    'status', v_sc.status,
    'updatedItems', v_updated
  );
end;
$$;

-- ===== 8. submit_stock_count RPC(counting/draft → submitted) =====
-- 提交前校验:全部明细已录入实盘数(未录入的拒绝提交)
create or replace function public.submit_stock_count(
  p_tenant_id uuid,
  p_count_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sc public.stock_counts;
  v_uncounted integer;
begin
  select * into v_sc from public.stock_counts
  where id = p_count_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'STOCK_COUNT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_sc.status not in ('draft', 'counting') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  -- 全部明细必须已录入实盘数
  select count(*) into v_uncounted
  from public.stock_count_items
  where stock_count_id = p_count_id and counted_quantity is null;
  if v_uncounted > 0 then
    raise exception 'UNCOUNTED_ITEMS' using errcode = 'P0003';
  end if;

  update public.stock_counts
  set status = 'submitted', submitted_by = p_operator_id, submitted_at = now()
  where id = p_count_id
  returning * into v_sc;

  return jsonb_build_object('id', v_sc.id, 'countNo', v_sc.count_no, 'status', v_sc.status, 'submittedAt', v_sc.submitted_at);
end;
$$;

-- ===== 9. approve_stock_count RPC(submitted → approved,禁止自审) =====
create or replace function public.approve_stock_count(
  p_tenant_id uuid,
  p_count_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sc public.stock_counts;
begin
  select * into v_sc from public.stock_counts
  where id = p_count_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'STOCK_COUNT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_sc.status <> 'submitted' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;
  if p_operator_id is not null and v_sc.submitted_by = p_operator_id then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0003';
  end if;

  update public.stock_counts
  set status = 'approved', approved_by = p_operator_id, approved_at = now()
  where id = p_count_id
  returning * into v_sc;

  return jsonb_build_object('id', v_sc.id, 'countNo', v_sc.count_no, 'status', v_sc.status, 'approvedAt', v_sc.approved_at);
end;
$$;

-- ===== 10. post_stock_count_doc RPC(approved → posted,过账才按实盘调整余额) =====
-- 盘盈(counted > book)写 count_gain 正数流水;盘亏(counted < book)写 count_loss 负数流水
-- 幂等:同 idempotency_key 返回原结果;同一盘点单只能过账一次(状态机保证)
create or replace function public.post_stock_count_doc(
  p_tenant_id uuid,
  p_count_id uuid,
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
  v_sc public.stock_counts;
  v_item record;
  v_balance public.inventory_balances;
  v_diff numeric;
  v_mtype text;
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

  select * into v_sc from public.stock_counts
  where id = p_count_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'STOCK_COUNT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_sc.status <> 'approved' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  -- 逐项按实盘调整余额
  for v_item in
    select it.* from public.stock_count_items it
    where it.stock_count_id = p_count_id
  loop
    select * into v_balance from public.inventory_balances
    where warehouse_id = v_sc.warehouse_id and catalog_item_id = v_item.catalog_item_id
    for update;

    v_diff := coalesce(v_item.counted_quantity, v_item.book_quantity) - v_item.book_quantity;
    if v_diff = 0 then
      v_results := v_results || jsonb_build_object(
        'catalogItemId', v_item.catalog_item_id,
        'adjusted', false
      );
      continue;
    end if;

    -- 盘盈/盘亏:余额直接置为实盘数
    if v_balance is null then
      insert into public.inventory_balances (tenant_id, warehouse_id, catalog_item_id, quantity_on_hand, quantity_reserved)
      values (p_tenant_id, v_sc.warehouse_id, v_item.catalog_item_id, coalesce(v_item.counted_quantity, v_item.book_quantity), 0)
      returning * into v_balance;
    else
      update public.inventory_balances
      set quantity_on_hand = coalesce(v_item.counted_quantity, v_item.book_quantity),
          updated_at = now()
      where id = v_balance.id
      returning * into v_balance;
    end if;

    -- 盘盈 count_gain 正数 / 盘亏 count_loss 负数
    v_mtype := case when v_diff > 0 then 'count_gain' else 'count_loss' end;
    insert into public.inventory_movements (
      tenant_id, warehouse_id, catalog_item_id, batch_id,
      movement_type, quantity, balance_after,
      reference_type, reference_id, idempotency_key, operator_id
    )
    values (
      p_tenant_id, v_sc.warehouse_id, v_item.catalog_item_id, null,
      v_mtype, v_diff, v_balance.quantity_on_hand,
      'stock_count', v_sc.count_no, p_idempotency_key || ':' || v_item.catalog_item_id, p_operator_id
    )
    returning * into v_movement;

    v_results := v_results || jsonb_build_object(
      'catalogItemId', v_item.catalog_item_id,
      'adjusted', true,
      'diff', v_diff,
      'movementType', v_mtype,
      'movementId', v_movement.id
    );
  end loop;

  update public.stock_counts
  set status = 'posted', posted_by = p_operator_id, posted_at = now()
  where id = p_count_id
  returning * into v_sc;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'post_stock_count_doc', 'stock_count', p_count_id, jsonb_build_object(
      'id', v_sc.id,
      'countNo', v_sc.count_no,
      'status', v_sc.status,
      'postedAt', v_sc.posted_at,
      'items', v_results
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'id', v_sc.id,
    'countNo', v_sc.count_no,
    'status', v_sc.status,
    'postedAt', v_sc.posted_at,
    'items', v_results
  );
end;
$$;

-- ===== 11. cancel_stock_count RPC(draft/counting/submitted → cancelled) =====
-- 已审核/已过账禁止取消(对应 R-8,以取消替代物理删除)
create or replace function public.cancel_stock_count(
  p_tenant_id uuid,
  p_count_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sc public.stock_counts;
begin
  select * into v_sc from public.stock_counts
  where id = p_count_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'STOCK_COUNT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_sc.status not in ('draft', 'counting', 'submitted') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  update public.stock_counts
  set status = 'cancelled', cancelled_by = p_operator_id, cancelled_at = now()
  where id = p_count_id
  returning * into v_sc;

  return jsonb_build_object('id', v_sc.id, 'countNo', v_sc.count_no, 'status', v_sc.status, 'cancelledAt', v_sc.cancelled_at);
end;
$$;

-- ===== 12. service-role-only 授权(自包含,幂等;与 migration 96 对齐) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'create_stock_count', 'update_stock_count_counting',
    'submit_stock_count', 'approve_stock_count',
    'post_stock_count_doc', 'cancel_stock_count'
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
