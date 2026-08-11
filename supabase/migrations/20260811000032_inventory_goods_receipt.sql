-- ============================================================
-- 20260811000032_inventory_goods_receipt.sql
-- 库存域修复 R-1/R-2/R-3(3.5.1 快速入库审核方案 A 完整状态机)
--   - goods_receipts / goods_receipt_items 单据表(参照 purchase_orders 同构)
--   - 状态机:draft → submitted → approved → posted;draft/submitted 可取消
--   - 过账(post_goods_receipt_doc)才复用现有 post_goods_receipt 增加库存,幂等键强制
--   - 权限:inventory.receive(已有权限码,不再重复插入)
--   - select 开放浏览器直连(RLS 按 can_access_store);写入一律走 service role RPC
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. 入库单号序列(GR + 日期 + 序号) =====
create sequence if not exists public.goods_receipt_no_seq;

-- ===== 2. goods_receipts 表(header) =====
create table if not exists public.goods_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  gr_no text not null,
  supplier text,
  status text not null default 'draft',
  total_cost numeric(12,2) not null default 0,
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

  constraint goods_receipts_status_check check (
    status in ('draft', 'submitted', 'approved', 'posted', 'cancelled')
  )
);

-- ===== 3. goods_receipt_items 表(明细) =====
create table if not exists public.goods_receipt_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  goods_receipt_id uuid not null references public.goods_receipts(id) on delete cascade,
  catalog_item_id uuid not null,
  quantity numeric not null default 0,
  unit_cost numeric(12,2) not null default 0,
  batch_no text,
  expires_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint goods_receipt_items_qty_check check (quantity > 0)
);

create unique index if not exists idx_goods_receipts_tenant_no on public.goods_receipts (tenant_id, gr_no);
create index if not exists idx_goods_receipts_tenant_status on public.goods_receipts (tenant_id, status, created_at desc);
create index if not exists idx_goods_receipts_store on public.goods_receipts (tenant_id, store_id);
create index if not exists idx_goods_receipts_warehouse on public.goods_receipts (tenant_id, warehouse_id);
create index if not exists idx_goods_receipt_items_gr on public.goods_receipt_items (goods_receipt_id);

drop trigger if exists trg_goods_receipts_updated_at on public.goods_receipts;
create trigger trg_goods_receipts_updated_at
  before update on public.goods_receipts
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_goods_receipt_items_updated_at on public.goods_receipt_items;
create trigger trg_goods_receipt_items_updated_at
  before update on public.goods_receipt_items
  for each row execute procedure public.touch_updated_at();

-- ===== 4. RLS(select 开放浏览器直连,写入仅 service role RPC) =====
alter table public.goods_receipts enable row level security;
alter table public.goods_receipt_items enable row level security;

drop policy if exists "goods_receipts_select" on public.goods_receipts;
create policy "goods_receipts_select" on public.goods_receipts
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
  );

drop policy if exists "goods_receipt_items_select" on public.goods_receipt_items;
create policy "goods_receipt_items_select" on public.goods_receipt_items
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.goods_receipts gr
      where gr.id = goods_receipt_items.goods_receipt_id
        and public.can_access_store(gr.tenant_id, gr.store_id)
    )
  );

-- 写入不建 insert/update/delete 策略,默认拒绝;由 service role RPC 落库

