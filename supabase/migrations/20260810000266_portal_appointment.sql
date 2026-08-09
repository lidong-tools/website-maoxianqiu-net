-- ============================================================
-- Agent-08(Stage-04) C 端预约创建(接 Clinical Appointment Domain)
-- migration 266: portal_appointment_requests(幂等表)
--              + create_portal_appointment RPC
-- ------------------------------------------------------------
-- 设计约束(Agent-08 DEEP §10):
--   * C 端不能直接 insert appointments;预约必须经本 RPC(source=customer_portal)
--   * 禁止客户指定 tenant / 任意 doctor / 内部 status
--   * 幂等:同租户同 idempotency_key 直接返回既有结果
--   * 宠物可见性:identity.customer 为宠物 owner(pets.customer_id) 或
--     存在有效 customer_pet_access 且 permissions 含 'appointment'
-- RPC ACL:仅 service_role(§9)
-- ============================================================
set search_path = public;

-- ===== 1. portal_appointment_requests(幂等记录) =====
create table if not exists public.portal_appointment_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  identity_id uuid not null,                          -- 引用 customer_identities.id,不加 FK
  customer_id uuid not null,                          -- 引用 customers.id,不加 FK
  pet_id uuid not null,                               -- 引用 pets.id,不加 FK
  store_id uuid references public.stores(id) on delete set null,
  idempotency_key text not null,
  status text not null default 'created',             -- created / failed
  appointment_id uuid,                                -- 引用 appointments.id,不加 FK
  error_message text,
  created_at timestamptz not null default now(),

  constraint portal_appointment_requests_status_check check (
    status in ('created', 'failed')
  )
);

comment on table public.portal_appointment_requests is
  'C 端预约创建请求幂等记录。create_portal_appointment 事务内先查后插,保证同租户同
  idempotency_key 只创建一个预约,外部重试/重复提交安全。';

create unique index if not exists idx_portal_appointment_requests_idem
  on public.portal_appointment_requests (tenant_id, idempotency_key);
create index if not exists idx_portal_appointment_requests_identity
  on public.portal_appointment_requests (tenant_id, identity_id, created_at desc);

alter table public.portal_appointment_requests enable row level security;

-- 读:需 portal.identity.view(预约请求含客户信息)
drop policy if exists "portal_appointment_requests_select" on public.portal_appointment_requests;
create policy "portal_appointment_requests_select" on public.portal_appointment_requests
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'portal.identity.view')
  );

-- 写:仅 service role(Hono Command / RPC)

