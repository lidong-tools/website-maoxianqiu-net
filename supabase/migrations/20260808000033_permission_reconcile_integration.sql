-- ============================================================
-- 20260808000033_permission_reconcile_integration.sql
-- S31-MERGE-A 权限与主线集成收口(A01 + A02)
--
-- A01 tenant_owner 监管权限 reconciliation:
--   - 主线 migration 28 已创建 tenant_owner(scope = tenant,
--     仅 veterinarian_registration.read / manage);
--   - 并发监管 migration 31/32 只 seed 了 system_admin / store_manager / doctor,
--     未给 tenant_owner 监管权限,导致普通医院 owner 无法自行:
--       管理许可证 / 生成+提交年度报告 / 管理疫情事件 / 管理医疗废弃物;
--   - 本次补齐 10 个监管权限:同时写入 role_permissions(新模型)
--     与 roles.permissions 数组(旧模型兼容),并同步 seed.sql 保证
--     db reset 后(seed 覆盖数组)语义一致;
--   - 不把 tenant-level 能力塞回 store_manager / doctor(维持 F05 基线)。
--
-- A02 can_access_store tenant-wide semantics:
--   - Hono scoped permission 语义:合法 tenant-wide role
--     (role.scope = tenant AND employee_role_assignments.store_id IS NULL)
--     → 可访问本 tenant 下全部 store;
--   - 原 can_access_store 只认 employee_store_assignments,导致
--     "Hono Command 可操作,但 Supabase Query + RLS 看不到"的不一致;
--   - 重定义至少满足:platform admin OR 合法 tenant-wide role
--     OR 目标门店分配;
--   - 不放大 store role;era.tenant_id 限定目标租户,保持
--     tenant A role ≠ tenant B access。
-- ============================================================

-- ============================================================
-- 1. A01:tenant_owner 监管权限 reconciliation
-- ============================================================

-- 1.1 新模型:role_permissions 关联表(幂等,不重复插入)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'tenant_owner'
  and p.code in (
    'license.read', 'license.manage',
    'regulatory_report.read', 'regulatory_report.generate', 'regulatory_report.submit',
    'epidemic.read', 'epidemic.report', 'epidemic.resolve',
    'waste.read', 'waste.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp
    where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 1.2 旧模型兼容:roles.permissions 数组追加(幂等去重)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'license.read', 'license.manage',
    'regulatory_report.read', 'regulatory_report.generate', 'regulatory_report.submit',
    'epidemic.read', 'epidemic.report', 'epidemic.resolve',
    'waste.read', 'waste.manage'
  ])
)
where code = 'tenant_owner' and is_system = true;

-- ============================================================
-- 2. A02:can_access_store tenant-wide semantics 重定义
--    判定:platform admin OR 合法 tenant-wide role OR 目标门店分配
-- ============================================================
create or replace function public.can_access_store(p_tenant_id uuid, p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or exists (
      -- 合法 tenant-wide role:role.scope = tenant 且租户级分配(store_id IS NULL)
      -- era.tenant_id 限定目标租户,杜绝 tenant A role 越权访问 tenant B
      select 1
      from public.employee_role_assignments era
      join public.employees e on e.id = era.employee_id
      join public.roles r on r.id = era.role_id
      where era.tenant_id = p_tenant_id
        and era.store_id is null
        and r.scope = 'tenant'
        and e.user_id = auth.uid()
        and e.status = 'active'
    )
    or exists (
      -- 目标门店分配(既有语义保留,store role 不放大为 tenant-wide)
      select 1
      from public.employee_store_assignments esa
      join public.employees e on e.id = esa.employee_id
      where esa.tenant_id = p_tenant_id
        and esa.store_id = p_store_id
        and e.user_id = auth.uid()
        and e.status = 'active'
        and (esa.ends_at is null or esa.ends_at > now())
    );
$$;

-- 权限收紧与 migration 10 保持一致:仅 authenticated 可调用(RLS 内联调用)
revoke all on function public.can_access_store(uuid, uuid) from public;
grant execute on function public.can_access_store(uuid, uuid) to authenticated;
