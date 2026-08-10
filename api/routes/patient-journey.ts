/* eslint-disable style/max-statements-per-line -- 守卫语句保持状态机命令紧凑可读 */
import type { Context } from 'hono'
import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { err } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import { requireScopedPermission } from '../lib/permission.js'
import { getContext, loadContext, resolveRequestedStore, resolveRequestedTenant } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

const patientJourneyRoutes = new Hono<AppEnv>()

patientJourneyRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const roleSchema = z.enum([
  'frontdesk',
  'triage',
  'doctor',
  'nurse',
  'lab',
  'imaging',
  'cashier',
  'pharmacy',
  'followup',
  'manager',
])

const rolePermissions: Record<z.infer<typeof roleSchema>, string[]> = {
  frontdesk: ['workbench.frontdesk', 'queue.manage'],
  triage: ['workbench.triage', 'triage.write'],
  doctor: ['workbench.doctor', 'encounter.work'],
  nurse: ['workbench.nurse', 'nurse_task.view'],
  lab: ['workbench.lab', 'lab.view'],
  imaging: ['workbench.imaging', 'imaging.view'],
  cashier: ['workbench.cashier', 'invoice.create'],
  pharmacy: ['workbench.pharmacy', 'prescription.dispense'],
  followup: ['workbench.followup', 'followup.view'],
  manager: ['workbench.manager', 'journey.audit', 'store.manage'],
}

const workbenchQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  storeId: z.string().uuid(),
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
})

const actorSchema = z.object({
  actorRole: z.string().min(1).max(80),
  sourceWorkbench: z.string().min(1).max(80),
  idempotencyKey: z.string().min(8).max(200).optional(),
})

function idem(c: Context<AppEnv>, bodyKey?: string): string {
  return getRequestIdempotencyKey(c) || bodyKey || crypto.randomUUID()
}

function mapJourneyRpcError(error: { message: string }) {
  const message = error.message.replace(/^ERROR:\s*/, '')
  if (message.includes('NOT_FOUND')) { return err.notFound(message) }
  if (message.includes('REQUIRED') || message.includes('FORBIDDEN')) { return err.forbidden(message) }
  if (message.includes('INVALID') || message.includes('ONLY_') || message.includes('HAS_') || message.includes('ALREADY_')) {
    return err.unprocessable(message)
  }
  return err.internal(`患者旅程操作失败: ${message}`)
}

async function enrichPeople(
  service: ReturnType<typeof createServiceClient>,
  rows: Array<Record<string, any>>,
) {
  const customerIds = [...new Set(rows.map(row => row.customer_id).filter(Boolean))]
  const petIds = [...new Set(rows.map(row => row.pet_id).filter(Boolean))]
  const employeeIds = [...new Set(rows.flatMap(row => [row.assignee_employee_id, row.last_operator_employee_id]).filter(Boolean))]
  const [customers, pets, employees] = await Promise.all([
    customerIds.length ? service.from('customers').select('id,name,phone').in('id', customerIds) : Promise.resolve({ data: [] }),
    petIds.length ? service.from('pets').select('id,name,species,breed').in('id', petIds) : Promise.resolve({ data: [] }),
    employeeIds.length ? service.from('employees').select('id,name,employee_no').in('id', employeeIds) : Promise.resolve({ data: [] }),
  ])
  const customerMap = new Map((customers.data ?? []).map((item: any) => [item.id, item]))
  const petMap = new Map((pets.data ?? []).map((item: any) => [item.id, item]))
  const employeeMap = new Map((employees.data ?? []).map((item: any) => [item.id, item]))
  return rows.map(row => ({
    ...row,
    customer: customerMap.get(row.customer_id) ?? null,
    pet: petMap.get(row.pet_id) ?? null,
    assignee: employeeMap.get(row.assignee_employee_id) ?? null,
    lastOperator: employeeMap.get(row.last_operator_employee_id) ?? null,
  })) as Array<Record<string, any>>
}

