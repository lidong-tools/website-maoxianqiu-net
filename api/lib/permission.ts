import type { Context } from 'hono'
import type { AppEnv, RequestContext } from './types'
import { err } from './errors'
import { getContext } from './request-context'
import { createServiceClient } from './supabase'

interface RolePermissionRow {
  permissions?: { code: string } | { code: string }[] | null
}

interface RoleRow {
  id: string
  code: string
  scope: string
  is_system: boolean
  permissions: string[] | null
}

/** 平台管理员角色码(与 SQL is_system_admin() 判定一致,独立平台级授权) */
const PLATFORM_ADMIN_ROLE = 'system_admin'

interface EmployeeRow {
  id: string
}

interface EmployeeRoleAssignmentRow {
  role_id: string
  store_id: string | null
}

/**
 * 授权作用域(P0-01)
 * 代表调用者在"目标租户 + 目标门店"下已被确认的角色与权限,
 * 作为 service role 路由 Command/列表的授权依据,替代全局权限 union。
 */
export interface AccessScope {
  userId: string
  employeeId: string
  tenantId: string
  storeId?: string
  /** 调用者在目标租户下被授权可访问的门店 id 集合(P0-06 报表数据范围) */
  allowedStoreIds: string[]
  roleIds: string[]
  permissions: string[]
  isPlatformAdmin: boolean
}

/**
 * 加载调用者聚合权限码(去重),结果写入 context.permissions。
 * MXQ-3010:权限来源升级为新模型 role_permissions 关联表 + 旧模型 roles.permissions 数组(union 兼容)。
 *
 * @deprecated P0-01 之后 Command 授权应使用 requireScopedPermission;
 * 本函数保留用于兼容旧调用方与需要"全量权限概览"的场景,不再作为租户/门店命令授权依据。
 */
export async function loadPermissions(c: Context<AppEnv>): Promise<string[]> {
  const context = getContext(c)
  const roleIds = [...new Set(context.memberships.map(m => m.role_id))]
  if (roleIds.length === 0) {
    context.permissions = []
    return context.permissions
  }
  const service = createServiceClient()

  // 1) 新模型:role_permissions 关联表
  const { data: rpRows } = await service
    .from('role_permissions')
    .select('permission_id, permissions(code)')
    .in('role_id', roleIds)
  const rpPerms = (rpRows ?? [])
    .flatMap((row: RolePermissionRow) => {
      if (!row.permissions) {
        return []
      }
      return Array.isArray(row.permissions)
        ? row.permissions.map(p => p.code)
        : [row.permissions.code]
    })

  // 2) 旧模型兼容:roles.permissions 数组
  const { data: roleRows } = await service
    .from('roles')
    .select('permissions')
    .in('id', roleIds)
  const legacyPerms = (roleRows ?? []).flatMap(
    (r: { permissions: string[] | null }) => r.permissions ?? [],
  )

  const perms = [...new Set([...rpPerms, ...legacyPerms])]
  context.permissions = perms
  return perms
}

export interface PermissionRequirement {
  code: string
  storeId?: string
}

/**
 * 权限校验(MXQ-2006)
 * - 无权限码抛 403 FORBIDDEN
 * - 指定 storeId 时,系统管理员放行;否则要求成员关系覆盖该门店(临时机制,
 *   迁移到 employee_store_assignments 后由 RLS 兜底,此处作为服务端第一道校验)
 *
 * @deprecated P0-01 之后新业务应使用 requireScopedPermission 做租户/门店收敛。
 */
export async function requirePermission(
  c: Context<AppEnv>,
  requirement: PermissionRequirement,
): Promise<RequestContext> {
  const context = getContext(c)
  let permissions = context.permissions
  if (permissions.length === 0) {
    permissions = await loadPermissions(c)
  }
  if (!permissions.includes(requirement.code)) {
    throw err.forbidden(`缺少权限: ${requirement.code}`)
  }

  if (requirement.storeId) {
    const isSystemAdmin = permissions.includes('system.admin')
    const inScope = context.memberships.some(m => m.store_id === requirement.storeId)
    if (!isSystemAdmin && !inScope) {
      throw err.forbidden('无权访问该门店的数据')
    }
  }
  return context
}

