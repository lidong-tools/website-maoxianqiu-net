/* eslint-disable style/max-statements-per-line -- 诊断状态机使用紧凑守卫语句 */
import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import { requireScopedPermission } from '../lib/permission.js'
import { getContext, loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

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
  catalogItemId: z.string().uuid().optional(),
  remark: z.string().max(1000).optional(),
})

/**
 * 创建检验申请(MXQ-10006)
 * - 权限:lab.request
 * - 自动生成申请单号:LAB-yyyymmdd-随机后缀
 */
diagnosticsRoutes.post('/lab-orders', async (c) => {
  const input = await parseJsonBody(c, createLabOrderSchema)
  const idempotencyKey = getRequestIdempotencyKey(c)
  if (!idempotencyKey) { throw err.badRequest('缺少 idempotency-key') }
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
      catalog_item_id: input.catalogItemId ?? null,
      order_no: orderNo,
      status: 'requested',
      requested_by: user.id,
      remark: input.remark ?? null,
      idempotency_key: idempotencyKey,
    })
    .select('*')
    .single()

  if (error?.code === '23505') {
    const { data: existing } = await service.from('lab_orders').select('*').eq('tenant_id', scope.tenantId).eq('idempotency_key', idempotencyKey).maybeSingle()
    if (existing) { return ok(c, existing) }
  }
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

// ============================================================
// S3.1-并发任务C:检验标本(lab_samples)流转闭环(migration 45)
// ============================================================