function taskRole(role: z.infer<typeof roleSchema>): string {
  return role === 'frontdesk'
    ? 'receptionist'
    : role === 'triage'
      ? 'triage_nurse'
      : role === 'nurse'
        ? 'nurse'
        : role === 'pharmacy'
          ? 'pharmacist'
          : role === 'lab'
            ? 'lab_technician'
            : role === 'imaging'
              ? 'imaging_technician'
              : role === 'followup'
                ? 'followup_service'
                : role
}

const roleAliases: Record<string, string[]> = {
  frontdesk: ['receptionist'],
  triage: ['triage_nurse'],
  doctor: ['doctor'],
  nurse: ['nurse'],
  lab: ['lab_technician'],
  imaging: ['imaging_technician'],
  cashier: ['cashier'],
  pharmacy: ['pharmacist'],
  followup: ['followup_service'],
  manager: ['store_manager', 'tenant_owner'],
}

/** 将界面岗位别名解析为员工在当前门店真实持有的角色，防止伪造岗位快照。 */
async function resolveActorRole(
  service: ReturnType<typeof createServiceClient>,
  employeeId: string,
  tenantId: string,
  storeId: string | null | undefined,
  requestedRole: string,
) {
  const { data: assignments } = await service
    .from('employee_role_assignments')
    .select('role_id,store_id')
    .eq('employee_id', employeeId)
    .eq('tenant_id', tenantId)
  const scoped = (assignments ?? []).filter((item: any) => !item.store_id || item.store_id === storeId)
  const roleIds = scoped.map((item: any) => item.role_id)
  if (!roleIds.length) { throw err.forbidden('当前员工在本门店没有可用岗位') }
  const { data: roles } = await service.from('roles').select('id,code').in('id', roleIds)
  const allowed = new Set([requestedRole, ...(roleAliases[requestedRole] ?? [])])
  const matched = (roles ?? []).find((item: any) => allowed.has(item.code))
  if (!matched) { throw err.forbidden('当前员工未被授权使用所选岗位') }
  return matched.code as string
}

/** 新版工作台权限优先，兼容既有租户已经持有的领域权限。 */
async function requireWorkbenchAccess(
  c: Context<AppEnv>,
  role: z.infer<typeof roleSchema>,
  tenantId: string,
  storeId?: string,
) {
  let lastError: unknown
  for (const code of rolePermissions[role]) {
    try {
      return await requireScopedPermission(c, { code, tenantId, storeId })
    }
    catch (error) {
      lastError = error
    }
  }
  throw lastError ?? err.forbidden('当前员工没有该岗位工作台权限')
}

/** 岗位工作台聚合，浏览器不跨表拼装患者旅程。 */
patientJourneyRoutes.get('/workbenches/:role', async (c) => {
  const role = roleSchema.parse(c.req.param('role'))
  const input = workbenchQuerySchema.parse(c.req.query())
  const tenantId = resolveRequestedTenant(c, input.tenantId)
  if (!tenantId) { throw err.badRequest('缺少租户上下文') }
  await requireWorkbenchAccess(c, role, tenantId, input.storeId)
  const service = createServiceClient()

  let rows: Array<Record<string, any>> = []
  if (role === 'frontdesk' || role === 'triage' || role === 'doctor' || role === 'manager') {
    const allowedStatuses = role === 'triage'
      ? ['checked_in', 'triage']
      : role === 'doctor'
        ? ['waiting', 'called', 'in_consultation']
        : ['checked_in', 'triage', 'waiting', 'called', 'missed', 'in_consultation']
    const { data, error } = await service
      .from('clinical_queue_entries')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('store_id', input.storeId)
      .in('status', input.status ? [input.status] : allowedStatuses)
      .order('priority', { ascending: false })
      .order('checked_in_at', { ascending: true })
      .limit(input.limit)
    if (error) { throw err.internal(`加载候诊工作台失败: ${error.message}`) }
    rows = data ?? []
  }
  else if (role === 'cashier') {
    const { data, error } = await service
      .from('encounter_charge_items')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('store_id', input.storeId)
      .in('status', input.status ? [input.status] : ['pending', 'invoiced'])
      .order('created_at', { ascending: true })
      .limit(input.limit)
    if (error) { throw err.internal(`加载收银待付款失败: ${error.message}`) }
    rows = data ?? []
  }
  else {
    const { data, error } = await service
      .from('workflow_tasks')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('store_id', input.storeId)
      .eq('owner_role', taskRole(role))
      .in('status', input.status ? [input.status] : ['pending', 'claimed', 'in_progress', 'failed'])
      .order('priority', { ascending: false })
      .order('due_at', { ascending: true, nullsFirst: false })
      .limit(input.limit)
    if (error) { throw err.internal(`加载岗位任务失败: ${error.message}`) }
    rows = data ?? []
  }

  const enriched = await enrichPeople(service, rows)
  const counts = enriched.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status)
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  return ok(c, { role, counts, total: enriched.length, list: enriched })
})

