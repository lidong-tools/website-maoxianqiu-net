-- ============================================================
-- 20260806000015_crm_customers_pets.sql
-- MXQ-5001/5005/5006/5008/5009/5010:CRM 领域 客户/宠物 数据模型
--   - customers / pets / pet_weights 表
--   - business_sequences 业务单号原子计数器
--   - RLS 策略(基于 is_tenant_member / can_access_store / has_permission)
--   - RPC:create_customer / update_customer / archive_customer
--         create_pet / update_pet / archive_pet
--         generate_customer_no / merge_customers
--   - 权限码:customer.* / pet.*
-- 幂等,可重复应用
--
-- 设计要点:
--   - 客户编号格式 {STORE_CODE}-CUST-{YYYYMMDD}-{SEQ},由 generate_customer_no 生成
--   - 状态机:客户 active → archived/merged;宠物 active → deceased/lost/archived
--   - 客户合并走 merge_customers RPC,事务化迁移宠物/附件到目标客户
--   - 附件关联复用 attachments 表(entity_type='customer'/'pet')
-- ============================================================

-- ===== 1. customers 表 =====
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  customer_no text not null,                         -- {STORE_CODE}-CUST-{YYYYMMDD}-{SEQ}
  name text not null,
  gender text,                                       -- male / female / unknown
  phone text,
  email text,
  address text,
  birthday date,
  source text,                                       -- walk_in / referral / online / import / ...
  member_level text not null default 'normal',       -- normal / silver / gold / diamond
  member_points integer not null default 0,
  balance numeric(12,2) not null default 0,
  remark text,

  status text not null default 'active',             -- active / archived / merged
  merged_into uuid references public.customers(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,

  constraint customers_status_check check (status in ('active', 'archived', 'merged')),
  constraint customers_member_level_check check (member_level in ('normal', 'silver', 'gold', 'diamond')),
  constraint customers_gender_check check (gender is null or gender in ('male', 'female', 'unknown'))
);

create index if not exists idx_customers_tenant on public.customers (tenant_id);
create index if not exists idx_customers_tenant_store on public.customers (tenant_id, store_id);
create index if not exists idx_customers_tenant_phone on public.customers (tenant_id, phone);
create index if not exists idx_customers_tenant_name on public.customers (tenant_id, name);
create index if not exists idx_customers_status on public.customers (tenant_id, status);
create unique index if not exists idx_customers_tenant_customer_no on public.customers (tenant_id, customer_no);

-- ===== 2. pets 表 =====
create table if not exists public.pets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete cascade,

  name text not null,
  species text,                                      -- dog / cat / rabbit / ...
  breed text,
  gender text,                                       -- male / female / unknown
  birth_date date,
  weight numeric(8,3),                               -- 当前体重 kg
  is_neutered boolean not null default false,
  microchip text,
  color text,
  photo_file_id uuid references public.files(id) on delete set null,

  risk_tags text[] not null default '{}',            -- allergy / aggressive / chronic / ...
  temperament text,
  medical_notes text,

  status text not null default 'active',             -- active / deceased / lost / archived
  deceased_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,

  constraint pets_status_check check (status in ('active', 'deceased', 'lost', 'archived')),
  constraint pets_gender_check check (gender is null or gender in ('male', 'female', 'unknown'))
);

create index if not exists idx_pets_tenant on public.pets (tenant_id);
create index if not exists idx_pets_customer on public.pets (customer_id);
create index if not exists idx_pets_tenant_customer on public.pets (tenant_id, customer_id);
create index if not exists idx_pets_status on public.pets (tenant_id, status);
create index if not exists idx_pets_microchip on public.pets (microchip) where microchip is not null;

-- ===== 3. pet_weights 表(体重记录) =====
create table if not exists public.pet_weights (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  pet_id uuid not null references public.pets(id) on delete cascade,

  weight numeric(8,3) not null,                      -- kg
  recorded_at timestamptz not null default now(),
  recorded_by uuid references auth.users(id) on delete set null,
  note text,

  created_at timestamptz not null default now(),

  constraint pet_weights_weight_check check (weight > 0)
);

create index if not exists idx_pet_weights_pet on public.pet_weights (pet_id);
create index if not exists idx_pet_weights_pet_recorded on public.pet_weights (pet_id, recorded_at desc);

