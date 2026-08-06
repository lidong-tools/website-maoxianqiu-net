import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv, MembershipInfo } from '../lib/types'
import { createServiceClient, createUserClient } from '../lib/supabase'

export function authMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = c.req.header('Token') ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) {
      return c.json({ status: 0, error: '未登录', data: null })
    }
    const supabase = createUserClient(token)
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) {
      return c.json({ status: 0, error: '登录状态已失效', data: null })
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

    const active = (memberships ?? []).filter((item: any) => item.status === 'active')
    const roleIds = [...new Set(active.map((item: any) => item.role_id))]
    const roleCodeMap: Record<string, string> = {}
    if (roleIds.length > 0) {
      const { data: roles } = await service.from('roles').select('id, code').in('id', roleIds)
      for (const role of roles ?? []) {
        roleCodeMap[role.id] = role.code
      }
    }

    c.set('memberships', active.map((item: any): MembershipInfo => ({
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