/** 候诊大屏的最小化数据接口，不返回主人、病历、联系方式或费用。 */
patientJourneyRoutes.get('/clinical/queue/display', async (c) => {
  const storeId = z.string().uuid().parse(c.req.query('storeId'))
  const tenantId = resolveRequestedTenant(c)
  if (!tenantId) { throw err.badRequest('缺少租户上下文') }
  await requireScopedPermission(c, { code: 'queue.display', tenantId, storeId })
  const service = createServiceClient()
  const { data, error } = await service.from('clinical_queue_entries')
    .select('id,queue_no,status,room_name,call_sequence,pet_id,assigned_doctor_id,updated_at')
    .eq('tenant_id', tenantId)
    .eq('store_id', storeId)
    .in('status', ['waiting', 'called'])
    .order('checked_in_at')
    .limit(100)
  if (error) { throw err.internal(`加载候诊大屏失败: ${error.message}`) }
  const petIds = [...new Set((data ?? []).map((row: any) => row.pet_id).filter(Boolean))]
  const doctorIds = [...new Set((data ?? []).map((row: any) => row.assigned_doctor_id).filter(Boolean))]
  const [pets, doctors] = await Promise.all([
    petIds.length ? service.from('pets').select('id,name').in('id', petIds) : Promise.resolve({ data: [] }),
    doctorIds.length ? service.from('employees').select('user_id,name').in('user_id', doctorIds) : Promise.resolve({ data: [] }),
  ])
  const petMap = new Map((pets.data ?? []).map((item: any) => [item.id, item.name]))
  const doctorMap = new Map((doctors.data ?? []).map((item: any) => [item.user_id, item.name]))
  return ok(c, { list: (data ?? []).map((row: any) => ({
    ...row,
    pet: { name: petMap.get(row.pet_id) ?? '宠物' },
    doctor_display_name: doctorMap.get(row.assigned_doctor_id) ?? '',
  })) })
})

