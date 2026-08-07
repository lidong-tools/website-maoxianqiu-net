-- ============================================================
-- 20260809000037_tenant_init_rbac.sql
-- S3.1 并发任务 A:租户初始化 RBAC(migration 37,独占 35~38)
--
-- 1. 4 张新表 RLS:仅开放 SELECT(初始化状态/支付上下文/打印设置/基础字典),
--    写操作一律走 service-role-only RPC(initialize_tenant),不开放任何写策略;
-- 2. 权限码 seed:tenant.initialize(执行初始化) / tenant.initialization.read(查看状态);
-- 3. 角色授权:system_admin(平台,全量)+ tenant_owner(租户级,scope=tenant);
-- 4. service-role-only:initialize_tenant / get_tenant_initialization
--    revoke public/anon/authenticated + grant service_role(与 manifest 静态校验对齐);
-- 5. 表级权限收紧:新表 revoke public,仅 service_role(RLS SELECT 策略 + authenticated grant 放行读取)。
-- ============================================================

-- ============================================================
-- 1. RLS 策略(仅 SELECT;写走 RPC)
-- ============================================================

-- 1.1 tenant_initializations:租户成员 + tenant.initialization.read 可读最新状态
alter table public.tenant_initializations enable row level security;

drop policy if exists "tenant_initializations_select" on public.tenant_initializations;
create policy "tenant_initializations_select" on public.tenant_initializations
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'tenant.initialization.read')
  );

-- 1.2 payment_contexts:租户成员 + 门店可访问(初始化产物,读=支付上下文查看能力)
alter table public.payment_contexts enable row level security;

drop policy if exists "payment_contexts_select" on public.payment_contexts;
create policy "payment_contexts_select" on public.payment_contexts
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'payment_context.read')
  );

-- 1.3 print_settings:租户成员 + 门店可访问(读=打印配置查看能力)
alter table public.print_settings enable row level security;

drop policy if exists "print_settings_select" on public.print_settings;
create policy "print_settings_select" on public.print_settings
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.can_access_store(tenant_id, store_id)
    and public.has_permission(tenant_id, store_id, 'print.setting.read')
  );

-- 1.4 base_dictionaries:租户成员即可读(初始化基础字典,业务全局可用)
alter table public.base_dictionaries enable row level security;

drop policy if exists "base_dictionaries_select" on public.base_dictionaries;
create policy "base_dictionaries_select" on public.base_dictionaries
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- ============================================================
-- 2. 权限码 seed
-- ============================================================
insert into public.permissions (code, name, module) values
  ('tenant.initialize', '初始化租户', 'tenant'),
  ('tenant.initialization.read', '查看租户初始化状态', 'tenant'),
  ('payment_context.read', '查看支付上下文', 'billing'),
  ('print.setting.read', '查看打印设置', 'operations')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- ============================================================
-- 3. 角色授权
-- ============================================================

-- 3.1 system_admin(平台角色,全量授予)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'tenant.initialize', 'tenant.initialization.read',
    'payment_context.read', 'print.setting.read'
  )
  and not exists (
    select 1 from public.role_permissions rp
    where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 3.2 tenant_owner(租户级角色 scope=tenant;S31-A 约束:不得用 system_admin 替代)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'tenant_owner'
  and p.code in (
    'tenant.initialize', 'tenant.initialization.read',
    'payment_context.read', 'print.setting.read'
  )
  and not exists (
    select 1 from public.role_permissions rp
    where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 3.3 旧模型兼容:roles.permissions 数组追加(幂等去重)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'tenant.initialize', 'tenant.initialization.read',
    'payment_context.read', 'print.setting.read'
  ])
)
where code in ('system_admin', 'tenant_owner') and is_system = true;

-- ============================================================
-- 4. service-role-only(与 api/lib/service-rpc-manifest.ts 静态校验对齐)
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    -- S3.1-A 租户初始化
    'initialize_tenant',
    'get_tenant_initialization'
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

-- ============================================================
-- 5. 新表表级权限收紧(仅 service_role 写;authenticated 读由 RLS 策略兜底)
-- ============================================================
revoke all on table public.tenant_initializations from public;
revoke all on table public.payment_contexts from public;
revoke all on table public.print_settings from public;
revoke all on table public.base_dictionaries from public;

grant select on table public.tenant_initializations to authenticated;
grant select on table public.payment_contexts to authenticated;
grant select on table public.print_settings to authenticated;
grant select on table public.base_dictionaries to authenticated;
