-- ============================================================
-- 20260810000071_boarding_stays.sql
-- S3.1 寄养(Boarding)核心表与生命周期 RPC(Agent-06)
--   - boarding_stays 表(寄养记录)
--   - 状态机:planned → checked_in → in_service → checkout_pending → checked_out
--            planned → cancelled
--   - 房位锁:入住/换房/离店均 SELECT FOR UPDATE 锁 cages 行,
--     与住院共用 cages.status / current_occupation 事实来源,禁止双占
--   - RPC:boarding_book_stay / boarding_check_in / boarding_cancel
--         boarding_change_cage / boarding_prepare_checkout / boarding_checkout
--   - 幂等:check_in / change_cage / checkout 走 idempotency_records
--   - 寄养不是医疗病程:每日照护记录在 boarding_daily_records(migration 72)
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. boarding_stays 表(寄养记录) =====
create table if not exists public.boarding_stays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  boarding_no text not null,
  customer_id uuid not null,                        -- 跨 migration 不加 FK
  pet_id uuid not null,                             -- 跨 migration 不加 FK
  cage_id uuid not null,                            -- 同表内引用 cages(id),通过应用层维护
  check_in_at timestamptz,                          -- 预约时为预计入住,入住时刷新为实际
  expected_check_out_at timestamptz,
  checked_out_at timestamptz,
  status text not null default 'planned',            -- planned/checked_in/in_service/checkout_pending/checked_out/cancelled
  diet_notes text,                                  -- 饮食要求
  walking_notes text,                               -- 遛宠要求
  medication_notes text,                            -- 用药要求
  vaccine_verified boolean not null default false,   -- 疫苗核验
  risk_acknowledged boolean not null default false,  -- 风险确认
  emergency_contact jsonb not null default '{}'::jsonb, -- {name, phone, relation}
  total_charge numeric(12,2) not null default 0,
  created_by uuid,                                  -- 跨 migration 不加 FK(auth.users.id)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint boarding_stays_status_check check (
    status in ('planned', 'checked_in', 'in_service', 'checkout_pending', 'checked_out', 'cancelled')
  ),
  constraint boarding_stays_total_charge_check check (total_charge >= 0)
);

create unique index if not exists idx_boarding_stays_tenant_no
  on public.boarding_stays (tenant_id, boarding_no);
create index if not exists idx_boarding_stays_tenant_store
  on public.boarding_stays (tenant_id, store_id);
create index if not exists idx_boarding_stays_pet
  on public.boarding_stays (pet_id);
create index if not exists idx_boarding_stays_customer
  on public.boarding_stays (customer_id);
create index if not exists idx_boarding_stays_cage
  on public.boarding_stays (cage_id);
create index if not exists idx_boarding_stays_status
  on public.boarding_stays (tenant_id, store_id, status);

drop trigger if exists trg_boarding_stays_updated_at on public.boarding_stays;
create trigger trg_boarding_stays_updated_at
  before update on public.boarding_stays
  for each row execute procedure public.touch_updated_at();

-- ===== 2. RLS(写走 security definer RPC,直连写须 boarding.manage) =====
alter table public.boarding_stays enable row level security;

drop policy if exists "boarding_stays_select" on public.boarding_stays;
create policy "boarding_stays_select" on public.boarding_stays
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'boarding.view')
  );

drop policy if exists "boarding_stays_insert" on public.boarding_stays;
create policy "boarding_stays_insert" on public.boarding_stays
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'boarding.manage')
  );

drop policy if exists "boarding_stays_update" on public.boarding_stays;
create policy "boarding_stays_update" on public.boarding_stays
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'boarding.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'boarding.manage')
  );

