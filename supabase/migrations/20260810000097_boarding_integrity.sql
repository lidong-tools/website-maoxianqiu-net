-- ============================================================
-- 20260810000097_boarding_integrity.sql
-- Agent-07 二轮收口(P0-18 / P0-19):寄养事务完整性
--
-- 修复:
-- 1. boarding_change_cage / boarding_checkout 幂等查询缺 tenant 范围:
--      先加载寄养单得到 tenant_id,再按 (tenant_id, idempotency_key) 查幂等,
--      避免跨租户相同 key 返回他人历史结果。
-- 2. boarding_check_in / boarding_book_stay 增加客户/宠物归属校验:
--      customer ∈ tenant;pet ∈ tenant 且 pet.customer_id = customer。
-- 3. boarding_book_stay 拒绝为当前已被占用的笼位预约(当前占用 → CAGE_OCCUPIED)。
-- 4. boarding_add_charge 校验 catalog_item_id 属于寄养单租户。
-- ============================================================

-- ===== 1. boarding_change_cage(幂等按 stay.tenant 限定) =====
create or replace function public.boarding_change_cage(
  p_stay_id uuid,
  p_new_cage_id uuid,
  p_reason text default null,
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
  v_old_cage public.cages;
  v_new_cage public.cages;
  v_existing jsonb;
  v_was_checked_in boolean;
begin
  select * into v_stay from public.boarding_stays
  where id = p_stay_id
  for update;
  if not found then
    raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- P0-18:幂等查询按寄养单 tenant 限定
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = v_stay.tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  if v_stay.status in ('checked_out', 'cancelled') then
    raise exception 'BOARDING_NOT_CHANGEABLE' using errcode = 'P0003';
  end if;

  select * into v_old_cage from public.cages
  where id = v_stay.cage_id and tenant_id = v_stay.tenant_id and store_id = v_stay.store_id
  for update;
  if not found then
    raise exception 'OLD_CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_new_cage from public.cages
  where id = p_new_cage_id and tenant_id = v_stay.tenant_id and store_id = v_stay.store_id
  for update;
  if not found then
    raise exception 'NEW_CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_new_cage.id = v_old_cage.id then
    raise exception 'SAME_CAGE' using errcode = 'P0003';
  end if;
  if v_new_cage.status <> 'available' then
    raise exception 'NEW_CAGE_NOT_AVAILABLE' using errcode = 'P0003';
  end if;

  v_was_checked_in := v_stay.status in ('checked_in', 'in_service', 'checkout_pending');

  update public.boarding_stays
  set cage_id = p_new_cage_id, updated_at = now()
  where id = p_stay_id;

  if v_old_cage.current_boarding_stay_id = v_stay.id then
    update public.cages
    set status = 'available',
        current_boarding_stay_id = null,
        updated_at = now()
    where id = v_old_cage.id;
  end if;

  if v_was_checked_in then
    update public.cages
    set status = 'occupied',
        current_boarding_stay_id = p_stay_id,
        updated_at = now()
    where id = p_new_cage_id;
  end if;

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_stay.tenant_id, p_idempotency_key, 'boarding_change_cage', 'boarding_stay', p_stay_id, jsonb_build_object(
      'stayId', p_stay_id,
      'cageId', p_new_cage_id,
      'status', v_stay.status
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'stayId', p_stay_id,
    'cageId', p_new_cage_id,
    'status', v_stay.status
  );
end;
$$;

-- ===== 2. boarding_book_stay(客户/宠物归属 + 当前占用笼位拒绝预约) =====
create or replace function public.boarding_book_stay(
  p_tenant_id uuid,
  p_store_id uuid,
  p_customer_id uuid,
  p_pet_id uuid,
  p_cage_id uuid,
  p_expected_check_out_at timestamptz default null,
  p_check_in_at timestamptz default null,
  p_diet_notes text default null,
  p_walking_notes text default null,
  p_medication_notes text default null,
  p_vaccine_verified boolean default false,
  p_risk_acknowledged boolean default false,
  p_emergency_contact jsonb default '{}'::jsonb,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.boarding_stays;
  v_boarding_no text;
begin
  -- P0-19:客户/宠物归属校验
  perform 1 from public.customers c
  where c.id = p_customer_id and c.tenant_id = p_tenant_id and c.status not in ('archived', 'merged');
  if not found then
    raise exception 'BOARDING_CUSTOMER_INVALID' using errcode = 'P0003';
  end if;
  perform 1 from public.pets p
  where p.id = p_pet_id and p.tenant_id = p_tenant_id and p.customer_id = p_customer_id;
  if not found then
    raise exception 'BOARDING_PET_INVALID' using errcode = 'P0003';
  end if;

  -- P0-19:笼位归属 + 当前占用拒绝预约
  perform 1 from public.cages
  where id = p_cage_id and tenant_id = p_tenant_id and store_id = p_store_id
    and current_boarding_stay_id is null and current_admission_id is null;
  if not found then
    raise exception 'CAGE_OCCUPIED' using errcode = 'P0002';
  end if;

  v_boarding_no := public.boarding_generate_no(p_tenant_id, p_store_id);

  insert into public.boarding_stays (
    tenant_id, store_id, boarding_no, customer_id, pet_id, cage_id,
    check_in_at, expected_check_out_at, status,
    diet_notes, walking_notes, medication_notes,
    vaccine_verified, risk_acknowledged, emergency_contact, created_by
  )
  values (
    p_tenant_id, p_store_id, v_boarding_no, p_customer_id, p_pet_id, p_cage_id,
    p_check_in_at, p_expected_check_out_at, 'planned',
    p_diet_notes, p_walking_notes, p_medication_notes,
    p_vaccine_verified, p_risk_acknowledged, p_emergency_contact, p_operator_id
  )
  returning * into v_stay;

  return jsonb_build_object(
    'stayId', v_stay.id,
    'boardingNo', v_stay.boarding_no,
    'status', v_stay.status
  );
end;
$$;

-- ===== 3. boarding_check_in(直接入住路径增加客户/宠物归属校验) =====
create or replace function public.boarding_check_in(
  p_tenant_id uuid,
  p_store_id uuid,
  p_customer_id uuid default null,
  p_pet_id uuid default null,
  p_cage_id uuid default null,
  p_expected_check_out_at timestamptz default null,
  p_diet_notes text default null,
  p_walking_notes text default null,
  p_medication_notes text default null,
  p_vaccine_verified boolean default false,
  p_risk_acknowledged boolean default false,
  p_emergency_contact jsonb default '{}'::jsonb,
  p_stay_id uuid default null,
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
  v_cage_id uuid;
  v_tenant_id uuid;
  v_store_id uuid;
  v_existing jsonb;
  v_boarding_no text;
begin
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  if p_stay_id is not null then
    select * into v_stay from public.boarding_stays
    where id = p_stay_id and tenant_id = p_tenant_id and store_id = p_store_id
    for update;
    if not found then
      raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_stay.status in ('checked_in', 'in_service', 'checkout_pending') then
      return jsonb_build_object(
        'stayId', v_stay.id,
        'boardingNo', v_stay.boarding_no,
        'cageId', v_stay.cage_id,
        'status', v_stay.status
      );
    end if;
    if v_stay.status <> 'planned' then
      raise exception 'BOARDING_NOT_CHECK_INABLE' using errcode = 'P0003';
    end if;
    v_cage_id := v_stay.cage_id;
    v_tenant_id := v_stay.tenant_id;
    v_store_id := v_stay.store_id;
  else
    if p_customer_id is null or p_pet_id is null or p_cage_id is null then
      raise exception 'BOARDING_INPUT_REQUIRED' using errcode = 'P0003';
    end if;
    v_cage_id := p_cage_id;
    v_tenant_id := p_tenant_id;
    v_store_id := p_store_id;

    -- P0-19:直接入住路径客户/宠物归属校验
    perform 1 from public.customers c
    where c.id = p_customer_id and c.tenant_id = v_tenant_id and c.status not in ('archived', 'merged');
    if not found then
      raise exception 'BOARDING_CUSTOMER_INVALID' using errcode = 'P0003';
    end if;
    perform 1 from public.pets p
    where p.id = p_pet_id and p.tenant_id = v_tenant_id and p.customer_id = p_customer_id;
    if not found then
      raise exception 'BOARDING_PET_INVALID' using errcode = 'P0003';
    end if;
  end if;

  select * into v_cage from public.cages
  where id = v_cage_id and tenant_id = v_tenant_id and store_id = v_store_id
  for update;
  if not found then
    raise exception 'CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_cage.status <> 'available' then
    raise exception 'CAGE_NOT_AVAILABLE' using errcode = 'P0003';
  end if;

  if p_stay_id is not null then
    update public.boarding_stays
    set status = 'checked_in',
        check_in_at = coalesce(check_in_at, now()),
        expected_check_out_at = coalesce(p_expected_check_out_at, expected_check_out_at),
        updated_at = now()
    where id = v_stay.id
    returning * into v_stay;
  else
    v_boarding_no := public.boarding_generate_no(p_tenant_id, p_store_id);
    insert into public.boarding_stays (
      tenant_id, store_id, boarding_no, customer_id, pet_id, cage_id,
      check_in_at, expected_check_out_at, status,
      diet_notes, walking_notes, medication_notes,
      vaccine_verified, risk_acknowledged, emergency_contact, created_by
    )
    values (
      v_tenant_id, v_store_id, v_boarding_no, p_customer_id, p_pet_id, v_cage_id,
      now(), p_expected_check_out_at, 'checked_in',
      p_diet_notes, p_walking_notes, p_medication_notes,
      p_vaccine_verified, p_risk_acknowledged, p_emergency_contact, p_operator_id
    )
    returning * into v_stay;
  end if;

  update public.cages
  set status = 'occupied',
      current_boarding_stay_id = v_stay.id,
      updated_at = now()
  where id = v_cage_id;

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_tenant_id, p_idempotency_key, 'boarding_check_in', 'boarding_stay', v_stay.id, jsonb_build_object(
      'stayId', v_stay.id,
      'boardingNo', v_stay.boarding_no,
      'cageId', v_cage_id,
      'status', v_stay.status
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'stayId', v_stay.id,
    'boardingNo', v_stay.boarding_no,
    'cageId', v_cage_id,
    'status', v_stay.status
  );
end;
$$;

-- ===== 4. boarding_add_charge(catalog_item 属于寄养单租户) =====
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

  -- P0-19:catalog_item 必须属于寄养单租户
  if p_catalog_item_id is not null then
    perform 1 from public.catalog_items ci
    where ci.id = p_catalog_item_id and ci.tenant_id = v_stay.tenant_id;
    if not found then
      raise exception 'BOARDING_CATALOG_INVALID' using errcode = 'P0003';
    end if;
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

-- ===== 5. boarding_checkout(幂等按寄养单 tenant 限定;保留 Billing 发票集成) =====
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
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_invoice jsonb;
  v_invoice_id uuid;
begin
  -- 先加载寄养单获得 tenant_id(P0-18:幂等按 tenant 限定)
  select * into v_stay from public.boarding_stays
  where id = p_stay_id;
  if not found then
    raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = v_stay.tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 加锁并重读
  select * into v_stay from public.boarding_stays
  where id = p_stay_id
  for update;
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

  -- Billing Invoice(同事务;失败整体回滚)
  if v_total > 0 then
    if v_daily_amount > 0 then
      v_items := v_items || jsonb_build_object(
        'name', '寄养日费(笼位)',
        'unit_price', v_daily_amount,
        'quantity', 1,
        'amount', v_daily_amount,
        'category', 'service'
      );
    end if;
    for v_item in select jsonb_build_object(
        'name', coalesce(sc.description, '寄养服务费'),
        'catalog_item_id', sc.catalog_item_id,
        'unit_price', sc.amount,
        'quantity', 1,
        'amount', sc.amount,
        'category', 'service'
      )
      from public.boarding_service_charges sc
      where sc.boarding_stay_id = p_stay_id
      order by sc.created_at
    loop
      v_items := v_items || v_item;
    end loop;

    v_invoice := public.create_invoice(
      v_stay.tenant_id,
      v_stay.store_id,
      v_stay.customer_id,
      v_stay.pet_id,
      null,
      v_items,
      0, null, 0, null, null,
      p_operator_id,
      false
    );
    v_invoice_id := (v_invoice->>'invoiceId')::uuid;
    if v_invoice_id is null then
      raise exception 'BOARDING_INVOICE_FAILED' using errcode = 'P0003';
    end if;
  end if;

  update public.boarding_stays
  set status = 'checked_out',
      checked_out_at = now(),
      total_charge = v_total,
      updated_at = now()
  where id = p_stay_id
  returning * into v_stay;

  if v_cage is not null and v_cage.current_boarding_stay_id = p_stay_id then
    update public.cages
    set status = 'available',
        current_boarding_stay_id = null,
        updated_at = now()
    where id = v_cage.id;
  end if;

  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_stay.tenant_id, p_idempotency_key, 'boarding_checkout', 'boarding_stay', p_stay_id, jsonb_build_object(
      'stayId', p_stay_id,
      'boardingNo', v_stay.boarding_no,
      'status', v_stay.status,
      'totalCharge', v_total,
      'invoiceId', v_invoice_id,
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
    'invoiceId', v_invoice_id,
    'status', v_stay.status,
    'checkedOutAt', v_stay.checked_out_at
  );
end;
$$;

-- ===== 6. service-role-only 授权(自包含,幂等) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'boarding_change_cage', 'boarding_book_stay', 'boarding_check_in',
    'boarding_add_charge', 'boarding_checkout'
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