/** 当前患者完整工作区。 */
patientJourneyRoutes.get('/clinical/encounters/:id/workspace', async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'))
  const service = createServiceClient()
  const { data: encounter, error } = await service.from('encounters').select('*').eq('id', id).maybeSingle()
  if (error || !encounter) { throw err.notFound('就诊不存在') }
  await requireScopedPermission(c, { code: 'encounter.view', tenantId: encounter.tenant_id, storeId: encounter.store_id ?? undefined })
  const [queue, triage, tasks, charges, events, prescriptions, labs, imaging] = await Promise.all([
    service.from('clinical_queue_entries').select('*').eq('encounter_id', id).maybeSingle(),
    service.from('triage_assessments').select('*').eq('encounter_id', id).maybeSingle(),
    service.from('workflow_tasks').select('*').eq('encounter_id', id).order('created_at'),
    service.from('encounter_charge_items').select('*').eq('encounter_id', id).order('created_at'),
    service.from('patient_journey_events').select('*').eq('encounter_id', id).order('occurred_at'),
    service.from('prescriptions').select('*').eq('encounter_id', id).order('created_at'),
    service.from('lab_orders').select('*').eq('encounter_id', id).order('requested_at'),
    service.from('imaging_orders').select('*').eq('encounter_id', id).order('created_at'),
  ])
  const openTasks = (tasks.data ?? []).filter((task: any) => ['pending', 'claimed', 'in_progress'].includes(task.status))
  const unpaidCharges = (charges.data ?? []).filter((charge: any) => ['pending', 'invoiced'].includes(charge.status))
  const journeyStage = encounter.clinical_status === 'closed'
    ? 'closed'
    : queue.data?.status === 'in_consultation' && (labs.data?.some((x: any) => x.status !== 'completed') || imaging.data?.some((x: any) => x.status !== 'published'))
      ? 'diagnostics'
      : unpaidCharges.length
        ? 'payment'
        : openTasks.length
          ? openTasks[0].owner_role
          : encounter.clinical_status === 'plan_ready' ? 'discharge' : 'consultation'
  const blockers = [
    ...openTasks.filter((task: any) => !['record_sign', 'followup'].includes(task.task_type)).map((task: any) => ({ type: 'task', id: task.id, label: task.title })),
    ...unpaidCharges.map((charge: any) => ({ type: 'payment', id: charge.id, label: charge.item_name })),
  ]
  return ok(c, {
    encounter,
    queue: queue.data ?? null,
    triage: triage.data ?? null,
    tasks: tasks.data ?? [],
    charges: charges.data ?? [],
    timeline: events.data ?? [],
    prescriptions: prescriptions.data ?? [],
    labOrders: labs.data ?? [],
    imagingOrders: imaging.data ?? [],
    journeyStage,
    blockers,
    warnings: [],
    nextOwnerRole: openTasks[0]?.owner_role ?? (unpaidCharges.length ? 'cashier' : 'doctor'),
    allowedActions: encounter.clinical_status === 'active'
      ? ['save', 'finish_consultation', 'transfer']
      : encounter.clinical_status === 'plan_ready' && blockers.length === 0 ? ['close', 'transfer'] : ['view'],
  })
})

patientJourneyRoutes.get('/clinical/encounters/:id/timeline', async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'))
  const service = createServiceClient()
  const { data: encounter } = await service.from('encounters').select('tenant_id,store_id').eq('id', id).maybeSingle()
  if (!encounter) { throw err.notFound('就诊不存在') }
  await requireScopedPermission(c, { code: 'encounter.view', tenantId: encounter.tenant_id, storeId: encounter.store_id ?? undefined })
  const { data, error } = await service.from('patient_journey_events').select('*').eq('encounter_id', id).order('occurred_at')
  if (error) { throw err.internal(`加载患者旅程失败: ${error.message}`) }
  return ok(c, { list: data ?? [] })
})

const checkInSchema = actorSchema.extend({
  appointmentId: z.string().uuid(),
  triageRequired: z.boolean().default(true),
  serviceType: z.string().min(1).max(50).default('outpatient'),
})

patientJourneyRoutes.post('/clinical/queue/check-in', async (c) => {
  const input = await parseJsonBody(c, checkInSchema)
  const service = createServiceClient()
  const { data: appointment } = await service.from('appointments').select('tenant_id,store_id').eq('id', input.appointmentId).maybeSingle()
  if (!appointment?.store_id) { throw err.notFound('预约或预约门店不存在') }
  const scope = await requireScopedPermission(c, { code: 'queue.manage', tenantId: appointment.tenant_id, storeId: appointment.store_id })
  const actorRole = await resolveActorRole(service, scope.employeeId, appointment.tenant_id, appointment.store_id, input.actorRole)
  const { data, error } = await service.rpc('check_in_clinical_patient', {
    p_appointment_id: input.appointmentId,
    p_triage_required: input.triageRequired,
    p_service_type: input.serviceType,
    p_actor_employee_id: scope.employeeId,
    p_actor_role: actorRole,
    p_source_workbench: input.sourceWorkbench,
    p_request_id: getContext(c).requestId,
    p_idempotency_key: idem(c, input.idempotencyKey),
  })
  if (error) { throw mapJourneyRpcError(error) }
  return ok(c, data)
})

const triageSchema = actorSchema.extend({
  weightKg: z.number().positive().max(500).optional(),
  temperatureC: z.number().min(20).max(50).optional(),
  heartRate: z.number().int().positive().max(500).optional(),
  respiratoryRate: z.number().int().positive().max(300).optional(),
  painScore: z.number().int().min(0).max(10).optional(),
  acuity: z.enum(['routine', 'priority', 'urgent', 'emergency']),
  allergyNotes: z.string().max(2000).optional(),
  riskFlags: z.array(z.string().max(100)).max(30).default([]),
  chiefComplaint: z.string().max(4000).optional(),
  notes: z.string().max(4000).optional(),
})