-- ===== 4. business_sequences 表(业务单号原子计数器) =====
-- 按 (tenant_id, store_id, sequence_key) 维度生成单调递增序号
-- sequence_key 例:customer-20260807
create table if not exists public.business_sequences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete cascade,
  sequence_key text not null,                        -- {entity_type}-{date_prefix}
  last_seq integer not null default 0,
  updated_at timestamptz not null default now(),

  constraint business_sequences_key_unique unique (tenant_id, store_id, sequence_key)
);

create index if not exists idx_business_sequences_lookup on public.business_sequences (tenant_id, store_id, sequence_key);

-- ===== 5. updated_at 触发器(customers / pets) =====
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_customers_updated_at on public.customers;
create trigger trg_customers_updated_at
  before update on public.customers
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_pets_updated_at on public.pets;
create trigger trg_pets_updated_at
  before update on public.pets
  for each row execute procedure public.touch_updated_at();

-- ===== 6. RLS =====
alter table public.customers enable row level security;
alter table public.pets enable row level security;
alter table public.pet_weights enable row level security;
alter table public.business_sequences enable row level security;

-- customers 读:租户成员可读,门店级数据须有该门店权限
drop policy if exists "customers_select" on public.customers;
create policy "customers_select" on public.customers
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

-- customers 写:通过 service role(Hono Command) 为主;直连需 customer.create 权限
drop policy if exists "customers_insert" on public.customers;
create policy "customers_insert" on public.customers
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'customer.create')
  );

drop policy if exists "customers_update" on public.customers;
create policy "customers_update" on public.customers
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'customer.update')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'customer.update')
  );

drop policy if exists "customers_delete" on public.customers;
create policy "customers_delete" on public.customers
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'customer.archive')
  );

-- pets 读:同 customers(通过 customer 归属判定)
drop policy if exists "pets_select" on public.pets;
create policy "pets_select" on public.pets
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.customers c
      where c.id = pets.customer_id
        and (c.store_id is null or public.can_access_store(c.tenant_id, c.store_id))
    )
  );

drop policy if exists "pets_insert" on public.pets;
create policy "pets_insert" on public.pets
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'pet.create')
    and exists (
      select 1 from public.customers c
      where c.id = pets.customer_id
        and (c.store_id is null or public.can_access_store(c.tenant_id, c.store_id))
    )
  );

drop policy if exists "pets_update" on public.pets;
create policy "pets_update" on public.pets
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'pet.update')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'pet.update')
  );

drop policy if exists "pets_delete" on public.pets;
create policy "pets_delete" on public.pets
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'pet.update')
  );

-- pet_weights 读:同 pets 归属
drop policy if exists "pet_weights_select" on public.pet_weights;
create policy "pet_weights_select" on public.pet_weights
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and exists (
      select 1 from public.pets p
      where p.id = pet_weights.pet_id
    )
  );

drop policy if exists "pet_weights_insert" on public.pet_weights;
create policy "pet_weights_insert" on public.pet_weights
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'pet.update')
  );

drop policy if exists "pet_weights_delete" on public.pet_weights;
create policy "pet_weights_delete" on public.pet_weights
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'pet.update')
  );

-- business_sequences:仅 service role 写入,authenticated 不可直连
drop policy if exists "business_sequences_select" on public.business_sequences;
create policy "business_sequences_select" on public.business_sequences
  for select to authenticated
  using (public.is_system_admin());

-- ===== 7. 新增权限码 =====
insert into public.permissions (code, name, module) values
  ('customer.view', '查看客户', 'customer'),
  ('customer.create', '创建客户', 'customer'),
  ('customer.update', '编辑客户', 'customer'),
  ('customer.archive', '归档客户', 'customer'),
  ('customer.merge', '合并客户', 'customer'),
  ('customer.import', '导入客户', 'customer'),
  ('pet.view', '查看宠物', 'pet'),
  ('pet.create', '创建宠物', 'pet'),
  ('pet.update', '编辑宠物', 'pet')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 系统角色补 customer.* / pet.* 权限(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'customer.view', 'customer.create', 'customer.update', 'customer.archive',
    'customer.merge', 'customer.import',
    'pet.view', 'pet.create', 'pet.update'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'customer.view', 'customer.create', 'customer.update', 'customer.archive',
    'customer.import',
    'pet.view', 'pet.create', 'pet.update'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in (
    'customer.view', 'customer.create', 'customer.update',
    'pet.view', 'pet.create', 'pet.update'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'customer.view', 'customer.create', 'customer.update', 'customer.archive',
    'customer.merge', 'customer.import',
    'pet.view', 'pet.create', 'pet.update'
  ])
)
where code in ('system_admin') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'customer.view', 'customer.create', 'customer.update', 'customer.archive',
    'customer.import',
    'pet.view', 'pet.create', 'pet.update'
  ])
)
where code in ('store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'customer.view', 'customer.create', 'customer.update',
    'pet.view', 'pet.create', 'pet.update'
  ])
)
where code in ('doctor') and is_system = true;

