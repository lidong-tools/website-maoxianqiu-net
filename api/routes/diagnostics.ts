import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import { loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * Diagnostics 疫苗与检验领域 Command 路由(MXQ-10001~10011)
 *
 * 分层:
 *   - Query(list/detail):Hono 聚合查询 + 对应 *.view 权限
 *   - Command(create/update):Hono 调 service client 写入,RLS 兜底
 *   - 跨表事务(证书签发 / 结果发布 / 结果审核 / 提醒扫描):Hono 调 PostgreSQL RPC,
 *     RPC 内置权限校验 + 事务化审计写入
 *
 * 状态机:
 *   疫苗接种:scheduled→administered; scheduled→overdue; scheduled→skipped
 *   检验申请:requested→collected→completed; requested→cancelled
 *   标本:collected→in_transit→received→discarded
 *   危急值告警:pending→acknowledged→resolved
 *   疫苗证明:issued→revoked
 *
 * 权限码:
 *   vaccine.view / vaccine.manage / vaccine.certificate.issue
 *   deworming.view / deworming.manage
 *   lab.view / lab.request / lab.collect / lab.result.input / lab.result.review / lab.critical.acknowledge
 *   diag_reminder.view
 */
const diagnosticsRoutes = new Hono<AppEnv>()

diagnosticsRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/** 将 RPC 抛出的业务错误码映射为 HTTP 错误 */
function mapRpcError(error: { message: string }) {
  const msg = error.message
  if (msg.includes('VACCINATION_NOT_FOUND') || msg.includes('LAB_ORDER_NOT_FOUND')) {
    return err.notFound('记录不存在')
  }
  if (msg.includes('VACCINATION_NOT_ADMINISTERED')) {
    return err.conflict('疫苗未接种,无法签发证明')
  }
  if (msg.includes('CERTIFICATE_ALREADY_ISSUED')) {
    return err.conflict('该疫苗接种已签发证明,不可重复签发')
  }
  if (msg.includes('LAB_ORDER_NOT_PUBLISHABLE')) {
    return err.conflict('检验申请当前状态不可发布结果')
  }
  if (msg.includes('INVALID_RESULT_ITEM')) {
    return err.badRequest('结果项 id 缺失')
  }
  if (msg.includes('INVALID_REVIEW_DECISION')) {
    return err.badRequest('审核决定无效,仅支持 approved/rejected')
  }
  if (msg.includes('NO_RESULTS_TO_REVIEW')) {
    return err.conflict('该检验申请尚未录入结果,无可审核内容')
  }
  if (msg.includes('REVIEWER_IS_RESULT_INPUTTER')) {
    return err.conflict('审核人不可与结果录入人为同一人(双签要求)')
  }
  return err.internal(`Diagnostics 操作失败: ${msg}`)
}

// ============================================================
// 疫苗方案 MXQ-10001
// ============================================================

const createProtocolSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  species: z.enum(['dog', 'cat', 'rabbit', 'other']).optional(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
})

/**
 * 创建疫苗方案(MXQ-10001)
 * - 权限:vaccine.manage
 */