drop policy if exists "boarding_stays_delete" on public.boarding_stays;
create policy "boarding_stays_delete" on public.boarding_stays
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- ===== 3. 寄养编号生成(与 generate_customer_no 同模式,原子递增) =====
create or replace function public.boarding_generate_no(
  p_tenant_id uuid,
  p_store_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_code text;
  v_date_prefix text := to_char(now(), 'YYYYMMDD');
  v_seq_key text := 'boarding-' || v_date_prefix;
  v_next_seq integer;
  v_result text;
begin
  select s.code into v_store_code
  from public.stores s
  where s.id = p_store_id and s.tenant_id = p_tenant_id;

  if v_store_code is null or v_store_code = '' then
    v_store_code := 'TENANT';
  end if;

  insert into public.business_sequences (tenant_id, store_id, sequence_key, last_seq)
  values (p_tenant_id, p_store_id, v_seq_key, 1)
  on conflict (tenant_id, store_id, sequence_key)
  do update set last_seq = business_sequences.last_seq + 1,
                updated_at = now()
  returning last_seq into v_next_seq;

  v_result := v_store_code || '-BOARD-' || v_date_prefix || '-' || lpad(v_next_seq::text, 4, '0');
  return v_result;
end;
$$;

-- ===== 4. boarding_book_stay(预约入住,不锁笼位) =====
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
  -- 校验笼位归属
  perform 1 from public.cages
  where id = p_cage_id and tenant_id = p_tenant_id and store_id = p_store_id;
  if not found then
    raise exception 'CAGE_NOT_FOUND' using errcode = 'P0002';
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

-- ===== 5. boarding_check_in(入住,锁笼位;支持直接入住或确认预约) =====
-- 事务:SELECT FOR UPDATE cages → 校验 available(防住院/寄养双占)
--      → 创建或确认 boarding_stays(checked_in)→ 更新 cage.status=occupied, current_boarding_stay_id
-- 幂等:同 idempotency_key 返回原结果
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

  -- 确认已预约的寄养单(p_stay_id 提供)
  if p_stay_id is not null then
    select * into v_stay from public.boarding_stays
    where id = p_stay_id and tenant_id = p_tenant_id and store_id = p_store_id
    for update;
    if not found then
      raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
    end if;
    -- 已入住则直接返回(幂等友好)
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
    -- 直接入住:需完整入参
    if p_customer_id is null or p_pet_id is null or p_cage_id is null then
      raise exception 'BOARDING_INPUT_REQUIRED' using errcode = 'P0003';
    end if;
    v_cage_id := p_cage_id;
    v_tenant_id := p_tenant_id;
    v_store_id := p_store_id;
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
    -- 确认预约:更新状态与入住时间
    update public.boarding_stays
    set status = 'checked_in',
        check_in_at = coalesce(check_in_at, now()),
        expected_check_out_at = coalesce(p_expected_check_out_at, expected_check_out_at),
        updated_at = now()
    where id = v_stay.id
    returning * into v_stay;
  else
    -- 直接入住:创建寄养单
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

  -- 记录幂等结果
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

-- ===== 6. boarding_cancel(取消预约,仅 planned) =====
create or replace function public.boarding_cancel(
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
begin
  select * into v_stay from public.boarding_stays
  where id = p_stay_id
  for update;
  if not found then
    raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_stay.status <> 'planned' then
    raise exception 'BOARDING_NOT_CANCELLABLE' using errcode = 'P0003';
  end if;

  update public.boarding_stays
  set status = 'cancelled', updated_at = now()
  where id = p_stay_id
  returning * into v_stay;

  return jsonb_build_object(
    'stayId', v_stay.id,
    'boardingNo', v_stay.boarding_no,
    'status', v_stay.status
  );
end;
$$;

-- ===== 7. boarding_change_cage(换笼位,住院/寄养单占用互斥) =====
-- 事务:SELECT FOR UPDATE 旧笼 + 新笼 → 校验新笼 available
--      → 更新 boarding_stays.cage_id → 释放旧笼(如有占用)→ 占用新笼(如已入住)
-- 幂等:同 idempotency_key 返回原结果
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
  if v_stay.status in ('checked_out', 'cancelled') then
    raise exception 'BOARDING_NOT_CHANGEABLE' using errcode = 'P0003';
  end if;

  -- 锁定旧笼
  select * into v_old_cage from public.cages
  where id = v_stay.cage_id and tenant_id = v_stay.tenant_id and store_id = v_stay.store_id
  for update;
  if not found then
    raise exception 'OLD_CAGE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 锁定新笼,校验可用
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

  -- 更新寄养单笼位
  update public.boarding_stays
  set cage_id = p_new_cage_id, updated_at = now()
  where id = p_stay_id;

  -- 释放旧笼(仅当旧笼确实被该寄养单占用)
  if v_old_cage.current_boarding_stay_id = v_stay.id then
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

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_stay.tenant_id, p_idempotency_key, 'boarding_change_cage', 'boarding_stay', p_stay_id, jsonb_build_object(
      'stayId', p_stay_id,
      'fromCageId', v_old_cage.id,
      'toCageId', p_new_cage_id
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'stayId', p_stay_id,
    'boardingNo', v_stay.boarding_no,
    'fromCageId', v_old_cage.id,
    'toCageId', p_new_cage_id
  );
end;
$$;

-- ===== 10. RPC 权限(仅 service_role 可执行,与 migration 29 同模式) =====
-- 注:boarding_prepare_checkout / boarding_checkout(依赖 boarding_service_charges)
--     定义在 migration 73 中,与 boarding_add_charge 同文件。
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'boarding_generate_no', 'boarding_book_stay', 'boarding_check_in',
    'boarding_cancel', 'boarding_change_cage'
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

-- ===== 11. 结束 =====
-- service-role-only manifest 函数清单:
-- 'boarding_generate_no','boarding_book_stay','boarding_check_in','boarding_cancel',
-- 'boarding_change_cage','boarding_prepare_checkout','boarding_checkout',
-- 'boarding_record_daily'(migration 72),'boarding_add_charge'(migration 73)
