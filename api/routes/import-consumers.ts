import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'
import { consumeEmployeeInvites, retryEmployeeInvite } from '../services/import-consumers/employee.js'
import { consumeOpeningStockRequests, retryOpeningStockRequest } from '../services/import-consumers/opening-stock.js'

/**
 * Import Consumers Command 路由(Stage-04 Agent-07)
 *
 * 消费 Import V2 生成的领域命令队列,收口 Import Job 终态:
 *   - employee_invite_imports(pending) → 既有 IAM 域(invite_employee + auth.admin.createUser)
 *   - opening_stock_import_requests(pending) → 期初入账正式 Command(apply_opening_stock_import)
 *
 * 路由清单:
 *   - POST /import-consumers/employee/apply            批量消费员工待邀请(权限 imports.employee.execute)
 *   - POST /import-consumers/employee/:id/retry        重试单条失败邀请(权限 imports.employee.execute)
 *   - POST /import-consumers/opening-stock/apply       批量消费期初入账命令(权限 imports.opening_stock.execute)
 *   - POST /import-consumers/opening-stock/:id/retry   重试单条失败期初命令(权限 imports.opening_stock.execute)
 *   - POST /import-consumers/jobs/:jobId/apply-domain  消费单个 Import Job 并收口终态(权限 imports.execute)
 *
 * 收口规则(IMPORT_TERMINAL_STATE_RULE):
 *   领域命令全部 applied → completed;有成功有失败 → partially_completed;
 *   全失败 → failed;仍有 pending → 保持 awaiting_domain_apply(可再次触发)。
 */
const importConsumerRoutes = new Hono<AppEnv>()

importConsumerRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const applySchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  jobId: z.string().uuid('导入任务 id 格式错误').optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

const idParamSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
})

interface ImportJobRow {
  id: string
  tenant_id: string
  store_id: string | null
  type: string
  status: string
}