/**
 * 租户归属校验(MXQ-3007 跨租户隔离)
 * 服务端唯一真源是调用者的 memberships;请求体/URL 中的 tenantId 必须与调用者所属租户一致。
 * system_admin 放行;其余用户要求至少存在一个 tenant_id 与该租户相同的有效成员关系。
 */
export function assertTenantAccess(c: Context<AppEnv>, tenantId?: string | null): RequestContext {
  const context = getContext(c)
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  const isSystemAdmin = context.permissions.includes('system.admin')
  if (isSystemAdmin) {
    return context
  }
  const authorized = context.memberships.some(m => m.tenant_id === tenantId)
  if (!authorized) {
    throw err.forbidden('无权访问该租户的数据')
  }
  return context
}

/**
 * 门店归属校验(返回门店所属租户)
 * 用于需要同时校验"门店租户 == 调用者租户"的场景,避免先查库再手写判断。
 */
export async function assertStoreTenant(
  c: Context<AppEnv>,
  storeId: string,
): Promise<string> {
  // getContext 用于校验请求上下文已初始化,结果在此无需使用
  const _context = getContext(c)
  const service = createServiceClient()
  const { data: store, error } = await service
    .from('stores')
    .select('tenant_id')
    .eq('id', storeId)
    .single()
  if (error || !store) {
    throw err.notFound('门店不存在')
  }
  assertTenantAccess(c, store.tenant_id)
  return store.tenant_id
}

/**
 * 从角色 id 列表聚合权限码(role_permissions 关联表 + roles.permissions 旧模型兼容)
 * @param service supabase service client
 * @param roleIds 目标角色 id 列表
 * @param roles 已加载的角色行(用于旧模型数组权限)
 * @returns 去重后的权限码集合
 */
async function collectRolePermissions(
  service: ReturnType<typeof createServiceClient>,
  roleIds: string[],
  roles: RoleRow[],
): Promise<string[]> {
  if (roleIds.length === 0) {
    return []
  }
  const { data: rpRows, error: rpError } = await service
    .from('role_permissions')
    .select('permission_id, permissions(code)')
    .in('role_id', roleIds)
  if (rpError) {
    throw err.internal(`查询角色权限失败: ${rpError.message}`)
  }
  const rpPerms = ((rpRows as RolePermissionRow[] | null) ?? []).flatMap((row) => {
    if (!row.permissions) {
      return []
    }
    return Array.isArray(row.permissions)
      ? row.permissions.map(p => p.code)
      : [row.permissions.code]
  })
  const roleIdSet = new Set(roleIds)
  const legacyPerms = roles
    .filter(r => roleIdSet.has(r.id))
    .flatMap(r => r.permissions ?? [])
  return [...new Set([...rpPerms, ...legacyPerms])]
}

export interface ScopedRequirement {
  code: string
  tenantId: string
  storeId?: string
  /**
   * 数据范围模式(报表等只读聚合):
   * - 未传 storeId 时允许门店级角色参与授权(而不要求 tenant-wide role),
   *   但实际数据范围由 scope.allowedStoreIds 收敛到被授权门店;
   * - 默认(命令模式)未传 storeId 时只允许 tenant-wide role,禁止门店角色越权。
   */
  dataScope?: boolean
}

/**
 * 解析调用者在"目标租户 + 目标门店"下的真实授权作用域(P0-01)
 *
 * 处理顺序:
 * 1. 平台管理员(拥有 system_admin 系统角色)是独立平台级授权,
 *    不限定租户/门店,直接加载其角色权限后放行;
 * 2. 根据 auth.uid() 查目标租户下 active employee;
 * 3. 查该员工在目标租户下的 role assignment;
 * 4. 门店命令只匹配:store_id = 目标门店 或 明确 tenant-wide role(store_id is null);
 *    未传 storeId 的命令只允许 tenant-wide role(审计 4.2,禁止 store role 越权);
 *    数据范围模式(dataScope)允许门店级角色,但通过 allowedStoreIds 收敛;
 * 5. 只加载匹配 role IDs 的 permissions(role_permissions 关联表 + roles.permissions 兼容);
 * 6. 校验目标门店确实属于目标租户;
 * 7. 计算 allowedStoreIds:tenant-wide 权限 → 全租户门店;否则 → 被授权门店集合;
 * 8. 返回已确认的授权作用域。
 */
