import type { Context } from 'hono'
import type { AppEnv } from './types'
import { err } from './errors'
import { loadPlatformAdminPermissions } from './permission'
import { createServiceClient } from './supabase'

/**
 * 当前用户工作上下文 DTO(P0-01..P0-05)
 * /api/me/context 的唯一事实来源:浏览器不再维护第二套权限/上下文算法。
 *
 * 规则与 resolveScopedAccess 保持一致:
 * - 角色按 roles.scope 分类(不是 store_id 是否为空):
 *   scope ∈ (system, tenant) 且 store_id IS NULL → tenant-wide(该租户全部门店);
 *   scope = store 且 store_id 非空 → store-scoped(仅被授权门店);
 *   交叉非法分配不参与。
 * - 门店出现在上下文 iff 有生效角色;tenant-wide 角色存在时列出该租户全部门店。
 * - isPrimary 来自 employee_store_assignments.is_primary。
 * - 平台管理员(mode='platform')跨租户,不强制默认门店。
 */

export interface MeContextStore {
  id: string
  name: string
  code?: string
  isPrimary: boolean
  roles: string[]
  permissions: string[]
}

export interface MeContextTenant {
  id: string
  name: string
  roles: string[]
  primaryStoreId?: string
  stores: MeContextStore[]
}

export interface MeContext {
  user: { id: string, name: string, email: string }
  mode: 'platform' | 'tenant' | 'none'
  platformRoles: string[]
  tenants: MeContextTenant[]
  permissions: string[]
  primaryStoreId?: string
}

interface RoleJoin {
  id: string
  code: string
  scope: string
  permissions: string[] | null
}

interface EraRow {
  employee_id: string
  tenant_id: string
  store_id: string | null
  role_id: string
  roles: RoleJoin | RoleJoin[] | null
}

interface EmpRow {
  id: string
  tenant_id: string
  tenant: { name: string } | { name: string }[] | null
}

interface StoreRow {
  id: string
  name: string
  code: string | null
  tenant_id: string
}

function asSingle<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) {
    return null
  }
  return Array.isArray(value) ? (value[0] ?? null) : value
}

/** 一次查询聚合 role_permissions(新模型关联表),避免逐门店 N+1 */
async function buildRolePermMap(
  service: ReturnType<typeof createServiceClient>,
  roleIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (roleIds.length === 0) {
    return map
  }
  const { data, error } = await service
    .from('role_permissions')
    .select('role_id, permissions(code)')
    .in('role_id', roleIds)
  if (error) {
    throw err.internal(`查询角色权限失败: ${error.message}`)
  }
  for (const row of (data ?? []) as Array<{
    role_id: string
    permissions: { code: string } | { code: string }[] | null
  }>) {
    if (!row.permissions) {
      continue
    }
    const codes = Array.isArray(row.permissions)
      ? row.permissions.map(p => p.code)
      : [row.permissions.code]
    const arr = map.get(row.role_id) ?? []
    arr.push(...codes)
    map.set(row.role_id, arr)
  }
  return map
}

