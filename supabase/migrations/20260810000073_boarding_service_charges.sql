-- ============================================================
-- 20260810000073_boarding_service_charges.sql
-- S3.1 寄养额外服务费(Agent-06)
--   - boarding_service_charges:寄养期间附加服务(美容/喂药/加餐等)
--   - 目录项使用 catalog type=boarding(管理员在 Catalog 维护)
--   - 权限:读 boarding.view,写 boarding.manage
--   - boarding_cage_status 视图:寄养房态(共享 cages 占用事实来源)
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. boarding_service_charges 表 =====
create table if not exists public.boarding_service_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  boarding_stay_id uuid not null,                   -- 跨 migration 不加 FK
  catalog_item_id uuid,                             -- 跨 migration 不加 FK(catalog type=boarding)
  description text,
  quantity numeric not null default 1,
  unit_price numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0,
  charge_date date not null default current_date,
  created_by uuid,                                  -- 跨 migration 不加 FK
  created_at timestamptz not null default now(),

  constraint boarding_service_charges_quantity_check check (quantity > 0),
  constraint boarding_service_charges_amount_check check (amount >= 0)
);

create index if not exists idx_boarding_service_charges_stay
  on public.boarding_service_charges (boarding_stay_id, charge_date);
create index if not exists idx_boarding_service_charges_tenant_store
  on public.boarding_service_charges (tenant_id, store_id, charge_date desc);

-- ===== 2. RLS =====
alter table public.boarding_service_charges enable row level security;

drop policy if exists "boarding_service_charges_select" on public.boarding_service_charges;
create policy "boarding_service_charges_select" on public.boarding_service_charges
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'boarding.view')
  );

drop policy if exists "boarding_service_charges_insert" on public.boarding_service_charges;
create policy "boarding_service_charges_insert" on public.boarding_service_charges
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'boarding.manage')
  );

