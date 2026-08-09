-- ============================================================
-- Agent-06(Stage-04) 保险理赔 / PDF 归档 / 电子签名 生命周期
-- migration 235: insurance_claim_packs + insurance_claim_pack_items
--              + insurance_claim_exports + document_archives
--              + signature_requests + signature_events + signature_artifacts
-- ------------------------------------------------------------
-- 设计约束:
--   * 保险理赔包只记录"引用"不复制业务真相,items.source_type/source_id 指向已发布源
--   * export 保存 data_snapshot + data_hash + archive 引用,半年后源修订仍可证明当时提交
--   * document_archives 不可变:PDF bytes/hash 不更新,业务修订 → 新 archive,旧 → superseded
--   * signature 首版 provider=internal/manual,状态只表达内部流程;接入合规 Provider 前
--     UI 禁止宣称"已完成合法可靠电子签名"
--   * 全部写操作仅 service_role(Hono Command + RPC);authenticated 只读(RLS 兜底)
-- ============================================================

-- ===== 1. insurance_claim_packs(理赔包头) =====
create table if not exists public.insurance_claim_packs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,
  customer_id uuid not null,                          -- 引用 customers.id,不加 FK
  pet_id uuid not null,                               -- 引用 pets.id,不加 FK
  encounter_id uuid,                                  -- 引用 encounters.id,不加 FK
  admission_id uuid,                                  -- 引用 admissions.id,不加 FK
  pack_no text not null,
  status text not null default 'draft',               -- draft/generated/archived/cancelled
  version integer not null default 1,
  remark text,
  idempotency_key text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint insurance_claim_packs_status_check check (
    status in ('draft', 'generated', 'archived', 'cancelled')
  ),
  constraint insurance_claim_packs_version_check check (version >= 1)
);

create unique index if not exists idx_insurance_packs_tenant_no
  on public.insurance_claim_packs (tenant_id, pack_no);
create unique index if not exists idx_insurance_packs_tenant_idem
  on public.insurance_claim_packs (tenant_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_insurance_packs_tenant_store
  on public.insurance_claim_packs (tenant_id, store_id, created_at desc);
create index if not exists idx_insurance_packs_pet
  on public.insurance_claim_packs (tenant_id, pet_id, created_at desc);

drop trigger if exists trg_insurance_claim_packs_updated_at on public.insurance_claim_packs;
create trigger trg_insurance_claim_packs_updated_at
  before update on public.insurance_claim_packs
  for each row execute procedure public.touch_updated_at();

-- ===== 2. insurance_claim_pack_items(材料清单,只记录引用) =====
create table if not exists public.insurance_claim_pack_items (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.insurance_claim_packs(id) on delete cascade,
  source_type text not null,                          -- encounter/prescription/invoice/lab_report/imaging_report/discharge_summary/medical_record_summary/vaccination_certificate
  source_id uuid not null,                            -- 源业务实体 id
  display_order integer not null default 0,
  required boolean not null default true,
  included boolean not null default true,
  created_at timestamptz not null default now(),

  constraint insurance_pack_items_source_type_check check (
    source_type in (
      'encounter', 'prescription', 'invoice', 'lab_report',
      'imaging_report', 'discharge_summary', 'medical_record_summary',
      'vaccination_certificate'
    )
  ),
  constraint insurance_pack_items_unique_src unique (pack_id, source_type, source_id)
);

create index if not exists idx_insurance_pack_items_pack
  on public.insurance_claim_pack_items (pack_id, display_order);

-- ===== 3. insurance_claim_exports(导出快照,不可变) =====
create table if not exists public.insurance_claim_exports (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.insurance_claim_packs(id) on delete cascade,
  pack_version integer not null,
  data_snapshot jsonb not null default '{}'::jsonb,   -- 必要字段快照(禁止存无边界医疗全文)
  data_hash text not null,                            -- 快照 sha256
  document_archive_id uuid references public.document_archives(id) on delete set null,
  generated_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz not null default now(),
  idempotency_key text,

  constraint insurance_claim_exports_version_check check (pack_version >= 1),
  constraint insurance_claim_exports_idem_unique unique (pack_id, idempotency_key)
    where idempotency_key is not null
);

create index if not exists idx_insurance_exports_pack
  on public.insurance_claim_exports (pack_id, pack_version desc);
create index if not exists idx_insurance_exports_archive
  on public.insurance_claim_exports (document_archive_id)
  where document_archive_id is not null;

-- ===== 4. document_archives(不可变文档归档) =====
create table if not exists public.document_archives (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,
  document_type text not null,                        -- insurance_claim_pack / prescription / invoice / ...
  entity_type text not null,                          -- 业务实体类型(insurance_claim_pack / encounter / ...)
  entity_id uuid not null,                            -- 业务实体 id
  document_history_id uuid references public.document_history(id) on delete set null,
  template_id uuid references public.document_templates(id) on delete set null,
  template_version integer,
  file_id uuid not null references public.files(id) on delete restrict,
  sha256 text not null,                               -- PDF bytes 的 sha256(不可变校验)
  mime_type text not null default 'application/pdf',
  size_bytes bigint not null default 0,
  status text not null default 'active',              -- active/superseded/archived
  customer_visible boolean not null default false,    -- Agent-08 Portal 归档契约
  published boolean not null default false,           -- 面向客户发布
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint document_archives_status_check check (
    status in ('active', 'superseded', 'archived')
  ),
  constraint document_archives_sha256_check check (sha256 ~ '^[a-f0-9]{64}$')
);

create index if not exists idx_document_archives_tenant_time
  on public.document_archives (tenant_id, created_at desc);
create index if not exists idx_document_archives_entity
  on public.document_archives (entity_type, entity_id, created_at desc);
create index if not exists idx_document_archives_file
  on public.document_archives (file_id);

-- ===== 5. signature_requests(签名请求生命周期) =====
create table if not exists public.signature_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,
  archive_id uuid references public.document_archives(id) on delete set null,
  signer_type text not null default 'customer',       -- customer/guardian/other
  signer_name text,
  signer_email text,
  provider text not null default 'internal',          -- internal/manual | 合规 Provider 名
  provider_request_id text,                           -- 外部 Provider 侧请求 id
  status text not null default 'created',             -- created/sent/completed/failed/cancelled
  reason text,                                        -- 取消/失败原因
  idempotency_key text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint signature_requests_status_check check (
    status in ('created', 'sent', 'completed', 'failed', 'cancelled')
  ),
  constraint signature_requests_signer_type_check check (
    signer_type in ('customer', 'guardian', 'other')
  ),
  constraint signature_requests_idem_unique unique (tenant_id, idempotency_key)
    where idempotency_key is not null
);