const labSampleListSchema = z.object({
  tenantId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  labOrderId: z.string().uuid().optional(),
  status: z.enum(['planned', 'collected', 'received', 'testing', 'completed', 'rejected']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/**
 * 标本列表(S3.1-C)
 * - 权限:lab_sample.read
 */
diagnosticsRoutes.get('/lab-samples', async (c) => {
  const input = labSampleListSchema.parse(c.req.query())
  const tenantId = input.tenantId ?? getContext(c).tenantId ?? getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, { code: 'lab_sample.read', tenantId, storeId: input.storeId })

  const service = createServiceClient()
  let query = service
    .from('lab_samples')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.labOrderId) {
    query = query.eq('lab_order_id', input.labOrderId)
  }
  if (input.status) {
    query = query.eq('status', input.status)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询标本列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

const createLabSampleSchema = z.object({
  labOrderId: z.string().uuid('检验申请 id 格式错误'),
  sampleType: z.enum(['blood', 'urine', 'feces', 'tissue', 'other']).default('blood'),
  container: z.string().max(200).optional(),
  storageCondition: z.string().max(200).optional(),
  remark: z.string().max(1000).optional(),
})

/**
 * 创建标本(S3.1-C)
 * - 权限:lab_sample.write
 * - 调 create_lab_sample RPC:校验检验申请状态 + 生成标本编号 + 审计
 */
diagnosticsRoutes.post('/lab-samples', async (c) => {
  const input = await parseJsonBody(c, createLabSampleSchema)
  const service = createServiceClient()

  const { data: order, error: orderErr } = await service
    .from('lab_orders')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.labOrderId)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('检验申请不存在')
  }
  await requireScopedPermission(c, { code: 'lab_sample.write', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('create_lab_sample', {
    p_lab_order_id: input.labOrderId,
    p_sample_type: input.sampleType,
    p_operator_id: user.id,
    p_container: input.container ?? null,
    p_storage_condition: input.storageCondition ?? null,
    p_remark: input.remark ?? null,
  })

  if (error) {
    if (error.message.includes('LAB_ORDER_NOT_FOUND')) {
      throw err.notFound('检验申请不存在')
    }
    if (error.message.includes('LAB_ORDER_NOT_ACCEPTING_SAMPLE')) {
      throw err.conflict('仅待采集/已采集状态的检验申请可添加标本')
    }
    throw err.internal(`创建标本失败: ${error.message}`)
  }

  return ok(c, data)
})

const transitionLabSampleSchema = z.object({
  toStatus: z.enum(['planned', 'collected', 'received', 'testing', 'completed', 'rejected']),
  reason: z.string().max(1000).optional(),
})

/**
 * 标本状态流转(S3.1-C)
 * - 权限:lab_sample.execute
 * - 调 transition_lab_sample RPC:状态机校验 + 全部标本完成联动检验申请 + 审计
 */
diagnosticsRoutes.post('/lab-samples/:id/transition', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, transitionLabSampleSchema)
  const service = createServiceClient()

  const { data: sample, error: sampleErr } = await service
    .from('lab_samples')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (sampleErr || !sample) {
    throw err.notFound('标本不存在')
  }
  await requireScopedPermission(c, { code: 'lab_sample.execute', tenantId: sample.tenant_id, storeId: sample.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('transition_lab_sample', {
    p_sample_id: id,
    p_to_status: input.toStatus,
    p_operator_id: user.id,
    p_reason: input.reason ?? null,
  })

  if (error) {
    if (error.message.includes('LAB_SAMPLE_NOT_FOUND')) {
      throw err.notFound('标本不存在')
    }
    if (error.message.includes('INVALID_SAMPLE_TRANSITION')) {
      throw err.conflict(`标本状态不可由 ${sample.status} 转为 ${input.toStatus}`)
    }
    if (error.message.includes('REJECT_REASON_REQUIRED')) {
      throw err.badRequest('拒收须填写原因')
    }
    throw err.internal(`标本状态流转失败: ${error.message}`)
  }

  return ok(c, data)
})

// ============================================================
// S3.1-并发任务C:危急值(critical value)闭环(migration 46)
// ============================================================

const criticalAlertListSchema = z.object({
  tenantId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  petId: z.string().uuid().optional(),
  labOrderId: z.string().uuid().optional(),
  status: z.enum(['pending', 'acknowledged', 'resolved']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/**
 * 危急值列表(S3.1-C)
 * - 权限:lab_critical.read
 */
diagnosticsRoutes.get('/critical-values', async (c) => {
  const input = criticalAlertListSchema.parse(c.req.query())
  const tenantId = input.tenantId ?? getContext(c).tenantId ?? getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, { code: 'lab_critical.read', tenantId, storeId: input.storeId })

  const service = createServiceClient()
  let query = service
    .from('critical_value_alerts')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.petId) {
    query = query.eq('pet_id', input.petId)
  }
  if (input.labOrderId) {
    query = query.eq('lab_order_id', input.labOrderId)
  }
  if (input.status) {
    query = query.eq('status', input.status)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询危急值列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

const notifyCriticalValueSchema = z.object({
  channel: z.enum(['phone', 'wechat', 'inperson', 'other']).default('phone'),
})

/**
 * 通知危急值(S3.1-C)
 * - 权限:lab_critical.execute
 * - 调 notify_critical_value RPC:标记已通知(不改变状态)+ 审计
 */
diagnosticsRoutes.post('/critical-values/:id/notify', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, notifyCriticalValueSchema)
  const service = createServiceClient()

  const { data: alert, error: alertErr } = await service
    .from('critical_value_alerts')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (alertErr || !alert) {
    throw err.notFound('危急值告警不存在')
  }
  await requireScopedPermission(c, { code: 'lab_critical.execute', tenantId: alert.tenant_id, storeId: alert.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('notify_critical_value', {
    p_alert_id: id,
    p_operator_id: user.id,
    p_channel: input.channel,
  })

  if (error) {
    if (error.message.includes('CRITICAL_ALERT_NOT_FOUND')) {
      throw err.notFound('危急值告警不存在')
    }
    if (error.message.includes('CRITICAL_ALERT_RESOLVED')) {
      throw err.conflict('已解除的危急值不可再通知')
    }
    throw err.internal(`通知危急值失败: ${error.message}`)
  }

  return ok(c, data)
})

const ackCriticalValueSchema = z.object({
  toStatus: z.enum(['acknowledged', 'resolved']).default('acknowledged'),
  note: z.string().max(1000).optional(),
})

/**
 * 确认/解除危急值(S3.1-C)
 * - 权限:lab_critical.execute
 * - 调 ack_critical_value RPC:状态机校验(pending→acknowledged→resolved)+ 审计
 */
diagnosticsRoutes.post('/critical-values/:id/ack', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, ackCriticalValueSchema)
  const service = createServiceClient()

  const { data: alert, error: alertErr } = await service
    .from('critical_value_alerts')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (alertErr || !alert) {
    throw err.notFound('危急值告警不存在')
  }
  await requireScopedPermission(c, { code: 'lab_critical.execute', tenantId: alert.tenant_id, storeId: alert.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('ack_critical_value', {
    p_alert_id: id,
    p_to_status: input.toStatus,
    p_operator_id: user.id,
    p_note: input.note ?? null,
  })

  if (error) {
    if (error.message.includes('CRITICAL_ALERT_NOT_FOUND')) {
      throw err.notFound('危急值告警不存在')
    }
    if (error.message.includes('INVALID_CRITICAL_TRANSITION')) {
      throw err.conflict(`危急值状态不可由 ${alert.status} 转为 ${input.toStatus}`)
    }
    if (error.message.includes('CRITICAL_NOT_NOTIFIED')) {
      throw err.conflict('危急值须先通知后方可确认')
    }
    throw err.internal(`确认危急值失败: ${error.message}`)
  }

  return ok(c, data)
})

// ============================================================
// P0-27:检验工作台统一业务状态 DTO
// 后端推导 workflowStage / primaryAction / canEditResult / canReview / canPublish,
// 前端只消费业务状态,不再自行拼接 order.status + sample.status + review.status
// ============================================================

type LabWorkflowStage = 'awaiting_sample' | 'testing' | 'awaiting_review' | 'published' | 'rejected' | 'cancelled'
type LabPrimaryAction = 'collect' | 'publish' | 'review' | null

interface LabWorkflowDerived {
  workflowStage: LabWorkflowStage
  primaryAction: LabPrimaryAction
  canEditResult: boolean
  canReview: boolean
  canPublish: boolean
}

/**
 * 推导检验工作台统一业务状态(S3.1-Fix B1)
 *
 * 真实 RPC 语义:
 *   - 录入结果 = publish_lab_results(写 resulted_at/resulted_by,collected→completed)
 *   - 审核 = review_lab_results(要求至少一条 resulted_at,否则 NO_RESULTS_TO_REVIEW)
 *
 * 因此状态分支含义(P0-27 原实现将"无结果待提交"与"结果已提交待审核"混为一谈,导致死锁):
 *   | order.status | 条件                              | workflowStage | primaryAction | canEditResult | canReview | canPublish |
 *   |--------------|-----------------------------------|---------------|---------------|---------------|-----------|------------|
 *   | collected    | 无 received/testing 标本          | awaiting_review | publish      | true          | false     | true       |
 *   | collected    | 有 received/testing 标本(检测中)  | testing       | null          | true          | false     | false      |
 *   | completed    | 无审核记录                         | awaiting_review | review       | true          | true      | false      |
 *   | completed    | latestReview=rejected 且未重录    | rejected      | publish       | true          | false     | true       |
 *   | completed    | latestReview=rejected 且已重录    | awaiting_review | review       | true          | true      | false      |
 *   | completed    | latestReview=approved             | published     | null          | false         | false     | false      |
 *
 * @param order            检验申请行(须含 status)
 * @param samples          该单标本行列表(仅取 status 字段)
 * @param latestReview     最新一条审核记录(含 decision/reviewed_at),无审核时为 undefined
 * @param latestResultedAt 该单最新一条结果的 resulted_at(重录后大于最近审核时间即视为"已重新提交")
 */
function deriveLabWorkflow(
  order: { status: string },
  samples: Array<{ status: string }>,
  latestReview: { decision?: string, reviewed_at?: string } | undefined,
  latestResultedAt?: string | null,
): LabWorkflowDerived {
  if (order.status === 'cancelled') {
    return { workflowStage: 'cancelled', primaryAction: null, canEditResult: false, canReview: false, canPublish: false }
  }
  const hasRejectedSample = samples.some(s => s.status === 'rejected')
  if (hasRejectedSample) {
    return { workflowStage: 'rejected', primaryAction: 'publish', canEditResult: true, canReview: true, canPublish: true }
  }
  if (order.status === 'requested') {
    return { workflowStage: 'awaiting_sample', primaryAction: 'collect', canEditResult: false, canReview: false, canPublish: false }
  }
  if (order.status === 'collected') {
    const hasTesting = samples.some(s => s.status === 'received' || s.status === 'testing')
    if (hasTesting) {
      // 检测中:可编辑结果,但不可提交/审核(结果未就绪)
      return { workflowStage: 'testing', primaryAction: null, canEditResult: true, canReview: false, canPublish: false }
    }
    // 已采集且结果就绪:录入后通过 publish_lab_results 提交审核(修复 P0 死锁)
    return { workflowStage: 'awaiting_review', primaryAction: 'publish', canEditResult: true, canReview: false, canPublish: true }
  }
  if (order.status === 'completed') {
    if (latestReview?.decision === 'rejected') {
      // 审核退回:若结果已在审核后重新录入(resulted_at > reviewed_at),回到待审核;否则允许重新提交
      const reviewedAt = latestReview.reviewed_at ? new Date(latestReview.reviewed_at).getTime() : 0
      const resultedAt = latestResultedAt ? new Date(latestResultedAt).getTime() : 0
      if (latestResultedAt && latestReview.reviewed_at && resultedAt > reviewedAt) {
        return { workflowStage: 'awaiting_review', primaryAction: 'review', canEditResult: true, canReview: true, canPublish: false }
      }
      // 退回未重录:编辑结果后重新提交审核
      return { workflowStage: 'rejected', primaryAction: 'publish', canEditResult: true, canReview: false, canPublish: true }
    }
    if (latestReview?.decision === 'approved') {
      return { workflowStage: 'published', primaryAction: null, canEditResult: false, canReview: false, canPublish: false }
    }
    // 结果已通过 publish 提交,待审核
    return { workflowStage: 'awaiting_review', primaryAction: 'review', canEditResult: true, canReview: true, canPublish: false }
  }
  return { workflowStage: 'awaiting_sample', primaryAction: null, canEditResult: false, canReview: false, canPublish: false }
}

const labWorkbenchSchema = z.object({
  tenantId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  petId: z.string().uuid().optional(),
  stage: z.enum(['awaiting_sample', 'testing', 'awaiting_review', 'published', 'rejected', 'cancelled']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/** stage → lab_orders.status 粗筛(JS 层再做精确推导过滤) */
const STAGE_TO_STATUS: Record<Exclude<LabWorkflowStage, 'cancelled'>, string[]> = {
  awaiting_sample: ['requested'],
  testing: ['collected'],
  awaiting_review: ['collected', 'completed'],
  published: ['completed'],
  rejected: ['collected', 'completed'],
}

/**
 * 检验工作台列表(P0-27)
 * - 权限:lab.view
 * - 返回带 workflowStage/primaryAction/canX 的业务 DTO
 */
diagnosticsRoutes.get('/lab-workbench', async (c) => {
  const input = labWorkbenchSchema.parse(c.req.query())
  const tenantId = input.tenantId ?? getContext(c).tenantId ?? getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, { code: 'lab.view', tenantId, storeId: input.storeId })

  const service = createServiceClient()
  let query = service
    .from('lab_orders')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.encounterId) {
    query = query.eq('encounter_id', input.encounterId)
  }
  if (input.petId) {
    query = query.eq('pet_id', input.petId)
  }
  if (input.stage && input.stage !== 'cancelled') {
    const statuses = STAGE_TO_STATUS[input.stage]
    if (statuses.length === 1) {
      query = query.eq('status', statuses[0])
    }
    else {
      query = query.in('status', statuses)
    }
  }
  else if (input.stage === 'cancelled') {
    query = query.eq('status', 'cancelled')
  }

  const { data: orders, error } = await query.order('requested_at', { ascending: false }).limit(500)
  if (error) {
    throw err.internal(`查询检验工作台失败: ${error.message}`)
  }

  const orderIds = (orders ?? []).map(o => o.id)
  const samplesMap = new Map<string, Array<{ status: string }>>()
  const reviewMap = new Map<string, { decision?: string, reviewed_at?: string }>()
  // S3.1-Fix B1:每单最新一条结果的 resulted_at,用于区分"退回后已重录"与"退回未重录"
  const resultedMap = new Map<string, string>()
  if (orderIds.length) {
    const { data: samples } = await service
      .from('lab_samples')
      .select('lab_order_id, status')
      .in('lab_order_id', orderIds)
    samples?.forEach((s: { lab_order_id: string, status: string }) => {
      const arr = samplesMap.get(s.lab_order_id) ?? []
      arr.push({ status: s.status })
      samplesMap.set(s.lab_order_id, arr)
    })

    const { data: reviews } = await service
      .from('lab_result_reviews')
      .select('lab_order_id, decision, reviewed_at')
      .in('lab_order_id', orderIds)
      .order('reviewed_at', { ascending: false })
    const seen = new Set<string>()
    reviews?.forEach((r: { lab_order_id: string, decision: string, reviewed_at: string }) => {
      if (!seen.has(r.lab_order_id)) {
        seen.add(r.lab_order_id)
        reviewMap.set(r.lab_order_id, { decision: r.decision, reviewed_at: r.reviewed_at })
      }
    })

    // S3.1-Fix B1:仅取已录结果的 resulted_at,每单保留最新一条
    const { data: analytes } = await service
      .from('lab_order_analytes')
      .select('lab_order_id, resulted_at')
      .in('lab_order_id', orderIds)
      .not('resulted_at', 'is', null)
    analytes?.forEach((a: { lab_order_id: string, resulted_at: string }) => {
      const prev = resultedMap.get(a.lab_order_id)
      if (!prev || a.resulted_at > prev) {
        resultedMap.set(a.lab_order_id, a.resulted_at)
      }
    })
  }

  let rows = (orders ?? []).map((o: any) => {
    const wf = deriveLabWorkflow(o, samplesMap.get(o.id) ?? [], reviewMap.get(o.id), resultedMap.get(o.id))
    return {
      ...o,
      workflowStage: wf.workflowStage,
      primaryAction: wf.primaryAction,
      canEditResult: wf.canEditResult,
      canReview: wf.canReview,
      canPublish: wf.canPublish,
    }
  })

  if (input.stage) {
    rows = rows.filter(r => r.workflowStage === input.stage)
  }

  const total = rows.length
  const from = (input.page - 1) * input.pageSize
  rows = rows.slice(from, from + input.pageSize)

  return ok(c, { list: rows, total, page: input.page, pageSize: input.pageSize })
})

// ============================================================
// 影像工作流(PRD §12.3):imaging_orders / imaging_reports
// 状态机:
//   order: requested→scheduled→in_progress→performed→reported→reviewed→published; 任意非终态→cancelled
//   report: draft→submitted→reviewed→published; submitted 退回→draft; 已发布修订→新版本行(draft)
//   create report 前置:order 须已 performed(performed/reported/reviewed/published 才允许创建)
// 权限:imaging.view / imaging.order / imaging.perform / imaging.report / imaging.review / imaging.publish
// 附件:复用 files/attachments/R2,entity_type = imaging_order | imaging_report
// ============================================================

const IMAGING_TYPES = ['ultrasound', 'xray', 'cr', 'ct', 'mri', 'other'] as const

/** 影像申请单工作台业务状态 */
const IMAGING_STAGE_MAP: Record<string, { workflowStage: string, primaryAction: string | null }> = {
  requested: { workflowStage: 'awaiting_schedule', primaryAction: 'schedule' },
  scheduled: { workflowStage: 'awaiting_perform', primaryAction: 'perform' },
  in_progress: { workflowStage: 'awaiting_perform', primaryAction: 'perform' },
  performed: { workflowStage: 'awaiting_report', primaryAction: 'report' },
  reported: { workflowStage: 'awaiting_review', primaryAction: 'review' },
  reviewed: { workflowStage: 'awaiting_review', primaryAction: 'review' },
  published: { workflowStage: 'published', primaryAction: null },
  cancelled: { workflowStage: 'cancelled', primaryAction: null },
}

function genImagingOrderNo() {
  return `IMG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

const imagingOrderListSchema = z.object({
  tenantId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  petId: z.string().uuid().optional(),
  stage: z.enum(['awaiting_schedule', 'awaiting_perform', 'awaiting_report', 'awaiting_review', 'published', 'cancelled']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/**
 * 影像申请单列表(MXQ-10021)
 * - 权限:imaging.view
 */
diagnosticsRoutes.get('/imaging/orders', async (c) => {
  const input = imagingOrderListSchema.parse(c.req.query())
  const tenantId = input.tenantId ?? getContext(c).tenantId ?? getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, { code: 'imaging.view', tenantId, storeId: input.storeId })

  const service = createServiceClient()
  let query = service
    .from('imaging_orders')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.encounterId) {
    query = query.eq('encounter_id', input.encounterId)
  }
  if (input.petId) {
    query = query.eq('pet_id', input.petId)
  }

  const { data: orders, error } = await query
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) {
    throw err.internal(`查询影像申请列表失败: ${error.message}`)
  }

  // S3.1-Fix B4(审计 41 节):每单最新报告行(draft 优先),用于"修订待处理"标记
  const orderIds = (orders ?? []).map((o: any) => o.id)
  const latestReportMap = new Map<string, { status: string }>()
  if (orderIds.length) {
    const { data: reports } = await service
      .from('imaging_reports')
      .select('imaging_order_id, status')
      .in('imaging_order_id', orderIds)
    const PRIORITY: Record<string, number> = { draft: 0, submitted: 1, reviewed: 2, published: 3 }
    reports?.forEach((r: { imaging_order_id: string, status: string }) => {
      const prev = latestReportMap.get(r.imaging_order_id)
      if (!prev || (PRIORITY[r.status] ?? 9) < (PRIORITY[prev.status] ?? 9)) {
        latestReportMap.set(r.imaging_order_id, { status: r.status })
      }
    })
  }

  let rows = (orders ?? []).map((o: any) => {
    const mapped = IMAGING_STAGE_MAP[o.status] ?? { workflowStage: o.status, primaryAction: null }
    const latest = latestReportMap.get(o.id)
    // 最新报告为 draft 且订单未取消 → 存在待处理报告/修订(已发布后创建 V2 draft 时订单主状态仍为 published)
    const revisionPending = !!latest && latest.status === 'draft' && o.status !== 'cancelled'
    return {
      ...o,
      workflowStage: mapped.workflowStage,
      primaryAction: mapped.primaryAction,
      latestReportStatus: latest?.status ?? null,
      revisionPending,
    }
  })
  if (input.stage) {
    rows = rows.filter(r => r.workflowStage === input.stage)
  }

  const total = rows.length
  const from = (input.page - 1) * input.pageSize
  rows = rows.slice(from, from + input.pageSize)

  return ok(c, { list: rows, total, page: input.page, pageSize: input.pageSize })
})

const createImagingOrderSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  customerId: z.string().uuid('客户 id 格式错误'),
  petId: z.string().uuid('宠物 id 格式错误'),
  imagingType: z.enum(IMAGING_TYPES),
  catalogItemId: z.string().uuid().optional(),
  scheduledAt: z.string().optional(),
  clinicalQuestion: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
})

/**
 * 创建影像申请(MXQ-10022)
 * - 权限:imaging.order
 */
diagnosticsRoutes.post('/imaging/orders', async (c) => {
  const input = await parseJsonBody(c, createImagingOrderSchema)
  const idempotencyKey = getRequestIdempotencyKey(c)
  if (!idempotencyKey) { throw err.badRequest('缺少 idempotency-key') }
  const scope = await requireScopedPermission(c, { code: 'imaging.order', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const user = c.get('user')

  // P0-13:实体关系链校验(service role 绕过 RLS,必须显式证明同租户/同关系)
  const { data: customer } = await service
    .from('customers')
    .select('id')
    .eq('id', input.customerId)
    .eq('tenant_id', scope.tenantId)
    .maybeSingle()
  if (!customer) {
    throw err.badRequest('客户不属于当前租户')
  }
  const { data: pet } = await service
    .from('pets')
    .select('id')
    .eq('id', input.petId)
    .eq('tenant_id', scope.tenantId)
    .eq('customer_id', input.customerId)
    .maybeSingle()
  if (!pet) {
    throw err.badRequest('宠物与客户不匹配或不属于当前租户')
  }
  if (input.encounterId) {
    const { data: enc } = await service
      .from('encounters')
      .select('id, store_id')
      .eq('id', input.encounterId)
      .eq('tenant_id', scope.tenantId)
      .eq('pet_id', input.petId)
      .maybeSingle()
    if (!enc || (enc.store_id && enc.store_id !== scope.storeId)) {
      throw err.badRequest('就诊记录与宠物/门店不匹配')
    }
  }
  if (input.catalogItemId) {
    const { data: ci } = await service
      .from('catalog_items')
      .select('id')
      .eq('id', input.catalogItemId)
      .eq('tenant_id', scope.tenantId)
      .maybeSingle()
    if (!ci) {
      throw err.badRequest('目录项目不属于当前租户')
    }
  }

  const orderNo = genImagingOrderNo()
  const { data, error } = await service
    .from('imaging_orders')
    .insert({
      tenant_id: scope.tenantId,
      store_id: scope.storeId ?? null,
      order_no: orderNo,
      encounter_id: input.encounterId ?? null,
      customer_id: input.customerId,
      pet_id: input.petId,
      requested_by: user.id,
      imaging_type: input.imagingType,
      catalog_item_id: input.catalogItemId ?? null,
      scheduled_at: input.scheduledAt ?? null,
      status: 'requested',
      clinical_question: input.clinicalQuestion ?? null,
      notes: input.notes ?? null,
      idempotency_key: idempotencyKey,
    })
    .select('*')
    .single()

  if (error?.code === '23505') {
    const { data: existing } = await service.from('imaging_orders').select('*').eq('tenant_id', scope.tenantId).eq('idempotency_key', idempotencyKey).maybeSingle()
    if (existing) { return ok(c, existing) }
  }
  if (error) {
    throw err.internal(`创建影像申请失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'imaging.order.create',
    entityType: 'imaging_order',
    entityId: data.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { orderNo, imagingType: input.imagingType, petId: input.petId, encounterId: input.encounterId ?? null },
  })

  return ok(c, data)
})

const scheduleImagingOrderSchema = z.object({
  scheduledAt: z.string().min(1, '请选择预约时间'),
})

/**
 * 影像排程(requested→scheduled)(MXQ-10023)
 * - 权限:imaging.order
 */
diagnosticsRoutes.post('/imaging/orders/:id/schedule', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, scheduleImagingOrderSchema)
  const service = createServiceClient()

  const { data: order, error: orderErr } = await service
    .from('imaging_orders')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('影像申请不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.order', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  if (order.status !== 'requested') {
    throw err.conflict('仅待预约状态的影像申请可排程')
  }

  // P0-14:条件更新(status=expected),并发下仅一方成功,避免两请求同时通过预检查
  const { data: rows, error } = await service
    .from('imaging_orders')
    .update({ status: 'scheduled', scheduled_at: input.scheduledAt, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'requested')
    .select('*')

  if (error) {
    throw err.internal(`影像排程失败: ${error.message}`)
  }
  if (!rows || rows.length === 0) {
    throw err.conflict('影像申请状态已变更,请刷新后重试')
  }
  const data = rows[0]

  await writeAudit(c, {
    action: 'imaging.order.schedule',
    entityType: 'imaging_order',
    entityId: id,
    tenantId: order.tenant_id,
    storeId: order.store_id ?? undefined,
    metadata: { scheduledAt: input.scheduledAt },
  })

  return ok(c, data)
})

/**
 * 影像开始执行(scheduled→in_progress)(MXQ-10024)
 * - 权限:imaging.perform
 */
diagnosticsRoutes.post('/imaging/orders/:id/start', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: order, error: orderErr } = await service
    .from('imaging_orders')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('影像申请不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.perform', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  if (order.status !== 'scheduled') {
    throw err.conflict('仅已排程状态的影像可开始执行')
  }

  // P0-14:条件更新(status=expected),并发防重
  const { data: rows, error } = await service
    .from('imaging_orders')
    .update({ status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'scheduled')
    .select('*')

  if (error) {
    throw err.internal(`开始影像执行失败: ${error.message}`)
  }
  if (!rows || rows.length === 0) {
    throw err.conflict('影像申请状态已变更,请刷新后重试')
  }
  const data = rows[0]

  await writeAudit(c, {
    action: 'imaging.perform.start',
    entityType: 'imaging_order',
    entityId: id,
    tenantId: order.tenant_id,
    storeId: order.store_id ?? undefined,
    metadata: {},
  })

  return ok(c, data)
})

/**
 * 影像完成执行(in_progress→performed)(MXQ-10025)
 * - 权限:imaging.perform
 */
diagnosticsRoutes.post('/imaging/orders/:id/perform', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()
  const user = c.get('user')

  const { data: order, error: orderErr } = await service
    .from('imaging_orders')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('影像申请不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.perform', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  if (order.status !== 'in_progress') {
    throw err.conflict('仅执行中状态的影像可标记完成')
  }

  // P0-14:条件更新(status=expected),并发防重
  const { data: rows, error } = await service
    .from('imaging_orders')
    .update({ status: 'performed', performed_at: new Date().toISOString(), performed_by: user.id, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'in_progress')
    .select('*')

  if (error) {
    throw err.internal(`完成影像执行失败: ${error.message}`)
  }
  if (!rows || rows.length === 0) {
    throw err.conflict('影像申请状态已变更,请刷新后重试')
  }
  const data = rows[0]

  await writeAudit(c, {
    action: 'imaging.perform.complete',
    entityType: 'imaging_order',
    entityId: id,
    tenantId: order.tenant_id,
    storeId: order.store_id ?? undefined,
    metadata: { performedBy: user.id },
  })

  return ok(c, data)
})

/**
 * 取消影像申请(MXQ-10026)
 * - 权限:imaging.order
 * - 仅 requested/scheduled 可取消
 */
diagnosticsRoutes.post('/imaging/orders/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: order, error: orderErr } = await service
    .from('imaging_orders')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('影像申请不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.order', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  if (!['requested', 'scheduled'].includes(order.status)) {
    throw err.conflict('仅待预约/已排程状态的影像可取消')
  }

  // P0-14:条件更新(status ∈ 可取消),并发防重
  const { data: rows, error } = await service
    .from('imaging_orders')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['requested', 'scheduled'])
    .select('*')

  if (error) {
    throw err.internal(`取消影像申请失败: ${error.message}`)
  }
  if (!rows || rows.length === 0) {
    throw err.conflict('影像申请状态已变更,请刷新后重试')
  }
  const data = rows[0]

  await writeAudit(c, {
    action: 'imaging.order.cancel',
    entityType: 'imaging_order',
    entityId: id,
    tenantId: order.tenant_id,
    storeId: order.store_id ?? undefined,
    metadata: {},
  })

  return ok(c, data)
})

/**
 * 影像申请详情(MXQ-10027)
 * - 权限:imaging.view
 * - 返回 order + reports(按版本升序) + attachments(关联 files)
 */
diagnosticsRoutes.get('/imaging/orders/:id', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: order, error: orderErr } = await service
    .from('imaging_orders')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('影像申请不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.view', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  const { data: reports, error: reportsErr } = await service
    .from('imaging_reports')
    .select('*')
    .eq('imaging_order_id', id)
    .order('version', { ascending: true })
  if (reportsErr) {
    throw err.internal(`查询影像报告失败: ${reportsErr.message}`)
  }

  const { data: attachments, error: attErr } = await service
    .from('attachments')
    .select('*, files(*)')
    .eq('entity_type', 'imaging_order')
    .eq('entity_id', id)
    .order('created_at', { ascending: false })
  if (attErr) {
    throw err.internal(`查询影像附件失败: ${attErr.message}`)
  }

  return ok(c, {
    order,
    reports: reports ?? [],
    attachments: (attachments ?? []).filter((a: any) => a.files).map((a: any) => ({ ...a, file: a.files })),
  })
})

/**
 * 影像报告列表(MXQ-10028)
 * - 权限:imaging.view
 */
diagnosticsRoutes.get('/imaging/orders/:id/reports', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: order, error: orderErr } = await service
    .from('imaging_orders')
    .select('id, tenant_id, store_id')
    .eq('id', id)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('影像申请不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.view', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  const { data, error } = await service
    .from('imaging_reports')
    .select('*')
    .eq('imaging_order_id', id)
    .order('version', { ascending: false })

  if (error) {
    throw err.internal(`查询影像报告失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [] })
})

const createImagingReportSchema = z.object({
  findings: z.string().max(10000).optional(),
  impression: z.string().max(5000).optional(),
  recommendation: z.string().max(5000).optional(),
})

/**
 * 创建/修订影像报告(MXQ-10029)
 * - 权限:imaging.report
 * - 无已发布版本 → 创建 v1;存在已发布版本 → 产生新版本行(已发布版本不可静默覆盖)
 * - 同时将申请单推进到 reported(performed 之后)
 */
diagnosticsRoutes.post('/imaging/orders/:id/reports', async (c) => {
  const orderId = c.req.param('id')
  const input = await parseJsonBody(c, createImagingReportSchema)
  const service = createServiceClient()

  const { data: order, error: orderErr } = await service
    .from('imaging_orders')
    .select('id, tenant_id, store_id, status')
    .eq('id', orderId)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('影像申请不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.report', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  // S3.1-Fix B4(审计 40 节):requested/scheduled/in_progress 阶段不允许提前出现 Report,
  // 仅执行完成(performed)之后的申请可创建报告(draft 亦在 performed 之后)
  if (!['performed', 'reported', 'reviewed', 'published'].includes(order.status)) {
    throw err.conflict('仅执行完成后的影像申请可创建报告')
  }

  // 计算版本号:max(version) + 1
  const { data: reports, error: verErr } = await service
    .from('imaging_reports')
    .select('version, status')
    .eq('imaging_order_id', orderId)
  if (verErr) {
    throw err.internal(`查询影像报告版本失败: ${verErr.message}`)
  }
  const hasPublished = (reports ?? []).some(r => r.status === 'published')
  const maxVersion = (reports ?? []).reduce((max, r) => Math.max(max, r.version), 0)
  const nextVersion = maxVersion + 1

  const user = c.get('user')
  const { data, error } = await service
    .from('imaging_reports')
    .insert({
      tenant_id: order.tenant_id,
      store_id: order.store_id ?? null,
      imaging_order_id: orderId,
      version: nextVersion,
      findings: input.findings ?? null,
      impression: input.impression ?? null,
      recommendation: input.recommendation ?? null,
      author_id: user.id,
      status: 'draft',
    })
    .select('*')
    .single()

  if (error) {
    throw err.internal(`创建影像报告失败: ${error.message}`)
  }

  // performed/reported/reviewed → reported(报告已生成)
  if (['performed', 'reported', 'reviewed'].includes(order.status)) {
    await service
      .from('imaging_orders')
      .update({ status: 'reported', updated_at: new Date().toISOString() })
      .eq('id', orderId)
  }

  await writeAudit(c, {
    action: 'imaging.report.create',
    entityType: 'imaging_report',
    entityId: data.id,
    tenantId: order.tenant_id,
    storeId: order.store_id ?? undefined,
    metadata: { imagingOrderId: orderId, version: nextVersion, revision: hasPublished },
  })

  return ok(c, data)
})

const updateImagingReportSchema = z.object({
  findings: z.string().max(10000).optional(),
  impression: z.string().max(5000).optional(),
  recommendation: z.string().max(5000).optional(),
})

/**
 * 保存影像报告草稿(MXQ-10030)
 * - 权限:imaging.report
 * - 已发布版本不可直接修改,须走 revision(新版本行)
 */
diagnosticsRoutes.patch('/imaging/reports/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateImagingReportSchema)
  const service = createServiceClient()

  const { data: report, error: reportErr } = await service
    .from('imaging_reports')
    .select('id, tenant_id, store_id, status, imaging_order_id, version')
    .eq('id', id)
    .maybeSingle()
  if (reportErr || !report) {
    throw err.notFound('影像报告不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.report', tenantId: report.tenant_id, storeId: report.store_id ?? undefined })

  if (report.status === 'published') {
    throw err.conflict('已发布报告不可直接修改,请创建修订版本')
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.findings !== undefined) { patch.findings = input.findings }
  if (input.impression !== undefined) { patch.impression = input.impression }
  if (input.recommendation !== undefined) { patch.recommendation = input.recommendation }

  const { data, error } = await service
    .from('imaging_reports')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()

  if (error) {
    throw err.internal(`保存影像报告失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'imaging.report.update',
    entityType: 'imaging_report',
    entityId: id,
    tenantId: report.tenant_id,
    storeId: report.store_id ?? undefined,
    metadata: { imagingOrderId: report.imaging_order_id, version: report.version },
  })

  return ok(c, data)
})

/**
 * 提交影像报告待审(draft→submitted)(MXQ-10031a)
 * - 权限:imaging.report
 */
diagnosticsRoutes.post('/imaging/reports/:id/submit', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: report, error: reportErr } = await service
    .from('imaging_reports')
    .select('id, tenant_id, store_id, status, imaging_order_id, version')
    .eq('id', id)
    .maybeSingle()
  if (reportErr || !report) {
    throw err.notFound('影像报告不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.report', tenantId: report.tenant_id, storeId: report.store_id ?? undefined })

  if (report.status !== 'draft') {
    throw err.conflict('仅草稿状态的报告可提交审核')
  }

  // S3.1-Fix B4(审计 40 节):条件更新(status=expected),并发下仅一方成功,避免"先 SELECT 后 UPDATE"竞态
  const { data: rows, error } = await service
    .from('imaging_reports')
    .update({ status: 'submitted', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'draft')
    .select('*')

  if (error) {
    throw err.internal(`提交影像报告失败: ${error.message}`)
  }
  if (!rows || rows.length === 0) {
    throw err.conflict('影像报告状态已变更,请刷新后重试')
  }
  const data = rows[0]

  await writeAudit(c, {
    action: 'imaging.report.submit',
    entityType: 'imaging_report',
    entityId: id,
    tenantId: report.tenant_id,
    storeId: report.store_id ?? undefined,
    metadata: { imagingOrderId: report.imaging_order_id, version: report.version },
  })

  return ok(c, data)
})

const reviewImagingReportSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().max(2000).optional(),
})

/**
 * 审核影像报告(submitted→reviewed/退回)(MXQ-10031b)
 * - 权限:imaging.review
 * - 双签:审核人不可与报告作者为同一人
 */
diagnosticsRoutes.post('/imaging/reports/:id/review', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, reviewImagingReportSchema)
  const service = createServiceClient()
  const user = c.get('user')

  const { data: report, error: reportErr } = await service
    .from('imaging_reports')
    .select('id, tenant_id, store_id, status, author_id, reviewer_id, imaging_order_id, version')
    .eq('id', id)
    .maybeSingle()
  if (reportErr || !report) {
    throw err.notFound('影像报告不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.review', tenantId: report.tenant_id, storeId: report.store_id ?? undefined })

  if (report.status !== 'submitted') {
    throw err.conflict('仅待审核状态的报告可审核')
  }
  if (report.author_id === user.id) {
    throw err.conflict('审核人不可与报告作者为同一人(双签要求)')
  }

  const nextStatus = input.decision === 'approved' ? 'reviewed' : 'draft'
  // S3.1-Fix B4(审计 40 节):条件更新(status=expected),并发下仅一方成功,避免"先 SELECT 后 UPDATE"竞态
  const { data: rows, error } = await service
    .from('imaging_reports')
    .update({
      status: nextStatus,
      reviewer_id: input.decision === 'approved' ? user.id : report.reviewer_id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'submitted')
    .select('*')

  if (error) {
    throw err.internal(`审核影像报告失败: ${error.message}`)
  }
  if (!rows || rows.length === 0) {
    throw err.conflict('影像报告状态已变更,请刷新后重试')
  }
  const data = rows[0]

  // 审核通过 → 申请单推进到 reviewed;退回 → 回到 reported
  const orderStatus = input.decision === 'approved' ? 'reviewed' : 'reported'
  await service
    .from('imaging_orders')
    .update({ status: orderStatus, updated_at: new Date().toISOString() })
    .eq('id', report.imaging_order_id)
    .in('status', ['reported', 'reviewed'])

  await writeAudit(c, {
    action: 'imaging.report.review',
    entityType: 'imaging_report',
    entityId: id,
    tenantId: report.tenant_id,
    storeId: report.store_id ?? undefined,
    metadata: { imagingOrderId: report.imaging_order_id, version: report.version, decision: input.decision, comment: input.comment ?? null },
  })

  return ok(c, data)
})

