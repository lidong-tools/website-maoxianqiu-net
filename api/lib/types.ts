import type { User } from '@supabase/supabase-js'

export interface MembershipInfo {
  store_id: string
  role_id: string
  role_code: string
  status: string
}

/**
 * 请求上下文(API Foundation, MXQ-2005)
 * 由 auth + loadContext 中间件填充,供 permission/audit/idempotency 复用。
 */
export interface RequestContext {
  requestId: string
  userId: string
  email?: string
  /** 当前工作租户/门店(来自 x-tenant-id / x-store-id 或成员派生),UI 偏好非权限依据 */
  tenantId?: string
  storeId?: string
  /** 员工档案 id(依赖 MXQ-3003 employees 表) */
  employeeId?: string
  /** 已聚合权限码 */
  permissions: string[]
  memberships: MembershipInfo[]
}

export interface AppEnv {
  Variables: {
    user: User
    token: string
    roles: string[]
    memberships: MembershipInfo[]
    requestId: string
    context: RequestContext
    /** validateJson 中间件写入的校验结果 */
    validated: unknown
  }
}