create index if not exists idx_signature_requests_tenant_time
  on public.signature_requests (tenant_id, created_at desc);
create index if not exists idx_signature_requests_archive
  on public.signature_requests (archive_id) where archive_id is not null;
create index if not exists idx_signature_requests_provider
  on public.signature_requests (provider, provider_request_id) where provider_request_id is not null;

drop trigger if exists trg_signature_requests_updated_at on public.signature_requests;
create trigger trg_signature_requests_updated_at
  before update on public.signature_requests
  for each row execute procedure public.touch_updated_at();

-- ===== 6. signature_events(签名事件审计,防重放) =====
create table if not exists public.signature_events (
  id uuid primary key default gen_random_uuid(),
  signature_request_id uuid not null references public.signature_requests(id) on delete cascade,
  event_type text not null,                           -- request_created/request_sent/opened/signed/completed/failed/cancelled
  event_payload jsonb not null default '{}'::jsonb,
  provider_event_id text,                             -- 外部 Provider 事件 id(防重放)
  occurred_at timestamptz not null default now(),

  constraint signature_events_type_check check (
    event_type in (
      'request_created', 'request_sent', 'opened', 'signed',
      'completed', 'failed', 'cancelled'
    )
  )
);

create unique index if not exists idx_signature_events_provider_unique
  on public.signature_events (signature_request_id, provider_event_id)
  where provider_event_id is not null;
create index if not exists idx_signature_events_request
  on public.signature_events (signature_request_id, occurred_at);

-- ===== 7. signature_artifacts(已签产物文件引用) =====
create table if not exists public.signature_artifacts (
  id uuid primary key default gen_random_uuid(),
  signature_request_id uuid not null references public.signature_requests(id) on delete cascade,
  file_id uuid not null references public.files(id) on delete restrict,
  artifact_type text not null default 'signed_pdf',   -- signed_pdf/evidence
  created_at timestamptz not null default now(),

  constraint signature_artifacts_type_check check (
    artifact_type in ('signed_pdf', 'evidence')
  )
);

create index if not exists idx_signature_artifacts_request
  on public.signature_artifacts (signature_request_id);