async function loadJob(service: ReturnType<typeof createServiceClient>, id: string): Promise<ImportJobRow> {
  const { data, error } = await service.from('import_jobs').select('id, tenant_id, store_id, type, status').eq('id', id).maybeSingle()
  if (error) {
    throw err.internal(`查询导入任务失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('导入任务不存在')
  }
  return data as ImportJobRow
}

/**
 * 批量消费员工待邀请
 * POST /import-consumers/employee/apply
 * - 权限:imports.employee.execute(门店作用域)
 * - 行为:CAS claim → IAM 域邀请 → applied/failed;返回统计
 */
importConsumerRoutes.post('/employee/apply', async (c) => {
  const input = await parseJsonBody(c, applySchema)
  const scope = await requireScopedPermission(c, {
    code: 'imports.employee.execute',
    tenantId: input.tenantId,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const result = await consumeEmployeeInvites(service, {
    tenantId: scope.tenantId,
    jobId: input.jobId,
    limit: input.limit,
    operatorId: user.id,
  })

  await writeAudit(c, {
    action: 'imports.consumer.employee',
    entityType: 'employee_invite_import',
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
    metadata: { applied: result.applied, failed: result.failed, skipped: result.skipped, jobId: input.jobId ?? null },
  })

  return ok(c, result)
})

/**
 * 批量消费期初入账命令
 * POST /import-consumers/opening-stock/apply
 * - 权限:imports.opening_stock.execute(门店作用域)
 */
importConsumerRoutes.post('/opening-stock/apply', async (c) => {
  const input = await parseJsonBody(c, applySchema)
  const scope = await requireScopedPermission(c, {
    code: 'imports.opening_stock.execute',
    tenantId: input.tenantId,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const result = await consumeOpeningStockRequests(service, {
    tenantId: scope.tenantId,
    jobId: input.jobId,
    limit: input.limit,
    operatorId: user.id,
  })

  await writeAudit(c, {
    action: 'imports.consumer.openingStock',
    entityType: 'opening_stock_import_request',
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
    metadata: { applied: result.applied, failed: result.failed, skipped: result.skipped, jobId: input.jobId ?? null },
  })

  return ok(c, result)
})

/**
 * 重试单条失败员工邀请
 * POST /import-consumers/employee/:id/retry
 * - 权限:imports.employee.execute
 * - 行为:failed → pending,由下一次消费重新处理
 */
importConsumerRoutes.post('/employee/:id/retry', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, idParamSchema)
  const service = createServiceClient()

  // 取记录校验租户归属
  const { data: row, error } = await service
    .from('employee_invite_imports')
    .select('id, tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (error || !row) {
    throw err.notFound('员工邀请记录不存在')
  }
  const scope = await requireScopedPermission(c, {
    code: 'imports.employee.execute',
    tenantId: row.tenant_id,
  })

  const retried = await retryEmployeeInvite(service, id)
  if (!retried) {
    throw err.conflict('仅失败状态的邀请记录可重试')
  }

  await writeAudit(c, {
    action: 'imports.consumer.employeeRetry',
    entityType: 'employee_invite_import',
    entityId: id,
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
    metadata: {},
  })

  return ok(c, { id, retried: true })
})

/**
 * 重试单条失败期初入账命令
 * POST /import-consumers/opening-stock/:id/retry
 * - 权限:imports.opening_stock.execute
 */
importConsumerRoutes.post('/opening-stock/:id/retry', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, idParamSchema)
  const service = createServiceClient()

  const { data: row, error } = await service
    .from('opening_stock_import_requests')
    .select('id, tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (error || !row) {
    throw err.notFound('期初入账命令不存在')
  }
  const scope = await requireScopedPermission(c, {
    code: 'imports.opening_stock.execute',
    tenantId: row.tenant_id,
  })

  const retried = await retryOpeningStockRequest(service, id)
  if (!retried) {
    throw err.conflict('仅失败状态的期初命令可重试')
  }

  await writeAudit(c, {
    action: 'imports.consumer.openingStockRetry',
    entityType: 'opening_stock_import_request',
    entityId: id,
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
    metadata: {},
  })

  return ok(c, { id, retried: true })
})

/**
 * 消费单个 Import Job 的领域命令并收口终态
 * POST /import-consumers/jobs/:jobId/apply-domain
 * - 权限:imports.execute(门店作用域)
 * - 行为:仅 employee / opening-stock 类型且处于 awaiting_domain_apply 的任务可收口;
 *        消费后按领域命令状态统计收口:
 *        全部 applied → completed;部分成功 → partially_completed;全失败 → failed;
 *        仍有 pending → 保持 awaiting_domain_apply(可再次触发,幂等)
 */
importConsumerRoutes.post('/jobs/:jobId/apply-domain', async (c) => {
  const jobId = c.req.param('jobId')
  const service = createServiceClient()
  const job = await loadJob(service, jobId)
  const scope = await requireScopedPermission(c, {
    code: 'imports.execute',
    tenantId: job.tenant_id,
    storeId: job.store_id ?? undefined,
  })

  if (job.type !== 'employee' && job.type !== 'opening-stock') {
    throw err.badRequest('仅 employee / opening-stock 类型的导入需要领域应用')
  }
  // 幂等:已收口终态直接返回现状
  if (['completed', 'partially_completed', 'failed'].includes(job.status)) {
    return ok(c, { jobId, status: job.status, idempotent: true })
  }
  if (job.status !== 'awaiting_domain_apply') {
    throw err.conflict('导入任务当前状态不允许领域应用')
  }

  const user = c.get('user')
  const stats = job.type === 'employee'
    ? await consumeEmployeeInvites(service, { tenantId: scope.tenantId, jobId, limit: 500, operatorId: user.id })
    : await consumeOpeningStockRequests(service, { tenantId: scope.tenantId, jobId, limit: 500, operatorId: user.id })

  // 统计领域命令状态(该 job 下)
  const table = job.type === 'employee' ? 'employee_invite_imports' : 'opening_stock_import_requests'
  const [applied, failed, pending] = await Promise.all([
    service.from(table).select('id', { count: 'exact', head: true }).eq('import_job_id', jobId).eq('status', 'applied'),
    service.from(table).select('id', { count: 'exact', head: true }).eq('import_job_id', jobId).eq('status', 'failed'),
    service.from(table).select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing']),
  ])
  const appliedCount = applied.count ?? 0
  const failedCount = failed.count ?? 0
  const pendingCount = pending.count ?? 0

  // 收口终态(CAS:仅 awaiting_domain_apply 可更新,防并发双收口)
  const terminal = pendingCount > 0
    ? 'awaiting_domain_apply'
    : (failedCount > 0 && appliedCount > 0)
        ? 'partially_completed'
        : failedCount > 0
          ? 'failed'
          : 'completed'
  const updatePayload: Record<string, unknown> = {
    status: terminal,
    error_summary: { applied: appliedCount, failed: failedCount, pending: pendingCount },
  }
  if (terminal !== 'awaiting_domain_apply') {
    updatePayload.finished_at = new Date().toISOString()
  }
  const { data: updated, error: updErr } = await service
    .from('import_jobs')
    .update(updatePayload)
    .eq('id', jobId)
    .eq('status', 'awaiting_domain_apply')
    .select('*')
    .maybeSingle()
  if (updErr) {
    throw err.internal(`收口导入任务失败: ${updErr.message}`)
  }
  // CAS 失败:说明已被并发收口,返回当前状态
  if (!updated) {
    const cur = await loadJob(service, jobId)
    return ok(c, { jobId, status: cur.status, idempotent: true, applied: appliedCount, failed: failedCount })
  }

  await writeAudit(c, {
    action: 'imports.consumer.applyDomain',
    entityType: 'import_job',
    entityId: jobId,
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
    metadata: { type: job.type, applied: appliedCount, failed: failedCount, pending: pendingCount, status: terminal },
  })

  return ok(c, {
    jobId,
    status: terminal,
    idempotent: false,
    applied: appliedCount,
    failed: failedCount,
    pending: pendingCount,
    remaining: stats.remaining,
    failedSamples: stats.failedSamples,
  })
})

export default importConsumerRoutes
