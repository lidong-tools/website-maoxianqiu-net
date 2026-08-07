-- ============================================================
-- 20260806000014_files_attachments.sql
-- MXQ-4001 files/attachments 数据模型
-- MXQ-4002 R2 私有 key(tenant/store/domain 分段)
-- MXQ-4007 旧 r2_files 迁移到 files
-- 幂等,可重复应用
--
-- 设计要点:
--   - files:对象元数据 + 归属租户/门店 + 上传状态 + 归档标记
--   - attachments:文件与业务实体的多对多关联(purpose 区分用途)
--   - object_key 全局唯一,包含 env/tenant/store/domain/yyyy/mm/uuid
--   - 私有医疗文件默认不公开,仅通过 download-url RPC 访问
--   - 软删除(archived_at),不立即删 R2 对象,延迟清理任务回收
-- ============================================================

-- ===== 1. files 表 =====
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  bucket text not null default 'private',          -- private / public
  object_key text not null unique,                  -- 全局唯一,包含分段信息
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  checksum text,                                    -- sha256,上传完成时填入
  category text not null default 'general',         -- pet-avatar / customer-consent / medical-record / lab-report / image / import / export / general

  status text not null default 'pending',           -- pending / uploaded / archived / error
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz,
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,
  archived_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint files_status_check check (status in ('pending', 'uploaded', 'archived', 'error')),
  constraint files_bucket_check check (bucket in ('private', 'public')),
  constraint files_category_check check (category in (
    'pet-avatar', 'customer-consent', 'medical-record',
    'lab-report', 'image', 'import', 'export', 'general'
  ))
);

create index if not exists idx_files_tenant on public.files (tenant_id);
create index if not exists idx_files_store on public.files (store_id);
create index if not exists idx_files_tenant_store on public.files (tenant_id, store_id);
create index if not exists idx_files_status on public.files (status);
create index if not exists idx_files_category on public.files (category);
create index if not exists idx_files_uploaded_by on public.files (uploaded_by);
create index if not exists idx_files_created_at on public.files (created_at desc);
create index if not exists idx_files_archived_at on public.files (archived_at);

-- ===== 2. attachments 表(文件 ↔ 业务实体多对多) =====
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  file_id uuid not null references public.files(id) on delete cascade,
  entity_type text not null,                        -- customer / pet / encounter / prescription / lab_report / ...
  entity_id uuid not null,
  purpose text not null default 'attachment',       -- attachment / avatar / consent / report / ...
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint attachments_entity_purpose_check check (
    entity_type in ('customer', 'pet', 'encounter', 'prescription', 'lab_report', 'inventory', 'store', 'tenant')
    and purpose in ('attachment', 'avatar', 'consent', 'report', 'image', 'export')
  )
);

create index if not exists idx_attachments_tenant on public.attachments (tenant_id);
create index if not exists idx_attachments_file on public.attachments (file_id);
create index if not exists idx_attachments_entity on public.attachments (entity_type, entity_id);
create index if not exists idx_attachments_tenant_entity on public.attachments (tenant_id, entity_type, entity_id);

-- ===== 3. RLS =====
alter table public.files enable row level security;
alter table public.attachments enable row level security;

-- files 读:租户成员可读本租户文件;门店级文件须有该门店权限
drop policy if exists "files_select" on public.files;
create policy "files_select" on public.files
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

-- files 写(创建/更新/归档):走 service role 为主;直连需 file.upload 权限
drop policy if exists "files_insert" on public.files;
create policy "files_insert" on public.files
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and public.has_permission(tenant_id, store_id, 'file.upload')
    )
  );

drop policy if exists "files_update" on public.files;
create policy "files_update" on public.files
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and public.has_permission(tenant_id, store_id, 'file.upload')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and public.has_permission(tenant_id, store_id, 'file.upload')
    )
  );

-- attachments 读:同 files(租户成员且门店可见)
drop policy if exists "attachments_select" on public.attachments;
create policy "attachments_select" on public.attachments
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and exists (
        select 1 from public.files f
        where f.id = attachments.file_id
          and (f.store_id is null or public.can_access_store(f.tenant_id, f.store_id))
      )
    )
  );

-- attachments 写:通过 service role(Hono Command) 为主;直连需 file.upload
drop policy if exists "attachments_insert" on public.attachments;
create policy "attachments_insert" on public.attachments
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and public.has_permission(tenant_id, null, 'file.upload')
    )
  );

drop policy if exists "attachments_delete" on public.attachments;
create policy "attachments_delete" on public.attachments
  for delete to authenticated
  using (
    public.is_system_admin()
    or public.has_permission(tenant_id, null, 'file.upload')
  );

-- ===== 4. 新增权限码 =====
insert into public.permissions (code, name, module) values
  ('file.upload', '上传文件', 'file'),
  ('file.download', '下载文件', 'file'),
  ('file.archive', '归档文件', 'file'),
  ('file.delete', '删除文件', 'file')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 系统角色补 file.* 权限(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in ('file.upload', 'file.download', 'file.archive', 'file.delete')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in ('file.upload', 'file.download', 'file.archive')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array['file.upload', 'file.download', 'file.archive', 'file.delete'])
)
where code in ('system_admin') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['file.upload', 'file.download', 'file.archive'])
)
where code in ('store_manager') and is_system = true;

