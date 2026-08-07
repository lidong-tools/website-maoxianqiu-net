import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv, MembershipInfo } from '../lib/types'
import { err } from '../lib/errors'
import { createServiceClient, createUserClient } from '../lib/supabase'

interface LegacyStoreMemberRow {
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

/**
 * 加载调用者的角色与成员关系(须在 authMiddleware 之后)
 * MXQ-3010:迁移到新模型 employees + employee_role_assignments + employee_store_assignments
 * 兼容期:若新模型无数据,回退查询 store_members(迁移 0011 已把旧数据导入新模型)
 */
export function loadCaller(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user')
    const service = createServiceClient()

    // 优先查新模型:employees + employee_role_assignments
    const { data: eraRows } = await service
      .from('employee_role_assignments')
      .select(`
        employee_id,
        tenant_id,
        store_id,
        role_id,
        role_code:roles(code),
        employee:employees(status, user_id)
      `)
      .eq('employee.user_id', user.id)

    const eraData = (eraRows ?? []) as unknown as Array<{
      employee_id: string
      tenant_id: string
      store_id: string | null
      role_id: string
      role_code: { code: string } | { code: string }[] | null
      employee: { status: string, user_id: string } | { status: string, user_id: string }[] | null
    }>

    let memberships: MembershipInfo[] = []
    const roleCodeSet = new Set<string>()

    if (eraData.length > 0) {
      for (const row of eraData) {
        const employeeStatus = Array.isArray(row.employee)
          ? row.employee[0]?.status
          : row.employee?.status
        const roleCode = Array.isArray(row.role_code)
          ? row.role_code[0]?.code
          : row.role_code?.code
        if (employeeStatus !== 'active') {
          continue
        }
        memberships.push({
          store_id: row.store_id ?? '',
          role_id: row.role_id,
          role_code: roleCode ?? '',
          status: 'active',
          tenant_id: row.tenant_id,
        })
        if (roleCode) {
          roleCodeSet.add(roleCode)
        }
      }
    }

    // 兼容回退:新模型无数据时查旧模型 store_members
    if (memberships.length === 0) {
      const { data: legacyRows } = await service
        .from('store_members')
        .select('store_id, role_id, status')
        .eq('user_id', user.id)

      const legacy = (legacyRows ?? []) as LegacyStoreMemberRow[]
      const active = legacy.filter(item => item.status === 'active')
      const roleIds = [...new Set(active.map(item => item.role_id))]
      const roleCodeMap: Record<string, string> = {}
      if (roleIds.length > 0) {
        const { data: roles } = await service.from('roles').select('id, code').in('id', roleIds)
        for (const role of (roles ?? []) as RoleRow[]) {
          roleCodeMap[role.id] = role.code
        }
      }
      memberships = active.map((item): MembershipInfo => ({
        store_id: item.store_id,
        role_id: item.role_id,
        role_code: roleCodeMap[item.role_id] ?? '',
        status: item.status,
      }))
      for (const code of Object.values(roleCodeMap)) {
        roleCodeSet.add(code)
      }
    }

    c.set('memberships', memberships)
    c.set('roles', [...roleCodeSet])
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
  return (c.get('memberships') ?? []).some(
    item => item.store_id === storeId
      && (item.role_code === 'store_manager' || item.role_code === 'tenant_manager'),
  )
}
