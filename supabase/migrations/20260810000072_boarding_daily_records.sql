-- ============================================================
-- 20260810000072_boarding_daily_records.sql
-- S3.1 寄养每日照护记录(Agent-06)
--   - boarding_daily_records:饮食/遛宠/用药/状态 每日记录
--   - 同一寄养单同一天仅一条记录(upsert)
--   - 权限:读 boarding.view,写 boarding.care
--   - 寄养记录不是医疗病程,不写入 inpatient_progress_notes
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. boarding_daily_records 表 =====
create table if not exists public.boarding_daily_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  boarding_stay_id uuid not null,                   -- 跨 migration 不加 FK
  record_date date not null default current_date,
  feeding text,                                     -- 饮食记录
  walking text,                                     -- 遛宠记录
  medication text,                                  -- 用药记录
  condition text,                                   -- 状态评估
  note text,                                        -- 备注
  recorded_by uuid,                                 -- 跨 migration 不加 FK
  created_at timestamptz not null default now(),

  constraint boarding_daily_records_stay_date_key unique (boarding_stay_id, record_date)
);

create index if not exists idx_boarding_daily_records_stay
  on public.boarding_daily_records (boarding_stay_id, record_date desc);
create index if not exists idx_boarding_daily_records_tenant_store
  on public.boarding_daily_records (tenant_id, store_id, record_date desc);

-- ===== 2. RLS =====
alter table public.boarding_daily_records enable row level security;

drop policy if exists "boarding_daily_records_select" on public.boarding_daily_records;
create policy "boarding_daily_records_select" on public.boarding_daily_records
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'boarding.view')
  );

drop policy if exists "boarding_daily_records_insert" on public.boarding_daily_records;
create policy "boarding_daily_records_insert" on public.boarding_daily_records
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'boarding.care')
  );

drop policy if exists "boarding_daily_records_update" on public.boarding_daily_records;
create policy "boarding_daily_records_update" on public.boarding_daily_records
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'boarding.care')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'boarding.care')
  );

drop policy if exists "boarding_daily_records_delete" on public.boarding_daily_records;
create policy "boarding_daily_records_delete" on public.boarding_daily_records
  for delete to authenticated
  using (
    public.is_system_admin()
    and public.can_access_store(tenant_id, store_id)
  );

-- ===== 3. boarding_record_daily RPC(upsert,同一天一条) =====
-- 幂等:同 (boarding_stay_id, record_date) 已存在则更新
create or replace function public.boarding_record_daily(
  p_stay_id uuid,
  p_record_date date default current_date,
  p_feeding text default null,
  p_walking text default null,
  p_medication text default null,
  p_condition text default null,
  p_note text default null,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.boarding_stays;
  v_record public.boarding_daily_records;
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

  insert into public.boarding_daily_records (
    tenant_id, store_id, boarding_stay_id, record_date,
    feeding, walking, medication, condition, note, recorded_by
  )
  values (
    v_stay.tenant_id, v_stay.store_id, p_stay_id, p_record_date,
    p_feeding, p_walking, p_medication, p_condition, p_note, p_operator_id
  )
  on conflict (boarding_stay_id, record_date)
  do update set
    feeding = excluded.feeding,
    walking = excluded.walking,
    medication = excluded.medication,
    condition = excluded.condition,
    note = excluded.note,
    recorded_by = excluded.recorded_by
  returning * into v_record;

  return jsonb_build_object(
    'recordId', v_record.id,
    'boardingStayId', p_stay_id,
    'recordDate', v_record.record_date
  );
end;
$$;

do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array['boarding_record_daily']
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

-- ===== 4. 结束 =====