drop policy if exists "boarding_service_charges_delete" on public.boarding_service_charges;
create policy "boarding_service_charges_delete" on public.boarding_service_charges
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- ===== 3. boarding_add_charge RPC(追加额外服务费) =====
create or replace function public.boarding_add_charge(
  p_stay_id uuid,
  p_catalog_item_id uuid default null,
  p_description text default null,
  p_quantity numeric default 1,
  p_unit_price numeric default 0,
  p_charge_date date default current_date,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.boarding_stays;
  v_charge public.boarding_service_charges;
  v_amount numeric(12,2);
begin
  select * into v_stay from public.boarding_stays
  where id = p_stay_id
  for update;
  if not found then
    raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_stay.status not in ('checked_in', 'in_service', 'checkout_pending') then
    raise exception 'BOARDING_NOT_ACTIVE' using errcode = 'P0003';
  end if;
  if p_quantity <= 0 then
    raise exception 'BOARDING_QUANTITY_INVALID' using errcode = 'P0003';
  end if;

  v_amount := round((p_quantity * p_unit_price)::numeric, 2);

  insert into public.boarding_service_charges (
    tenant_id, store_id, boarding_stay_id, catalog_item_id,
    description, quantity, unit_price, amount, charge_date, created_by
  )
  values (
    v_stay.tenant_id, v_stay.store_id, p_stay_id, p_catalog_item_id,
    coalesce(p_description, p_catalog_item_id::text), p_quantity, p_unit_price,
    v_amount, p_charge_date, p_operator_id
  )
  returning * into v_charge;

  return jsonb_build_object(
    'chargeId', v_charge.id,
    'boardingStayId', p_stay_id,
    'amount', v_charge.amount
  );
end;
$$;

-- RPC 权限收紧见本文件末尾 DO 块(仅 service_role)

-- ===== 4. boarding_prepare_checkout(准备离店,计算应收,状态 → checkout_pending) =====
-- 应收 = 笼位日费 × 入住天数 + 额外服务费(boarding_service_charges)
-- 状态:checked_in / in_service → checkout_pending(不释放笼位)
create or replace function public.boarding_prepare_checkout(
  p_stay_id uuid,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.boarding_stays;
  v_cage public.cages;
  v_days integer;
  v_daily_amount numeric(12,2) := 0;
  v_service_amount numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
begin
  select * into v_stay from public.boarding_stays
  where id = p_stay_id
  for update;
  if not found then
    raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_stay.status not in ('checked_in', 'in_service', 'checkout_pending') then
    raise exception 'BOARDING_NOT_CHECKOUT_ABLE' using errcode = 'P0003';
  end if;

  select * into v_cage from public.cages where id = v_stay.cage_id;
  if v_cage is not null and v_cage.daily_rate > 0 then
    v_days := greatest(1, ceil(extract(epoch from (now() - v_stay.check_in_at)) / 86400)::integer);
    v_daily_amount := v_cage.daily_rate * v_days;
  end if;

  select coalesce(sum(amount), 0) into v_service_amount
  from public.boarding_service_charges
  where boarding_stay_id = p_stay_id;

  v_total := v_daily_amount + v_service_amount;

  update public.boarding_stays
  set status = 'checkout_pending', updated_at = now()
  where id = p_stay_id
  returning * into v_stay;

  return jsonb_build_object(
    'stayId', v_stay.id,
    'boardingNo', v_stay.boarding_no,
    'stayDays', v_days,
    'dailyAmount', v_daily_amount,
    'serviceAmount', v_service_amount,
    'totalCharge', v_total,
    'status', v_stay.status
  );
end;
$$;

revoke all on function public.boarding_prepare_checkout(uuid, uuid) from public;
grant execute on function public.boarding_prepare_checkout(uuid, uuid) to authenticated;

-- ===== 5. boarding_checkout(完成离店,释放笼位) =====
-- 事务:锁定寄养单 → 汇总应收 → 状态 → checked_out → 释放笼位
-- 幂等:同 idempotency_key 返回原结果
-- 集成点:Billing Invoice 创建由 Agent-07 在此处前/后接入(见 AGENT-06-HANDOFF)
create or replace function public.boarding_checkout(
  p_stay_id uuid,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.boarding_stays;
  v_cage public.cages;
  v_days integer;
  v_daily_amount numeric(12,2) := 0;
  v_service_amount numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_existing jsonb;
begin
  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  select * into v_stay from public.boarding_stays
  where id = p_stay_id
  for update;
  if not found then
    raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_stay.status not in ('checked_in', 'in_service', 'checkout_pending') then
    raise exception 'BOARDING_NOT_CHECKOUT_ABLE' using errcode = 'P0003';
  end if;

  select * into v_cage from public.cages
  where id = v_stay.cage_id
  for update;

  -- 汇总应收
  if v_cage is not null and v_cage.daily_rate > 0 then
    v_days := greatest(1, ceil(extract(epoch from (now() - v_stay.check_in_at)) / 86400)::integer);
    v_daily_amount := v_cage.daily_rate * v_days;
  end if;
  select coalesce(sum(amount), 0) into v_service_amount
  from public.boarding_service_charges
  where boarding_stay_id = p_stay_id;
  v_total := v_daily_amount + v_service_amount;

  update public.boarding_stays
  set status = 'checked_out',
      checked_out_at = now(),
      total_charge = v_total,
      updated_at = now()
  where id = p_stay_id
  returning * into v_stay;

  -- 释放笼位
  if v_cage is not null and v_cage.current_boarding_stay_id = p_stay_id then
    update public.cages
    set status = 'available',
        current_boarding_stay_id = null,
        updated_at = now()
    where id = v_cage.id;
  end if;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_stay.tenant_id, p_idempotency_key, 'boarding_checkout', 'boarding_stay', p_stay_id, jsonb_build_object(
      'stayId', p_stay_id,
      'boardingNo', v_stay.boarding_no,
      'status', v_stay.status,
      'totalCharge', v_total,
      'checkedOutAt', v_stay.checked_out_at
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'stayId', p_stay_id,
    'boardingNo', v_stay.boarding_no,
    'stayDays', v_days,
    'dailyAmount', v_daily_amount,
    'serviceAmount', v_service_amount,
    'totalCharge', v_total,
    'status', v_stay.status,
    'checkedOutAt', v_stay.checked_out_at
  );
end;
$$;

revoke all on function public.boarding_checkout(uuid, uuid, text) from public;
grant execute on function public.boarding_checkout(uuid, uuid, text) to authenticated;

-- ===== 6. boarding_cage_status 视图(寄养房态看板) =====
-- 与住院共享 cages / rooms 事实来源;关联当前寄养单展示占用信息
create or replace view public.boarding_cage_status as
  select
    c.id as cage_id,
    c.tenant_id,
    c.store_id,
    c.room_id,
    r.name as room_name,
    r.code as room_code,
    r.floor as room_floor,
    r.room_type,
    c.name as cage_name,
    c.code as cage_code,
    c.cage_type,
    c.daily_rate,
    c.status as cage_status,
    c.current_boarding_stay_id,
    c.current_admission_id,
    bs.pet_id,
    bs.customer_id,
    bs.boarding_no,
    bs.check_in_at,
    bs.expected_check_out_at,
    bs.diet_notes,
    bs.walking_notes,
    bs.medication_notes,
    bs.risk_acknowledged,
    bs.status as boarding_status
  from public.cages c
  left join public.rooms r on r.id = c.room_id
  left join public.boarding_stays bs on bs.id = c.current_boarding_stay_id;

grant select on public.boarding_cage_status to authenticated;

-- ===== 7. RPC 权限收紧(仅 service_role,与 migration 29 同模式) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'boarding_add_charge', 'boarding_prepare_checkout', 'boarding_checkout'
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

-- ===== 8. 结束 =====
