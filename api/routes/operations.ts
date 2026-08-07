import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { assertTenantAccess, requirePermission } from '../lib/permission'
import { loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * Operations 领域 Command 路由(MXQ-12001~12009)
 *
 * 路由清单:
 *   - POST /operations/points/adjust              (MXQ-12002 调整积分)
 *   - POST /operations/reminders/scan             (MXQ-12004 提醒扫描)
 *   - POST /operations/deliveries/:id/send        (MXQ-12005 触发发送)
 *   - POST /operations/imports                    (MXQ-12006 创建导入任务)
 *   - GET  /operations/imports/:id                (MXQ-12006 导入任务详情)
 *   - POST /operations/print                      (MXQ-12007 创建打印任务)
 *   - GET  /operations/print/:id                  (MXQ-12007 打印任务详情)
 *   - POST /operations/reports/:code/generate     (MXQ-12008 生成报表快照)
 *   - GET  /operations/reports                    (MXQ-12008 报表定义列表)
 *   - GET  /operations/security-events            (MXQ-12009 安全事件,仅超管)
 *
 * 状态机:
 *   reminders:     pending → sent / pending → cancelled
 *   deliveries:    queued → sent / queued → failed / queued → retry → sent
 *   import_tasks:  pending → processing → completed | failed
 *   print_jobs:    queued → printed / queued → failed
 */
const operationsRoutes = new Hono<AppEnv>()

operationsRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

// ===== MXQ-12002 调整积分 =====
const adjustPointsSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
  delta: z.number().int().refine(v => v !== 0, 'delta 不可为 0'),
  reason: z.enum(['purchase', 'redeem', 'adjust', 'expiry']),
  referenceId: z.string().uuid().optional(),
  referenceType: z.string().max(64).optional(),
})

/**
 * 调整积分(MXQ-12002)
 * - 权限:points.adjust
 * - 行为:调 adjust_points RPC,事务化更新余额 + 写流水 + 幂等控制
 * - 幂等键通过 idempotency-key header 传入
 */