-- ===== 5. MXQ-4007 旧 r2_files 迁移到 files(幂等) =====
-- 旧表按 user 归属,迁移时根据 user 的 membership 派生 tenant_id/store_id
-- 缺失租户的记录跳过(留给后续清理)
insert into public.files (
  id, tenant_id, store_id, bucket, object_key, original_name,
  mime_type, size_bytes, category, status, uploaded_by, uploaded_at, created_at
)
select
  r.id,
  coalesce(m.tenant_id, (select id from public.tenants where slug = 'default')),
  null,                                -- store_id 留空(旧记录无法可靠派生)
  'public',                             -- 旧文件默认公共可读
  r.key,
  coalesce(nullif(split_part(r.key, '/', -1), ''), r.key),
  coalesce(r.content_type, 'application/octet-stream'),
  coalesce(r.size, 0),
  'general',
  'uploaded',
  r.user_id,
  r.created_at,
  r.created_at
from public.r2_files r
left join lateral (
  select tm.tenant_id
  from public.tenant_memberships tm
  where tm.user_id = r.user_id
    and tm.status = 'active'
  order by tm.joined_at desc
  limit 1
) m on true
where not exists (select 1 from public.files f where f.id = r.id)
  and not exists (select 1 from public.files f where f.object_key = r.key);

-- ===== 6. create_upload_intent RPC(MXQ-4003) =====
-- 创建 pending 文件记录 + 返回预签名上传 URL(由 Hono 层生成,RPC 只负责落库)
-- object_key 格式:{env}/tenant/{tenantId}/store/{storeId}/{domain}/{yyyy}/{mm}/{uuid}.{ext}
create or replace function public.create_upload_intent(
  p_tenant_id uuid,
  p_store_id uuid default null,
  p_category text default 'general',
  p_original_name text default null,
  p_mime_type text default 'application/octet-stream',
  p_size_bytes bigint default 0,
  p_uploaded_by uuid default null,
  p_object_key text default null
)
returns public.files
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.files;
  v_category text := coalesce(p_category, 'general');
  v_mime text := coalesce(p_mime_type, 'application/octet-stream');
begin
  if v_category not in (
    'pet-avatar', 'customer-consent', 'medical-record',
    'lab-report', 'image', 'import', 'export', 'general'
  ) then
    raise exception 'INVALID_FILE_CATEGORY' using errcode = 'P0003';
  end if;

  insert into public.files (
    tenant_id, store_id, bucket, object_key, original_name,
    mime_type, size_bytes, category, status, uploaded_by
  )
  values (
    p_tenant_id,
    p_store_id,
    case when v_category in ('medical-record', 'customer-consent', 'lab-report') then 'private' else 'public' end,
    p_object_key,
    coalesce(p_original_name, p_object_key),
    v_mime,
    p_size_bytes,
    v_category,
    'pending',
    p_uploaded_by
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_upload_intent(uuid, uuid, text, text, text, bigint, uuid, text) from public;
grant execute on function public.create_upload_intent(uuid, uuid, text, text, text, bigint, uuid, text) to authenticated;

-- ===== 7. complete_upload RPC(MXQ-4004) =====
-- 标记文件已上传(写入 uploaded_at + checksum + size),服务端 Hono 已 HEAD 校验
create or replace function public.complete_upload(
  p_file_id uuid,
  p_checksum text default null,
  p_size_bytes bigint default null,
  p_operator_id uuid default null
)
returns public.files
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.files;
begin
  select * into v_row from public.files where id = p_file_id for update;
  if not found then
    raise exception 'FILE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status = 'archived' then
    raise exception 'FILE_ALREADY_ARCHIVED' using errcode = 'P0003';
  end if;

  update public.files
  set status = 'uploaded',
      uploaded_at = now(),
      checksum = coalesce(p_checksum, checksum),
      size_bytes = coalesce(p_size_bytes, size_bytes),
      updated_at = now()
  where id = p_file_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.complete_upload(uuid, text, bigint, uuid) from public;
grant execute on function public.complete_upload(uuid, text, bigint, uuid) to authenticated;

-- ===== 8. archive_file RPC(MXQ-4006) =====
-- 软删除:标记 archived_at + archived_by + reason,不删 R2 对象
create or replace function public.archive_file(
  p_file_id uuid,
  p_archived_by uuid default null,
  p_reason text default null
)
returns public.files
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.files;
begin
  select * into v_row from public.files where id = p_file_id for update;
  if not found then
    raise exception 'FILE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status = 'archived' then
    raise exception 'FILE_ALREADY_ARCHIVED' using errcode = 'P0003';
  end if;

  update public.files
  set status = 'archived',
      archived_at = now(),
      archived_by = p_archived_by,
      archived_reason = p_reason,
      updated_at = now()
  where id = p_file_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.archive_file(uuid, uuid, text) from public;
grant execute on function public.archive_file(uuid, uuid, text) to authenticated;