patientJourneyRoutes.post('/clinical/queue/:id/triage', async (c) => {
  const queueId = z.string().uuid().parse(c.req.param('id'))
  const input = await parseJsonBody(c, triageSchema)
  const service = createServiceClient()
  const { data: queue } = await service.from('clinical_queue_entries').select('tenant_id,store_id').eq('id', queueId).maybeSingle()
  if (!queue) { throw err.notFound('候诊记录不存在') }
  const scope = await requireScopedPermission(c, { code: 'triage.write', tenantId: queue.tenant_id, storeId: queue.store_id })
  const actorRole = await resolveActorRole(service, scope.employeeId, queue.tenant_id, queue.store_id, input.actorRole)
  const { data, error } = await service.rpc('record_clinical_triage', {
    p_queue_entry_id: queueId,
    p_payload: input,
    p_actor_employee_id: scope.employeeId,
    p_actor_role: actorRole,
    p_source_workbench: input.sourceWorkbench,
    p_request_id: getContext(c).requestId,
    p_idempotency_key: idem(c, input.idempotencyKey),
  })
  if (error) { throw mapJourneyRpcError(error) }
  return ok(c, data)
})

const queueTransitionSchema = actorSchema.extend({
  targetStatus: z.enum(['waiting', 'called', 'missed', 'in_consultation', 'closed', 'cancelled']),
  reason: z.string().max(2000).optional(),
  roomName: z.string().max(100).optional(),
})

patientJourneyRoutes.post('/clinical/queue/:id/transition', async (c) => {
  const queueId = z.string().uuid().parse(c.req.param('id'))
  const input = await parseJsonBody(c, queueTransitionSchema)
  const service = createServiceClient()
  const { data: queue } = await service.from('clinical_queue_entries').select('tenant_id,store_id').eq('id', queueId).maybeSingle()
  if (!queue) { throw err.notFound('候诊记录不存在') }
  const code = ['called', 'missed', 'waiting', 'in_consultation'].includes(input.targetStatus) ? 'queue.call' : 'queue.manage'
  const scope = await requireScopedPermission(c, { code, tenantId: queue.tenant_id, storeId: queue.store_id })
  const actorRole = await resolveActorRole(service, scope.employeeId, queue.tenant_id, queue.store_id, input.actorRole)
  const { data, error } = await service.rpc('transition_clinical_queue', {
    p_queue_entry_id: queueId,
    p_target_status: input.targetStatus,
    p_reason: input.reason ?? null,
    p_room_name: input.roomName ?? null,
    p_actor_employee_id: scope.employeeId,
    p_actor_role: actorRole,
    p_source_workbench: input.sourceWorkbench,
    p_request_id: getContext(c).requestId,
    p_idempotency_key: idem(c, input.idempotencyKey),
  })
  if (error) { throw mapJourneyRpcError(error) }
  return ok(c, data)
})

const taskTransitionSchema = actorSchema.extend({
  action: z.enum(['claim', 'transfer', 'start', 'complete', 'fail', 'cancel']),
  targetEmployeeId: z.string().uuid().optional(),
  reason: z.string().max(4000).optional(),
})

patientJourneyRoutes.post('/workflow-tasks/:id/transition', async (c) => {
  const taskId = z.string().uuid().parse(c.req.param('id'))
  const input = await parseJsonBody(c, taskTransitionSchema)
  const service = createServiceClient()
  const { data: task } = await service.from('workflow_tasks').select('tenant_id,store_id').eq('id', taskId).maybeSingle()
  if (!task) { throw err.notFound('岗位任务不存在') }
  const permission = input.action === 'transfer' ? 'workflow_task.transfer' : 'workflow_task.execute'
  const scope = await requireScopedPermission(c, { code: permission, tenantId: task.tenant_id, storeId: task.store_id })
  const actorRole = await resolveActorRole(service, scope.employeeId, task.tenant_id, task.store_id, input.actorRole)
  const { data, error } = await service.rpc('transition_workflow_task', {
    p_task_id: taskId,
    p_action: input.action,
    p_target_employee_id: input.targetEmployeeId ?? null,
    p_reason: input.reason ?? null,
    p_actor_employee_id: scope.employeeId,
    p_actor_role: actorRole,
    p_source_workbench: input.sourceWorkbench,
    p_request_id: getContext(c).requestId,
    p_idempotency_key: idem(c, input.idempotencyKey),
  })
  if (error) { throw mapJourneyRpcError(error) }
  return ok(c, data)
})

