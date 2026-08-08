-- ============================================================
-- 20260810000099_boarding_planned_cage_nullable.sql
-- S3.1 Final-Fix Agent C(C7,审计 42-44):寄养预约笼位语义
--
-- 背景:
--   原模型 boarding_book_stay 要求 planned 状态必须绑定 cage_id,
--   但只查「当前占用」未做未来时间段 overlap ——
--   既可能「现在空闲但下周预约重叠」漏检(太松),
--   又可能「现在有人但下周预约」被拒(太严)。
--
-- Pilot 方案(审计推荐):不开发复杂 Reservation Engine,
--   改为最简单稳定模型:
--     planned 预约阶段不绑定笼位(cage_id 允许 NULL);
--     check-in 入住时才选择并锁定笼位。
--
-- 改动:
--   1. boarding_stays.cage_id DROP NOT NULL;
--   2. boarding_book_stay:p_cage_id 允许 NULL;提供时仍校验归属 + 当前未占用;
--      不提供时创建无笼位预约(planned 不绑定笼位)。
--   3. boarding_check_in:确认预约时若预约未绑定笼位且本次传入笼位 → 采用之;
--      两者皆无 → CAGE_REQUIRED。直接入住路径仍必须提供笼位。
--   4. boarding_change_cage:旧笼为 NULL(planned 未绑定笼位)时跳过旧笼锁定/释放。
--   5. boarding_checkout 已兼容 NULL cage_id(migration 97 版本以 if v_cage is not null 保护),无需改动。
-- 自包含幂等,重复应用安全。
-- ============================================================

-- ===== 1. cage_id 可空(仅入住后必须非空,由 RPC 保证) =====
alter table public.boarding_stays alter column cage_id drop not null;

-- ===== 2. boarding_book_stay:预约阶段笼位可选 =====
create or replace function public.boarding_book_stay(
  p_tenant_id uuid,
  p_store_id uuid,
  p_customer_id uuid,
  p_pet_id uuid,
  p_cage_id uuid default null,
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
  -- 客户/宠物归属校验(与 migration 97 一致)
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

  -- C7:预约阶段笼位可选。提供时仍校验归属 + 当前未占用(防与在养/在院笼位冲突);
  --     不提供时允许创建无笼位预约,入住(check-in)时再选择并锁定。
  if p_cage_id is not null then
    perform 1 from public.cages
    where id = p_cage_id and tenant_id = p_tenant_id and store_id = p_store_id
      and current_boarding_stay_id is null and current_admission_id is null;
    if not found then
      raise exception 'CAGE_OCCUPIED' using errcode = 'P0002';
    end if;
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

-- ===== 3. boarding_check_in:确认预约时允许补选笼位;必须锁定笼位后才能入住 =====
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
    -- C7:预约未绑定笼位时,允许入住时补选笼位;两者皆无 → 拒绝入住
    if v_cage_id is null and p_cage_id is not null then
      v_cage_id := p_cage_id;
    end if;
    if v_cage_id is null then
      raise exception 'CAGE_REQUIRED' using errcode = 'P0003';
    end if;
    v_tenant_id := v_stay.tenant_id;
    v_store_id := v_stay.store_id;
  else
    if p_customer_id is null or p_pet_id is null or p_cage_id is null then
      raise exception 'BOARDING_INPUT_REQUIRED' using errcode = 'P0003';
    end if;
    v_cage_id := p_cage_id;
    v_tenant_id := p_tenant_id;
    v_store_id := p_store_id;

    -- 直接入住路径客户/宠物归属校验(与 migration 97 一致)
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

  -- 锁定笼位,校验可用(occupied 可能是住院占用或寄养占用,一律不可再入住)
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
    -- 确认预约:回填笼位与入住时间(预约可能未绑定笼位,C7 模型)
    update public.boarding_stays
    set status = 'checked_in',
        cage_id = v_cage_id,
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

  -- 占用笼位
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

-- ===== 4. boarding_change_cage:旧笼为空(planned 未绑定笼位)时跳过旧笼锁定/释放 =====
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

  -- 幂等查询按寄养单 tenant 限定
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

  -- C7:旧笼为 NULL(planned 未绑定笼位)时跳过旧笼锁定
  if v_stay.cage_id is not null then
    select * into v_old_cage from public.cages
    where id = v_stay.cage_id and tenant_id = v_stay.tenant_id and store_id = v_stay.store_id
    for update;
    if not found then
      raise exception 'OLD_CAGE_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  -- 锁定新笼,校验可用
  select * into v_new_cage from public.cages
  where id = p_new_cage_id and tenant_id = v_stay.tenant_id and store_id = v_stay.store_id
  for update;
  if not found then
    raise exception 'NEW_CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_stay.cage_id is not null and v_new_cage.id = v_stay.cage_id then
    raise exception 'SAME_CAGE' using errcode = 'P0003';
  end if;
  if v_new_cage.status <> 'available' then
    raise exception 'NEW_CAGE_NOT_AVAILABLE' using errcode = 'P0003';
  end if;

  v_was_checked_in := v_stay.status in ('checked_in', 'in_service', 'checkout_pending');

  -- 更新寄养单笼位
  update public.boarding_stays
  set cage_id = p_new_cage_id, updated_at = now()
  where id = p_stay_id;

  -- 释放旧笼(仅当旧笼确实被该寄养单占用)
  if v_stay.cage_id is not null and v_old_cage.current_boarding_stay_id = v_stay.id then
    update public.cages
    set status = 'available',
        current_boarding_stay_id = null,
        updated_at = now()
    where id = v_old_cage.id;
  end if;

  -- 已入住的寄养单占用新笼
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

-- ===== 5. service-role-only 授权(自包含,幂等;与 migration 92 的最终 ACL 一致) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'boarding_book_stay', 'boarding_check_in', 'boarding_change_cage'
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