-- ============================================================
-- RLS:authenticated 只读(租户成员 + 门店可见),写一律 service_role
-- ============================================================
alter table public.insurance_claim_packs enable row level security;
alter table public.insurance_claim_pack_items enable row level security;
alter table public.insurance_claim_exports enable row level security;
alter table public.document_archives enable row level security;
alter table public.signature_requests enable row level security;
alter table public.signature_events enable row level security;
alter table public.signature_artifacts enable row level security;

drop policy if exists "insurance_claim_packs_select" on public.insurance_claim_packs;
create policy "insurance_claim_packs_select" on public.insurance_claim_packs
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

drop policy if exists "insurance_claim_pack_items_select" on public.insurance_claim_pack_items;
create policy "insurance_claim_pack_items_select" on public.insurance_claim_pack_items
  for select to authenticated
  using (
    exists (
      select 1 from public.insurance_claim_packs p
      where p.id = insurance_claim_pack_items.pack_id
        and public.is_tenant_member(p.tenant_id)
        and (p.store_id is null or public.can_access_store(p.tenant_id, p.store_id))
    )
  );

drop policy if exists "insurance_claim_exports_select" on public.insurance_claim_exports;
create policy "insurance_claim_exports_select" on public.insurance_claim_exports
  for select to authenticated
  using (
    exists (
      select 1 from public.insurance_claim_packs p
      where p.id = insurance_claim_exports.pack_id
        and public.is_tenant_member(p.tenant_id)
        and (p.store_id is null or public.can_access_store(p.tenant_id, p.store_id))
    )
  );

drop policy if exists "document_archives_select" on public.document_archives;
create policy "document_archives_select" on public.document_archives
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

drop policy if exists "signature_requests_select" on public.signature_requests;
create policy "signature_requests_select" on public.signature_requests
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

drop policy if exists "signature_events_select" on public.signature_events;
create policy "signature_events_select" on public.signature_events
  for select to authenticated
  using (
    exists (
      select 1 from public.signature_requests r
      where r.id = signature_events.signature_request_id
        and public.is_tenant_member(r.tenant_id)
        and (r.store_id is null or public.can_access_store(r.tenant_id, r.store_id))
    )
  );

drop policy if exists "signature_artifacts_select" on public.signature_artifacts;
create policy "signature_artifacts_select" on public.signature_artifacts
  for select to authenticated
  using (
    exists (
      select 1 from public.signature_requests r
      where r.id = signature_artifacts.signature_request_id
        and public.is_tenant_member(r.tenant_id)
        and (r.store_id is null or public.can_access_store(r.tenant_id, r.store_id))
    )
  );