-- ===== 5. create_goods_receipt RPC(创建草稿 + 明细) =====
-- p_items: [{catalog_item_id, quantity, unit_cost, batch_no, expires_at}]
-- 校验:store 存在、warehouse 属于 store、每项 catalog_item 属于目标租户
create or replace function public.create_goods_receipt(
  p_tenant_id uuid,
  p_store_id uuid,
  p_warehouse_id uuid,
  p_supplier text default null,
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
  v_catalog_count integer;
  v_gr public.goods_receipts;
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

  -- 仓库必须属于目标 store(对齐 20260810000096 P0-17A 约束)
  select count(*) into v_wh_count
  from public.warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id and store_id = p_store_id and is_active = true;
  if v_wh_count = 0 then
    raise exception 'WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 明细 catalog_item 必须属于目标租户
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    select count(*) into v_catalog_count
    from public.catalog_items
    where id = (v_item.item->>'catalog_item_id')::uuid and tenant_id = p_tenant_id;
    if v_catalog_count = 0 then
      raise exception 'CATALOG_ITEM_NOT_FOUND' using errcode = 'P0002';
    end if;
  end loop;

  insert into public.goods_receipts (
    tenant_id, store_id, warehouse_id, gr_no, supplier, status, total_cost, note, created_by
  )
  values (
    p_tenant_id, p_store_id, p_warehouse_id,
    'GR' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.goods_receipt_no_seq')::text, 4, '0'),
    p_supplier, 'draft', 0, p_note, p_operator_id
  )
  returning * into v_gr;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    declare
      v_qty numeric := (v_item.item->>'quantity')::numeric;
      v_cost numeric := (v_item.item->>'unit_cost')::numeric;
    begin
      if v_qty is null or v_qty <= 0 then
        raise exception 'INVALID_QUANTITY' using errcode = 'P0003';
      end if;
      insert into public.goods_receipt_items (
        tenant_id, goods_receipt_id, catalog_item_id, quantity, unit_cost, batch_no, expires_at
      )
      values (
        p_tenant_id, v_gr.id, (v_item.item->>'catalog_item_id')::uuid, v_qty, coalesce(v_cost, 0),
        (v_item.item->>'batch_no')::text, (v_item.item->>'expires_at')::date
      );
      v_total := v_total + v_qty * coalesce(v_cost, 0);
    end;
  end loop;

  update public.goods_receipts set total_cost = v_total where id = v_gr.id returning * into v_gr;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', it.id,
    'catalogItemId', it.catalog_item_id,
    'quantity', it.quantity,
    'unitCost', it.unit_cost,
    'batchNo', it.batch_no,
    'expiresAt', it.expires_at
  )), '[]'::jsonb) into v_items_json
  from public.goods_receipt_items it where it.goods_receipt_id = v_gr.id;

  return jsonb_build_object(
    'id', v_gr.id,
    'tenantId', v_gr.tenant_id,
    'storeId', v_gr.store_id,
    'warehouseId', v_gr.warehouse_id,
    'grNo', v_gr.gr_no,
    'supplier', v_gr.supplier,
    'status', v_gr.status,
    'totalCost', v_gr.total_cost,
    'note', v_gr.note,
    'items', v_items_json
  );
end;
$$;

revoke all on function public.create_goods_receipt(uuid, uuid, uuid, text, text, jsonb, uuid) from public;
grant execute on function public.create_goods_receipt(uuid, uuid, uuid, text, text, jsonb, uuid) to authenticated;