diagnosticsRoutes.post('/protocols', async (c) => {
  const input = await parseJsonBody(c, createProtocolSchema)
  const scope = await requireScopedPermission(c, { code: 'vaccine.manage', tenantId: input.tenantId })

  const service = createServiceClient()
  const { data, error } = await service
    .from('vaccine_protocols')
    .insert({
      tenant_id: scope.tenantId,
      code: input.code,
      name: input.name,
      species: input.species ?? 'other',
      description: input.description ?? null,
      is_active: input.isActive ?? true,
    })
    .select('*')
    .single()

  if (error) {
    throw err.internal(`创建疫苗方案失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'vaccine.protocol.create',
    entityType: 'vaccine_protocol',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { code: input.code, name: input.name },
  })

  return ok(c, data)
})

// ============================================================
// 疫苗接种 MXQ-10002
// ============================================================

const createVaccinationSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  customerId: z.string().uuid('客户 id 格式错误'),
  petId: z.string().uuid('宠物 id 格式错误'),
  encounterId: z.string().uuid().optional(),
  vaccineCatalogItemId: z.string().uuid().optional(),
  protocolItemId: z.string().uuid().optional(),
  doseNo: z.number().int().positive().optional(),
  scheduledDate: z.string().optional(),
  batchNo: z.string().max(100).optional(),
  manufacturer: z.string().max(200).optional(),
  remark: z.string().max(1000).optional(),
})

/**
 * 创建疫苗接种(MXQ-10002)
 * - 权限:vaccine.manage
 */
diagnosticsRoutes.post('/vaccinations', async (c) => {
  const input = await parseJsonBody(c, createVaccinationSchema)
  const scope = await requireScopedPermission(c, { code: 'vaccine.manage', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const { data, error } = await service
    .from('vaccinations')
    .insert({
      tenant_id: scope.tenantId,
      store_id: scope.storeId ?? null,
      customer_id: input.customerId,
      pet_id: input.petId,
      encounter_id: input.encounterId ?? null,
      vaccine_catalog_item_id: input.vaccineCatalogItemId ?? null,
      protocol_item_id: input.protocolItemId ?? null,
      dose_no: input.doseNo ?? 1,
      scheduled_date: input.scheduledDate ?? null,
      batch_no: input.batchNo ?? null,
      manufacturer: input.manufacturer ?? null,
      status: 'scheduled',
      remark: input.remark ?? null,
    })
    .select('*')
    .single()

  if (error) {
    throw err.internal(`创建疫苗接种失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'vaccination.create',
    entityType: 'vaccination',
    entityId: data.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { customerId: input.customerId, petId: input.petId, doseNo: input.doseNo ?? 1 },
  })

  return ok(c, data)
})

// ============================================================
// 签发疫苗证明 MXQ-10005(跨表事务 RPC)
// ============================================================

const issueCertificateSchema = z.object({
  vaccinationId: z.string().uuid('疫苗接种 id 格式错误'),
  pdfFileId: z.string().uuid().optional(),
})

/**
 * 签发疫苗证明(MXQ-10005)
 * - 权限:vaccine.certificate.issue
 * - 行为:调 issue_vaccine_certificate RPC,事务化生成证书编号 + 落库 + 审计
 * - 校验:vaccination 必须为 administered 状态;同 vaccination 不可重复签发
 */
diagnosticsRoutes.post('/certificates/issue', async (c) => {
  const input = await parseJsonBody(c, issueCertificateSchema)
  const service = createServiceClient()

  // 先查 vaccination 获取 tenant/store,用于权限校验
  const { data: vacc, error: vaccErr } = await service
    .from('vaccinations')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.vaccinationId)
    .maybeSingle()
  if (vaccErr || !vacc) {
    throw err.notFound('疫苗接种记录不存在')
  }
  await requireScopedPermission(c, { code: 'vaccine.certificate.issue', tenantId: vacc.tenant_id, storeId: vacc.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('issue_vaccine_certificate', {
    p_vaccination_id: input.vaccinationId,
    p_operator_id: user.id,
    p_pdf_file_id: input.pdfFileId ?? null,
  })

  if (error) {
    throw mapRpcError(error)
  }

  // 审计已由 RPC 内部写入,此处补充 request_id 关联
  return ok(c, data)
})

// ============================================================
// 扫描到期提醒 MXQ-10004(跨表事务 RPC)
// ============================================================

const scanRemindersSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  lookaheadDays: z.number().int().positive().max(365).default(7),
})

/**
 * 扫描到期提醒(MXQ-10004)
 * - 权限:diag_reminder.view
 * - 行为:调 scan_diag_reminders RPC,扫描到期疫苗/驱虫记录,生成提醒(幂等)
 */
