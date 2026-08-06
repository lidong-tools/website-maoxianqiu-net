import type { Context } from 'hono'
import type { AppEnv, RequestContext } from './types'
import { err } from './errors'
import { getContext } from './request-context'
import { createServiceClient } from './supabase'

/**
 * 加载调用者聚合权限码(去重),结果写入 context.permissions。
 * 权限来源:当前成员关系对应角色的 permissions 集合。
 */
export async function loadPermissions(c: Context<AppEnv>): Promise<string[]> {
  const context = getContext(c)
  const roleIds = [...new Set(context.memberships.map(m => m.role_id))]
  if (roleIds.length === 0) {
    context.permissions = []
    return context.permissions
  }
  const service = createServiceClient()
  const { data } = await service
    .from('roles')
    .select('permissions')
    .in('id', roleIds)
  const perms = [...new Set((data ?? []).flatMap((r: { permissions: string[] | null }) => r.permissions ?? []))]
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