export async function resolveScopedAccess(
  c: Context<AppEnv>,
  requirement: ScopedRequirement,
): Promise<AccessScope> {
  const user = c.get('user')
  const service = createServiceClient()

  // ===== 1) 平台管理员独立分支 =====
  // 判定方式与 SQL is_system_admin() 一致:任一 active employee 分配了 system_admin 角色
  const { data: allEmployees, error: empAllError } = await service
    .from('employees')
    .select('id')
    .eq('user_id', user.id)
    .eq('status', 'active')
  if (empAllError) {
    throw err.internal(`查询员工档案失败: ${empAllError.message}`)
  }
  const allEmpIds = ((allEmployees as EmployeeRow[] | null) ?? []).map(e => e.id)
  if (allEmpIds.length > 0) {
    const { data: allAssignments, error: assignAllError } = await service
      .from('employee_role_assignments')
      .select('role_id')
      .in('employee_id', allEmpIds)
    if (assignAllError) {
      throw err.internal(`查询角色分配失败: ${assignAllError.message}`)
    }
    const allRoleIds = [...new Set(((allAssignments as { role_id: string }[] | null) ?? []).map(a => a.role_id))]
    if (allRoleIds.length > 0) {
      const { data: allRoles, error: rolesAllError } = await service
        .from('roles')
        .select('id, code, scope, is_system, permissions')
        .in('id', allRoleIds)
      if (rolesAllError) {
        throw err.internal(`查询角色失败: ${rolesAllError.message}`)
      }
      const rolesAll = (allRoles as RoleRow[] | null) ?? []
      // 平台管理员纵深防御:code = system_admin AND is_system = true AND scope = system(审计 4.3)
      const isPlatformAdmin = rolesAll.some(r =>
        r.code === PLATFORM_ADMIN_ROLE && r.is_system === true && r.scope === 'system',
      )
      if (isPlatformAdmin) {
        // 平台管理员权限集:system_admin 角色(新模型关联表 + 旧模型数组)
        const adminRoleIds = rolesAll.filter(r => r.code === PLATFORM_ADMIN_ROLE).map(r => r.id)
        const { data: adminRp, error: adminRpError } = await service
          .from('role_permissions')
          .select('permission_id, permissions(code)')
          .in('role_id', adminRoleIds)
        if (adminRpError) {
          throw err.internal(`查询角色权限失败: ${adminRpError.message}`)
        }
        const adminPerms = ((adminRp as RolePermissionRow[] | null) ?? []).flatMap((row) => {
          if (!row.permissions) {
            return []
          }
          return Array.isArray(row.permissions)
            ? row.permissions.map(p => p.code)
            : [row.permissions.code]
        })
        const legacyAdminPerms = rolesAll
          .filter(r => r.code === PLATFORM_ADMIN_ROLE)
          .flatMap(r => r.permissions ?? [])
        const permissions = [...new Set([...adminPerms, ...legacyAdminPerms])]
        if (!permissions.includes(requirement.code)) {
          throw err.forbidden(`缺少权限: ${requirement.code}`)
        }
        // 平台管理员跨租户放行;仍校验目标门店属于目标租户(若提供)
        if (requirement.storeId) {
          const { data: store, error: storeError } = await service
            .from('stores')
            .select('tenant_id')
            .eq('id', requirement.storeId)
            .single()
          if (storeError || !store) {
            throw err.notFound('门店不存在')
          }
          if (store.tenant_id !== requirement.tenantId) {
            throw err.forbidden('门店不属于该租户')
          }
        }
        // 平台管理员可访问目标租户下全部门店
        const { data: tenantStores, error: tenantStoresError } = await service
          .from('stores')
          .select('id')
          .eq('tenant_id', requirement.tenantId)
        if (tenantStoresError) {
          throw err.internal(`查询门店失败: ${tenantStoresError.message}`)
        }
        return {
          userId: user.id,
          employeeId: allEmpIds[0],
          tenantId: requirement.tenantId,
          storeId: requirement.storeId,
          allowedStoreIds: (tenantStores as { id: string }[] | null ?? []).map(s => s.id),
          roleIds: adminRoleIds,
          permissions,
          isPlatformAdmin: true,
        }
      }
    }
  }

  // ===== 2) 普通租户作用域 =====
  // 2a) 查目标租户下 active employee
  const { data: employees, error: empError } = await service
    .from('employees')
    .select('id')
    .eq('user_id', user.id)
    .eq('tenant_id', requirement.tenantId)
    .eq('status', 'active')
    .limit(1)

  if (empError) {
    throw err.internal(`查询员工档案失败: ${empError.message}`)
  }
  const employee = (employees as EmployeeRow[] | null)?.[0]
  if (!employee) {
    throw err.forbidden('无权访问该租户的数据')
  }

  // 2b) 查该员工在目标租户下的 role assignment(仅 active 员工)
  const { data: assignments, error: assignError } = await service
    .from('employee_role_assignments')
    .select('role_id, store_id')
    .eq('employee_id', employee.id)
    .eq('tenant_id', requirement.tenantId)
  if (assignError) {
    throw err.internal(`查询角色分配失败: ${assignError.message}`)
  }
  const assignRows = ((assignments as EmployeeRoleAssignmentRow[] | null) ?? [])

  // 2c) 先加载全部候选角色并建立 role.scope 索引(S30-R02):
  //     在计算 permission union 之前校验 role.scope,禁止把 scope='store' 的角色
  //     当作 tenant role(即使其分配 store_id 为 NULL 的非法数据)。
  const assignRoleIds = [...new Set(assignRows.map(a => a.role_id))]
  const { data: roleRows, error: roleError } = await service
    .from('roles')
    .select('id, code, scope, is_system, permissions')
    .in('id', assignRoleIds)
  if (roleError) {
    throw err.internal(`查询角色失败: ${roleError.message}`)
  }
  const allRoles = (roleRows as RoleRow[] | null) ?? []
  const roleScope = new Map(allRoles.map(r => [r.id, r.scope]))
  // 租户级角色:scope ∈ (system, tenant);门店级角色:scope = 'store'
  const isTenantWideRole = (roleId: string): boolean => {
    const scope = roleScope.get(roleId)
    return scope === 'system' || scope === 'tenant'
  }
  const isStoreRole = (roleId: string): boolean => roleScope.get(roleId) === 'store'

  // 2c-1) 按 role.scope + assignment.store_id 双重校验分类(S30-R01/R02):
  // - tenant-wide 分配:assignment.store_id IS NULL 且角色 scope ∈ (system, tenant)
  // - store 分配:assignment.store_id 非空 且角色 scope = 'store'
  // 两者交叉的非法分配(scope=store+store_id NULL / scope=tenant+store_id 非空)一律不参与授权
  const tenantWideAssigns = assignRows.filter(a => a.store_id === null && isTenantWideRole(a.role_id))
  const storeAssigns = assignRows.filter(a => a.store_id !== null && isStoreRole(a.role_id))

  // 2c-2) 匹配规则:
  // - 传了 storeId(门店命令):目标门店的 store 角色分配 或 tenant-wide 角色分配;
  // - 未传 storeId:
  //     command 模式:只允许 tenant-wide 角色分配,禁止 store role 提升为租户级权限(审计 4.2);
  //     dataScope 模式(报表):允许门店级角色参与授权,数据范围由 allowedStoreIds 收敛(审计 5.2)。
  const matched = assignRows.filter((a) => {
    if (requirement.storeId) {
      return (a.store_id === requirement.storeId && isStoreRole(a.role_id))
        || (a.store_id === null && isTenantWideRole(a.role_id))
    }
    if (requirement.dataScope) {
      return isStoreRole(a.role_id) || isTenantWideRole(a.role_id)
    }
    return a.store_id === null && isTenantWideRole(a.role_id)
  })
  if (matched.length === 0) {
    throw err.forbidden('无权访问该门店的数据')
  }

  const roleIds = [...new Set(matched.map(a => a.role_id))]
  const tenantWideRoleIds = [...new Set(tenantWideAssigns.map(a => a.role_id))]

  // 2d) 校验目标门店确实属于目标租户
  if (requirement.storeId) {
    const { data: store, error: storeError } = await service
      .from('stores')
      .select('tenant_id')
      .eq('id', requirement.storeId)
      .single()
    if (storeError || !store) {
      throw err.notFound('门店不存在')
    }
    if (store.tenant_id !== requirement.tenantId) {
      throw err.forbidden('门店不属于该租户')
    }
  }

  // 2e) 只加载匹配 role IDs 的 permissions
  const roles = allRoles.filter(r => roleIds.includes(r.id))

  // 2e-1) 新模型 role_permissions 关联表 + 旧模型 roles.permissions 数组
  const permissions = await collectRolePermissions(service, roleIds, roles)

  // 权限码校验
  if (!permissions.includes(requirement.code)) {
    throw err.forbidden(`缺少权限: ${requirement.code}`)
  }

  // 2e-3) 计算允许门店集合 allowedStoreIds(P0-06 报表数据范围):
  // a) 若存在有效的 tenant-wide role(scope = system/tenant)且其权限包含该 code
  //    → 授予全租户数据范围;
  // b) 否则 → 只包含"被分配了含该权限码角色"的门店集合(store-scoped 收敛)。
  let allowedStoreIds: string[] = []
  // 仅 scope ∈ (system, tenant) 的角色可作为 tenant-wide(S30-R02:计算 union 前已校验 role.scope)
  const validTenantWideRoleIds = tenantWideRoleIds.filter(id => isTenantWideRole(id))
  if (validTenantWideRoleIds.length > 0) {
    const twPerms = await collectRolePermissions(service, validTenantWideRoleIds, roles)
    if (twPerms.includes(requirement.code)) {
      const { data: stores } = await service
        .from('stores')
        .select('id')
        .eq('tenant_id', requirement.tenantId)
      allowedStoreIds = (stores as { id: string }[] | null ?? []).map(s => s.id)
    }
  }
  if (allowedStoreIds.length === 0) {
    // store-scoped:按门店分组角色,仅保留"角色权限包含该 code"的门店
    const storeRoleByStore = new Map<string, string[]>()
    for (const a of storeAssigns) {
      if (!a.store_id) {
        continue
      }
      const arr = storeRoleByStore.get(a.store_id) ?? []
      arr.push(a.role_id)
      storeRoleByStore.set(a.store_id, arr)
    }
    for (const [storeId, sRoleIds] of storeRoleByStore) {
      const sPerms = await collectRolePermissions(service, sRoleIds, roles)
      if (sPerms.includes(requirement.code)) {
        allowedStoreIds.push(storeId)
      }
    }
  }

  // 平台管理员:仅当角色是系统级(scope = 'system')且为 system_admin 角色时成立(审计 4.3)
  const isPlatformAdmin = roles.some(r =>
    r.code === PLATFORM_ADMIN_ROLE && r.is_system === true && r.scope === 'system',
  )

  return {
    userId: user.id,
    employeeId: employee.id,
    tenantId: requirement.tenantId,
    storeId: requirement.storeId,
    allowedStoreIds,
    roleIds,
    permissions,
    isPlatformAdmin,
  }
}

/**
 * 带权限校验的授权作用域解析(P0-01)
 * 等价于 resolveScopedAccess,但会先校验 requirement.code 是否在目标作用域内,
 * 不通过时抛 403。所有 service role 路由的 Command 必须使用本函数获取 scope。
 */
export async function requireScopedPermission(
  c: Context<AppEnv>,
  requirement: ScopedRequirement,
): Promise<AccessScope> {
  return resolveScopedAccess(c, requirement)
}
