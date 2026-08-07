import type { Context } from 'hono'
import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { getRequestIdempotencyKey } from '../lib/idempotency'
import { requireScopedPermission } from '../lib/permission'
import { getContext, loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * Inpatient 住院管理领域 Command 路由(MXQ-11001~11009)
 *
 * 状态机:
 *   cage: available → occupied → available(出院);available → maintenance → available
 *   admission: admitted → discharged;admitted → transferred(换房不改状态,只更新 cage_id)
 *   nursing_task: pending → in_progress → done;pending → skipped
 *
 * 安全:
 *   - 入院须 inpatient.admit 权限 + 笼位归属门店校验
 *   - 出院须 inpatient.discharge 权限 + 入院归属门店校验
 *   - 换房须 inpatient.transfer 权限 + 入院归属门店校验
 *   - 交接班须 handover.manage 权限 + 门店归属校验
 *   - 自动计费须 inpatient.admit 权限(管理员/医生触发,通常为定时任务)
 *   - 所有房位操作走 Hono Command + PostgreSQL RPC,SELECT FOR UPDATE 防房位冲突
 *   - 幂等:请求须带 idempotency-key(Header 或 body.idempotencyKey),RPC 内 SELECT FOR UPDATE + 唯一键防重复占用
 */
const inpatientRoutes = new Hono<AppEnv>()

inpatientRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/** 从 Header 或 body 解析幂等键;关键写操作必须提供,缺失返回 400 防止绕过幂等 */
function resolveIdempotencyKey(c: Context<AppEnv>, bodyKey?: string): string {
  const key = getRequestIdempotencyKey(c) || bodyKey
  if (!key) {
    throw err.badRequest('缺少幂等键(Idempotency-Key header 或 body.idempotencyKey)')
  }
  return key
}

/** 将 RPC 抛出的业务错误码映射为 HTTP 错误 */
function mapRpcError(error: { message: string }) {
  const msg = error.message
  if (msg.includes('CAGE_NOT_FOUND') || msg.includes('OLD_CAGE_NOT_FOUND') || msg.includes('NEW_CAGE_NOT_FOUND')) {
    return err.notFound('笼位不存在')
  }
  if (msg.includes('ADMISSION_NOT_FOUND')) {
    return err.notFound('住院记录不存在')
  }
  if (msg.includes('CAGE_NOT_AVAILABLE') || msg.includes('NEW_CAGE_NOT_AVAILABLE')) {
    return err.conflict('笼位不可用(已被占用或维护中)')
  }
  if (msg.includes('ADMISSION_NOT_ADMITTED')) {
    return err.conflict('住院记录不在院状态,无法操作')
  }
  if (msg.includes('SAME_CAGE')) {
    return err.badRequest('新旧笼位相同,无需换房')
  }
  if (msg.includes('INVALID_SHIFT_TYPE')) {
    return err.badRequest('班次类型无效')
  }
  return err.internal(`住院操作失败: ${msg}`)
}

const admitSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
  petId: z.string().uuid('宠物 id 格式错误'),
  cageId: z.string().uuid('笼位 id 格式错误'),
  doctorId: z.string().uuid().optional(),
  admissionReason: z.string().max(500).optional(),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 办理入院(MXQ-11003)
 * - 权限:inpatient.admit
 * - 行为:调 admit_patient RPC,事务化创建 admission + 锁笼位(occupied)
 * - 幂等:同一 idempotency-key 重复请求返回原结果
 * - 并发:RPC 内 SELECT FOR UPDATE 锁 cages 行,防止同一笼位被两个入院同时占用
 */
inpatientRoutes.post('/admit', async (c) => {
  const input = await parseJsonBody(c, admitSchema)
  const service = createServiceClient()

  // 校验笼位归属与门店,作为权限校验的数据来源
  const { data: cage, error: cageErr } = await service
    .from('cages')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.cageId)
    .eq('tenant_id', input.tenantId)
    .eq('store_id', input.storeId)
    .maybeSingle()
  if (cageErr || !cage) {
    throw err.notFound('笼位不存在')
  }
  if (cage.status !== 'available') {
    throw err.conflict('笼位不可用(已被占用或维护中)')
  }
  // P0-02 scoped:门店级作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'inpatient.admit',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('admit_patient', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_customer_id: input.customerId,
    p_pet_id: input.petId,
    p_cage_id: input.cageId,
    p_doctor_id: input.doctorId ?? null,
    p_admission_reason: input.admissionReason ?? null,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inpatient.admit',
    entityType: 'admission',
    entityId: (data as { admissionId?: string })?.admissionId,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: {
      customerId: input.customerId,
      petId: input.petId,
      cageId: input.cageId,
      doctorId: input.doctorId,
      admissionReason: input.admissionReason,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

const transferSchema = z.object({
  admissionId: z.string().uuid('住院 id 格式错误'),
  newCageId: z.string().uuid('新笼位 id 格式错误'),
  reason: z.string().max(500).optional(),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 换房(MXQ-11006)
 * - 权限:inpatient.transfer(须同时有权访问原笼位与新笼位门店,本任务范围限定为同门店内换房)
 * - 行为:调 transfer_cage RPC,事务化释放旧笼位 + 占用新笼位,记录 cage_transfers
 * - 幂等:同一 idempotency-key 重复请求返回原结果
 */
inpatientRoutes.post('/transfer', async (c) => {
  const input = await parseJsonBody(c, transferSchema)
  const service = createServiceClient()

  // 查住院记录获取 store_id 做权限校验
  const { data: admission, error: admErr } = await service
    .from('admissions')
    .select('id, tenant_id, store_id, cage_id, status')
    .eq('id', input.admissionId)
    .maybeSingle()
  if (admErr || !admission) {
    throw err.notFound('住院记录不存在')
  }
  if (admission.status !== 'admitted') {
    throw err.conflict('住院记录不在院状态,无法换房')
  }
  // P0-02 scoped:按住院记录所属门店作用域授权,替代 requirePermission
  await requireScopedPermission(c, {
    code: 'inpatient.transfer',
    tenantId: admission.tenant_id,
    storeId: admission.store_id ?? undefined,
  })

  // 校验新笼位归属门店
  const { data: newCage, error: newCageErr } = await service
    .from('cages')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.newCageId)
    .eq('tenant_id', admission.tenant_id)
    .eq('store_id', admission.store_id)
    .maybeSingle()
  if (newCageErr || !newCage) {
    throw err.notFound('目标笼位不存在')
  }
  if (newCage.status !== 'available') {
    throw err.conflict('目标笼位不可用')
  }
  if (newCage.id === admission.cage_id) {
    throw err.badRequest('新旧笼位相同,无需换房')
  }

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('transfer_cage', {
    p_admission_id: input.admissionId,
    p_new_cage_id: input.newCageId,
    p_reason: input.reason ?? null,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inpatient.transfer',
    entityType: 'cage_transfer',
    entityId: (data as { transferId?: string })?.transferId,
    tenantId: admission.tenant_id,
    storeId: admission.store_id,
    metadata: {
      admissionId: input.admissionId,
      newCageId: input.newCageId,
      reason: input.reason,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

const dischargeSchema = z.object({
  admissionId: z.string().uuid('住院 id 格式错误'),
  dischargeReason: z.string().max(200).optional(),
  dischargeNotes: z.string().max(2000).optional(),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 办理出院(MXQ-11008)
 * - 权限:inpatient.discharge
 * - 行为:调 discharge_patient RPC,事务化汇总 total_charge + 释放笼位(available)
 * - 幂等:同一 idempotency-key 重复请求返回原结果
 */
inpatientRoutes.post('/discharge', async (c) => {
  const input = await parseJsonBody(c, dischargeSchema)
  const service = createServiceClient()

  // 查住院记录获取 store_id 做权限校验
  const { data: admission, error: admErr } = await service
    .from('admissions')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.admissionId)
    .maybeSingle()
  if (admErr || !admission) {
    throw err.notFound('住院记录不存在')
  }
  if (admission.status !== 'admitted') {
    throw err.conflict('住院记录不在院状态,无法出院')
  }
  // P0-02 scoped:按住院记录所属门店作用域授权,替代 requirePermission
  await requireScopedPermission(c, {
    code: 'inpatient.discharge',
    tenantId: admission.tenant_id,
    storeId: admission.store_id ?? undefined,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('discharge_patient', {
    p_admission_id: input.admissionId,
    p_discharge_reason: input.dischargeReason ?? null,
    p_discharge_notes: input.dischargeNotes ?? null,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inpatient.discharge',
    entityType: 'admission',
    entityId: input.admissionId,
    tenantId: admission.tenant_id,
    storeId: admission.store_id,
    metadata: {
      dischargeReason: input.dischargeReason,
      totalCharge: (data as { totalCharge?: number })?.totalCharge,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

const handoverSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  shiftDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '班次日期格式应为 YYYY-MM-DD'),
  shiftType: z.enum(['morning', 'evening', 'night']),
  outgoingUser: z.string().uuid().optional(),
  incomingUser: z.string().uuid().optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
})

/**
 * 创建交接班(MXQ-11005)
 * - 权限:handover.manage
 * - 行为:调 create_handover RPC,同班次已存在则更新 summary(便于多次保存草稿)
 */
inpatientRoutes.post('/handover', async (c) => {
  const input = await parseJsonBody(c, handoverSchema)
  // P0-02 scoped:门店级作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'handover.manage',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })

  const service = createServiceClient()
  const user = c.get('user')

  const { data, error } = await service.rpc('create_handover', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_shift_date: input.shiftDate,
    p_shift_type: input.shiftType,
    p_outgoing_user: input.outgoingUser ?? null,
    p_incoming_user: input.incomingUser ?? null,
    p_summary: input.summary ?? {},
    p_operator_id: user.id,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inpatient.handover',
    entityType: 'shift_handover',
    entityId: (data as { handoverId?: string })?.handoverId,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: {
      shiftDate: input.shiftDate,
      shiftType: input.shiftType,
      outgoingUser: input.outgoingUser,
      incomingUser: input.incomingUser,
    },
  })

  return ok(c, data)
})

const generateChargesSchema = z.object({
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').optional().nullable(),
})

/**
 * 自动计费(MXQ-11007)
 * - 权限:inpatient.admit(管理员或医生触发,通常为定时任务调用)
 * - 行为:调 generate_daily_charges RPC,扫描所有 admitted admission 生成当日笼位费
 * - 幂等:同 charge_date + admission_id + catalog_item_id 不重复生成
 */
inpatientRoutes.post('/charges/generate', async (c) => {
  const input = await parseJsonBody(c, generateChargesSchema)

  // P0-02 scoped:自动计费为系统级操作,取调用者默认租户做作用域授权(可由超管/定时任务触发)
  const tenantId = getContext(c).tenantId ?? getContext(c).memberships[0]?.tenant_id ?? ''
  await requireScopedPermission(c, { code: 'inpatient.admit', tenantId })

  const service = createServiceClient()

  const { data, error } = await service.rpc('generate_daily_charges', {
    p_target_date: input.targetDate ?? null,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inpatient.generateDailyCharges',
    entityType: 'inpatient_charges',
    entityId: undefined,
    tenantId,
    metadata: {
      targetDate: input.targetDate ?? new Date().toISOString().slice(0, 10),
      generatedCount: (data as { generatedCount?: number })?.generatedCount,
    },
  })

  return ok(c, data)
})

/**
 * 房态看板(MXQ-11002)
 * - 权限:inpatient.view
 * - 行为:查 inpatient_cage_status 视图,按 tenant_id/store_id 过滤
 */
inpatientRoutes.get('/cages/status', async (c) => {
  // P0-02 scoped:校验 tenant 归属(缺失取调用者默认租户),并强制按 scope.tenantId 过滤
  const tenantId = c.req.query('tenantId') ?? getContext(c).memberships[0]?.tenant_id
  const storeId = c.req.query('storeId')
  const scope = await requireScopedPermission(c, {
    code: 'inpatient.view',
    tenantId: tenantId ?? '',
    storeId: storeId ?? undefined,
  })

  const service = createServiceClient()
  let query = service.from('inpatient_cage_status').select('*').eq('tenant_id', scope.tenantId)
  if (storeId) {
    query = query.eq('store_id', storeId)
  }
  const { data, error } = await query.order('room_name', { ascending: true })
  if (error) {
    throw err.internal(`查询房态看板失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [] })
})

// ============================================================
// S3.1-并发任务C:住院病程(inpatient_progress_notes)(migration 47)
// ============================================================

const progressNoteListSchema = z.object({
  tenantId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  admissionId: z.string().uuid().optional(),
  petId: z.string().uuid().optional(),
  status: z.enum(['draft', 'signed']).optional(),
  noteType: z.enum(['daily', 'critical', 'preop', 'postop', 'discharge']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/**
 * 病程记录列表(S3.1-C)
 * - 权限:progress.view
 */
inpatientRoutes.get('/progress-notes', async (c) => {
  const input = progressNoteListSchema.parse(c.req.query())
  const tenantId = input.tenantId ?? getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, { code: 'progress.view', tenantId, storeId: input.storeId })

  const service = createServiceClient()
  let query = service
    .from('inpatient_progress_notes')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.admissionId) {
    query = query.eq('admission_id', input.admissionId)
  }
  if (input.petId) {
    query = query.eq('pet_id', input.petId)
  }
  if (input.status) {
    query = query.eq('status', input.status)
  }
  if (input.noteType) {
    query = query.eq('note_type', input.noteType)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('recorded_at', { ascending: false })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询病程记录失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

const createProgressNoteSchema = z.object({
  admissionId: z.string().uuid('住院 id 格式错误'),
  content: z.string().min(1, '病程内容不能为空').max(5000),
  noteType: z.enum(['daily', 'critical', 'preop', 'postop', 'discharge']).default('daily'),
  recordedAt: z.string().optional(),
})

/**
 * 记录病程(S3.1-C)
 * - 权限:progress.write
 * - 调 create_progress_note RPC:校验住院中 + 生成编号 + 审计
 */
inpatientRoutes.post('/progress-notes', async (c) => {
  const input = await parseJsonBody(c, createProgressNoteSchema)
  const service = createServiceClient()

  const { data: admission, error: admErr } = await service
    .from('admissions')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.admissionId)
    .maybeSingle()
  if (admErr || !admission) {
    throw err.notFound('住院记录不存在')
  }
  await requireScopedPermission(c, { code: 'progress.write', tenantId: admission.tenant_id, storeId: admission.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('create_progress_note', {
    p_admission_id: input.admissionId,
    p_content: input.content,
    p_note_type: input.noteType,
    p_recorded_at: input.recordedAt ?? null,
    p_operator_id: user.id,
  })

  if (error) {
    if (error.message.includes('ADMISSION_NOT_FOUND')) {
      throw err.notFound('住院记录不存在')
    }
    if (error.message.includes('ADMISSION_NOT_ADMITTED')) {
      throw err.conflict('仅住院中的记录可书写病程')
    }
    if (error.message.includes('PROGRESS_CONTENT_REQUIRED')) {
      throw err.badRequest('病程内容不能为空')
    }
    throw err.internal(`记录病程失败: ${error.message}`)
  }

  return ok(c, data)
})

/**
 * 签署病程(S3.1-C)
 * - 权限:progress.sign
 * - 调 sign_progress_note RPC:draft → signed + 审计
 */
inpatientRoutes.post('/progress-notes/:id/sign', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: note, error: noteErr } = await service
    .from('inpatient_progress_notes')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (noteErr || !note) {
    throw err.notFound('病程记录不存在')
  }
  await requireScopedPermission(c, { code: 'progress.sign', tenantId: note.tenant_id, storeId: note.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('sign_progress_note', {
    p_note_id: id,
    p_signed_by: user.id,
  })

  if (error) {
    if (error.message.includes('PROGRESS_NOTE_NOT_FOUND')) {
      throw err.notFound('病程记录不存在')
    }
    if (error.message.includes('PROGRESS_NOTE_ALREADY_SIGNED')) {
      throw err.conflict('病程已签署,不可重复签署')
    }
    throw err.internal(`签署病程失败: ${error.message}`)
  }

  return ok(c, data)
})

// ============================================================
// S3.1-并发任务C:出院结算(discharge settlement)(migration 48)
// ============================================================

/**
 * 生成结算单(S3.1-C)
 * - 权限:settlement.write
 * - 调 prepare_settlement RPC:汇总费用生成结算单(幂等)
 */
inpatientRoutes.post('/admissions/:id/settlement/prepare', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: admission, error: admErr } = await service
    .from('admissions')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (admErr || !admission) {
    throw err.notFound('住院记录不存在')
  }
  await requireScopedPermission(c, { code: 'settlement.write', tenantId: admission.tenant_id, storeId: admission.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('prepare_settlement', {
    p_admission_id: id,
    p_operator_id: user.id,
  })

  if (error) {
    if (error.message.includes('ADMISSION_NOT_FOUND')) {
      throw err.notFound('住院记录不存在')
    }
    if (error.message.includes('ADMISSION_NOT_ADMITTED')) {
      throw err.conflict('仅住院中的记录可生成结算单')
    }
    if (error.message.includes('SETTLEMENT_ALREADY_STARTED')) {
      throw err.conflict('该住院记录已进入结算流程,不可重复生成结算单')
    }
    throw err.internal(`生成结算单失败: ${error.message}`)
  }

  return ok(c, data)
})

const settleSchema = z.object({
  paidAmount: z.number().nonnegative('实收金额不能为负'),
  paymentMethod: z.enum(['cash', 'card', 'wechat', 'alipay', 'stored_value', 'other']).default('cash'),
})

/**
 * 收款结算(S3.1-C)
 * - 权限:settlement.write
 * - 调 settle_admission RPC:登记实收 + 状态 prepared → settled
 */
inpatientRoutes.post('/admissions/:id/settlement/settle', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, settleSchema)
  const service = createServiceClient()

  const { data: admission, error: admErr } = await service
    .from('admissions')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (admErr || !admission) {
    throw err.notFound('住院记录不存在')
  }
  await requireScopedPermission(c, { code: 'settlement.write', tenantId: admission.tenant_id, storeId: admission.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('settle_admission', {
    p_admission_id: id,
    p_paid_amount: input.paidAmount,
    p_payment_method: input.paymentMethod,
    p_operator_id: user.id,
  })

  if (error) {
    if (error.message.includes('ADMISSION_NOT_FOUND')) {
      throw err.notFound('住院记录不存在')
    }
    if (error.message.includes('SETTLEMENT_NOT_PREPARED')) {
      throw err.conflict('请先生成结算单再收款')
    }
    if (error.message.includes('PAID_EXCEEDS_PAYABLE')) {
      throw err.conflict('实收金额超过应付金额')
    }
    throw err.internal(`收款结算失败: ${error.message}`)
  }

  return ok(c, data)
})

const waiveSchema = z.object({
  amount: z.number().nonnegative('减免金额不能为负'),
  reason: z.string().max(500).optional(),
})

/**
 * 减免/挂账(S3.1-C)
 * - 权限:settlement.execute
 * - 调 waive_admission_charge RPC:减免金额 + 状态 → waived
 */
inpatientRoutes.post('/admissions/:id/settlement/waive', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, waiveSchema)
  const service = createServiceClient()

  const { data: admission, error: admErr } = await service
    .from('admissions')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (admErr || !admission) {
    throw err.notFound('住院记录不存在')
  }
  await requireScopedPermission(c, { code: 'settlement.execute', tenantId: admission.tenant_id, storeId: admission.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('waive_admission_charge', {
    p_admission_id: id,
    p_amount: input.amount,
    p_reason: input.reason ?? null,
    p_operator_id: user.id,
  })

  if (error) {
    if (error.message.includes('ADMISSION_NOT_FOUND')) {
      throw err.notFound('住院记录不存在')
    }
    if (error.message.includes('SETTLEMENT_NOT_WAIVABLE')) {
      throw err.conflict('仅已生成结算单的记录可减免')
    }
    if (error.message.includes('WAIVE_EXCEEDS_PAYABLE')) {
      throw err.conflict('减免金额超过可减免上限')
    }
    throw err.internal(`减免失败: ${error.message}`)
  }

  return ok(c, data)
})

/**
 * 完成结算并出院(S3.1-C)
 * - 权限:settlement.execute
 * - 调 finalize_settlement RPC:联动出院(释放笼位 + total_charge 同步)+ 状态 → finalized
 */
inpatientRoutes.post('/admissions/:id/settlement/finalize', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: admission, error: admErr } = await service
    .from('admissions')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (admErr || !admission) {
    throw err.notFound('住院记录不存在')
  }
  await requireScopedPermission(c, { code: 'settlement.execute', tenantId: admission.tenant_id, storeId: admission.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('finalize_settlement', {
    p_admission_id: id,
    p_operator_id: user.id,
  })

  if (error) {
    if (error.message.includes('ADMISSION_NOT_FOUND')) {
      throw err.notFound('住院记录不存在')
    }
    if (error.message.includes('SETTLEMENT_NOT_COMPLETED')) {
      throw err.conflict('仅已收款或已减免的结算可完成出院')
    }
    throw err.internal(`完成结算失败: ${error.message}`)
  }

  return ok(c, data)
})

export default inpatientRoutes
