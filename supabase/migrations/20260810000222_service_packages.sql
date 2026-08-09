-- ============================================================
-- 20260810000222_service_packages.sql
-- Agent-05 CRM Growth & Marketing: 套餐/次卡域
--   - service_packages        套餐模板(洗护 10 次卡/疫苗年度套餐/复诊包)
--   - service_package_items   套餐包含的可核销项目(名称/数量快照)
--   - customer_packages       客户已购套餐(剩余次数,行锁防负)
--   - package_redemptions     核销流水(不可变,幂等)
--   - purchase_package()      购买开卡(remaining = items 总次数)
--   - redeem_package()        权威核销(锁 + 防负 + 幂等)
--   - reverse_package_redemption() 冲正核销(恢复次数)
--   - refund_package()        退款(状态 → refunded,次数冻结)
-- 原则:
--   - Redemption Ledger 不可变,仅可通过冲正恢复
--   - 并发核销防负次数(条件 UPDATE + 行锁)
-- 权限:
--   marketing.view / marketing.manage / marketing.adjust_entitlement(见 221)
-- ============================================================
set search_path = public;

-- ===== 1. service_packages 表 =====
create table if not exists public.service_packages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  price numeric(12,2) not null default 0,
  validity_days integer,                            -- null=长期有效
  store_id uuid references public.stores(id) on delete cascade, -- null=全门店
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_packages_price_check check (price >= 0),
  constraint service_packages_validity_check check (validity_days is null or validity_days > 0)
);

create unique index if not exists idx_service_packages_tenant_code on public.service_packages (tenant_id, code);
create index if not exists idx_service_packages_tenant_active on public.service_packages (tenant_id, is_active);

drop trigger if exists trg_service_packages_updated_at on public.service_packages;
create trigger trg_service_packages_updated_at
  before update on public.service_packages
  for each row execute procedure public.touch_updated_at();

-- ===== 2. service_package_items 表 =====
create table if not exists public.service_package_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  package_id uuid not null references public.service_packages(id) on delete cascade,
  catalog_item_id uuid,                             -- 可空:仅登记名称快照
  name text not null,                               -- 项目名称快照
  quantity integer not null default 1,
  sort_order integer not null default 0,
  constraint service_package_items_quantity_check check (quantity > 0)
);

create index if not exists idx_package_items_package on public.service_package_items (package_id);
create index if not exists idx_package_items_tenant on public.service_package_items (tenant_id);

-- ===== 3. customer_packages 表(客户已购套餐) =====
create table if not exists public.customer_packages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null,
  package_id uuid not null,
  store_id uuid references public.stores(id) on delete set null,   -- 购买门店
  order_invoice_id uuid,                                          -- 购买关联发票
  total_quantity integer not null default 0,
  remaining_quantity integer not null default 0,
  valid_from timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'active',            -- active/expired/refunded/cancelled
  remark text,
  idempotency_key text,                             -- 开卡/退款幂等键
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_packages_status_check check (status in ('active', 'expired', 'refunded', 'cancelled')),
  constraint customer_packages_remaining_check check (remaining_quantity >= 0),
  constraint customer_packages_total_check check (total_quantity >= 0)
);

create index if not exists idx_customer_packages_tenant_customer on public.customer_packages (tenant_id, customer_id, status);
create index if not exists idx_customer_packages_tenant_package on public.customer_packages (tenant_id, package_id);
create unique index if not exists idx_customer_packages_tenant_idem
  on public.customer_packages (tenant_id, idempotency_key)
  where idempotency_key is not null;

drop trigger if exists trg_customer_packages_updated_at on public.customer_packages;
create trigger trg_customer_packages_updated_at
  before update on public.customer_packages
  for each row execute procedure public.touch_updated_at();

-- ===== 4. package_redemptions 表(核销流水,不可变) =====
create table if not exists public.package_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_package_id uuid not null,
  package_item_id uuid,
  customer_id uuid not null,
  catalog_item_id uuid,
  invoice_id uuid,
  quantity integer not null default 1,
  service_date timestamptz not null default now(),
  status text not null default 'normal',            -- normal / reversed
  reversed_by uuid references auth.users(id) on delete set null,
  reversed_at timestamptz,
  idempotency_key text,
  operator_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint package_redemptions_quantity_check check (quantity > 0),
  constraint package_redemptions_status_check check (status in ('normal', 'reversed'))
);