-- ===== 8. generate_customer_no RPC =====
-- 生成客户编号 {STORE_CODE}-CUST-{YYYYMMDD}-{SEQ},原子递增
create or replace function public.generate_customer_no(
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
  v_seq_key text := 'customer-' || v_date_prefix;
  v_next_seq integer;
  v_result text;
begin
  -- 取门店编码(缺失时回退 TENANT)
  select s.code into v_store_code
  from public.stores s
  where s.id = p_store_id and s.tenant_id = p_tenant_id;

  if v_store_code is null or v_store_code = '' then
    v_store_code := 'TENANT';
  end if;

  -- 原子递增计数器(upsert + returning)
  insert into public.business_sequences (tenant_id, store_id, sequence_key, last_seq)
  values (p_tenant_id, p_store_id, v_seq_key, 1)
  on conflict (tenant_id, store_id, sequence_key)
  do update set last_seq = business_sequences.last_seq + 1,
                 updated_at = now()
  returning last_seq into v_next_seq;

  v_result := v_store_code || '-CUST-' || v_date_prefix || '-' || lpad(v_next_seq::text, 4, '0');
  return v_result;
end;
$$;

revoke all on function public.generate_customer_no(uuid, uuid) from public;
grant execute on function public.generate_customer_no(uuid, uuid) to authenticated;

-- ===== 9. create_customer RPC =====
-- 事务化创建客户(自动生成 customer_no),返回新建记录
create or replace function public.create_customer(
  p_tenant_id uuid,
  p_name text,
  p_store_id uuid default null,
  p_gender text default null,
  p_phone text default null,
  p_email text default null,
  p_address text default null,
  p_birthday date default null,
  p_source text default null,
  p_member_level text default 'normal',
  p_remark text default null,
  p_customer_no text default null
)
returns public.customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.customers;
  v_customer_no text;
begin
  -- 编号:外部传入优先,否则自动生成
  if p_customer_no is not null and p_customer_no <> '' then
    v_customer_no := p_customer_no;
  else
    v_customer_no := public.generate_customer_no(p_tenant_id, coalesce(p_store_id, (select id from public.stores where tenant_id = p_tenant_id order by created_at limit 1)));
  end if;

  insert into public.customers (
    tenant_id, store_id, customer_no,
    name, gender, phone, email, address, birthday,
    source, member_level, remark
  )
  values (
    p_tenant_id, p_store_id, v_customer_no,
    p_name, p_gender, p_phone, p_email, p_address, p_birthday,
    p_source, p_member_level, p_remark
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_customer(uuid, text, uuid, text, text, text, text, date, text, text, text, text) from public;
grant execute on function public.create_customer(uuid, text, uuid, text, text, text, text, date, text, text, text, text) to authenticated;

-- ===== 10. update_customer RPC =====
-- 局部更新客户(仅允许 active 客户;archived/merged 不可改)
create or replace function public.update_customer(
  p_customer_id uuid,
  p_name text default null,
  p_gender text default null,
  p_phone text default null,
  p_email text default null,
  p_address text default null,
  p_birthday date default null,
  p_source text default null,
  p_member_level text default null,
  p_member_points integer default null,
  p_balance numeric default null,
  p_remark text default null
)
returns public.customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.customers;
begin
  select * into v_row from public.customers where id = p_customer_id for update;
  if not found then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status <> 'active' then
    raise exception 'CUSTOMER_NOT_ACTIVE' using errcode = 'P0003';
  end if;

  update public.customers
  set name = coalesce(p_name, name),
      gender = coalesce(p_gender, gender),
      phone = coalesce(p_phone, phone),
      email = coalesce(p_email, email),
      address = coalesce(p_address, address),
      birthday = coalesce(p_birthday, birthday),
      source = coalesce(p_source, source),
      member_level = coalesce(p_member_level, member_level),
      member_points = coalesce(p_member_points, member_points),
      balance = coalesce(p_balance, balance),
      remark = coalesce(p_remark, remark),
      updated_at = now()
  where id = p_customer_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.update_customer(uuid, text, text, text, text, text, date, text, text, integer, numeric, text) from public;
grant execute on function public.update_customer(uuid, text, text, text, text, text, date, text, text, integer, numeric, text) to authenticated;

-- ===== 11. archive_customer RPC =====
-- 归档客户(active → archived);merged 客户不可归档
create or replace function public.archive_customer(
  p_customer_id uuid,
  p_archived_by uuid default null,
  p_reason text default null
)
returns public.customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.customers;
begin
  select * into v_row from public.customers where id = p_customer_id for update;
  if not found then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status = 'archived' then
    raise exception 'CUSTOMER_ALREADY_ARCHIVED' using errcode = 'P0003';
  end if;
  if v_row.status = 'merged' then
    raise exception 'CUSTOMER_ALREADY_MERGED' using errcode = 'P0003';
  end if;

  update public.customers
  set status = 'archived',
      archived_at = now(),
      updated_at = now()
  where id = p_customer_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.archive_customer(uuid, uuid, text) from public;
grant execute on function public.archive_customer(uuid, uuid, text) to authenticated;

-- ===== 12. create_pet RPC =====
create or replace function public.create_pet(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_name text,
  p_species text default null,
  p_breed text default null,
  p_gender text default null,
  p_birth_date date default null,
  p_weight numeric default null,
  p_is_neutered boolean default false,
  p_microchip text default null,
  p_color text default null,
  p_photo_file_id uuid default null,
  p_risk_tags text[] default '{}',
  p_temperament text default null,
  p_medical_notes text default null
)
returns public.pets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pets;
  v_customer public.customers;
begin
  select * into v_customer from public.customers where id = p_customer_id;
  if not found then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_customer.tenant_id <> p_tenant_id then
    raise exception 'PET_TENANT_MISMATCH' using errcode = 'P0003';
  end if;

  insert into public.pets (
    tenant_id, customer_id,
    name, species, breed, gender, birth_date, weight,
    is_neutered, microchip, color, photo_file_id,
    risk_tags, temperament, medical_notes
  )
  values (
    p_tenant_id, p_customer_id,
    p_name, p_species, p_breed, p_gender, p_birth_date, p_weight,
    p_is_neutered, p_microchip, p_color, p_photo_file_id,
    p_risk_tags, p_temperament, p_medical_notes
  )
  returning * into v_row;

  -- 若提供初始体重,同步落一条体重记录
  if p_weight is not null and p_weight > 0 then
    insert into public.pet_weights (tenant_id, pet_id, weight, recorded_at, note)
    values (p_tenant_id, v_row.id, p_weight, now(), '建档初始体重');
  end if;

  return v_row;
end;
$$;

revoke all on function public.create_pet(uuid, uuid, text, text, text, text, date, numeric, boolean, text, text, uuid, text[], text, text) from public;
grant execute on function public.create_pet(uuid, uuid, text, text, text, text, date, numeric, boolean, text, text, uuid, text[], text, text) to authenticated;

-- ===== 13. update_pet RPC =====
create or replace function public.update_pet(
  p_pet_id uuid,
  p_name text default null,
  p_species text default null,
  p_breed text default null,
  p_gender text default null,
  p_birth_date date default null,
  p_weight numeric default null,
  p_is_neutered boolean default null,
  p_microchip text default null,
  p_color text default null,
  p_photo_file_id uuid default null,
  p_risk_tags text[] default null,
  p_temperament text default null,
  p_medical_notes text default null,
  p_status text default null
)
returns public.pets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pets;
  v_old_weight numeric;
begin
  select * into v_row from public.pets where id = p_pet_id for update;
  if not found then
    raise exception 'PET_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status = 'archived' then
    raise exception 'PET_ALREADY_ARCHIVED' using errcode = 'P0003';
  end if;

  v_old_weight := v_row.weight;

  update public.pets
  set name = coalesce(p_name, name),
      species = coalesce(p_species, species),
      breed = coalesce(p_breed, breed),
      gender = coalesce(p_gender, gender),
      birth_date = coalesce(p_birth_date, birth_date),
      weight = coalesce(p_weight, weight),
      is_neutered = coalesce(p_is_neutered, is_neutered),
      microchip = coalesce(p_microchip, microchip),
      color = coalesce(p_color, color),
      photo_file_id = coalesce(p_photo_file_id, photo_file_id),
      risk_tags = coalesce(p_risk_tags, risk_tags),
      temperament = coalesce(p_temperament, temperament),
      medical_notes = coalesce(p_medical_notes, medical_notes),
      status = coalesce(p_status, status),
      updated_at = now()
  where id = p_pet_id
  returning * into v_row;

  -- 体重变化时自动落一条体重记录
  if p_weight is not null and p_weight > 0 and (v_old_weight is null or p_weight <> v_old_weight) then
    insert into public.pet_weights (tenant_id, pet_id, weight, recorded_at, note)
    values (v_row.tenant_id, p_pet_id, p_weight, now(), '资料更新');
  end if;

  return v_row;
end;
$$;

revoke all on function public.update_pet(uuid, text, text, text, text, date, numeric, boolean, text, text, uuid, text[], text, text, text) from public;
grant execute on function public.update_pet(uuid, text, text, text, text, date, numeric, boolean, text, text, uuid, text[], text, text, text) to authenticated;

-- ===== 14. archive_pet RPC =====
-- 归档宠物(active/deceased/lost → archived)
create or replace function public.archive_pet(
  p_pet_id uuid,
  p_archived_by uuid default null,
  p_reason text default null
)
returns public.pets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pets;
begin
  select * into v_row from public.pets where id = p_pet_id for update;
  if not found then
    raise exception 'PET_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status = 'archived' then
    raise exception 'PET_ALREADY_ARCHIVED' using errcode = 'P0003';
  end if;

  update public.pets
  set status = 'archived',
      archived_at = now(),
      updated_at = now()
  where id = p_pet_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.archive_pet(uuid, uuid, text) from public;
grant execute on function public.archive_pet(uuid, uuid, text) to authenticated;

-- ===== 15. merge_customers RPC(MXQ-5009) =====
-- 事务化合并客户:源客户的宠物/附件迁移到目标客户,源客户标记 merged
-- 限制:同租户、两者均 active、不可自合并
create or replace function public.merge_customers(
  p_source_id uuid,
  p_target_id uuid,
  p_operator_id uuid default null
)
returns public.customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.customers;
  v_target public.customers;
begin
  if p_source_id = p_target_id then
    raise exception 'MERGE_SAME_CUSTOMER' using errcode = 'P0003';
  end if;

  select * into v_source from public.customers where id = p_source_id for update;
  if not found then
    raise exception 'SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_source.status <> 'active' then
    raise exception 'SOURCE_NOT_ACTIVE' using errcode = 'P0003';
  end if;

  select * into v_target from public.customers where id = p_target_id for update;
  if not found then
    raise exception 'TARGET_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_target.status <> 'active' then
    raise exception 'TARGET_NOT_ACTIVE' using errcode = 'P0003';
  end if;
  if v_source.tenant_id <> v_target.tenant_id then
    raise exception 'MERGE_TENANT_MISMATCH' using errcode = 'P0003';
  end if;

  -- 1) 迁移宠物归属
  update public.pets
  set customer_id = p_target_id,
      updated_at = now()
  where customer_id = p_source_id;

  -- 2) 迁移客户级附件(entity_type='customer')
  update public.attachments
  set entity_id = p_target_id
  where entity_type = 'customer' and entity_id = p_source_id;

  -- 3) 合并积分/余额到目标客户
  update public.customers
  set member_points = member_points + v_source.member_points,
      balance = balance + v_source.balance,
      updated_at = now()
  where id = p_target_id;

  -- 4) 标记源客户为 merged
  update public.customers
  set status = 'merged',
      merged_into = p_target_id,
      archived_at = now(),
      updated_at = now()
  where id = p_source_id;

  select * into v_target from public.customers where id = p_target_id;
  return v_target;