-- ============================================================
-- 新增权限码(Stage-04 Agent-06)
-- ============================================================
insert into public.permissions (code, name, module) values
  ('insurance.view', '查看保险理赔', 'insurance'),
  ('insurance.generate', '生成理赔材料', 'insurance'),
  ('documents.pdf.generate', '生成 PDF 归档', 'documents'),
  ('documents.archive.view', '查看文档归档', 'documents'),
  ('documents.signature.manage', '管理签名请求', 'documents')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin 补全部保险/归档权限(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'insurance.view', 'insurance.generate',
    'documents.pdf.generate', 'documents.archive.view', 'documents.signature.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager 补保险/归档查看与生成权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'insurance.view', 'insurance.generate',
    'documents.pdf.generate', 'documents.archive.view', 'documents.signature.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'insurance.view', 'insurance.generate',
    'documents.pdf.generate', 'documents.archive.view', 'documents.signature.manage'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;

-- ============================================================
-- RPC:create_insurance_claim_pack
-- 幂等(tenant_id + idempotency_key);聚合后的 items 由 Hono 服务层传入(已校验合格源)
-- ============================================================
create or replace function public.create_insurance_claim_pack(
  p_tenant_id uuid,
  p_store_id uuid default null,
  p_customer_id uuid default null,
  p_pet_id uuid default null,
  p_encounter_id uuid default null,
  p_admission_id uuid default null,
  p_created_by uuid default null,
  p_idempotency_key text default null,
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack public.insurance_claim_packs;
  v_item jsonb;
  v_pack_no text;
begin
  -- 幂等:重复请求返回已存在结果
  if p_idempotency_key is not null then
    select * into v_pack
    from public.insurance_claim_packs
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object(
        'pack', to_jsonb(v_pack),
        'items', (
          select coalesce(jsonb_agg(to_jsonb(i) order by i.display_order), '[]'::jsonb)
          from public.insurance_claim_pack_items i
          where i.pack_id = v_pack.id
        )
      );
    end if;
  end if;

  if p_customer_id is null or p_pet_id is null then
    raise exception 'INSURANCE_MISSING_PARTY' using errcode = 'P0002';
  end if;

  -- 生成租户内唯一 pack_no(短随机后缀,配合唯一索引兜底)
  v_pack_no := 'CLM-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(md5(random()::text), 1, 8));

  insert into public.insurance_claim_packs (
    tenant_id, store_id, customer_id, pet_id, encounter_id, admission_id,
    status, version, pack_no, created_by, idempotency_key
  )
  values (
    p_tenant_id, p_store_id, p_customer_id, p_pet_id, p_encounter_id, p_admission_id,
    'draft', 1, v_pack_no, p_created_by, p_idempotency_key
  )
  returning * into v_pack;

  -- 落材料清单(引用不复制业务真相)
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.insurance_claim_pack_items (
      pack_id, source_type, source_id, display_order, required, included
    )
    values (
      v_pack.id,
      v_item->>'source_type',
      (v_item->>'source_id')::uuid,
      coalesce((v_item->>'display_order')::int, 0),
      coalesce((v_item->>'required')::boolean, true),
      coalesce((v_item->>'included')::boolean, true)
    );
  end loop;

  return jsonb_build_object(
    'pack', to_jsonb(v_pack),
    'items', (
      select coalesce(jsonb_agg(to_jsonb(i) order by i.display_order), '[]'::jsonb)
      from public.insurance_claim_pack_items i
      where i.pack_id = v_pack.id
    )
  );
end;
$$;

-- ============================================================
-- RPC:update_insurance_claim_pack_items(仅 draft 可编辑清单)
-- ============================================================
create or replace function public.update_insurance_claim_pack_items(
  p_pack_id uuid,
  p_items jsonb default '[]'::jsonb,
  p_updated_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack public.insurance_claim_packs;
  v_item jsonb;
begin
  select * into v_pack from public.insurance_claim_packs where id = p_pack_id for update;
  if not found then
    raise exception 'INSURANCE_PACK_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_pack.status <> 'draft' then
    raise exception 'INSURANCE_PACK_NOT_EDITABLE' using errcode = 'P0003';
  end if;

  delete from public.insurance_claim_pack_items where pack_id = p_pack_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.insurance_claim_pack_items (
      pack_id, source_type, source_id, display_order, required, included
    )
    values (
      p_pack_id,
      v_item->>'source_type',
      (v_item->>'source_id')::uuid,
      coalesce((v_item->>'display_order')::int, 0),
      coalesce((v_item->>'required')::boolean, true),
      coalesce((v_item->>'included')::boolean, true)
    );
  end loop;

  return jsonb_build_object(
    'pack', to_jsonb(v_pack),
    'items', (
      select coalesce(jsonb_agg(to_jsonb(i) order by i.display_order), '[]'::jsonb)
      from public.insurance_claim_pack_items i
      where i.pack_id = p_pack_id
    )
  );
end;
$$;

-- ============================================================
-- RPC:transition_insurance_claim_pack(状态机 + 版本语义)
--   draft → generated(由 generate 命令 RPC 处理,不走本函数)
--   draft → archived / cancelled
--   generated → draft(重新起草,版本保持)/ archived / cancelled
-- ============================================================
create or replace function public.transition_insurance_claim_pack(
  p_pack_id uuid,
  p_status text,
  p_actor_id uuid default null
)
returns public.insurance_claim_packs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack public.insurance_claim_packs;
begin
  select * into v_pack from public.insurance_claim_packs where id = p_pack_id for update;
  if not found then
    raise exception 'INSURANCE_PACK_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_status not in ('archived', 'cancelled', 'draft') then
    raise exception 'INSURANCE_INVALID_STATUS' using errcode = 'P0003';
  end if;

  -- 状态机校验
  if v_pack.status in ('archived', 'cancelled') then
    raise exception 'INSURANCE_PACK_TERMINAL' using errcode = 'P0003';
  end if;
  if p_status = 'draft' and v_pack.status <> 'generated' then
    raise exception 'INSURANCE_INVALID_TRANSITION' using errcode = 'P0003';
  end if;
  if p_status in ('archived', 'cancelled') and v_pack.status not in ('draft', 'generated') then
    raise exception 'INSURANCE_INVALID_TRANSITION' using errcode = 'P0003';
  end if;

  update public.insurance_claim_packs
  set status = p_status, updated_at = now()
  where id = p_pack_id
  returning * into v_pack;

  return v_pack;
end;
$$;

-- ============================================================
-- RPC:create_insurance_claim_export(生成导出:快照 + 归档 + 版本推进)
-- 幂等(pack_id + idempotency_key);乐观并发:要求 p_pack_version = pack.version + 1
-- ============================================================
create or replace function public.create_insurance_claim_export(
  p_pack_id uuid,
  p_pack_version integer,
  p_data_snapshot jsonb default '{}'::jsonb,
  p_data_hash text default null,
  p_file_id uuid,
  p_sha256 text,
  p_mime_type text default 'application/pdf',
  p_size_bytes bigint default 0,
  p_generated_by uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack public.insurance_claim_packs;
  v_export public.insurance_claim_exports;
  v_archive public.document_archives;
begin
  -- 幂等:重复请求返回已存在结果
  if p_idempotency_key is not null then
    select e.* into v_export
    from public.insurance_claim_exports e
    where e.pack_id = p_pack_id and e.idempotency_key = p_idempotency_key;
    if found then
      select * into v_archive from public.document_archives where id = v_export.document_archive_id;
      return jsonb_build_object('export', to_jsonb(v_export), 'archive', to_jsonb(v_archive));
    end if;
  end if;

  select * into v_pack from public.insurance_claim_packs where id = p_pack_id for update;
  if not found then
    raise exception 'INSURANCE_PACK_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_pack.status in ('archived', 'cancelled') then
    raise exception 'INSURANCE_PACK_TERMINAL' using errcode = 'P0003';
  end if;
  if p_pack_version <> v_pack.version + 1 then
    raise exception 'INSURANCE_VERSION_CONFLICT' using errcode = 'P0003';
  end if;

  -- 归档行(不可变:hash/mime/size 一次性写入,之后不得 update)
  insert into public.document_archives (
    tenant_id, store_id, document_type, entity_type, entity_id,
    file_id, sha256, mime_type, size_bytes, status, customer_visible, published, created_by
  )
  values (
    v_pack.tenant_id, v_pack.store_id, 'insurance_claim_pack', 'insurance_claim_pack', p_pack_id,
    p_file_id, p_sha256, p_mime_type, p_size_bytes, 'active', true, false, p_generated_by
  )
  returning * into v_archive;

  insert into public.insurance_claim_exports (
    pack_id, pack_version, data_snapshot, data_hash,
    document_archive_id, generated_by, idempotency_key
  )
  values (
    p_pack_id, p_pack_version, p_data_snapshot, p_data_hash,
    v_archive.id, p_generated_by, p_idempotency_key
  )
  returning * into v_export;

  -- 版本推进 + 状态流转
  update public.insurance_claim_packs
  set version = p_pack_version, status = 'generated', updated_at = now()
  where id = p_pack_id;

  select * into v_pack from public.insurance_claim_packs where id = p_pack_id;

  return jsonb_build_object(
    'export', to_jsonb(v_export),
    'archive', to_jsonb(v_archive),
    'pack', to_jsonb(v_pack)
  );
end;
$$;

-- ============================================================
-- RPC:create_signature_request(创建签名请求,幂等)
-- ============================================================
create or replace function public.create_signature_request(
  p_tenant_id uuid,
  p_store_id uuid default null,
  p_archive_id uuid,
  p_signer_type text default 'customer',
  p_signer_name text default null,
  p_signer_email text default null,
  p_provider text default 'internal',
  p_provider_request_id text default null,
  p_created_by uuid default null,
  p_idempotency_key text default null
)
returns public.signature_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.signature_requests;
  v_archive public.document_archives;
begin
  if p_idempotency_key is not null then
    select * into v_req
    from public.signature_requests
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if found then
      return v_req;
    end if;
  end if;

  select * into v_archive from public.document_archives where id = p_archive_id;
  if not found then
    raise exception 'ARCHIVE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_archive.tenant_id <> p_tenant_id then
    raise exception 'ARCHIVE_TENANT_MISMATCH' using errcode = 'P0003';
  end if;
  if v_archive.status <> 'active' then
    raise exception 'ARCHIVE_NOT_ACTIVE' using errcode = 'P0003';
  end if;

  insert into public.signature_requests (
    tenant_id, store_id, archive_id, signer_type, signer_name, signer_email,
    provider, provider_request_id, status, created_by, idempotency_key
  )
  values (
    p_tenant_id, coalesce(p_store_id, v_archive.store_id), p_archive_id,
    p_signer_type, p_signer_name, p_signer_email,
    p_provider, p_provider_request_id, 'created', p_created_by, p_idempotency_key
  )
  returning * into v_req;

  -- 事件审计(request_created)
  insert into public.signature_events (signature_request_id, event_type, event_payload)
  values (v_req.id, 'request_created', jsonb_build_object('provider', p_provider, 'archiveId', p_archive_id));

  return v_req;
end;
$$;

-- ============================================================
-- RPC:transition_signature_request(状态流转 + 事件落库)
-- ============================================================
create or replace function public.transition_signature_request(
  p_signature_request_id uuid,
  p_status text,
  p_actor_id uuid default null,
  p_reason text default null,
  p_provider_request_id text default null,
  p_event_type text default null,
  p_event_payload jsonb default '{}'::jsonb,
  p_provider_event_id text default null
)
returns public.signature_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.signature_requests;
begin
  select * into v_req from public.signature_requests where id = p_signature_request_id for update;
  if not found then
    raise exception 'SIGNATURE_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 终态不可再流转
  if v_req.status in ('completed', 'cancelled') then
    raise exception 'SIGNATURE_REQUEST_TERMINAL' using errcode = 'P0003';
  end if;
  if p_status not in ('sent', 'completed', 'failed', 'cancelled') then
    raise exception 'SIGNATURE_INVALID_STATUS' using errcode = 'P0003';
  end if;
  -- failed 仅允许回到 sent 重试;completed 只能来自 sent/created 之后
  if p_status = 'completed' and v_req.status = 'failed' then
    raise exception 'SIGNATURE_INVALID_TRANSITION' using errcode = 'P0003';
  end if;

  update public.signature_requests
  set status = p_status,
      reason = case when p_status in ('failed', 'cancelled') then coalesce(p_reason, reason) else reason end,
      provider_request_id = coalesce(p_provider_request_id, provider_request_id),
      updated_at = now()
  where id = p_signature_request_id
  returning * into v_req;

  -- 事件审计(默认映射 event_type;未提供时按状态推导)
  insert into public.signature_events (
    signature_request_id, event_type, event_payload, provider_event_id
  )
  values (
    v_req.id,
    coalesce(p_event_type, p_status),
    p_event_payload,
    p_provider_event_id
  );

  return v_req;
end;
$$;

-- ============================================================
-- RPC:record_signature_event(Provider 事件落库,防重放)
-- ============================================================
create or replace function public.record_signature_event(
  p_signature_request_id uuid,
  p_event_type text,
  p_event_payload jsonb default '{}'::jsonb,
  p_provider_event_id text default null
)
returns public.signature_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.signature_events;
begin
  -- 防重放:同一 provider 事件仅入库一次
  if p_provider_event_id is not null then
    select * into v_event
    from public.signature_events
    where signature_request_id = p_signature_request_id
      and provider_event_id = p_provider_event_id;
    if found then
      return v_event;
    end if;
  end if;

  insert into public.signature_events (
    signature_request_id, event_type, event_payload, provider_event_id
  )
  values (
    p_signature_request_id, p_event_type, p_event_payload, p_provider_event_id
  )
  returning * into v_event;

  return v_event;
end;
$$;

-- ============================================================
-- RPC ACL:全部仅 service_role(Stage-04 Agent-06 新增)
-- ============================================================
do $$
declare
  fns text[] := array[
    'create_insurance_claim_pack(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb)',
    'update_insurance_claim_pack_items(uuid, jsonb, uuid)',
    'transition_insurance_claim_pack(uuid, text, uuid)',
    'create_insurance_claim_export(uuid, integer, jsonb, text, uuid, text, text, bigint, uuid, text)',
    'create_signature_request(uuid, uuid, uuid, text, text, text, text, text, uuid, text)',
    'transition_signature_request(uuid, text, uuid, text, text, text, jsonb, text)',
    'record_signature_event(uuid, text, jsonb, text)'
  ];
  f text;
begin
  foreach f in array fns loop
    execute format('revoke all on function public.%s from public, anon, authenticated;', f);
    execute format('grant execute on function public.%s to service_role;', f);
  end loop;
end;
$$;
