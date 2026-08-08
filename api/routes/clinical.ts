import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import { getContext, loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * Clinical 诊疗核心领域路由(MXQ-7001~7011)
 *
 * 分层:
 *   - Query(list/detail):Hono 聚合查询 + 对应 *.view 权限
 *   - Command(create/update/transition/sign/revise/save_prescription):Hono 调 PostgreSQL RPC,禁止前端直连写
 *
 * 状态机:
 *   预约:pending→confirmed→checked_in→in_progress→completed;任意非终态→cancelled/no_show
 *   就诊:in_progress→completed→signed(终态,需修订)
 *   处方:draft→dispensed;draft→cancelled
 */
const clinicalRoutes = new Hono<AppEnv>()

clinicalRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

// ============================================================
// 预约 MXQ-7001 / MXQ-7002
// ============================================================

const appointmentListSchema = z.object({
  tenantId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  petId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  status: z.enum(['pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show']).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/**
 * 预约列表(MXQ-7001)
 * - 权限:appointment.view
 * - 支持 tenantId/storeId/doctorId/petId/customerId/status/日期范围筛选
 */
clinicalRoutes.get('/appointments', async (c) => {
  const input = appointmentListSchema.parse(c.req.query())
  // P0-02 scoped:租户作用域授权(tenantId 缺失时取调用者首个成员租户)
  const tenantId = input.tenantId ?? getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, { code: 'appointment.view', tenantId, storeId: input.storeId })

  const service = createServiceClient()
  let query = service
    .from('appointments')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.doctorId) {
    query = query.eq('doctor_id', input.doctorId)
  }
  if (input.petId) {
    query = query.eq('pet_id', input.petId)
  }
  if (input.customerId) {
    query = query.eq('customer_id', input.customerId)
  }
  if (input.status) {
    query = query.eq('status', input.status)
  }
  if (input.dateFrom) {
    query = query.gte('scheduled_start', input.dateFrom)
  }
  if (input.dateTo) {
    query = query.lte('scheduled_start', input.dateTo)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('scheduled_start', { ascending: true })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询预约列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

/**
 * 候诊队列(MXQ-7002)
 * - 权限:appointment.view
 * - 返回 status=checked_in 的预约,按 scheduled_start 排序
 */
clinicalRoutes.get('/appointments/waiting', async (c) => {
  const storeId = c.req.query('storeId')
  // P0-02 scoped:租户作用域授权(缺失时取调用者首个成员租户)
  const tenantId = getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  await requireScopedPermission(c, { code: 'appointment.view', tenantId, storeId: storeId || undefined })

  const service = createServiceClient()
  let query = service
    .from('appointments')
    .select('*')
    .eq('status', 'checked_in')
    .eq('tenant_id', tenantId)
    .order('scheduled_start', { ascending: true })

  if (storeId) {
    query = query.eq('store_id', storeId)
  }

  const { data, error } = await query

  if (error) {
    throw err.internal(`查询候诊队列失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [] })
})

const createAppointmentSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  customerId: z.string().uuid('客户 id 格式错误'),
  petId: z.string().uuid('宠物 id 格式错误'),
  doctorId: z.string().uuid().optional(),
  scheduledStart: z.string(),
  scheduledEnd: z.string(),
  reason: z.string().max(500).optional(),
  source: z.enum(['walk_in', 'phone', 'online']).optional(),
  remark: z.string().max(1000).optional(),
})

/**
 * 创建预约(MXQ-7001)
 * - 权限:appointment.manage
 * - 走 service client 写入(RLS 兜底),created_by 记录创建人
 * - 创建前校验租户归属 + 医生时段冲突(同门店/同医生/非终态/时间重叠)
 */
clinicalRoutes.post('/appointments', async (c) => {
  const input = await parseJsonBody(c, createAppointmentSchema)
  // P0-02 scoped:租户/门店作用域授权(替代 requirePermission + assertTenantAccess)
  const scope = await requireScopedPermission(c, { code: 'appointment.manage', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const user = c.get('user')

  // 医生时段冲突校验:同门店 + 同医生 + 非终态 + 时间区间重叠
  if (input.doctorId) {
    let conflictQuery = service
      .from('appointments')
      .select('id', { count: 'exact', head: true })
    conflictQuery = scope.storeId
      ? conflictQuery.eq('store_id', scope.storeId)
      : conflictQuery.is('store_id', null)
    const { count: conflictCount, error: conflictError } = await conflictQuery
      .eq('doctor_id', input.doctorId)
      .in('status', ['pending', 'confirmed', 'checked_in', 'arrived', 'in_progress'])
      .lt('scheduled_start', input.scheduledEnd)
      .gt('scheduled_end', input.scheduledStart)
    if (conflictError) {
      throw err.internal(`校验医生时段冲突失败: ${conflictError.message}`)
    }
    if (conflictCount && conflictCount > 0) {
      throw err.conflict('该医生在该时段已有预约')
    }
  }

  const { data, error } = await service
    .from('appointments')
    .insert({
      tenant_id: scope.tenantId,
      store_id: scope.storeId ?? null,
      customer_id: input.customerId,
      pet_id: input.petId,
      doctor_id: input.doctorId ?? null,
      scheduled_start: input.scheduledStart,
      scheduled_end: input.scheduledEnd,
      reason: input.reason ?? null,
      source: input.source ?? 'walk_in',
      remark: input.remark ?? null,
      created_by: user.id,
      status: 'pending',
    })
    .select('*')
    .single()

  if (error) {
    throw err.internal(`创建预约失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'appointment.create',
    entityType: 'appointment',
    entityId: data.id,
    tenantId: scope.tenantId,
    storeId: scope.storeId,
    metadata: { customerId: input.customerId, petId: input.petId },
  })

  return ok(c, data)
})

const updateAppointmentSchema = z.object({
  doctorId: z.string().uuid().optional().or(z.literal('')),
  scheduledStart: z.string().optional(),
  scheduledEnd: z.string().optional(),
  reason: z.string().max(500).optional(),
  source: z.enum(['walk_in', 'phone', 'online']).optional(),
  remark: z.string().max(1000).optional(),
})

/**
 * 更新预约(MXQ-7001)
 * - 权限:appointment.manage
 * - 仅非终态可编辑
 */
clinicalRoutes.patch('/appointments/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateAppointmentSchema)

  const service = createServiceClient()
  const { data: existing, error: fetchError } = await service
    .from('appointments')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('预约不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'appointment.manage', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  if (['completed', 'cancelled', 'no_show'].includes(existing.status)) {
    throw err.conflict('终态预约不可编辑')
  }

  const patch: Record<string, unknown> = {}
  if (input.doctorId !== undefined) {
    patch.doctor_id = input.doctorId || null
  }
  if (input.scheduledStart !== undefined) {
    patch.scheduled_start = input.scheduledStart
  }
  if (input.scheduledEnd !== undefined) {
    patch.scheduled_end = input.scheduledEnd
  }
  if (input.reason !== undefined) {
    patch.reason = input.reason
  }
  if (input.source !== undefined) {
    patch.source = input.source
  }
  if (input.remark !== undefined) {
    patch.remark = input.remark
  }

  const { data, error } = await service
    .from('appointments')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()

  if (error) {
    throw err.internal(`更新预约失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'appointment.update',
    entityType: 'appointment',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
    metadata: patch,
  })

  return ok(c, data)
})

const transitionAppointmentSchema = z.object({
  targetStatus: z.enum(['pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show']),
})

/**
 * 预约状态转换(MXQ-7010)
 * - 权限:appointment.manage
 * - 调 transition_appointment RPC,校验状态机合法性
 */
clinicalRoutes.post('/appointments/:id/transition', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, transitionAppointmentSchema)

  const service = createServiceClient()
  const user = c.get('user')

  const { data: existing, error: fetchError } = await service
    .from('appointments')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('预约不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'appointment.manage', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  const { data, error: rpcError } = await service.rpc('transition_appointment', {
    p_appointment_id: id,
    p_target_status: input.targetStatus,
    p_operator_id: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('APPOINTMENT_NOT_FOUND')) {
      throw err.notFound('预约不存在')
    }
    if (rpcError.message.includes('INVALID_APPOINTMENT_STATUS') || rpcError.message.includes('APPOINTMENT_INVALID_TRANSITION')) {
      throw err.conflict(`预约状态转换不合法: ${existing.status} → ${input.targetStatus}`)
    }
    throw err.internal(`预约状态转换失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'appointment.transition',
    entityType: 'appointment',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
    metadata: { from: existing.status, to: input.targetStatus },
  })

  return ok(c, data)
})

// ============================================================
// 就诊/病历 MXQ-7003 / MXQ-7005
// ============================================================

const encounterListSchema = z.object({
  tenantId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  petId: z.string().uuid().optional(),
  status: z.enum(['in_progress', 'completed', 'signed']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/**
 * 就诊列表(MXQ-7003)
 * - 权限:encounter.view
 */
clinicalRoutes.get('/encounters', async (c) => {
  const input = encounterListSchema.parse(c.req.query())
  // P0-02 scoped:租户作用域授权(tenantId 缺失时取调用者首个成员租户)
  const tenantId = input.tenantId ?? getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, { code: 'encounter.view', tenantId, storeId: input.storeId })

  const service = createServiceClient()
  let query = service
    .from('encounters')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.doctorId) {
    query = query.eq('doctor_id', input.doctorId)
  }
  if (input.petId) {
    query = query.eq('pet_id', input.petId)
  }
  if (input.status) {
    query = query.eq('status', input.status)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('started_at', { ascending: false })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询就诊列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

/**
 * 就诊详情(MXQ-7003 / MXQ-7005)
 * - 权限:encounter.view
 * - 返回病历 + 修订历史
 */
clinicalRoutes.get('/encounters/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const { data: encounter, error } = await service
    .from('encounters')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !encounter) {
    throw err.notFound('病历不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'encounter.view', tenantId: encounter.tenant_id, storeId: encounter.store_id ?? undefined })

  // 并行查询修订历史
  const { data: revisions, error: revError } = await service
    .from('encounter_revisions')
    .select('*')
    .eq('encounter_id', id)
    .order('revision_no', { ascending: true })

  if (revError) {
    throw err.internal(`查询修订历史失败: ${revError.message}`)
  }

  return ok(c, { encounter, revisions: revisions ?? [] })
})

const createEncounterSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  appointmentId: z.string().uuid().optional(),
  customerId: z.string().uuid('客户 id 格式错误'),
  petId: z.string().uuid('宠物 id 格式错误'),
  doctorId: z.string().uuid().optional(),
  nurseId: z.string().uuid().optional(),
  chiefComplaint: z.string().max(2000).optional(),
})

/**
 * 创建就诊(MXQ-7003)
 * - 权限:encounter.work
 * - 创建时 status=in_progress,关联预约若有则同步推进到 in_progress
 */
clinicalRoutes.post('/encounters', async (c) => {
  const input = await parseJsonBody(c, createEncounterSchema)
  // P0-02 scoped:租户/门店作用域授权(替代 requirePermission + assertTenantAccess)
  const scope = await requireScopedPermission(c, { code: 'encounter.work', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error } = await service
    .from('encounters')
    .insert({
      tenant_id: scope.tenantId,
      store_id: scope.storeId ?? null,
      appointment_id: input.appointmentId ?? null,
      customer_id: input.customerId,
      pet_id: input.petId,
      doctor_id: input.doctorId ?? user.id,
      nurse_id: input.nurseId ?? null,
      chief_complaint: input.chiefComplaint ?? null,
      status: 'in_progress',
    })
    .select('*')
    .single()

  if (error) {
    throw err.internal(`创建就诊失败: ${error.message}`)
  }

  // 若关联预约,同步推进预约到 in_progress
  if (input.appointmentId) {
    await service.rpc('transition_appointment', {
      p_appointment_id: input.appointmentId,
      p_target_status: 'in_progress',
      p_operator_id: user.id,
    }).then(({ error: rpcError }) => {
      // 状态不匹配(如已完成)不阻断就诊创建,仅记录
      if (rpcError && !rpcError.message.includes('APPOINTMENT_INVALID_TRANSITION')) {
        console.warn('[clinical] 同步预约状态失败', rpcError.message)
      }
    })
  }

  await writeAudit(c, {
    action: 'encounter.create',
    entityType: 'encounter',
    entityId: data.id,
    tenantId: scope.tenantId,
    storeId: scope.storeId,
    metadata: { customerId: input.customerId, petId: input.petId, appointmentId: input.appointmentId },
  })

  return ok(c, data)
})

const updateEncounterSchema = z.object({
  chiefComplaint: z.string().max(2000).optional(),
  historyPresent: z.string().max(5000).optional(),
  examFindings: z.string().max(5000).optional(),
  diagnosisCodes: z.array(z.string().max(100)).optional(),
  diagnosisText: z.string().max(2000).optional(),
  treatmentPlan: z.string().max(5000).optional(),
  followUpDate: z.string().date().optional(),
  nurseId: z.string().uuid().optional().or(z.literal('')),
  status: z.enum(['in_progress', 'completed']).optional(),
  /** 乐观锁版本号:提交当前 version,不匹配返回 409(防多窗口覆盖病历) */
  expectedVersion: z.number().int().positive().optional(),
})

/**
 * 更新病历(MXQ-7003)
 * - 权限:encounter.work
 * - 已签署(signed)病历不可直接修改,RLS 兜底 + 此处显式校验
 */
clinicalRoutes.patch('/encounters/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateEncounterSchema)

  const service = createServiceClient()
  const { data: existing, error: fetchError } = await service
    .from('encounters')
    .select('id, tenant_id, store_id, status, version')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('病历不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'encounter.work', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  if (existing.status === 'signed') {
    throw err.conflict('已签署病历不可直接修改,请使用修订功能')
  }

  const patch: Record<string, unknown> = {}
  if (input.chiefComplaint !== undefined) {
    patch.chief_complaint = input.chiefComplaint
  }
  if (input.historyPresent !== undefined) {
    patch.history_present = input.historyPresent
  }
  if (input.examFindings !== undefined) {
    patch.exam_findings = input.examFindings
  }
  if (input.diagnosisCodes !== undefined) {
    patch.diagnosis_codes = input.diagnosisCodes
  }
  if (input.diagnosisText !== undefined) {
    patch.diagnosis_text = input.diagnosisText
  }
  if (input.treatmentPlan !== undefined) {
    patch.treatment_plan = input.treatmentPlan
  }
  if (input.followUpDate !== undefined) {
    patch.follow_up_date = input.followUpDate
  }
  if (input.nurseId !== undefined) {
    patch.nurse_id = input.nurseId || null
  }
  if (input.status !== undefined) {
    // 状态机:仅允许 in_progress→completed;signed 为终态不可经此修改(zod 已限制,此处为防御)
    patch.status = input.status
    if (patch.status === 'signed') {
      throw err.conflict('病历状态不可直接改为已签署,请使用签署功能')
    }
    if (existing.status === 'completed' && patch.status === 'in_progress') {
      throw err.conflict('已完成的病历不可回退到进行中')
    }
    if (patch.status === 'completed') {
      patch.ended_at = new Date().toISOString()
    }
  }

  // 乐观锁:携带 expectedVersion 时按版本条件更新,不匹配(0 行)返回 409
  if (input.expectedVersion !== undefined) {
    patch.version = existing.version + 1
  }

  let query = service.from('encounters').update(patch).eq('id', id)
  if (input.expectedVersion !== undefined) {
    query = query.eq('version', input.expectedVersion)
  }
  const { data: rows, error } = await query.select('*')

  if (error) {
    throw err.internal(`更新病历失败: ${error.message}`)
  }
  if (input.expectedVersion !== undefined && (!rows || rows.length === 0)) {
    throw err.conflict('病历已被其他窗口修改,请刷新后重试')
  }
  const data = rows?.[0]

  await writeAudit(c, {
    action: 'encounter.update',
    entityType: 'encounter',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
    metadata: patch,
  })

  return ok(c, data)
})

const signEncounterSchema = z.object({
  doctorId: z.string().uuid('医生 id 格式错误').optional(),
})

/**
 * 签署病历(MXQ-7005)
 * - 权限:encounter.sign
 * - 调 sign_encounter RPC:校验主治医生 + 状态 + 原子写入签名与审计
 * - doctorId 未传时默认当前登录用户;强制签署人=主治医生本人(防代签)
 */
clinicalRoutes.post('/encounters/:id/sign', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, signEncounterSchema)

  const service = createServiceClient()
  const user = c.get('user')
  const doctorId = input.doctorId ?? user.id
  if (doctorId !== user.id) {
    throw err.forbidden('仅可签署本人负责的病历')
  }

  // P0-02 scoped:先查实体获得租户/门店作用域
  const { data: existing, error: fetchError } = await service
    .from('encounters')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (fetchError || !existing) {
    throw err.notFound('病历不存在')
  }
  await requireScopedPermission(c, { code: 'encounter.sign', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  const { data, error: rpcError } = await service.rpc('sign_encounter', {
    p_encounter_id: id,
    p_doctor_id: doctorId,
  })

  if (rpcError) {
    if (rpcError.message.includes('ENCOUNTER_NOT_FOUND')) {
      throw err.notFound('病历不存在')
    }
    if (rpcError.message.includes('ENCOUNTER_NOT_OWNER')) {
      throw err.forbidden('仅主治医生可签署病历')
    }
    if (rpcError.message.includes('ENCOUNTER_NOT_SIGNABLE')) {
      throw err.conflict('当前状态不可签署')
    }
    throw err.internal(`签署病历失败: ${rpcError.message}`)
  }

  return ok(c, data)
})

const reviseEncounterSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  reason: z.string().min(1, '修订原因不能为空').max(500),
})

/**
 * 修订病历(MXQ-7005)
 * - 权限:encounter.revise
 * - 调 revise_encounter RPC:校验已签署 + 创建修订版本(原文保留)
 */
clinicalRoutes.post('/encounters/:id/revise', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, reviseEncounterSchema)

  const service = createServiceClient()
  const user = c.get('user')

  // P0-02 scoped:先查实体获得租户/门店作用域
  const { data: existing, error: fetchError } = await service
    .from('encounters')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (fetchError || !existing) {
    throw err.notFound('病历不存在')
  }
  await requireScopedPermission(c, { code: 'encounter.revise', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  const { data, error: rpcError } = await service.rpc('revise_encounter', {
    p_encounter_id: id,
    p_content: input.content,
    p_reason: input.reason,
    p_operator_id: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('ENCOUNTER_NOT_FOUND')) {
      throw err.notFound('病历不存在')
    }
    if (rpcError.message.includes('ENCOUNTER_NOT_SIGNED')) {
      throw err.conflict('仅已签署病历可修订')
    }
    throw err.internal(`修订病历失败: ${rpcError.message}`)
  }

  return ok(c, data)
})

// ============================================================
// 处方 MXQ-7006
// ============================================================

/**
 * 处方列表(MXQ-7006)
 * - 权限:prescription.view
 */
clinicalRoutes.get('/prescriptions', async (c) => {
  const tenantIdParam = c.req.query('tenantId')
  const encounterId = c.req.query('encounterId')
  const storeId = c.req.query('storeId')
  const petId = c.req.query('petId')
  const status = c.req.query('status')
  // P0-02 scoped:租户作用域授权(tenantId 缺失时取调用者首个成员租户)
  const tenantId = tenantIdParam ?? getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, { code: 'prescription.view', tenantId, storeId: storeId || undefined })

  const service = createServiceClient()
  let query = service
    .from('prescriptions')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (encounterId) {
    query = query.eq('encounter_id', encounterId)
  }
  if (storeId) {
    query = query.eq('store_id', storeId)
  }
  if (petId) {
    query = query.eq('pet_id', petId)
  }
  if (status) {
    query = query.eq('status', status)
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })

  if (error) {
    throw err.internal(`查询处方列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0 })
})

/**
 * 处方详情(含明细)(MXQ-7006)
 * - 权限:prescription.view
 */
clinicalRoutes.get('/prescriptions/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const { data: prescription, error } = await service
    .from('prescriptions')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !prescription) {
    throw err.notFound('处方不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'prescription.view', tenantId: prescription.tenant_id, storeId: prescription.store_id ?? undefined })

  const { data: items, error: itemsError } = await service
    .from('prescription_items')
    .select('*')
    .eq('prescription_id', id)
    .order('sort_order', { ascending: true })

  if (itemsError) {
    throw err.internal(`查询处方明细失败: ${itemsError.message}`)
  }

  return ok(c, { prescription, items: items ?? [] })
})

const prescriptionItemSchema = z.object({
  catalogItemId: z.string().uuid().optional().or(z.literal('')),
  drugName: z.string().min(1, '药品名称不能为空').max(200),
  dosage: z.string().max(200).optional(),
  frequency: z.string().max(200).optional(),
  durationDays: z.number().int().nonnegative().optional(),
  quantity: z.number().nonnegative().optional(),
  unit: z.string().max(50).optional(),
  instructions: z.string().max(1000).optional(),
  sortOrder: z.number().int().optional(),
})

const savePrescriptionSchema = z.object({
  encounterId: z.string().uuid('就诊 id 格式错误'),
  items: z.array(prescriptionItemSchema).min(1, '处方明细不能为空').max(100),
})

/**
 * 保存处方(MXQ-7006)
 * - 权限:prescription.create
 * - 调 save_prescription RPC:事务化创建/更新处方 + 明细
 */
clinicalRoutes.post('/prescriptions/save', async (c) => {
  const input = await parseJsonBody(c, savePrescriptionSchema)

  const service = createServiceClient()
  const user = c.get('user')

  // 先取就诊做门店范围校验
  const { data: encounter, error: fetchError } = await service
    .from('encounters')
    .select('id, tenant_id, store_id')
    .eq('id', input.encounterId)
    .maybeSingle()

  if (fetchError || !encounter) {
    throw err.notFound('就诊不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'prescription.create', tenantId: encounter.tenant_id, storeId: encounter.store_id ?? undefined })

  // 组装明细 JSON(RPC 入参)
  const itemsJson = input.items.map((item, idx) => ({
    catalog_item_id: item.catalogItemId || '',
    drug_name: item.drugName,
    dosage: item.dosage ?? '',
    frequency: item.frequency ?? '',
    duration_days: item.durationDays != null ? String(item.durationDays) : '',
    quantity: item.quantity != null ? String(item.quantity) : '',
    unit: item.unit ?? '',
    instructions: item.instructions ?? '',
    sort_order: String(item.sortOrder ?? idx),
  }))

  const { data, error: rpcError } = await service.rpc('save_prescription', {
    p_encounter_id: input.encounterId,
    p_items_json: itemsJson,
    p_doctor_id: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('ENCOUNTER_NOT_FOUND')) {
      throw err.notFound('就诊不存在')
    }
    throw err.internal(`保存处方失败: ${rpcError.message}`)
  }

  return ok(c, data)
})

// ============================================================
// 处方发药/取消的库存联动(P0-08 统一发药路径)
// ============================================================

/**
 * 查询处方关联的未处理预留流水(reserve 未被 confirm/release 引用)
 * @param service supabase service client
 * @param tenantId 租户 id
 * @param prescriptionId 处方 id
 * @returns 未处理 reserve 流水列表
 */
async function findPendingPrescriptionReservations(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  prescriptionId: string,
) {
  const { data: reserves, error: rErr } = await service
    .from('inventory_movements')
    .select('id, warehouse_id, catalog_item_id, quantity')
    .eq('tenant_id', tenantId)
    .eq('movement_type', 'reserve')
    .eq('reference_type', 'prescription')
    .eq('reference_id', prescriptionId)
  if (rErr) {
    throw err.internal(`查询处方预留失败: ${rErr.message}`)
  }
  const reserveIds = (reserves ?? []).map(r => r.id)
  if (reserveIds.length === 0) {
    return reserves ?? []
  }
  // 已被 confirm/release 处理的预留(id 集合)
  const { data: processed } = await service
    .from('inventory_movements')
    .select('reference_id')
    .eq('reference_type', 'inventory_reservation')
    .in('movement_type', ['confirm', 'release'])
    .in('reference_id', reserveIds)
  const processedIds = new Set((processed ?? []).map(p => p.reference_id as string))
  return (reserves ?? []).filter(r => !processedIds.has(r.id))
}

/**
 * 释放处方预留(取消处方时调用,防止库存永久占用)
 * @param service supabase service client
 * @param tenantId 租户 id
 * @param prescriptionId 处方 id
 * @param operatorId 操作人 id
 * @returns 释放条数
 */
async function releasePrescriptionReservations(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  prescriptionId: string,
  operatorId: string,
) {
  const pending = await findPendingPrescriptionReservations(service, tenantId, prescriptionId)
  for (const rsv of pending) {
    const { error: relErr } = await service.rpc('release_inventory_reservation', {
      p_tenant_id: tenantId,
      p_reservation_id: rsv.id,
      p_operator_id: operatorId,
    })
    if (relErr && !relErr.message.includes('RESERVATION_ALREADY')) {
      throw err.internal(`释放预留失败: ${relErr.message}`)
    }
  }
  return pending.length
}

/**
 * 发药(MXQ-7006,审计反馈 R05 重写)
 * - 权限:prescription.dispense
 * - R05:发药 = 处方校验 + 库存扣减 + 状态变更 + 审计,全部收敛到
 *   dispense_prescription 单个 PostgreSQL 事务(plpgsql)内原子提交/回滚;
 *   Hono 层不再串联多个独立 RPC(旧两步编排:先扣库存再转状态,非原子且会重复扣减)。
 * - R04:仅 issued 处方可发药,draft 必须先开具(PRESCRIPTION_NOT_DISPENSABLE)
 */
clinicalRoutes.post('/prescriptions/:id/dispense', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const user = c.get('user')

  const { data: existing, error: fetchError } = await service
    .from('prescriptions')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('处方不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'prescription.dispense', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  // R05:单事务 RPC(校验 issued/未过期 → 逐项扣减库存(预留确认或即时 FEFO) → 状态 issued→dispensed → 审计)
  const { data, error: rpcError } = await service.rpc('dispense_prescription', {
    p_prescription_id: id,
    p_operator_id: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('PRESCRIPTION_NOT_FOUND')) {
      throw err.notFound('处方不存在')
    }
    if (rpcError.message.includes('PRESCRIPTION_NOT_DISPENSABLE')) {
      throw err.conflict('仅已开具(issued)处方可发药,草稿处方请先开具')
    }
    if (rpcError.message.includes('PRESCRIPTION_EXPIRED')) {
      throw err.conflict('处方已过期,禁止发药')
    }
    if (rpcError.message.includes('DISPENSE_WAREHOUSE_NOT_FOUND')) {
      throw err.conflict('该租户/门店下无可用仓库,无法发药')
    }
    if (rpcError.message.includes('INSUFFICIENT_STOCK')) {
      throw err.conflict('发药库存不足')
    }
    throw err.internal(`发药失败: ${rpcError.message}`)
  }

  return ok(c, data)
})

/**
 * 取消处方(MXQ-7006)
 * - 权限:prescription.create
 * - P0-08:取消前先释放关联预留(reserved 正确释放),再 draft→cancelled
 */
clinicalRoutes.post('/prescriptions/:id/cancel', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const user = c.get('user')
  const { data: existing, error: fetchError } = await service
    .from('prescriptions')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('处方不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'prescription.create', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  if (existing.status !== 'draft') {
    throw err.conflict('仅待发药处方可取消')
  }

  // P0-08:释放处方关联预留,防止库存永久占用
  await releasePrescriptionReservations(service, existing.tenant_id, id, user.id)

  const { data, error } = await service
    .from('prescriptions')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .select('*')
    .single()

  if (error) {
    throw err.internal(`取消处方失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'prescription.cancel',
    entityType: 'prescription',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
  })

  return ok(c, data)
})

// ============================================================
// 护士任务 MXQ-7007
// ============================================================

const nurseTaskListSchema = z.object({
  tenantId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  petId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'skipped', 'completed', 'failed', 'cancelled']).optional(),
  taskType: z.enum(['medication', 'observation', 'care', 'sample_collection', 'other']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/**
 * 护士任务列表(MXQ-7007)
 * - 权限:nurse_task.view
 */
clinicalRoutes.get('/nurse-tasks', async (c) => {
  const input = nurseTaskListSchema.parse(c.req.query())
  // P0-02 scoped:租户作用域授权(tenantId 缺失时取调用者首个成员租户)
  const tenantId = input.tenantId ?? getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, { code: 'nurse_task.view', tenantId, storeId: input.storeId })

  const service = createServiceClient()
  let query = service
    .from('nurse_tasks')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.assigneeId) {
    query = query.eq('assigned_to', input.assigneeId)
  }
  if (input.petId) {
    query = query.eq('pet_id', input.petId)
  }
  if (input.encounterId) {
    query = query.eq('encounter_id', input.encounterId)
  }
  if (input.status) {
    query = query.eq('status', input.status)
  }
  if (input.taskType) {
    query = query.eq('task_type', input.taskType)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询护士任务列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

const createNurseTaskSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  petId: z.string().uuid('宠物 id 格式错误'),
  assignedTo: z.string().uuid().optional().or(z.literal('')),
  taskType: z.enum(['medication', 'observation', 'care', 'sample_collection', 'other']).optional(),
  description: z.string().min(1, '任务描述不能为空').max(1000),
  scheduledAt: z.string().optional(),
})

/**
 * 创建护士任务(MXQ-7007)
 * - 权限:nurse_task.manage
 */
clinicalRoutes.post('/nurse-tasks', async (c) => {
  const input = await parseJsonBody(c, createNurseTaskSchema)
  // P0-02 scoped:租户/门店作用域授权(替代 requirePermission + assertTenantAccess)
  const scope = await requireScopedPermission(c, { code: 'nurse_task.manage', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const { data, error } = await service
    .from('nurse_tasks')
    .insert({
      tenant_id: scope.tenantId,
      store_id: scope.storeId ?? null,
      encounter_id: input.encounterId ?? null,
      pet_id: input.petId,
      assigned_to: input.assignedTo || null,
      task_type: input.taskType ?? 'other',
      description: input.description,
      scheduled_at: input.scheduledAt ?? null,
      status: 'pending',
    })
    .select('*')
    .single()

  if (error) {
    throw err.internal(`创建护士任务失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'nurse_task.create',
    entityType: 'nurse_task',
    entityId: data.id,
    tenantId: scope.tenantId,
    storeId: scope.storeId,
    metadata: { petId: input.petId, taskType: input.taskType },
  })

  return ok(c, data)
})

const updateNurseTaskSchema = z.object({
  assignedTo: z.string().uuid().optional().or(z.literal('')),
  taskType: z.enum(['medication', 'observation', 'care', 'sample_collection', 'other']).optional(),
  description: z.string().max(1000).optional(),
  scheduledAt: z.string().optional().or(z.literal('')),
  status: z.enum(['pending', 'in_progress', 'done', 'skipped']).optional(),
  note: z.string().max(1000).optional(),
})

/**
 * 更新护士任务(MXQ-7007)
 * - 权限:nurse_task.manage
 * - 完成(status=done)时自动填充 completed_at/completed_by
 */
clinicalRoutes.patch('/nurse-tasks/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateNurseTaskSchema)

  const service = createServiceClient()
  const user = c.get('user')
  const { data: existing, error: fetchError } = await service
    .from('nurse_tasks')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('护士任务不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'nurse_task.manage', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  const patch: Record<string, unknown> = {}
  if (input.assignedTo !== undefined) {
    patch.assigned_to = input.assignedTo || null
  }
  if (input.taskType !== undefined) {
    patch.task_type = input.taskType
  }
  if (input.description !== undefined) {
    patch.description = input.description
  }
  if (input.scheduledAt !== undefined) {
    patch.scheduled_at = input.scheduledAt || null
  }
  if (input.note !== undefined) {
    patch.note = input.note
  }
  if (input.status !== undefined) {
    patch.status = input.status
    if (input.status === 'done') {
      patch.completed_at = new Date().toISOString()
      patch.completed_by = user.id
    }
  }

  const { data, error } = await service
    .from('nurse_tasks')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()

  if (error) {
    throw err.internal(`更新护士任务失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'nurse_task.update',
    entityType: 'nurse_task',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
    metadata: patch,
  })

  return ok(c, data)
})

/**
 * 删除护士任务(MXQ-7007)
 * - 权限:nurse_task.manage
 */
clinicalRoutes.delete('/nurse-tasks/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const { data: existing, error: fetchError } = await service
    .from('nurse_tasks')
    .select('id, tenant_id, store_id')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('护士任务不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'nurse_task.manage', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  const { error } = await service
    .from('nurse_tasks')
    .delete()
    .eq('id', id)

  if (error) {
    throw err.internal(`删除护士任务失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'nurse_task.delete',
    entityType: 'nurse_task',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
  })

  return ok(c, { deleted: true })
})

// ============================================================
// S3.1-并发任务C:医嘱(medical_orders)闭环(migration 44)
// ============================================================

const medicalOrderListSchema = z.object({
  tenantId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  petId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  admissionId: z.string().uuid().optional(),
  status: z.enum(['active', 'completed', 'cancelled', 'expired']).optional(),
  orderType: z.enum(['injection', 'infusion', 'treatment', 'disposal', 'nursing', 'medication', 'other']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/**
 * 医嘱列表(S3.1-C)
 * - 权限:nurse_task.view(与医疗闭环共用护士任务读权限)
 */
clinicalRoutes.get('/medical-orders', async (c) => {
  const input = medicalOrderListSchema.parse(c.req.query())
  const tenantId = input.tenantId ?? getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, { code: 'nurse_task.view', tenantId, storeId: input.storeId })

  const service = createServiceClient()
  let query = service
    .from('medical_orders')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.petId) {
    query = query.eq('pet_id', input.petId)
  }
  if (input.encounterId) {
    query = query.eq('encounter_id', input.encounterId)
  }
  if (input.admissionId) {
    query = query.eq('admission_id', input.admissionId)
  }
  if (input.status) {
    query = query.eq('status', input.status)
  }
  if (input.orderType) {
    query = query.eq('order_type', input.orderType)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询医嘱列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

/**
 * 医嘱详情(含关联护士任务与检验申请)(S3.1-C)
 * - 权限:nurse_task.view
 */
clinicalRoutes.get('/medical-orders/:id', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: order, error } = await service
    .from('medical_orders')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !order) {
    throw err.notFound('医嘱不存在')
  }
  // P0-02 scoped:实体租户/门店作用域授权
  await requireScopedPermission(c, { code: 'nurse_task.view', tenantId: order.tenant_id, storeId: order.store_id ?? undefined })

  // 关联护士任务
  const { data: tasks, error: taskErr } = await service
    .from('nurse_tasks')
    .select('*')
    .eq('source_type', 'medical_order')
    .eq('source_id', id)
    .order('created_at', { ascending: true })
  if (taskErr) {
    throw err.internal(`查询医嘱关联任务失败: ${taskErr.message}`)
  }

  // 关联检验申请
  const { data: labRefs, error: refErr } = await service
    .from('medical_lab_refs')
    .select('*, lab_orders(*)')
    .eq('medical_order_id', id)
  if (refErr) {
    throw err.internal(`查询医嘱关联检验失败: ${refErr.message}`)
  }

  return ok(c, { order, tasks: tasks ?? [], labRefs: labRefs ?? [] })
})

const createMedicalOrderSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  petId: z.string().uuid('宠物 id 格式错误'),
  customerId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  admissionId: z.string().uuid().optional(),
  orderType: z.enum(['injection', 'infusion', 'treatment', 'disposal', 'nursing', 'medication', 'other']).default('treatment'),
  itemName: z.string().min(1, '医嘱项目不能为空').max(200),
  dosage: z.string().max(200).optional(),
  frequency: z.string().max(50).optional(),
  quantity: z.number().nonnegative().optional(),
  unit: z.string().max(50).optional(),
  instructions: z.string().max(1000).optional(),
  scheduledAt: z.string().optional(),
  assigneeId: z.string().uuid().optional(),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 开立医嘱(S3.1-C,自动生成护士任务)
 * - 权限:nurse_task.manage
 * - 调 create_medical_order RPC:单事务创建医嘱 + 护士任务 + 幂等 + 审计
 */
clinicalRoutes.post('/medical-orders', async (c) => {
  const input = await parseJsonBody(c, createMedicalOrderSchema)
  // P0-02 scoped:租户/门店作用域授权
  const scope = await requireScopedPermission(c, { code: 'nurse_task.manage', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error } = await service.rpc('create_medical_order', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_pet_id: input.petId,
    p_customer_id: input.customerId ?? null,
    p_encounter_id: input.encounterId ?? null,
    p_admission_id: input.admissionId ?? null,
    p_order_type: input.orderType,
    p_item_name: input.itemName,
    p_dosage: input.dosage ?? null,
    p_frequency: input.frequency ?? null,
    p_quantity: input.quantity ?? 1,
    p_unit: input.unit ?? null,
    p_instructions: input.instructions ?? null,
    p_scheduled_at: input.scheduledAt ?? null,
    p_assignee_id: input.assigneeId ?? null,
    p_operator_id: user.id,
    p_idempotency_key: input.idempotencyKey ?? null,
  })

  if (error) {
    if (error.message.includes('INVALID_ORDER_TYPE')) {
      throw err.badRequest('医嘱类型无效')
    }
    throw err.internal(`开立医嘱失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'medical_order.create',
    entityType: 'medical_order',
    entityId: (data as { orderId?: string })?.orderId,
    tenantId: scope.tenantId,
    storeId: scope.storeId,
    metadata: { petId: input.petId, orderType: input.orderType, itemName: input.itemName, encounterId: input.encounterId },
  })

  return ok(c, data)
})

const cancelMedicalOrderSchema = z.object({
  reason: z.string().max(500).optional(),
})

/**
 * 取消医嘱(S3.1-C)
 * - 权限:nurse_task.manage
 * - 调 cancel_medical_order RPC:未执行任务 → cancelled,已执行任务永久保留
 */
clinicalRoutes.post('/medical-orders/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, cancelMedicalOrderSchema)
  const service = createServiceClient()

  const { data: existing, error: fetchError } = await service
    .from('medical_orders')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (fetchError || !existing) {
    throw err.notFound('医嘱不存在')
  }
  await requireScopedPermission(c, { code: 'nurse_task.manage', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('cancel_medical_order', {
    p_order_id: id,
    p_operator_id: user.id,
    p_reason: input.reason ?? null,
  })

  if (error) {
    if (error.message.includes('MEDICAL_ORDER_NOT_FOUND')) {
      throw err.notFound('医嘱不存在')
    }
    if (error.message.includes('MEDICAL_ORDER_NOT_ACTIVE')) {
      throw err.conflict('仅进行中医嘱可取消')
    }
    throw err.internal(`取消医嘱失败: ${error.message}`)
  }

  return ok(c, data)
})

const linkLabRefSchema = z.object({
  labOrderId: z.string().uuid('检验申请 id 格式错误'),
  linkType: z.enum(['order_request', 'result_followup']).default('order_request'),
})

/**
 * 医嘱关联检验申请(S3.1-C)
 * - 权限:nurse_task.manage
 * - 调 link_medical_lab_ref RPC:校验同租户 + 幂等关联
 */
clinicalRoutes.post('/medical-orders/:id/link-lab', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, linkLabRefSchema)
  const service = createServiceClient()

  const { data: existing, error: fetchError } = await service
    .from('medical_orders')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (fetchError || !existing) {
    throw err.notFound('医嘱不存在')
  }
  await requireScopedPermission(c, { code: 'nurse_task.manage', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('link_medical_lab_ref', {
    p_medical_order_id: id,
    p_lab_order_id: input.labOrderId,
    p_link_type: input.linkType,
    p_operator_id: user.id,
  })

  if (error) {
    if (error.message.includes('MEDICAL_ORDER_NOT_FOUND')) {
      throw err.notFound('医嘱不存在')
    }
    if (error.message.includes('LAB_ORDER_NOT_FOUND')) {
      throw err.notFound('检验申请不存在')
    }
    if (error.message.includes('CROSS_TENANT_REF')) {
      throw err.forbidden('医嘱与检验申请不属于同一租户')
    }
    throw err.internal(`关联检验失败: ${error.message}`)
  }

  return ok(c, data)
})

// ============================================================
// S3.1-并发任务C:护士任务命令增强(complete/cancel/fail/scan)
// ============================================================

const completeNurseTaskSchema = z.object({
  note: z.string().max(1000).optional(),
})

/**
 * 完成任务(S3.1-C)
 * - 权限:nurse_task.manage
 * - 调 complete_nurse_task RPC:校验状态 + 联动医嘱 completed + 审计
 */
clinicalRoutes.post('/nurse-tasks/:id/complete', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, completeNurseTaskSchema)
  const service = createServiceClient()

  const { data: existing, error: fetchError } = await service
    .from('nurse_tasks')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (fetchError || !existing) {
    throw err.notFound('护士任务不存在')
  }
  await requireScopedPermission(c, { code: 'nurse_task.manage', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('complete_nurse_task', {
    p_task_id: id,
    p_operator_id: user.id,
    p_note: input.note ?? null,
  })

  if (error) {
    if (error.message.includes('NURSE_TASK_NOT_FOUND')) {
      throw err.notFound('护士任务不存在')
    }
    if (error.message.includes('NURSE_TASK_NOT_RUNNABLE')) {
      throw err.conflict('仅待处理/进行中任务可完成')
    }
    throw err.internal(`完成任务失败: ${error.message}`)
  }

  return ok(c, data)
})

const cancelNurseTaskSchema = z.object({
  reason: z.string().max(500).optional(),
})

/**
 * 取消任务(S3.1-C)
 * - 权限:nurse_task.manage
 * - 调 cancel_nurse_task RPC:仅未执行任务可取消,已执行任务永久保留
 */
clinicalRoutes.post('/nurse-tasks/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, cancelNurseTaskSchema)
  const service = createServiceClient()

  const { data: existing, error: fetchError } = await service
    .from('nurse_tasks')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (fetchError || !existing) {
    throw err.notFound('护士任务不存在')
  }
  await requireScopedPermission(c, { code: 'nurse_task.manage', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('cancel_nurse_task', {
    p_task_id: id,
    p_operator_id: user.id,
    p_reason: input.reason ?? null,
  })

  if (error) {
    if (error.message.includes('NURSE_TASK_NOT_FOUND')) {
      throw err.notFound('护士任务不存在')
    }
    if (error.message.includes('NURSE_TASK_ALREADY_EXECUTED')) {
      throw err.conflict('已执行任务不可取消(永久保留)')
    }
    throw err.internal(`取消任务失败: ${error.message}`)
  }

  return ok(c, data)
})

const failNurseTaskSchema = z.object({
  reason: z.string().min(1, '失败原因不能为空').max(500),
})

/**
 * 标记任务失败(S3.1-C)
 * - 权限:nurse_task.manage
 * - 调 fail_nurse_task RPC:仅未执行任务可标记失败,须填写原因
 */
clinicalRoutes.post('/nurse-tasks/:id/fail', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, failNurseTaskSchema)
  const service = createServiceClient()

  const { data: existing, error: fetchError } = await service
    .from('nurse_tasks')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()
  if (fetchError || !existing) {
    throw err.notFound('护士任务不存在')
  }
  await requireScopedPermission(c, { code: 'nurse_task.manage', tenantId: existing.tenant_id, storeId: existing.store_id ?? undefined })

  const user = c.get('user')
  const { data, error } = await service.rpc('fail_nurse_task', {
    p_task_id: id,
    p_reason: input.reason,
    p_operator_id: user.id,
  })

  if (error) {
    if (error.message.includes('NURSE_TASK_NOT_FOUND')) {
      throw err.notFound('护士任务不存在')
    }
    if (error.message.includes('NURSE_TASK_NOT_RUNNABLE')) {
      throw err.conflict('仅待处理/进行中任务可标记失败')
    }
    if (error.message.includes('FAIL_REASON_REQUIRED')) {
      throw err.badRequest('失败原因不能为空')
    }
    throw err.internal(`标记任务失败失败: ${error.message}`)
  }

  return ok(c, data)
})

const scanOverdueSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  dueSoonMinutes: z.number().int().positive().max(1440).default(120),
})

/**
 * 护士任务超时/即将到期扫描(S3.1-C)
 * - 权限:nurse_task.manage
 * - 调 scan_nurse_task_overdue RPC:批量标记 overdue/due_soon(幂等)
 */
clinicalRoutes.post('/nurse-tasks/scan-overdue', async (c) => {
  const input = await parseJsonBody(c, scanOverdueSchema)
  const scope = await requireScopedPermission(c, { code: 'nurse_task.manage', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const { data, error } = await service.rpc('scan_nurse_task_overdue', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_due_soon_minutes: input.dueSoonMinutes,
  })

  if (error) {
    throw err.internal(`扫描超时任务失败: ${error.message}`)
  }

  return ok(c, data)
})

export default clinicalRoutes
