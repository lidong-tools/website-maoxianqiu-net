-- ============================================================
-- 20260809000038_tenant_init_support.sql
-- S3.1 并发任务 A:租户初始化支撑视图(migration 38,独占 35~38)
--
-- 1. v_tenant_initialization_summary:租户初始化总览视图
--    (租户信息 + 最新初始化状态 + 默认门店/仓库/默认支付方式/默认打印规格/字典数量)
-- 2. 权限 reconcile 兜底:若上游 seed/migration 时序导致角色权限缺失,幂等补齐。
-- ============================================================

-- ============================================================
-- 1. v_tenant_initialization_summary
-- ============================================================
create or replace view public.v_tenant_initialization_summary as
select
  t.id as tenant_id,
  t.slug,
  t.name as tenant_name,
  t.status as tenant_status,
  ti.status as init_status,
  ti.attempts as init_attempts,
  ti.last_error,
  ti.started_at,
  ti.completed_at,
  ti.failed_at,
  s.id as store_id,
  s.name as store_name,
  s.code as store_code,
  w.id as warehouse_id,
  w.name as warehouse_name,
  pc.method as default_payment_method,
  ps.paper_size as default_paper_size,
  (select count(*) from public.base_dictionaries bd where bd.tenant_id = t.id) as dictionary_count
from public.tenants t
left join public.tenant_initializations ti
  on ti.tenant_id = t.id
 and ti.id = (
   select ti2.id from public.tenant_initializations ti2
   where ti2.tenant_id = t.id
   order by ti2.created_at desc
   limit 1
 )
left join public.stores s on s.id = ti.store_id
left join public.warehouses w
  on w.tenant_id = t.id and w.is_default = true and w.is_active = true
left join public.payment_contexts pc
  on pc.tenant_id = t.id and pc.store_id = s.id and pc.is_default = true and pc.is_active = true
left join public.print_settings ps
  on ps.tenant_id = t.id and ps.store_id = s.id and ps.is_default = true and ps.is_active = true;

comment on view public.v_tenant_initialization_summary is
  'S3.1-A 租户初始化总览:租户 + 最新初始化状态 + 默认门店/仓库/支付/打印/字典统计';

-- ============================================================
-- 2. 权限 reconcile 兜底(幂等)
--    S3.1 并发时序:seed.sql 在 db reset 时最后执行,会覆盖 roles.permissions 数组;
--    本兜底保证 role_permissions 关联表与数组在任意执行顺序下语义一致。
-- ============================================================

-- 2.1 tenant_owner:补齐初始化相关权限(幂等)
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

-- 2.2 system_admin:补齐初始化相关权限(幂等)
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

-- 2.3 数组兼容兜底:确保数组包含初始化权限(幂等去重)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'tenant.initialize', 'tenant.initialization.read',
    'payment_context.read', 'print.setting.read'
  ])
)
where code in ('system_admin', 'tenant_owner') and is_system = true
  and not (permissions @> array['tenant.initialize', 'tenant.initialization.read']);