const chargeSchema = actorSchema.extend({
  sourceType: z.enum(['prescription', 'lab_order', 'imaging_order', 'procedure', 'medical_order']),
  sourceId: z.string().min(1).max(100),
  sourceLineId: z.string().max(100).default(''),
  catalogItemId: z.string().uuid().optional(),
  itemName: z.string().min(1).max(500),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  paymentRequiredBeforeExecution: z.boolean().default(true),
})

patientJourneyRoutes.post('/clinical/encounters/:id/charge-items', async (c) => {
  const encounterId = z.string().uuid().parse(c.req.param('id'))
  const input = await parseJsonBody(c, chargeSchema)
  const service = createServiceClient()
  const { data: encounter } = await service.from('encounters').select('tenant_id,store_id').eq('id', encounterId).maybeSingle()
  if (!encounter?.store_id) { throw err.notFound('就诊或就诊门店不存在') }
  const scope = await requireScopedPermission(c, { code: 'encounter.work', tenantId: encounter.tenant_id, storeId: encounter.store_id })
  const actorRole = await resolveActorRole(service, scope.employeeId, encounter.tenant_id, encounter.store_id, input.actorRole)
  const { data, error } = await service.rpc('upsert_encounter_charge_item', {
    p_encounter_id: encounterId,
    p_source_type: input.sourceType,
    p_source_id: input.sourceId,
    p_source_line_id: input.sourceLineId,
    p_catalog_item_id: input.catalogItemId ?? null,
    p_item_name: input.itemName,
    p_quantity: input.quantity,
    p_unit_price: input.unitPrice,
    p_payment_required: input.paymentRequiredBeforeExecution,
    p_actor_employee_id: scope.employeeId,
    p_actor_role: actorRole,
    p_source_workbench: input.sourceWorkbench,
    p_request_id: getContext(c).requestId,
    p_idempotency_key: idem(c, input.idempotencyKey),
  })
  if (error) { throw mapJourneyRpcError(error) }
  return ok(c, data)
})

const voidChargeSchema = actorSchema.extend({ reason: z.string().trim().min(1).max(2000) })

patientJourneyRoutes.post('/billing/charge-items/:id/void', async (c) => {
  const chargeId = z.string().uuid().parse(c.req.param('id'))
  const input = await parseJsonBody(c, voidChargeSchema)
  const service = createServiceClient()
  const { data: charge } = await service.from('encounter_charge_items').select('tenant_id,store_id').eq('id', chargeId).maybeSingle()
  if (!charge) { throw err.notFound('待付款条目不存在') }
  const scope = await requireScopedPermission(c, { code: 'charge_item.void', tenantId: charge.tenant_id, storeId: charge.store_id })
  const actorRole = await resolveActorRole(service, scope.employeeId, charge.tenant_id, charge.store_id, input.actorRole)
  const { data, error } = await service.rpc('void_encounter_charge_item', {
    p_charge_item_id: chargeId,
    p_reason: input.reason,
    p_actor_employee_id: scope.employeeId,
    p_actor_role: actorRole,
    p_source_workbench: input.sourceWorkbench,
    p_request_id: getContext(c).requestId,
    p_idempotency_key: idem(c, input.idempotencyKey),
  })
  if (error) { throw mapJourneyRpcError(error) }
  return ok(c, data)
})

const invoiceFromChargesSchema = actorSchema.extend({
  chargeItemIds: z.array(z.string().uuid()).min(1).max(200),
  discountAmount: z.number().nonnegative().default(0),
  discountReason: z.string().max(2000).optional(),
  taxAmount: z.number().nonnegative().default(0),
})

