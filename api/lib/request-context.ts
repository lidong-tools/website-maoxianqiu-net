import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv, RequestContext } from './types'
import { err } from './errors'

const TENANT_HEADER = 'x-tenant-id'
const STORE_HEADER = 'x-store-id'

/**
 * 租户/门店上下文中间件(MXQ-2005)
 * 上下文是工作偏好,不是权限依据;数据边界由服务端 RLS / requirePermission 独立判断。
 */
export function loadContext(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user')
    const memberships = c.get('memberships') ?? []
    const context: RequestContext = {
      requestId: c.get('requestId') ?? '',
      userId: user?.id ?? '',
      email: user?.email,
      tenantId: c.req.header(TENANT_HEADER) || undefined,
      storeId: c.req.header(STORE_HEADER) || undefined,
      permissions: [],
      memberships,
    }
    c.set('context', context)
    await next()
  }
}

/** 获取当前请求上下文(未初始化时抛出) */
export function getContext(c: Context<AppEnv>): RequestContext {
  const context = c.get('context')
  if (!context) {
    throw new Error('context not initialized')
  }
  return context
}

/** 需要租户上下文的路由调用,缺少 tenant 返回 400 */
export function requireTenant(c: Context<AppEnv>): string {
  const context = getContext(c)
  if (!context.tenantId) {
    throw err.badRequest('缺少租户上下文')
  }
  return context.tenantId
}

/**
 * 解析请求级租户作用域。
 * 优先级:显式 API 参数 → X-Tenant-Id 请求头(context.tenantId) → legacy memberships[0] 兼容兜底。
 * 审计 S3.1 §9-11:多租户用户切换顶部 Tenant 后 X-Tenant-Id 与 memberships[0] 可能不一致
 * (UI Context=B,API Default=A),因此业务路由统一走本 helper,memberships[0] 仅作最后兜底。
 */
export function resolveRequestedTenant(c: Context<AppEnv>, explicitTenantId?: string | null | undefined): string | undefined {
  const context = getContext(c)
  return explicitTenantId || context.tenantId || context.memberships[0]?.tenant_id || undefined
}

/**
 * 解析请求级门店作用域。
 * 优先级:显式 API 参数 → X-Store-Id 请求头(context.storeId)。
 * 门店头缺失时返回 undefined,不做 memberships 兼容兜底(store 无 legacy 默认值)。
 */
export function resolveRequestedStore(c: Context<AppEnv>, explicitStoreId?: string | null | undefined): string | undefined {
  const context = getContext(c)
  return explicitStoreId || context.storeId || undefined
}
