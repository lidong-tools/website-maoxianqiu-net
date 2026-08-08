-- ============================================================
-- 20260810000093_permission_helper_restore.sql
-- Agent-07 二轮收口(P0-02/P0-03):权限 Helper 恢复 Hardened 语义
--
-- 背景:Agent-01 migration 54 为了加"租户停用"覆盖了三个 RLS Helper:
--   - has_permission 丢失 role_permissions 关联表 + role.scope 语义,
--     只判断 roles.permissions[] 数组 → store role 可被当作 tenant 权限;
--   - can_access_store 只认 employee_store_assignments,丢掉了 tenant/system
--     scope 合法 tenant-wide 角色可访问全门店的语义 → Hono 与 RLS 权限模型不一致;
--   - 三个 Helper 均要求 status='active',把未过期的 trial 租户也拦掉。
--
-- 本迁移以 Hardened 基线(migration 26 / 33 / 10)恢复完整语义:
--   has_permission   → scope 感知(v3)+ role_permissions 关联表 + legacy 数组
--   can_access_store → tenant-wide role OR store 分配,且 store∈tenant
--   is_tenant_member → is_system_admin OR 有效成员
-- 仅叠加统一租户业务可用判定 is_tenant_business_active:
--   active                       → 正常
--   trial 且 trial_ends_at 未过期 → 正常
--   trial 已过期 / suspended      → 拦截
-- 平台管理员 is_system_admin() 短路放行(可对 suspended/trial 租户执行恢复等管理动作)。
-- 幂等,可重复应用。
-- ============================================================

-- ===== 1. 统一租户业务可用判定 =====
create or replace function public.is_tenant_business_active(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tenants t
    where t.id = p_tenant_id
      and (
        t.status = 'active'
        or (t.status = 'trial' and (t.trial_ends_at is null or t.trial_ends_at > now()))
      )
  );
$$;

-- ===== 2. has_permission(v3 scope 感知 + role_permissions 关联表 + legacy 数组) =====
create or replace function public.has_permission(p_tenant_id uuid, p_store_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or (
      public.is_tenant_business_active(p_tenant_id)
      and exists (
        select 1
        from public.employee_role_assignments era
        join public.employees e on e.id = era.employee_id
        join public.roles r on r.id = era.role_id
        where e.user_id = auth.uid()
          and e.status = 'active'
          and era.tenant_id = p_tenant_id
          and (
            -- tenant 上下文:仅 tenant/system scope 的 tenant-wide 分配(禁止 store role 越权)
            (p_store_id is null and era.store_id is null and r.scope in ('system', 'tenant'))
            -- store 上下文:目标门店的 store 分配(role.scope = store)
            --            或 tenant/system scope 的 tenant-wide 分配(store_id IS NULL)
            or (p_store_id is not null and (
                  (era.store_id = p_store_id and r.scope = 'store')
                  or (era.store_id is null and r.scope in ('system', 'tenant'))
                ))
          )
          and (
            -- 新模型:role_permissions 关联表
            exists (
              select 1
              from public.role_permissions rp
              join public.permissions p on p.id = rp.permission_id
              where rp.role_id = r.id and p.code = p_permission
            )
            -- 旧模型兼容:roles.permissions 数组
            or (r.permissions is not null and p_permission = any(r.permissions))
          )
      )
    );
$$;

-- ===== 3. can_access_store(tenant-wide role OR store 分配,且 store∈tenant) =====
create or replace function public.can_access_store(p_tenant_id uuid, p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    -- 目标 store 必须真实存在且属于目标 tenant
    select 1
    from public.stores s
    where s.id = p_store_id
      and s.tenant_id = p_tenant_id
  )
  and (
    public.is_system_admin()
    or (
      public.is_tenant_business_active(p_tenant_id)
      and (
        exists (
          -- 合法 tenant-wide role:role.scope = tenant 且租户级分配(store_id IS NULL)
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
          -- 目标门店分配(store role 不放大为 tenant-wide)
          select 1
          from public.employee_store_assignments esa
          join public.employees e on e.id = esa.employee_id
          where esa.tenant_id = p_tenant_id
            and esa.store_id = p_store_id
            and e.user_id = auth.uid()
            and e.status = 'active'
            and (esa.ends_at is null or esa.ends_at > now())
        )
      )
    )
  );
$$;

-- ===== 4. is_tenant_member(is_system_admin OR 有效成员,叠加业务可用) =====
create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or (
      public.is_tenant_business_active(p_tenant_id)
      and exists (
        select 1 from public.tenant_memberships tm
        where tm.tenant_id = p_tenant_id
          and tm.user_id = auth.uid()
          and tm.status = 'active'
      )
    );
$$;

-- ===== 5. RLS helper 授权(仅 authenticated,RLS 内联调用) =====
revoke all on function public.is_tenant_business_active(uuid) from public;
revoke all on function public.has_permission(uuid, uuid, text) from public;
revoke all on function public.can_access_store(uuid, uuid) from public;
revoke all on function public.is_tenant_member(uuid) from public;
grant execute on function public.is_tenant_business_active(uuid) to authenticated;
grant execute on function public.has_permission(uuid, uuid, text) to authenticated;
grant execute on function public.can_access_store(uuid, uuid) to authenticated;
grant execute on function public.is_tenant_member(uuid) to authenticated;