-- ===== 2. create_portal_appointment RPC =====
create or replace function public.create_portal_appointment(
  p_identity_id uuid,
  p_pet_id uuid,
  p_store_id uuid default null,
  p_scheduled_start timestamptz default null,
  p_scheduled_end timestamptz default null,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_identity public.customer_identities;
  v_pet public.pets;
  v_access public.customer_pet_access;
  v_store_tenant uuid;
  v_appointment_id uuid;
  v_row public.portal_appointment_requests;
  v_start timestamptz := coalesce(p_scheduled_start, now() + interval '1 hour');
  v_end timestamptz := coalesce(p_scheduled_end, v_start + interval '30 minutes');
  v_store uuid;
begin
  -- 入参基础校验
  if p_identity_id is null then
    raise exception 'APPOINTMENT_MISSING_IDENTITY' using errcode = 'P0003';
  end if;
  if p_pet_id is null then
    raise exception 'APPOINTMENT_MISSING_PET' using errcode = 'P0003';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'APPOINTMENT_MISSING_IDEMPOTENCY' using errcode = 'P0003';
  end if;
  if v_end <= v_start then
    raise exception 'APPOINTMENT_INVALID_TIME' using errcode = 'P0003';
  end if;

  -- 幂等:同租户同键已存在 → 直接返回既有结果
  if exists (
    select 1 from public.portal_appointment_requests
    where tenant_id = (select tenant_id from public.customer_identities where id = p_identity_id)
      and idempotency_key = p_idempotency_key
  ) then
    select * into v_row
    from public.portal_appointment_requests
    where tenant_id = (select tenant_id from public.customer_identities where id = p_identity_id)
      and idempotency_key = p_idempotency_key
    limit 1;

    if v_row.status = 'created' and v_row.appointment_id is not null then
      return jsonb_build_object(
        'appointment', (
          select row_to_json(a) from public.appointments a where a.id = v_row.appointment_id
        ),
        'idempotent', true
      );
    end if;
    raise exception 'APPOINTMENT_PREVIOUS_FAILED' using errcode = 'P0003';
  end if;

  -- 1) 身份校验:identity 必须 active 且已绑定客户
  select * into v_identity
  from public.customer_identities
  where id = p_identity_id
    and status = 'active'
  for update;
  if not found then
    raise exception 'IDENTITY_INVALID' using errcode = 'P0002';
  end if;
  if v_identity.customer_id is null then
    raise exception 'IDENTITY_NOT_BOUND' using errcode = 'P0003';
  end if;

  -- 2) 宠物归属租户 + 可见性校验
  select * into v_pet
  from public.pets
  where id = p_pet_id
    and tenant_id = v_identity.tenant_id
    and status = 'active';
  if not found then
    raise exception 'PET_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- owner 直接可见;否则需显式授权且 permissions 含 appointment
  if v_pet.customer_id <> v_identity.customer_id then
    select * into v_access
    from public.customer_pet_access
    where tenant_id = v_identity.tenant_id
      and pet_id = p_pet_id
      and customer_id = v_identity.customer_id
      and status = 'active'
      and (expires_at is null or expires_at > now())
    limit 1;
    if not found then
      raise exception 'PET_ACCESS_DENIED' using errcode = 'P0003';
    end if;
    if not (v_access.permissions && array['appointment']) then
      raise exception 'PET_ACCESS_DENIED' using errcode = 'P0003';
    end if;
  end if;

  -- 3) 门店必须属于身份所在租户(客户可选门店,但不能跨租户)
  v_store := p_store_id;
  if v_store is null then
    select id into v_store
    from public.stores
    where tenant_id = v_identity.tenant_id
    order by created_at
    limit 1;
    if v_store is null then
      raise exception 'TENANT_NO_STORE' using errcode = 'P0003';
    end if;
  else
    select tenant_id into v_store_tenant from public.stores where id = v_store;
    if v_store_tenant is distinct from v_identity.tenant_id then
      raise exception 'STORE_TENANT_MISMATCH' using errcode = 'P0003';
    end if;
  end if;

  -- 4) 创建预约(source=customer_portal, 禁止指定 doctor / 内部 status)
  insert into public.appointments (
    tenant_id, store_id, customer_id, pet_id,
    doctor_id, scheduled_start, scheduled_end, reason,
    status, source, remark
  )
  values (
    v_identity.tenant_id, v_store, v_identity.customer_id, p_pet_id,
    null, v_start, v_end, p_reason,
    'pending', 'customer_portal', null
  )
  returning id into v_appointment_id;

  -- 5) 幂等记录
  insert into public.portal_appointment_requests (
    tenant_id, identity_id, customer_id, pet_id, store_id,
    idempotency_key, status, appointment_id
  )
  values (
    v_identity.tenant_id, p_identity_id, v_identity.customer_id, p_pet_id, v_store,
    p_idempotency_key, 'created', v_appointment_id
  );

  return jsonb_build_object(
    'appointment', (
      select row_to_json(a) from public.appointments a where a.id = v_appointment_id
    ),
    'idempotent', false
  );
end;
$$;

-- ============================================================
-- RPC ACL(§9)
-- ============================================================
revoke all on function public.create_portal_appointment(uuid, uuid, uuid, timestamptz, timestamptz, text, text) from public;
revoke all on function public.create_portal_appointment(uuid, uuid, uuid, timestamptz, timestamptz, text, text) from anon;
revoke all on function public.create_portal_appointment(uuid, uuid, uuid, timestamptz, timestamptz, text, text) from authenticated;
grant execute on function public.create_portal_appointment(uuid, uuid, uuid, timestamptz, timestamptz, text, text) to service_role;
