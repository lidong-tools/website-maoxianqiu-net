-- ============================================================
-- 0052_system_settings.sql
-- CORE-06 系统设置基础:
--   - stores.timezone / stores.business_hours
--   - system_settings 通用配置表(租户默认 + 门店覆盖,来源继承)
--   - 设置权限码
-- 应用方式:Supabase SQL Editor 按编号顺序执行(幂等)
-- ============================================================

-- ===== 1. stores 扩展门店营业字段 =====
alter table public.stores add column if not exists timezone text;
-- 语义:timezone IS NULL → 继承 tenant.timezone
alter table public.stores add column if not exists business_hours jsonb not null default '{}'::jsonb;

-- ===== 2. system_settings 通用配置表 =====
-- store_id IS NULL = 租户默认;store_id = X = 门店覆盖
-- 读取优先级:门店覆盖 → 租户默认 → 代码内置系统默认
create table if not exists public.system_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid references public.stores(id) on delete cascade,
  namespace text not null,
  key text not null,
  value_json jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint system_settings_scope_unique unique (tenant_id, store_id, namespace, key)
);

create index if not exists idx_system_settings_scope
  on public.system_settings (tenant_id, store_id, namespace);

-- RLS:仅租户成员可读;写入仅 service role(Hono Command),authenticated 无写策略
alter table public.system_settings enable row level security;
drop policy if exists "system_settings_select_tenant" on public.system_settings;
create policy "system_settings_select_tenant" on public.system_settings
  for select to authenticated using (public.is_tenant_member(tenant_id));

drop trigger if exists trg_system_settings_updated_at on public.system_settings;
create trigger trg_system_settings_updated_at
  before update on public.system_settings
  for each row execute procedure public.touch_updated_at();

-- ===== 3. 支付/打印/字典表 RLS(系统设置页直连维护) =====
-- 未显式启用 RLS 的表默认全量可读,这里补上租户边界的读写策略
alter table public.payment_contexts enable row level security;
drop policy if exists "payment_contexts_select_tenant" on public.payment_contexts;
create policy "payment_contexts_select_tenant" on public.payment_contexts
  for select to authenticated using (public.is_tenant_member(tenant_id));
drop policy if exists "payment_contexts_write_store" on public.payment_contexts;
create policy "payment_contexts_write_store" on public.payment_contexts
  for all to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, store_id, 'settings.store.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, store_id, 'settings.store.manage'));

alter table public.print_settings enable row level security;
drop policy if exists "print_settings_select_tenant" on public.print_settings;
create policy "print_settings_select_tenant" on public.print_settings
  for select to authenticated using (public.is_tenant_member(tenant_id));
drop policy if exists "print_settings_write_store" on public.print_settings;
create policy "print_settings_write_store" on public.print_settings
  for all to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, store_id, 'settings.store.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, store_id, 'settings.store.manage'));

alter table public.base_dictionaries enable row level security;
drop policy if exists "base_dictionaries_select_tenant" on public.base_dictionaries;
create policy "base_dictionaries_select_tenant" on public.base_dictionaries
  for select to authenticated using (public.is_tenant_member(tenant_id));
drop policy if exists "base_dictionaries_write_tenant" on public.base_dictionaries;
create policy "base_dictionaries_write_tenant" on public.base_dictionaries
  for all to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'settings.tenant.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'settings.tenant.manage'));

-- ===== 4. 设置权限码 =====
insert into public.permissions (code, name, module) values
  ('settings.tenant.read', '查看医院设置', 'system'),
  ('settings.tenant.manage', '管理医院设置', 'system'),
  ('settings.store.read', '查看门店设置', 'system'),
  ('settings.store.manage', '管理门店设置', 'system')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin / tenant_owner:全部设置权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner')
  and p.code in ('settings.tenant.read', 'settings.tenant.manage', 'settings.store.read', 'settings.store.manage')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:门店级设置权限(scope=store,仅本店覆盖)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in ('settings.store.read', 'settings.store.manage')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'settings.tenant.read', 'settings.tenant.manage', 'settings.store.read', 'settings.store.manage'
  ])
)
where code in ('system_admin', 'tenant_owner') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['settings.store.read', 'settings.store.manage'])
)
where code = 'store_manager' and is_system = true;