end;
$$;

revoke all on function public.merge_customers(uuid, uuid, uuid) from public;
grant execute on function public.merge_customers(uuid, uuid, uuid) to authenticated;

-- ============================================================
-- 以下为同序号文件 20260806000015_crm.sql 的内容(已合并,避免
-- 同序号双文件字典序导致 crm.sql 先执行却依赖本文件建表的顺序问题,R-04)。
-- 本文件先创建 customers/pets/pet_weights/business_sequences 表与全部
-- CRM RPC,再执行下述补充:created_by/remark 字段、import_jobs 表、导入 RPC。
-- ============================================================

-- ===== 1. customers 表补充 created_by 字段 =====
-- 任务 MXQ-5001 要求 customers 含 created_by;上述建表段未建,此处幂等补齐
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'customers'
      and column_name = 'created_by'
  ) then
    alter table public.customers
      add column created_by uuid references auth.users(id) on delete set null;
  end if;
end;
$$;

-- ===== 2. pets 表补充 remark 字段 =====
-- 任务 MXQ-5005 要求 pets 含 remark;上述建表段未建,此处幂等补齐
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pets'
      and column_name = 'remark'
  ) then
    alter table public.pets
      add column remark text;
  end if;
end;
$$;

-- ===== 3. import_jobs 表(MXQ-5010) =====
-- 导入任务追踪:客户/宠物批量导入进度与结果
create table if not exists public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,

  type text not null,                               -- customer / pet
  status text not null default 'pending',           -- pending / processing / completed / failed

  total_rows integer not null default 0,
  success_count integer not null default 0,
  failed_count integer not null default 0,

  error_file_key text,                              -- 失败行明细文件 object_key(R2)
  source_file_id uuid references public.files(id) on delete set null,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint import_jobs_type_check check (type in ('customer', 'pet')),
  constraint import_jobs_status_check check (status in ('pending', 'processing', 'completed', 'failed'))
);