/**
 * 发布影像报告(reviewed→published)(MXQ-10031c)
 * - 权限:imaging.publish
 * - 调 publish_imaging_report RPC:报告+申请单+审计 原子推进
 */
diagnosticsRoutes.post('/imaging/reports/:id/publish', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: report, error: reportErr } = await service
    .from('imaging_reports')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (reportErr || !report) {
    throw err.notFound('影像报告不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.publish', tenantId: report.tenant_id, storeId: report.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('publish_imaging_report', {
    p_report_id: id,
    p_operator_id: user.id,
  })

  if (error) {
    if (error.message.includes('IMAGING_REPORT_NOT_FOUND')) {
      throw err.notFound('影像报告不存在')
    }
    if (error.message.includes('IMAGING_REPORT_NOT_REVIEWED')) {
      throw err.conflict('仅已审核状态的报告可发布')
    }
    if (error.message.includes('IMAGING_ORDER_CANCELLED')) {
      throw err.conflict('已取消的影像申请不可发布')
    }
    throw err.internal(`发布影像报告失败: ${error.message}`)
  }

  return ok(c, data)
})

/**
 * 影像申请附件列表(MXQ-10032)
 * - 权限:imaging.view
 * - 复用 attachments 关联 files;entity_type = imaging_order | imaging_report
 */
diagnosticsRoutes.get('/imaging/orders/:id/attachments', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: order, error: orderErr } = await service
    .from('imaging_orders')
    .select('id, tenant_id, store_id')
    .eq('id', id)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('影像申请不存在')
  }
  await requireScopedPermission(c, { code: 'imaging.view', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  const { data, error } = await service
    .from('attachments')
    .select('*, files(*)')
    .in('entity_type', ['imaging_order', 'imaging_report'])
    .eq('entity_id', id)
    .order('created_at', { ascending: false })

  if (error) {
    throw err.internal(`查询影像附件失败: ${error.message}`)
  }

  return ok(c, { list: (data ?? []).filter((a: any) => a.files).map((a: any) => ({ ...a, file: a.files })) })
})

export default diagnosticsRoutes