operationsRoutes.post('/points/adjust', async (c) => {
  const input = await parseJsonBody(c, adjustPointsSchema)
  await requirePermission(c, { code: 'points.adjust' })

  const service = createServiceClient()
  const user = c.get('user')
  const idempotencyKey = c.req.header('idempotency-key') || null

  const { data, error: rpcError } = await service.rpc('adjust_points', {
    p_tenant_id: input.tenantId,
    p_customer_id: input.customerId,
    p_delta: input.delta,
    p_reason: input.reason,
    p_reference_id: input.referenceId ?? null,
    p_reference_type: input.referenceType ?? null,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (rpcError) {
    if (rpcError.message.includes('INVALID_DELTA')) {
      throw err.badRequest('积分变动值不可为 0')
    }
    if (rpcError.message.includes('INVALID_REASON')) {
      throw err.badRequest('积分变动原因无效')
    }
    if (rpcError.message.includes('INSUFFICIENT_POINTS')) {
      throw err.unprocessable('积分余额不足')
    }
    throw err.internal(`调整积分失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'points.adjust',
    entityType: 'point_transaction',
    entityId: data?.transaction_id ?? null,
    tenantId: input.tenantId,
    metadata: {
      customerId: input.customerId,
      delta: input.delta,
      reason: input.reason,
      balanceAfter: data?.balance_after,
    },
  })

  return ok(c, data)
})

// ===== MXQ-12004 提醒扫描 =====
const scanRemindersSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
})

/**
 * 扫描到期提醒(MXQ-12004)
 * - 权限:reminder.manage
 * - 行为:调 scan_reminders RPC,扫描 pending 且到期的提醒,生成发送任务
 */
operationsRoutes.post('/reminders/scan', async (c) => {
  const input = await parseJsonBody(c, scanRemindersSchema)
  await requirePermission(c, { code: 'reminder.manage', storeId: input.storeId })

  const service = createServiceClient()
  const { data, error: rpcError } = await service.rpc('scan_reminders', {
    p_tenant_id: input.tenantId,
    p_store_id: input.storeId ?? null,
  })

  if (rpcError) {
    throw err.internal(`扫描提醒失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'reminders.scan',
    entityType: 'reminder',
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: data,
  })

  return ok(c, data)
})

// ===== MXQ-12005 触发发送 =====
/**
 * 触发发送(MXQ-12005)
 * - 权限:message.manage
 * - 行为:调 send_delivery RPC,供应商适配模拟发送
 *   (queued/retry → sent/failed,写 provider_message_id 与发送结果)
 * - 幂等:已终态(sent/failed)的交付重复调用直接返回,不重复发送
 */
operationsRoutes.post('/deliveries/:id/send', async (c) => {
  const deliveryId = c.req.param('id')
  await requirePermission(c, { code: 'message.manage' })

  const service = createServiceClient()
  const { data, error: rpcError } = await service.rpc('send_delivery', {
    p_delivery_id: deliveryId,
  })

  if (rpcError) {
    if (rpcError.message.includes('DELIVERY_NOT_FOUND')) {
      throw err.notFound('发送任务不存在')
    }
    throw err.internal(`发送失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'delivery.send',
    entityType: 'message_delivery',
    entityId: deliveryId,
    tenantId: data?.tenant_id,
    metadata: {
      providerMessageId: data?.provider_message_id,
      reminderId: data?.reminder_id,
    },
  })

  return ok(c, data)
})

// ===== MXQ-12006 导入任务 =====
const createImportSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  type: z.enum(['customer', 'pet', 'product', 'inventory']),
  fileId: z.string().uuid().optional(),
})

/**
 * 创建导入任务(MXQ-12006)
 * - 权限:imports.manage
 * - 行为:调 create_import_task RPC,事务化建任务 + 入队 jobs
 */
operationsRoutes.post('/imports', async (c) => {
  const input = await parseJsonBody(c, createImportSchema)
  await requirePermission(c, { code: 'imports.manage', storeId: input.storeId })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error: rpcError } = await service.rpc('create_import_task', {
    p_tenant_id: input.tenantId,
    p_store_id: input.storeId ?? null,
    p_type: input.type,
    p_file_id: input.fileId ?? null,
    p_created_by: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('INVALID_IMPORT_TYPE')) {
      throw err.badRequest('导入类型无效')
    }
    throw err.internal(`创建导入任务失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'imports.create',
    entityType: 'import_task',
    entityId: data?.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { type: input.type, fileId: input.fileId },
  })

  return ok(c, data)
})

/**
 * 查询导入任务详情(MXQ-12006)
 * - 权限:imports.manage
 * - 行为:service role 直查,绕过 RLS 限制(API 层做权限校验)
 */
operationsRoutes.get('/imports/:id', async (c) => {
  const id = c.req.param('id')
  await requirePermission(c, { code: 'imports.manage' })

  const service = createServiceClient()
  const { data, error } = await service
    .from('import_tasks')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    throw err.internal(`查询导入任务失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('导入任务不存在')
  }

  // 跨租户隔离:仅调用者所属租户的导入任务可读
  assertTenantAccess(c, data.tenant_id)

  return ok(c, data)
})

// ===== MXQ-12007 打印 =====
const createPrintSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  templateId: z.string().uuid('模板 id 格式错误'),
  entityType: z.string().min(1, '实体类型不可为空').max(64),
  entityId: z.string().uuid('实体 id 格式错误'),
})

/**
 * 创建打印任务(MXQ-12007)
 * - 权限:print.manage
 * - 行为:调 create_print_job RPC,事务化建打印任务
 */
operationsRoutes.post('/print', async (c) => {
  const input = await parseJsonBody(c, createPrintSchema)
  await requirePermission(c, { code: 'print.manage', storeId: input.storeId })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error: rpcError } = await service.rpc('create_print_job', {
    p_tenant_id: input.tenantId,
    p_store_id: input.storeId ?? null,
    p_template_id: input.templateId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_operator_id: user.id,
  })

  if (rpcError) {
    throw err.internal(`创建打印任务失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'print.create',
    entityType: 'print_job',
    entityId: data?.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: {
      templateId: input.templateId,
      entityType: input.entityType,
      entityId: input.entityId,
    },
  })

  return ok(c, data)
})

/**
 * 查询打印任务详情(MXQ-12007)
 * - 权限:print.manage
 * - 行为:service role 直查,绕过 RLS 限制
 */
operationsRoutes.get('/print/:id', async (c) => {
  const id = c.req.param('id')
  await requirePermission(c, { code: 'print.manage' })

  const service = createServiceClient()
  const { data, error } = await service
    .from('print_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    throw err.internal(`查询打印任务失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('打印任务不存在')
  }

  // 跨租户隔离:仅调用者所属租户的打印任务可读
  assertTenantAccess(c, data.tenant_id)

  return ok(c, data)
})

// ===== MXQ-12008 报表 =====
const generateReportSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '起始日期格式应为 YYYY-MM-DD'),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '结束日期格式应为 YYYY-MM-DD'),
})

