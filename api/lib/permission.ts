import type { Context } from 'hono'
import type { AppEnv, RequestContext } from './types'
import { err } from './errors'
import { getContext } from './request-context'
import { createServiceClient } from './supabase'

/**
 * 加载调用者聚合权限码(去重),结果写入 context.permissions。
 * MXQ-3010:权限来源升级为新模型 role_permissions 关联表 + 旧模型 roles.permissions 数组(union 兼容)。
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
    .flatMap((row: { permissions?: { code: string } | { code: string }[] | null }) => {
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