create unique index if not exists idx_package_redemptions_tenant_idem
  on public.package_redemptions (tenant_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_package_redemptions_customer_package on public.package_redemptions (customer_package_id, status);
create index if not exists idx_package_redemptions_invoice on public.package_redemptions (invoice_id) where invoice_id is not null;

-- ===== 5. purchase_package RPC(购买开卡) =====
-- 幂等:同一 idempotency_key 不重复开卡
create or replace function public.purchase_package(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_package_id uuid,
  p_store_id uuid,
  p_invoice_id uuid default null,
  p_idempotency_key text default null,
  p_operator_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pkg record;
  v_total integer;
  v_cp_id uuid;
  v_expires timestamptz;
begin
  if p_idempotency_key is not null then
    select id, total_quantity into v_cp_id, v_total
    from public.customer_packages
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('customer_package_id', v_cp_id, 'idempotent', true);
    end if;
  end if;

  select * into v_pkg from public.service_packages
  where id = p_package_id and tenant_id = p_tenant_id and is_active = true;
  if not found then
    raise exception 'PACKAGE_NOT_FOUND_OR_INACTIVE';
  end if;

  if not exists (
    select 1 from public.customers where id = p_customer_id and tenant_id = p_tenant_id and status = 'active'
  ) then
    raise exception 'CUSTOMER_NOT_FOUND';
  end if;

  -- 总次数 = items 数量之和
  select coalesce(sum(quantity), 0)::int into v_total
  from public.service_package_items
  where package_id = p_package_id;

  if v_pkg.validity_days is not null then
    v_expires := now() + (v_pkg.validity_days || ' days')::interval;
  end if;

  insert into public.customer_packages
    (tenant_id, customer_id, package_id, store_id, order_invoice_id,
     total_quantity, remaining_quantity, valid_from, expires_at, status, created_by)
  values
    (p_tenant_id, p_customer_id, p_package_id, p_store_id, p_invoice_id,
     v_total, v_total, now(), v_expires, 'active', p_operator_id)
  returning id into v_cp_id;

  return jsonb_build_object('customer_package_id', v_cp_id, 'total_quantity', v_total, 'idempotent', false);
end;
$$;

-- ===== 6. redeem_package RPC(权威核销:行锁 + 防负 + 幂等) =====
create or replace function public.redeem_package(
  p_tenant_id uuid,
  p_customer_package_id uuid,
  p_package_item_id uuid,
  p_customer_id uuid,
  p_store_id uuid,
  p_invoice_id uuid default null,
  p_idempotency_key text default null,
  p_operator_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cp record;
  v_item record;
  v_redemption_id uuid;
begin
  -- 幂等
  if p_idempotency_key is not null then
    select id into v_redemption_id
    from public.package_redemptions
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if found then
      return jsonb_build_object('redemption_id', v_redemption_id, 'idempotent', true);
    end if;
  end if;

  -- 锁客户套餐行(防并发核销到负次数)
  select cp.* into v_cp
  from public.customer_packages cp
  where cp.id = p_customer_package_id and cp.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'CUSTOMER_PACKAGE_NOT_FOUND';
  end if;

  if v_cp.status <> 'active' then
    raise exception 'PACKAGE_NOT_ACTIVE';
  end if;
  if v_cp.customer_id <> p_customer_id then
    raise exception 'PACKAGE_CUSTOMER_MISMATCH';
  end if;
  if v_cp.expires_at is not null and v_cp.expires_at < now() then
    raise exception 'PACKAGE_EXPIRED';
  end if;
  if v_cp.remaining_quantity <= 0 then
    raise exception 'PACKAGE_QUANTITY_EXHAUSTED';
  end if;

  -- 项目属于该套餐
  select * into v_item
  from public.service_package_items
  where id = p_package_item_id and package_id = v_cp.package_id;
  if not found then
    raise exception 'PACKAGE_ITEM_NOT_FOUND';
  end if;

  -- 条件扣减:remaining > 0 才扣(防并发竞态双保险)
  update public.customer_packages
  set remaining_quantity = remaining_quantity - 1, updated_at = now()
  where id = v_cp.id and remaining_quantity > 0;
  if not found then
    raise exception 'PACKAGE_QUANTITY_EXHAUSTED';
  end if;

  -- 写不可变流水
  insert into public.package_redemptions
    (tenant_id, customer_package_id, package_item_id, customer_id, catalog_item_id,
     invoice_id, quantity, status, idempotency_key, operator_id)
  values
    (p_tenant_id, v_cp.id, v_item.id, p_customer_id, v_item.catalog_item_id,
     p_invoice_id, 1, 'normal', p_idempotency_key, p_operator_id)
  returning id into v_redemption_id;

  return jsonb_build_object(
    'redemption_id', v_redemption_id,
    'remaining_quantity', v_cp.remaining_quantity - 1,
    'idempotent', false
  );
end;
$$;

-- ===== 7. reverse_package_redemption RPC(冲正:恢复次数) =====
create or replace function public.reverse_package_redemption(
  p_tenant_id uuid,
  p_redemption_id uuid,
  p_reason text,
  p_operator_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_red record;
  v_cp_id uuid;
begin
  select * into v_red
  from public.package_redemptions
  where id = p_redemption_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'REDEMPTION_NOT_FOUND';
  end if;

  if v_red.status <> 'normal' then
    raise exception 'REDEMPTION_NOT_REVERSIBLE';
  end if;

  -- 恢复次数(行锁)
  select id into v_cp_id
  from public.customer_packages
  where id = v_red.customer_package_id and tenant_id = p_tenant_id
  for update;

  update public.customer_packages
  set remaining_quantity = remaining_quantity + v_red.quantity, updated_at = now()
  where id = v_red.customer_package_id;

  update public.package_redemptions
  set status = 'reversed',
      reversed_by = p_operator_id,
      reversed_at = now()
  where id = p_redemption_id;

  return jsonb_build_object('redemption_id', p_redemption_id, 'status', 'reversed');
end;
$$;

-- ===== 8. refund_package RPC(退款:状态 → refunded,次数冻结) =====
create or replace function public.refund_package(
  p_tenant_id uuid,
  p_customer_package_id uuid,
  p_reason text,
  p_idempotency_key text default null,
  p_operator_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cp record;
begin
  if p_idempotency_key is not null then
    select status into v_cp.status
    from public.customer_packages
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if found and v_cp.status = 'refunded' then
      return jsonb_build_object('customer_package_id', p_customer_package_id, 'status', 'refunded', 'idempotent', true);
    end if;
  end if;

  select cp.* into v_cp
  from public.customer_packages cp
  where cp.id = p_customer_package_id and cp.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'CUSTOMER_PACKAGE_NOT_FOUND';
  end if;

  if v_cp.status <> 'active' then
    raise exception 'PACKAGE_NOT_REFUNDABLE';
  end if;

  update public.customer_packages
  set status = 'refunded',
      remark = coalesce(p_reason, remark),
      idempotency_key = coalesce(idempotency_key, p_idempotency_key),
      updated_at = now()
  where id = v_cp.id;

  return jsonb_build_object('customer_package_id', v_cp.id, 'status', 'refunded', 'idempotent', false);
end;
$$;

-- ===== 9. RLS =====
alter table public.service_packages enable row level security;
alter table public.service_package_items enable row level security;
alter table public.customer_packages enable row level security;
alter table public.package_redemptions enable row level security;

drop policy if exists "service_packages_select" on public.service_packages;
create policy "service_packages_select" on public.service_packages
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "service_package_items_select" on public.service_package_items;
create policy "service_package_items_select" on public.service_package_items
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "customer_packages_select" on public.customer_packages;
create policy "customer_packages_select" on public.customer_packages
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop policy if exists "package_redemptions_select" on public.package_redemptions;
create policy "package_redemptions_select" on public.package_redemptions
  for select to authenticated using (public.is_tenant_member(tenant_id));

-- 模板写:marketing.manage
drop policy if exists "service_packages_insert" on public.service_packages;
create policy "service_packages_insert" on public.service_packages
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'));

drop policy if exists "service_packages_update" on public.service_packages;
create policy "service_packages_update" on public.service_packages
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'));

drop policy if exists "service_packages_delete" on public.service_packages;
create policy "service_packages_delete" on public.service_packages
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.manage'));

-- 客户套餐调整:marketing.adjust_entitlement
drop policy if exists "customer_packages_insert" on public.customer_packages;
create policy "customer_packages_insert" on public.customer_packages
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.adjust_entitlement'));

drop policy if exists "customer_packages_update" on public.customer_packages;
create policy "customer_packages_update" on public.customer_packages
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.adjust_entitlement'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'marketing.adjust_entitlement'));

-- ===== 10. 高危 RPC ACL:仅 service_role =====
revoke all on function public.purchase_package(uuid, uuid, uuid, uuid, uuid, text, uuid) from public;
revoke all on function public.purchase_package(uuid, uuid, uuid, uuid, uuid, text, uuid) from anon;
revoke all on function public.purchase_package(uuid, uuid, uuid, uuid, uuid, text, uuid) from authenticated;
grant execute on function public.purchase_package(uuid, uuid, uuid, uuid, uuid, text, uuid) to service_role;

revoke all on function public.redeem_package(uuid, uuid, uuid, uuid, uuid, uuid, text, uuid) from public;
revoke all on function public.redeem_package(uuid, uuid, uuid, uuid, uuid, uuid, text, uuid) from anon;
revoke all on function public.redeem_package(uuid, uuid, uuid, uuid, uuid, uuid, text, uuid) from authenticated;
grant execute on function public.redeem_package(uuid, uuid, uuid, uuid, uuid, uuid, text, uuid) to service_role;

revoke all on function public.reverse_package_redemption(uuid, uuid, text, uuid) from public;
revoke all on function public.reverse_package_redemption(uuid, uuid, text, uuid) from anon;
revoke all on function public.reverse_package_redemption(uuid, uuid, text, uuid) from authenticated;
grant execute on function public.reverse_package_redemption(uuid, uuid, text, uuid) to service_role;

revoke all on function public.refund_package(uuid, uuid, text, text, uuid) from public;
revoke all on function public.refund_package(uuid, uuid, text, text, uuid) from anon;
revoke all on function public.refund_package(uuid, uuid, text, text, uuid) from authenticated;
grant execute on function public.refund_package(uuid, uuid, text, text, uuid) to service_role;
