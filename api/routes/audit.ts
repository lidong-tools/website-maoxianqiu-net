import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext, resolveRequestedTenant } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * 审计查询路由(CORE-04 审计与安全)
 * - GET /audit-logs               审计日志列表(权限 audit.view)
 * - GET /audit-logs/:id           审计日志详情(权限 audit.view)
 *
 * 权限:audit.view 授予 system_admin / tenant_owner(租户级)。
 * 数据边界:service role 直查 audit_logs,强制限定调用者授权作用域租户。
 */
const auditRoutes = new Hono<AppEnv>()

auditRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/** 员工名映射:user_id → name(一次批量查询) */
async function mapEmployeeNames(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  userIds: string[],
): Promise<Record<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (ids.length === 0) {
    return {}
  }
  const { data } = await service
    .from('employees')
    .select('user_id, name')
    .eq('tenant_id', tenantId)
    .in('user_id', ids)
  const map: Record<string, string> = {}
  for (const row of (data ?? []) as Array<{ user_id: string, name: string }>) {
    if (!map[row.user_id]) {
      map[row.user_id] = row.name
    }
  }
  return map
}

/** 审计日志列表(CORE-04) */
auditRoutes.get('/audit-logs', async (c) => {
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  const userId = c.req.query('userId')
  const action = c.req.query('action')
  const entityType = c.req.query('entityType')
  const entityId = c.req.query('entityId')
  const requestId = c.req.query('requestId')
  const startAt = c.req.query('startAt')
  const endAt = c.req.query('endAt')
  const from = Math.max(Number(c.req.query('from') ?? 0), 0)
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)

  const scope = await requireScopedPermission(c, {
    code: 'audit.view',
    tenantId: resolveRequestedTenant(c, tenantId) ?? '',
  })

  const service = createServiceClient()
  let query = service
    .from('audit_logs')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
  if (storeId) {
    query = query.eq('store_id', storeId)
  }
  if (userId) {
    query = query.eq('user_id', userId)
  }
  if (action) {
    query = query.eq('action', action)
  }
  if (entityType) {
    query = query.eq('entity_type', entityType)
  }
  if (entityId) {
    query = query.eq('entity_id', entityId)
  }
  if (requestId) {
    query = query.eq('request_id', requestId)
  }
  if (startAt) {
    query = query.gte('created_at', startAt)
  }
  if (endAt) {
    query = query.lte('created_at', endAt)
  }
  query = query.range(from, from + limit - 1)

  const { data, error, count } = await query.order('created_at', { ascending: false })

  if (error) {
    throw err.internal(`查询审计日志失败: ${error.message}`)
  }

  const rows = (data ?? []) as Array<{ user_id: string | null, [k: string]: unknown }>
  const employeeNames = await mapEmployeeNames(
    service,
    scope.tenantId,
    rows.map(r => r.user_id ?? ''),
  )
  const list = rows.map(r => ({
    ...r,
    employee_name: r.user_id ? employeeNames[r.user_id] ?? null : null,
  }))

  await writeAudit(c, {
    action: 'audit.logs.view',
    entityType: 'audit_log',
    tenantId: scope.tenantId,
    metadata: {
      filters: { tenantId: scope.tenantId, storeId, userId, action, entityType, entityId, requestId, startAt, endAt, from, limit },
      total: count,
    },
  })

  return ok(c, { list, total: count ?? 0 })
})

/** 审计日志详情(CORE-04) */
auditRoutes.get('/audit-logs/:id', async (c) => {
  const id = c.req.param('id')
  const tenantId = c.req.query('tenantId')
  const service = createServiceClient()

  const { data: row, error } = await service
    .from('audit_logs')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    throw err.internal(`查询审计日志失败: ${error.message}`)
  }
  if (!row) {
    throw err.notFound('审计日志不存在')
  }

  await requireScopedPermission(c, {
    code: 'audit.view',
    tenantId: tenantId ?? row.tenant_id,
  })
  if (row.tenant_id !== (tenantId ?? row.tenant_id)) {
    throw err.forbidden('无权访问该租户的审计日志')
  }

  const employeeNames = await mapEmployeeNames(service, row.tenant_id, row.user_id ? [row.user_id] : [])
  const detail = {
    ...row,
    employee_name: row.user_id ? employeeNames[row.user_id] ?? null : null,
  }

  return ok(c, detail)
})

export default auditRoutes