patientJourneyRoutes.post('/billing/encounters/:id/invoice-from-charges', async (c) => {
  const encounterId = z.string().uuid().parse(c.req.param('id'))
  const input = await parseJsonBody(c, invoiceFromChargesSchema)
  const service = createServiceClient()
  const { data: encounter } = await service.from('encounters').select('tenant_id,store_id').eq('id', encounterId).maybeSingle()
  if (!encounter?.store_id) { throw err.notFound('就诊或就诊门店不存在') }
  const scope = await requireScopedPermission(c, { code: 'invoice.create', tenantId: encounter.tenant_id, storeId: encounter.store_id })
  const actorRole = await resolveActorRole(service, scope.employeeId, encounter.tenant_id, encounter.store_id, input.actorRole)
  const { data, error } = await service.rpc('create_invoice_from_pending_charges', {
    p_encounter_id: encounterId,
    p_charge_item_ids: input.chargeItemIds,
    p_discount_amount: input.discountAmount,
    p_discount_reason: input.discountReason ?? null,
    p_tax_amount: input.taxAmount,
    p_operator_employee_id: scope.employeeId,
    p_actor_role: actorRole,
    p_source_workbench: input.sourceWorkbench,
    p_request_id: getContext(c).requestId,
    p_idempotency_key: idem(c, input.idempotencyKey),
  })
  if (error) { throw mapJourneyRpcError(error) }
  return ok(c, data)
})

const encounterTransitionSchema = actorSchema.extend({ reason: z.string().max(2000).optional() })

patientJourneyRoutes.post('/clinical/encounters/:id/:action', async (c) => {
  const encounterId = z.string().uuid().parse(c.req.param('id'))
  const action = z.enum(['finish-consultation', 'close', 'transfer']).parse(c.req.param('action'))
  const input = await parseJsonBody(c, encounterTransitionSchema)
  const service = createServiceClient()
  const { data: encounter } = await service.from('encounters').select('tenant_id,store_id').eq('id', encounterId).maybeSingle()
  if (!encounter?.store_id) { throw err.notFound('就诊或就诊门店不存在') }
  const permission = action === 'finish-consultation' ? 'encounter.work' : 'encounter.close'
  const scope = await requireScopedPermission(c, { code: permission, tenantId: encounter.tenant_id, storeId: encounter.store_id })
  const actorRole = await resolveActorRole(service, scope.employeeId, encounter.tenant_id, encounter.store_id, input.actorRole)
  const target = action === 'finish-consultation' ? 'plan_ready' : action === 'close' ? 'closed' : 'transferred'
  const { data, error } = await service.rpc('transition_encounter_clinical_status', {
    p_encounter_id: encounterId,
    p_target_status: target,
    p_reason: input.reason ?? null,
    p_actor_employee_id: scope.employeeId,
    p_actor_role: actorRole,
    p_source_workbench: input.sourceWorkbench,
    p_request_id: getContext(c).requestId,
    p_idempotency_key: idem(c, input.idempotencyKey),
  })
  if (error) { throw mapJourneyRpcError(error) }
  return ok(c, data)
})

const preferenceSchema = z.object({ activeRole: roleSchema, storeId: z.string().uuid().optional() })

patientJourneyRoutes.post('/workbenches/preference', async (c) => {
  const input = await parseJsonBody(c, preferenceSchema)
  const tenantId = resolveRequestedTenant(c)
  const storeId = resolveRequestedStore(c, input.storeId)
  if (!tenantId) { throw err.badRequest('缺少租户上下文') }
  const scope = await requireWorkbenchAccess(c, input.activeRole, tenantId, storeId)
  const service = createServiceClient()
  const { data, error } = await service.from('workbench_preferences').upsert({
    tenant_id: tenantId,
    employee_id: scope.employeeId,
    store_id: storeId ?? null,
    active_role: input.activeRole,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,employee_id,store_id' }).select().single()
  if (error) { throw err.internal(`保存岗位偏好失败: ${error.message}`) }
  return ok(c, data)
})

export default patientJourneyRoutes
