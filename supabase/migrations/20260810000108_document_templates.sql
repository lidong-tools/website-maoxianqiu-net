-- ============================================================
-- S32-C 业务文档与打印中心 V2
-- migration 108: document_templates + document_history
-- ------------------------------------------------------------
-- 设计:
--   * document_templates:业务文档模板(支持 门店覆盖 > 租户默认 > 系统默认)
--   * document_history:文档渲染/打印历史(审计辅助,service_role 写入)
--   * 新增权限码:documents.view / documents.print / documents.template.manage
-- 安全:
--   * 系统默认模板(tenant_id is null)对 authenticated 只读,写入仅 service_role(种子)
--   * 模板只允许安全变量 {{path}} / {{#each}},服务端渲染器不执行任意 JS
-- ============================================================

-- ===== 文档类型约束 =====
-- prescription / invoice / medical_record_summary / lab_report
-- imaging_report / discharge_summary / vaccination_certificate / boarding_handover

create table if not exists public.document_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete cascade,
  document_type text not null,
  name text not null,
  version integer not null default 1,
  template_html text not null,                          -- 安全变量模板({{path}} / {{#each}})
  template_json jsonb not null default '{}'::jsonb,     -- 结构化配置(页眉/字段显隐等)
  paper_size text not null default 'A4',                -- A4 / 80mm / 58mm
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_templates_type_check check (
    document_type in (
      'prescription', 'invoice', 'medical_record_summary', 'lab_report',
      'imaging_report', 'discharge_summary', 'vaccination_certificate', 'boarding_handover'
    )
  ),
  constraint document_templates_paper_size_check check (paper_size in ('A4', '80mm', '58mm'))
);

-- 读取优先级索引:门店覆盖 → 租户默认 → 系统默认
create index if not exists idx_document_templates_lookup on public.document_templates
  (tenant_id, store_id, document_type, is_active);
create index if not exists idx_document_templates_type_default on public.document_templates
  (document_type, is_default);
create index if not exists idx_document_templates_tenant_type on public.document_templates
  (tenant_id, document_type);

drop trigger if exists trg_document_templates_updated_at on public.document_templates;
create trigger trg_document_templates_updated_at
  before update on public.document_templates
  for each row execute procedure public.touch_updated_at();

-- ===== RLS:document_templates =====
alter table public.document_templates enable row level security;

drop policy if exists "document_templates_select" on public.document_templates;
create policy "document_templates_select" on public.document_templates
  for select to authenticated
  using (
    tenant_id is null
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

-- 系统默认模板(tenant_id is null)不允许 authenticated 写入,仅 service_role 种子可写
drop policy if exists "document_templates_insert" on public.document_templates;
create policy "document_templates_insert" on public.document_templates
  for insert to authenticated
  with check (
    tenant_id is not null
    and public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'documents.template.manage')
  );

drop policy if exists "document_templates_update" on public.document_templates;
create policy "document_templates_update" on public.document_templates
  for update to authenticated
  using (
    tenant_id is not null
    and public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'documents.template.manage')
  )
  with check (
    tenant_id is not null
    and public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'documents.template.manage')
  );

drop policy if exists "document_templates_delete" on public.document_templates;
create policy "document_templates_delete" on public.document_templates
  for delete to authenticated
  using (
    tenant_id is not null
    and public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'documents.template.manage')
  );

-- ===== document_history(文档渲染/打印历史) =====
-- 设计为不可变审计辅助:仅 service_role 写入(Hono 路由代理),authenticated 只读
create table if not exists public.document_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  document_type text not null,
  entity_type text not null,                            -- 业务实体类型(与 document_type 通常一致)
  entity_id uuid not null,
  template_id uuid references public.document_templates(id) on delete set null,
  template_version integer,
  paper_size text,
  action text not null default 'render',                -- render / print
  operator_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint document_history_type_check check (
    document_type in (
      'prescription', 'invoice', 'medical_record_summary', 'lab_report',
      'imaging_report', 'discharge_summary', 'vaccination_certificate', 'boarding_handover'
    )
  ),
  constraint document_history_action_check check (action in ('render', 'print'))
);

create index if not exists idx_document_history_tenant_time on public.document_history
  (tenant_id, created_at desc);
create index if not exists idx_document_history_entity on public.document_history
  (entity_type, entity_id);
create index if not exists idx_document_history_type on public.document_history
  (tenant_id, document_type, created_at desc);

alter table public.document_history enable row level security;

drop policy if exists "document_history_select" on public.document_history;
create policy "document_history_select" on public.document_history
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

-- ============================================================
-- 新增权限码(S32-C)
-- ============================================================
insert into public.permissions (code, name, module) values
  ('documents.view', '查看业务文档', 'documents'),
  ('documents.print', '打印业务文档', 'documents'),
  ('documents.template.manage', '管理文档模板', 'documents')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin 补全部文档权限(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in ('documents.view', 'documents.print', 'documents.template.manage')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager 补文档权限(含模板管理)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in ('documents.view', 'documents.print', 'documents.template.manage')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'documents.view', 'documents.print', 'documents.template.manage'
  ])
)
where code = 'system_admin' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'documents.view', 'documents.print', 'documents.template.manage'
  ])
)
where code = 'store_manager' and is_system = true;