diagnosticsRoutes.post('/reminders/scan', async (c) => {
  const input = await parseJsonBody(c, scanRemindersSchema)
  const scope = await requireScopedPermission(c, { code: 'diag_reminder.view', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const { data, error } = await service.rpc('scan_diag_reminders', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_lookahead_days: input.lookaheadDays,
  })

  if (error) {
    throw err.internal(`扫描提醒失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'diag_reminder.scan',
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { lookaheadDays: input.lookaheadDays, result: data },
  })

  return ok(c, data)
})

// ============================================================
// 创建检验申请 MXQ-10006
// ============================================================

const createLabOrderSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  customerId: z.string().uuid('客户 id 格式错误'),
  petId: z.string().uuid('宠物 id 格式错误'),
  encounterId: z.string().uuid().optional(),
  panelId: z.string().uuid().optional(),
  remark: z.string().max(1000).optional(),
})

/**
 * 创建检验申请(MXQ-10006)
 * - 权限:lab.request
 * - 自动生成申请单号:LAB-yyyymmdd-随机后缀
 */
diagnosticsRoutes.post('/lab-orders', async (c) => {
  const input = await parseJsonBody(c, createLabOrderSchema)
  const scope = await requireScopedPermission(c, { code: 'lab.request', tenantId: input.tenantId, storeId: input.storeId })

  const orderNo = `LAB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error } = await service
    .from('lab_orders')
    .insert({
      tenant_id: scope.tenantId,
      store_id: scope.storeId ?? null,
      customer_id: input.customerId,
      pet_id: input.petId,
      encounter_id: input.encounterId ?? null,
      panel_id: input.panelId ?? null,
      order_no: orderNo,
      status: 'requested',
      requested_by: user.id,
      remark: input.remark ?? null,
    })
    .select('*')
    .single()

  if (error) {
    throw err.internal(`创建检验申请失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'lab.order.create',
    entityType: 'lab_order',
    entityId: data.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { orderNo, customerId: input.customerId, petId: input.petId },
  })

  return ok(c, data)
})

// ============================================================
// 发布检验结果 MXQ-10008(跨表事务 RPC,危急值自动告警)
// ============================================================

const publishResultsSchema = z.object({
  labOrderId: z.string().uuid('检验申请 id 格式错误'),
  results: z.array(z.object({
    id: z.string().uuid('结果项 id 格式错误'),
    result_value: z.string().optional(),
    result_numeric: z.number().optional(),
    is_abnormal: z.boolean().optional(),
    is_critical: z.boolean().optional(),
    flag: z.enum(['low', 'high', 'critical']).optional(),
    note: z.string().max(500).optional(),
  })).min(1, '至少录入一条结果'),
})

/**
 * 发布检验结果(MXQ-10008)
 * - 权限:lab.result.input
 * - 行为:调 publish_lab_results RPC,事务化批量更新结果 + 自动危急值告警 + 状态推进 + 审计
 * - 校验:lab_order 必须为 collected/completed 状态
 */
diagnosticsRoutes.post('/lab-orders/publish', async (c) => {
  const input = await parseJsonBody(c, publishResultsSchema)
  const service = createServiceClient()

  // 先查 lab_order 获取 tenant/store,用于权限校验
  const { data: order, error: orderErr } = await service
    .from('lab_orders')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.labOrderId)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('检验申请不存在')
  }
  await requireScopedPermission(c, { code: 'lab.result.input', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('publish_lab_results', {
    p_lab_order_id: input.labOrderId,
    p_results_json: input.results,
    p_operator_id: user.id,
  })

  if (error) {
    throw mapRpcError(error)
  }

  // 审计已由 RPC 内部写入,此处补充 request_id 关联
  return ok(c, data)
})

// ============================================================
// 审核检验结果 MXQ-10008(跨表事务 RPC,双签)
// ============================================================

const reviewResultsSchema = z.object({
  labOrderId: z.string().uuid('检验申请 id 格式错误'),
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().max(1000).optional(),
})

/**
 * 审核检验结果(MXQ-10008,双签)
 * - 权限:lab.result.review
 * - 行为:调 review_lab_results RPC,校验已录入 + 双签(审核人≠录入人)+ 写审核记录 + 状态推进 + 审计
 */
diagnosticsRoutes.post('/lab-orders/review', async (c) => {
  const input = await parseJsonBody(c, reviewResultsSchema)
  const service = createServiceClient()

  // 先查 lab_order 获取 tenant/store,用于权限校验
  const { data: order, error: orderErr } = await service
    .from('lab_orders')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.labOrderId)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('检验申请不存在')
  }
  await requireScopedPermission(c, { code: 'lab.result.review', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('review_lab_results', {
    p_lab_order_id: input.labOrderId,
    p_decision: input.decision,
    p_comment: input.comment ?? null,
    p_reviewer_id: user.id,
  })

  if (error) {
    throw mapRpcError(error)
  }

  // 审计已由 RPC 内部写入,此处补充 request_id 关联
  return ok(c, data)
})

export default diagnosticsRoutes