create index if not exists idx_import_jobs_tenant on public.import_jobs (tenant_id);
create index if not exists idx_import_jobs_tenant_status on public.import_jobs (tenant_id, status);
create index if not exists idx_import_jobs_created_by on public.import_jobs (created_by);

-- updated_at 触发器
drop trigger if exists trg_import_jobs_updated_at on public.import_jobs;
create trigger trg_import_jobs_updated_at
  before update on public.import_jobs
  for each row execute procedure public.touch_updated_at();

-- ===== 4. import_jobs RLS =====
alter table public.import_jobs enable row level security;

-- 读:租户成员可读本租户导入任务,门店级需 can_access_store
drop policy if exists "import_jobs_select" on public.import_jobs;
create policy "import_jobs_select" on public.import_jobs
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

-- 写:仅 service role(Hono Command) 写入;直连需 customer.import 权限
drop policy if exists "import_jobs_insert" on public.import_jobs;
create policy "import_jobs_insert" on public.import_jobs
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'customer.import')
  );

drop policy if exists "import_jobs_update" on public.import_jobs;
create policy "import_jobs_update" on public.import_jobs
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'customer.import')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'customer.import')
  );

-- ===== 5. create_import_job RPC(MXQ-5010) =====
-- 创建导入任务记录(状态 pending),返回新建记录
create or replace function public.create_import_job(
  p_tenant_id uuid,
  p_store_id uuid default null,
  p_type text default 'customer',
  p_total_rows integer default 0,
  p_source_file_id uuid default null,
  p_created_by uuid default null
)
returns public.import_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.import_jobs;
begin
  if p_type not in ('customer', 'pet') then
    raise exception 'INVALID_IMPORT_TYPE' using errcode = 'P0003';
  end if;

  insert into public.import_jobs (
    tenant_id, store_id, type, status,
    total_rows, success_count, failed_count,
    source_file_id, created_by
  )
  values (
    p_tenant_id, p_store_id, p_type, 'pending',
    p_total_rows, 0, 0,
    p_source_file_id, p_created_by
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_import_job(uuid, uuid, text, integer, uuid, uuid) from public;
grant execute on function public.create_import_job(uuid, uuid, text, integer, uuid, uuid) to authenticated;

-- ===== 6. update_import_job RPC(MXQ-5010) =====
-- 更新导入任务进度/状态(状态机:pending → processing → completed/failed)
create or replace function public.update_import_job(
  p_job_id uuid,
  p_status text default null,
  p_total_rows integer default null,
  p_success_count integer default null,
  p_failed_count integer default null,
  p_error_file_key text default null
)
returns public.import_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.import_jobs;
begin
  select * into v_row from public.import_jobs where id = p_job_id for update;
  if not found then
    raise exception 'IMPORT_JOB_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 状态机校验:终态不可再变更
  if v_row.status in ('completed', 'failed') and p_status is not null and p_status <> v_row.status then
    raise exception 'IMPORT_JOB_ALREADY_FINISHED' using errcode = 'P0003';
  end if;

  update public.import_jobs
  set status = coalesce(p_status, status),
      total_rows = coalesce(p_total_rows, total_rows),
      success_count = coalesce(p_success_count, success_count),
      failed_count = coalesce(p_failed_count, failed_count),
      error_file_key = coalesce(p_error_file_key, error_file_key),
      updated_at = now()
  where id = p_job_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.update_import_job(uuid, text, integer, integer, integer, text) from public;
grant execute on function public.update_import_job(uuid, text, integer, integer, integer, text) to authenticated;

-- ===== 7. 补充权限码到 role_permissions(幂等,上述已做大部分,此处保险) =====
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code = 'customer.import'
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );
