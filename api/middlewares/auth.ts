import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv, MembershipInfo } from '../lib/types'
import { err } from '../lib/errors'
import { createServiceClient, createUserClient } from '../lib/supabase'

interface StoreMemberRow {
  store_id: string
  role_id: string
  status: string
}

interface RoleRow {
  id: string
  code: string
}

export function authMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // 统一 Authorization: Bearer;迁移期兼容旧 Token 头,不新增依赖 Token 的接口
    const authHeader = c.req.header('Authorization')
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (c.req.header('Token') ?? '')
    if (!token) {
      throw err.unauthorized('未登录')
    }
    const supabase = createUserClient(token)
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) {
      throw err.unauthorized('登录状态已失效')
    }
    c.set('user', data.user)
    c.set('token', token)
    await next()
  }
}

// 加载调用者的角色与成员关系(须在 authMiddleware 之后)
export function loadCaller(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user')
    const service = createServiceClient()
    const { data: memberships } = await service
      .from('store_members')
      .select('store_id, role_id, status')
      .eq('user_id', user.id)

    const rows = (memberships ?? []) as StoreMemberRow[]
    const active = rows.filter(item => item.status === 'active')
    const roleIds = [...new Set(active.map(item => item.role_id))]
    const roleCodeMap: Record<string, string> = {}
    if (roleIds.length > 0) {
      const { data: roles } = await service.from('roles').select('id, code').in('id', roleIds)
      for (const role of (roles ?? []) as RoleRow[]) {
        roleCodeMap[role.id] = role.code
      }
    }

    c.set('memberships', active.map((item): MembershipInfo => ({
      store_id: item.store_id,
      role_id: item.role_id,
      role_code: roleCodeMap[item.role_id] ?? '',
      status: item.status,
    })))
    c.set('roles', [...new Set(Object.values(roleCodeMap))])
    await next()
  }
}

export function hasRole(c: Context<AppEnv>, ...codes: string[]) {
  const roles = c.get('roles') ?? []
  return codes.some(code => roles.includes(code))
}

export function canManageStore(c: Context<AppEnv>, storeId?: string) {
  if (!storeId) {
    return hasRole(c, 'system_admin')
  }
  if (hasRole(c, 'system_admin')) {
    return true
  }
  return (c.get('memberships') ?? []).some(item => item.store_id === storeId && item.role_code === 'store_manager')
}