/**
 * 生成报表快照(MXQ-12008)
 * - 权限:reports.view
 * - 行为:调 generate_report_snapshot RPC,框架实现:落空数据快照(实际查询逻辑后续补)
 */
operationsRoutes.post('/reports/:code/generate', async (c) => {
  const reportCode = c.req.param('code')
  const input = await parseJsonBody(c, generateReportSchema)
  await requirePermission(c, { code: 'reports.view' })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error: rpcError } = await service.rpc('generate_report_snapshot', {
    p_tenant_id: input.tenantId,
    p_report_code: reportCode,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_generated_by: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('REPORT_DEFINITION_NOT_FOUND')) {
      throw err.notFound('报表定义不存在或未启用')
    }
    if (rpcError.message.includes('INVALID_PERIOD')) {
      throw err.badRequest('起始日期不能晚于结束日期')
    }
    throw err.internal(`生成报表失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'reports.generate',
    entityType: 'report_snapshot',
    entityId: data?.id,
    tenantId: input.tenantId,
    metadata: {
      reportCode,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    },
  })

  return ok(c, data)
})

/**
 * 查询报表定义列表(MXQ-12008)
 * - 权限:reports.view
 * - 行为:service role 直查,绕过 RLS 限制
 */
operationsRoutes.get('/reports', async (c) => {
  await requirePermission(c, { code: 'reports.view' })

  const tenantId = c.req.query('tenantId')
  const category = c.req.query('category')
  const onlyActive = c.req.query('onlyActive') === 'true'

  const service = createServiceClient()
  let query = service
    .from('report_definitions')
    .select('*', { count: 'exact' })
  if (tenantId) {
    query = query.eq('tenant_id', tenantId)
  }
  if (category) {
    query = query.eq('category', category)
  }
  if (onlyActive) {
    query = query.eq('is_active', true)
  }

  const { data, error, count } = await query.order('created_at', { ascending: false })

  if (error) {
    throw err.internal(`查询报表列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ===== MXQ-12009 安全事件 =====
/**
 * 查询安全事件列表(MXQ-12009)
 * - 权限:security.view(seed 中仅 system_admin 角色被授予该权限码,保持"仅超管可读"语义)
 * - 行为:service role 直查 security_events(仅 service_role 写入)
 */
operationsRoutes.get('/security-events', async (c) => {
  // 统一走权限码校验(security.view 当前仅 system_admin 隐式拥有)
  await requirePermission(c, { code: 'security.view' })

  const tenantId = c.req.query('tenantId')
  const eventType = c.req.query('eventType')
  const severity = c.req.query('severity')
  const from = Number(c.req.query('from') ?? 0)
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)

  const service = createServiceClient()
  let query = service
    .from('security_events')
    .select('*', { count: 'exact' })
  if (tenantId) {
    query = query.eq('tenant_id', tenantId)
  }
  if (eventType) {
    query = query.eq('event_type', eventType)
  }
  if (severity) {
    query = query.eq('severity', severity)
  }
  query = query.range(from, from + limit - 1)

  const { data, error, count } = await query.order('created_at', { ascending: false })

  if (error) {
    throw err.internal(`查询安全事件失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'security.events.view',
    entityType: 'security_event',
    metadata: {
      filters: { tenantId, eventType, severity, from, limit },
      total: count,
    },
  })

  return ok(c, { list: data ?? [], total: count ?? 0 })
})

export default operationsRoutes