-- ===== 6. submit_goods_receipt RPC(draft → submitted) =====
create or replace function public.submit_goods_receipt(
  p_tenant_id uuid,
  p_gr_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gr public.goods_receipts;
  v_item_count integer;
begin
  select * into v_gr from public.goods_receipts
  where id = p_gr_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'GOODS_RECEIPT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_gr.status <> 'draft' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  -- 空明细不允许提交审核
  select count(*) into v_item_count
  from public.goods_receipt_items where goods_receipt_id = p_gr_id;
  if v_item_count = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  update public.goods_receipts
  set status = 'submitted', submitted_by = p_operator_id, submitted_at = now()
  where id = p_gr_id
  returning * into v_gr;

  return jsonb_build_object('id', v_gr.id, 'grNo', v_gr.gr_no, 'status', v_gr.status, 'submittedAt', v_gr.submitted_at);
end;
$$;

-- ===== 7. approve_goods_receipt RPC(submitted → approved,禁止自审) =====
create or replace function public.approve_goods_receipt(
  p_tenant_id uuid,
  p_gr_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gr public.goods_receipts;
begin
  select * into v_gr from public.goods_receipts
  where id = p_gr_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'GOODS_RECEIPT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_gr.status <> 'submitted' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;
  if p_operator_id is not null and v_gr.submitted_by = p_operator_id then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0003';
  end if;

  update public.goods_receipts
  set status = 'approved', approved_by = p_operator_id, approved_at = now()
  where id = p_gr_id
  returning * into v_gr;

  return jsonb_build_object('id', v_gr.id, 'grNo', v_gr.gr_no, 'status', v_gr.status, 'approvedAt', v_gr.approved_at);
end;
$$;

-- ===== 8. post_goods_receipt_doc RPC(approved → posted,幂等键强制) =====
-- 过账是唯一增加库存的动作:复用现有 post_goods_receipt(不复制库存算法),
-- 每条明细幂等键 = p_idempotency_key || ':' || 明细 id,同一事务任一条失败整体回滚
create or replace function public.post_goods_receipt_doc(
  p_tenant_id uuid,
  p_gr_id uuid,
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
  v_gr public.goods_receipts;
  v_supplier text;
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

  select * into v_gr from public.goods_receipts
  where id = p_gr_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'GOODS_RECEIPT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_gr.status <> 'approved' then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  v_supplier := coalesce(v_gr.supplier, v_gr.gr_no);

  -- 复用 post_goods_receipt:每条明细生成批次/余额/流水(同一事务)
  for v_item in
    select it.* from public.goods_receipt_items it
    where it.goods_receipt_id = p_gr_id
  loop
    v_result := public.post_goods_receipt(
      p_tenant_id,
      v_gr.warehouse_id,
      v_item.catalog_item_id,
      v_item.batch_no,
      v_item.quantity,
      v_item.unit_cost,
      v_item.expires_at,
      v_supplier,
      v_gr.gr_no,
      p_operator_id,
      p_idempotency_key || ':' || v_item.id
    );
    v_posted_total := v_posted_total + v_item.quantity * v_item.unit_cost;
    v_created_items := v_created_items || jsonb_build_object(
      'itemId', v_item.id,
      'catalogItemId', v_item.catalog_item_id,
      'batchId', v_result->>'batchId',
      'balanceId', v_result->>'balanceId',
      'movementId', v_result->>'movementId',
      'quantityOnHand', v_result->>'quantityOnHand'
    );
  end loop;

  update public.goods_receipts
  set status = 'posted', posted_by = p_operator_id, posted_at = now(), total_cost = v_posted_total
  where id = p_gr_id
  returning * into v_gr;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'post_goods_receipt_doc', 'goods_receipt', p_gr_id, jsonb_build_object(
      'id', v_gr.id,
      'grNo', v_gr.gr_no,
      'status', v_gr.status,
      'postedAt', v_gr.posted_at,
      'postedTotal', v_posted_total,
      'items', v_created_items
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'id', v_gr.id,
    'grNo', v_gr.gr_no,
    'status', v_gr.status,
    'postedAt', v_gr.posted_at,
    'postedTotal', v_posted_total,
    'items', v_created_items
  );
end;
$$;

-- ===== 9. cancel_goods_receipt RPC(draft/submitted → cancelled) =====
-- 已审核/已过账禁止取消(对应 R-2,以取消替代物理删除)
create or replace function public.cancel_goods_receipt(
  p_tenant_id uuid,
  p_gr_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gr public.goods_receipts;
begin
  select * into v_gr from public.goods_receipts
  where id = p_gr_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'GOODS_RECEIPT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_gr.status not in ('draft', 'submitted') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;

  update public.goods_receipts
  set status = 'cancelled', cancelled_by = p_operator_id, cancelled_at = now()
  where id = p_gr_id
  returning * into v_gr;

  return jsonb_build_object('id', v_gr.id, 'grNo', v_gr.gr_no, 'status', v_gr.status, 'cancelledAt', v_gr.cancelled_at);
end;
$$;

-- ===== 10. service-role-only 授权(自包含,幂等;与 migration 96 对齐) =====
-- 覆盖上方 create_goods_receipt 的 authenticated 授权,统一为仅 service_role
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'create_goods_receipt', 'submit_goods_receipt',
    'approve_goods_receipt', 'post_goods_receipt_doc', 'cancel_goods_receipt'
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