export async function resolveMeContext(c: Context<AppEnv>): Promise<MeContext> {
  const user = c.get('user')
  const service = createServiceClient()

  // ===== 用户基础信息 =====
  const { data: profile } = await service
    .from('profiles')
    .select('real_name')
    .eq('id', user.id)
    .maybeSingle()
  const name = (profile as { real_name?: string } | null)?.real_name
    || (user.user_metadata as { real_name?: string } | undefined)?.real_name
    || ''

  // ===== 平台角色(独立平台级授权,不参与租户角色推导) =====
  const { data: platformRows, error: purError } = await service
    .from('platform_user_roles')
    .select('role')
    .eq('user_id', user.id)
  if (purError) {
    throw err.internal(`查询平台授权失败: ${purError.message}`)
  }
  const platformRoles = ((platformRows as { role: string }[] | null) ?? []).map(r => r.role)
  const isPlatformAdmin = platformRoles.includes('platform_admin')

  // ===== 平台管理员分支:跨租户,列出全部租户/门店,不强制默认门店 =====
  if (isPlatformAdmin) {
    const { permissions } = await loadPlatformAdminPermissions(service, user.id)
    const { data: tenantRows, error: tErr } = await service
      .from('tenants')
      .select('id, name')
      .eq('status', 'active')
      .order('created_at', { ascending: true })
    if (tErr) {
      throw err.internal(`查询租户失败: ${tErr.message}`)
    }
    const tenants = (tenantRows as { id: string, name: string }[] | null) ?? []
    const tenantIds = tenants.map(t => t.id)
    let stores: StoreRow[] = []
    if (tenantIds.length > 0) {
      const { data: storeRows, error: sErr } = await service
        .from('stores')
        .select('id, name, code, tenant_id')
        .in('tenant_id', tenantIds)
        .is('archived_at', null)
      if (sErr) {
        throw err.internal(`查询门店失败: ${sErr.message}`)
      }
      stores = (storeRows ?? []) as StoreRow[]
    }
    return {
      user: { id: user.id, name, email: user.email ?? '' },
      mode: 'platform',
      platformRoles,
      tenants: tenants.map(t => ({
        id: t.id,
        name: t.name,
        roles: [],
        stores: stores
          .filter(s => s.tenant_id === t.id)
          .map(s => ({
            id: s.id,
            name: s.name,
            code: s.code ?? undefined,
            isPrimary: false,
            roles: [],
            permissions: [],
          })),
      })),
      permissions,
    }
  }

  // ===== 租户分支:按员工档案聚合 =====
  const { data: empRows, error: empErr } = await service
    .from('employees')
    .select('id, tenant_id, tenant:tenants(name)')
    .eq('user_id', user.id)
    .eq('status', 'active')
  if (empErr) {
    throw err.internal(`查询员工档案失败: ${empErr.message}`)
  }
  const employees = (empRows ?? []) as EmpRow[]
  if (employees.length === 0) {
    return {
      user: { id: user.id, name, email: user.email ?? '' },
      mode: 'none',
      platformRoles,
      tenants: [],
      permissions: [],
    }
  }

  // 停用租户拦截(S3.1-A):租户 status != 'active' 时其员工档案不进入工作上下文
  const activeTenantIds = await (async () => {
    const ids = [...new Set(employees.map(e => e.tenant_id))]
    const { data: tenantRows, error: tErr } = await service
      .from('tenants')
      .select('id, status')
      .in('id', ids)
    if (tErr) {
      throw err.internal(`查询租户状态失败: ${tErr.message}`)
    }
    return new Set(
      ((tenantRows as Array<{ id: string, status: string }> | null) ?? [])
        .filter(t => t.status === 'active')
        .map(t => t.id),
    )
  })()
  const activeEmployees = employees.filter(e => activeTenantIds.has(e.tenant_id))
  if (activeEmployees.length === 0) {
    return {
      user: { id: user.id, name, email: user.email ?? '' },
      mode: 'none',
      platformRoles,
      tenants: [],
      permissions: [],
    }
  }

  const employeeIds = [...new Set(activeEmployees.map(e => e.id))]
  const tenantIds = [...new Set(activeEmployees.map(e => e.tenant_id))]

  const { data: eraRows, error: eraErr } = await service
    .from('employee_role_assignments')
    .select('employee_id, tenant_id, store_id, role_id, roles(id, code, scope, permissions)')
    .in('employee_id', employeeIds)
  if (eraErr) {
    throw err.internal(`查询角色分配失败: ${eraErr.message}`)
  }
  const era = (eraRows ?? []) as EraRow[]

  const { data: esaRows, error: esaErr } = await service
    .from('employee_store_assignments')
    .select('employee_id, store_id, is_primary')
    .in('employee_id', employeeIds)
  if (esaErr) {
    throw err.internal(`查询门店分配失败: ${esaErr.message}`)
  }
  const esa = (esaRows ?? []) as Array<{ employee_id: string, store_id: string, is_primary: boolean }>

  let tenantStores: StoreRow[] = []
  if (tenantIds.length > 0) {
    const { data: storeRows, error: sErr } = await service
      .from('stores')
      .select('id, name, code, tenant_id')
      .in('tenant_id', tenantIds)
      .is('archived_at', null)
    if (sErr) {
      throw err.internal(`查询门店失败: ${sErr.message}`)
    }
    tenantStores = (storeRows ?? []) as StoreRow[]
  }

  // 每个角色 id 的权限码(新模型关联表 + 旧模型数组兼容)
  const allRoleIds = [...new Set(era.map(r => r.role_id))]
  const rolePermMap = await buildRolePermMap(service, allRoleIds)
  const rolePermCodeMap = new Map<string, string[]>()
  for (const r of era) {
    const role = asSingle(r.roles)
    if (!role) {
      continue
    }
    const codes = new Set<string>([
      ...(rolePermMap.get(r.role_id) ?? []),
      ...(role.permissions ?? []),
    ])
    rolePermCodeMap.set(r.role_id, [...codes])
  }

  const resolvePerms = (roleIds: string[]): string[] => {
    const out = new Set<string>()
    for (const rid of roleIds) {
      for (const p of rolePermCodeMap.get(rid) ?? []) {
        out.add(p)
      }
    }
    return [...out]
  }

  const globalPerms = new Set<string>()
  const tenants: MeContextTenant[] = []
  let topPrimaryStoreId: string | undefined

  for (const tenantId of tenantIds) {
    const empIdSet = new Set(activeEmployees.filter(e => e.tenant_id === tenantId).map(e => e.id))
    const tenantName = asSingle(activeEmployees.find(e => e.tenant_id === tenantId)?.tenant)?.name ?? ''

    const tenantWideRoles: string[] = []
    const storeRoleByStore = new Map<string, string[]>()
    for (const r of era) {
      if (!empIdSet.has(r.employee_id) || r.tenant_id !== tenantId) {
        continue
      }
      const role = asSingle(r.roles)
      if (!role) {
        continue
      }
      if (r.store_id === null && (role.scope === 'system' || role.scope === 'tenant')) {
        tenantWideRoles.push(r.role_id)
      }
      else if (r.store_id !== null && role.scope === 'store') {
        const arr = storeRoleByStore.get(r.store_id) ?? []
        arr.push(r.role_id)
        storeRoleByStore.set(r.store_id, arr)
      }
      // 交叉非法分配(scope=store+store_id NULL / scope=tenant+store_id 非空)一律排除
    }
    const tenantWideRoleIds = [...new Set(tenantWideRoles)]
    const tenantWidePerms = resolvePerms(tenantWideRoleIds)
    for (const p of tenantWidePerms) {
      globalPerms.add(p)
    }

    // 门店列表:tenant-wide 角色 → 全部门店;否则仅 store-scoped 授权门店
    const hasTenantWide = tenantWideRoleIds.length > 0
    const storePool = hasTenantWide
      ? tenantStores.filter(s => s.tenant_id === tenantId)
      : tenantStores.filter(s => s.tenant_id === tenantId && storeRoleByStore.has(s.id))

    const stores: MeContextStore[] = []
    let primaryStoreId: string | undefined
    for (const s of storePool) {
      const storeRoleIds = storeRoleByStore.get(s.id) ?? []
      const roleIds = [...new Set([...tenantWideRoleIds, ...storeRoleIds])]
      const perms = resolvePerms(roleIds)
      for (const p of perms) {
        globalPerms.add(p)
      }
      const codes = [
        ...new Set(era
          .filter(r => r.tenant_id === tenantId && empIdSet.has(r.employee_id) && roleIds.includes(r.role_id))
          .map(r => asSingle(r.roles)?.code)
          .filter((x): x is string => !!x)),
      ]
      const isPrimary = esa.some(a =>
        empIdSet.has(a.employee_id) && a.store_id === s.id && a.is_primary,
      )
      if (isPrimary && !primaryStoreId) {
        primaryStoreId = s.id
      }
      stores.push({
        id: s.id,
        name: s.name,
        code: s.code ?? undefined,
        isPrimary,
        roles: codes,
        permissions: perms,
      })
    }

    if (primaryStoreId && !topPrimaryStoreId) {
      topPrimaryStoreId = primaryStoreId
    }

    tenants.push({
      id: tenantId,
      name: tenantName,
      roles: [...new Set(era
        .filter(r => r.tenant_id === tenantId && empIdSet.has(r.employee_id) && tenantWideRoleIds.includes(r.role_id))
        .map(r => asSingle(r.roles)?.code)
        .filter((x): x is string => !!x))],
      primaryStoreId,
      stores,
    })
  }

  return {
    user: { id: user.id, name, email: user.email ?? '' },
    mode: 'tenant',
    platformRoles,
    tenants,
    permissions: [...globalPerms],
    primaryStoreId: topPrimaryStoreId,
  }
}
