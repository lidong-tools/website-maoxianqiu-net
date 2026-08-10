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
  keyword: z.string().max(100).optional(),
  limit: z.coerce.number().int().positive().max(500).default(50),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
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
  if (message.includes('VERSION_CONFLICT')) { return err.conflict(message) }
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

/** 关键词范围解析:按宠物名/主人名/主人电话在租户内解析可能的 id 集合,防止跨租户搜索。 */
async function resolveKeywordScopes(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  keyword: string,
) {
  const kw = `%${keyword}%`
  const [pets, customers] = await Promise.all([
    service.from('pets').select('id').eq('tenant_id', tenantId).ilike('name', kw),
    service.from('customers').select('id').eq('tenant_id', tenantId).or(`name.ilike.${kw},phone.ilike.${kw}`),
  ])
  return {
    petIds: (pets.data ?? []).map((item: any) => item.id),
    customerIds: (customers.data ?? []).map((item: any) => item.id),
  }
}

/** 构造工作台基础查询:门店/租户范围 + 关键词 OR 过滤(宠物/主人 id 或文本字段模糊匹配)。 */
function workbenchBuilder(
  service: ReturnType<typeof createServiceClient>,
  table: 'clinical_queue_entries' | 'encounter_charge_items' | 'workflow_tasks',
  tenantId: string,
  storeId: string,
  keyword: string | undefined,
  scopes: { petIds: string[], customerIds: string[] } | null,
  textFields: string[],
) {
  // 动态表名(from 联合类型)会产生 PostgrestQueryBuilder 联合类型,统一按 any 处理以便链式过滤
  // 必须先 select() 拿到 PostgrestFilterBuilder,否则 from() 返回的 QueryBuilder 上没有 eq/or 等过滤方法
  let builder: any = (service.from(table) as any)
    .select()
    .eq('tenant_id', tenantId)
    .eq('store_id', storeId)
  if (keyword && scopes) {
    const conds: string[] = []
    if (scopes.petIds.length) { conds.push(`pet_id.in.(${scopes.petIds.join(',')})`) }
    if (scopes.customerIds.length) { conds.push(`customer_id.in.(${scopes.customerIds.join(',')})`) }
    for (const field of textFields) { conds.push(`${field}.ilike.%${keyword}%`) }
    if (conds.length) { builder = builder.or(conds.join(',')) }
  }
  return builder
}

/** 全量状态计数(完整业务范围,不受状态筛选与分页影响),并返回筛选后总数与当前页记录。 */
async function aggregateWorkbenchPage(
  builder: any,
  statuses: string[],
  status: string | undefined,
  page: number,
  pageSize: number,
) {
  // 当前选中状态只作用于"总数 + 分页",状态计数始终按全部状态统计
  const activeStatuses = status ? [status] : statuses
  const { data: countRows, error: countError } = await builder.select('id,status').in('status', statuses)
  if (countError) { throw err.internal(`加载工作台统计失败: ${countError.message}`) }
  const counts = ((countRows ?? []) as Array<{ status: string }>).reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status)
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const { count, error: totalError } = await builder.select('id', { count: 'exact', head: true }).in('status', activeStatuses)
  if (totalError) { throw err.internal(`加载工作台总数失败: ${totalError.message}`) }
  const from = (page - 1) * pageSize
  const { data, error } = await builder.select('*').in('status', activeStatuses).range(from, from + pageSize - 1)
  if (error) { throw err.internal(`加载工作台列表失败: ${error.message}`) }
  return { list: data ?? [], counts, total: count ?? 0 }
}

/** 为工作台行补充统一展示结构与详情目标(保留旧字段兼容医生工作台)。 */
function buildWorkbenchRow(row: Record<string, any>, kind: 'queue' | 'task' | 'charge'): Record<string, any> {
  const now = Date.now()
  const startedAt = row.checked_in_at ?? row.waiting_at ?? row.claimed_at ?? row.started_at ?? row.created_at
  const dueAt = row.due_at ?? null
  const elapsedMinutes = startedAt ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 60000)) : 0
  const overdue = dueAt ? new Date(dueAt).getTime() < now : false
  let display: Record<string, any>
  if (kind === 'queue') {
    display = {
      businessNo: row.queue_no ?? undefined,
      title: row.queue_no ? `队列 ${row.queue_no}` : '候诊',
      subtitle: row.room_name ?? undefined,
    }
  }
  else if (kind === 'task') {
    display = {
      businessNo: row.source_id ?? undefined,
      title: row.title ?? row.task_type ?? '任务',
      subtitle: row.description ?? undefined,
      sourceLabel: row.source_type ?? undefined,
    }
  }
  else {
    display = {
      businessNo: row.source_id ?? undefined,
      title: row.item_name ?? '收费项目',
      subtitle: `${Number(row.quantity ?? 1)} × ¥${Number(row.unit_price ?? 0).toFixed(2)}`,
      sourceLabel: row.source_type ?? undefined,
    }
  }
  const detailTarget = row.encounter_id
    ? { type: 'encounter', id: row.encounter_id }
    : kind === 'queue'
      ? { type: 'queue', id: row.id }
      : kind === 'task'
        ? { type: 'task', id: row.id }
        : { type: 'charge', id: row.id }
  return {
    ...row,
    display,
    timing: { startedAt, dueAt, elapsedMinutes, overdue },
    detailTarget,
  }
}

/** 按岗位工作流推导主动作:队列岗按候诊状态,任务岗按领取/执行状态,收银按付款状态。 */
function derivePrimaryAction(role: z.infer<typeof roleSchema>, row: Record<string, any>): string | undefined {
  if (role === 'cashier') { return row.status === 'pending' ? 'settle' : undefined }
  if (role === 'triage') { return 'triage' }
  if (['frontdesk', 'doctor', 'manager'].includes(role)) {
    if (row.status === 'waiting') { return 'called' }
    if (row.status === 'called') { return 'in_consultation' }
    if (row.status === 'missed') { return 'waiting' }
    if (row.encounter_id) { return 'open' }
    return undefined
  }
  if (row.status === 'pending' || row.status === 'failed') { return 'claim' }
  if (row.status === 'claimed') { return 'start' }
  if (row.status === 'in_progress') { return 'complete' }
  return undefined
}

/** 允许动作:主动作 + 可执行次要动作(收银待付款可异议作废,队列可查看患者)。 */
function deriveAllowedActions(role: z.infer<typeof roleSchema>, row: Record<string, any>, primaryAction?: string): string[] {
  const actions: string[] = primaryAction ? [primaryAction] : []
  if (role === 'cashier' && row.status === 'pending') { actions.push('void') }
  if (['frontdesk', 'triage', 'doctor', 'manager'].includes(role) && row.encounter_id && !actions.includes('open')) {
    actions.push('open')
  }
  return actions
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

  const page = input.page
  const pageSize = input.pageSize ?? input.limit
  // 清洗 or 过滤语法中的分隔符,避免关键词破坏 PostgREST 查询结构
  const keyword = input.keyword?.trim().replace(/[,()"'\\]/g, ' ') || undefined
  // 关键词在租户内解析为宠物/主人 id 集合,供工作台跨表检索
  const scopes = keyword ? await resolveKeywordScopes(service, tenantId, keyword) : null

  let rows: Array<Record<string, any>> = []
  let counts: Record<string, number> = {}
  let total = 0

  if (role === 'frontdesk' || role === 'triage' || role === 'doctor' || role === 'manager') {
    const allowedStatuses = role === 'triage'
      ? ['checked_in', 'triage']
      : role === 'doctor'
        ? ['waiting', 'called', 'in_consultation']
        : ['checked_in', 'triage', 'waiting', 'called', 'missed', 'in_consultation']
    const builder = workbenchBuilder(service, 'clinical_queue_entries', tenantId, input.storeId, keyword, scopes, ['queue_no'])
      .order('priority', { ascending: false })
      .order('checked_in_at', { ascending: true })
    const paged = await aggregateWorkbenchPage(builder, allowedStatuses, input.status, page, pageSize)
    rows = paged.list
    counts = paged.counts
    total = paged.total
  }
  else if (role === 'cashier') {
    const builder = workbenchBuilder(service, 'encounter_charge_items', tenantId, input.storeId, keyword, scopes, ['item_name', 'source_id'])
      .order('created_at', { ascending: true })
    const paged = await aggregateWorkbenchPage(builder, ['pending', 'invoiced'], input.status, page, pageSize)
    rows = paged.list
    counts = paged.counts
    total = paged.total
  }
  else {
    const builder = workbenchBuilder(service, 'workflow_tasks', tenantId, input.storeId, keyword, scopes, ['title', 'source_id'])
      .eq('owner_role', taskRole(role))
      .order('priority', { ascending: false })
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
    const paged = await aggregateWorkbenchPage(builder, ['pending', 'claimed', 'in_progress', 'failed'], input.status, page, pageSize)
    rows = paged.list
    counts = paged.counts
    total = paged.total
  }

  const enriched = await enrichPeople(service, rows)

  // 医生岗位工作台:补充预约原因/就诊状态/分诊摘要与主动作,供前端一屏接诊
  let list: Array<Record<string, any>> = []
  if (role === 'doctor') {
    const appointmentIds = [...new Set(enriched.map(row => row.appointment_id).filter(Boolean))]
    const encounterIds = [...new Set(enriched.map(row => row.encounter_id).filter(Boolean))]
    const [appointments, encounters, triages] = await Promise.all([
      appointmentIds.length
        ? service.from('appointments').select('id,reason,scheduled_start,scheduled_end').in('id', appointmentIds)
        : Promise.resolve({ data: [] }),
      encounterIds.length
        ? service.from('encounters').select('id,status,clinical_status,archive_status,version').in('id', encounterIds)
        : Promise.resolve({ data: [] }),
      enriched.length
        ? service.from('triage_assessments').select('queue_entry_id,acuity,risk_flags,temperature_c,heart_rate,respiratory_rate,pain_score,weight_kg,allergy_notes').in('queue_entry_id', enriched.map(row => row.id))
        : Promise.resolve({ data: [] }),
    ])
    const appointmentMap = new Map((appointments.data ?? []).map((item: any) => [item.id, item]))
    const encounterMap = new Map((encounters.data ?? []).map((item: any) => [item.id, item]))
    const triageMap = new Map((triages.data ?? []).map((item: any) => [item.queue_entry_id, item]))
    list = enriched.map((row) => {
      const encounter = encounterMap.get(row.encounter_id) ?? null
      const triage = triageMap.get(row.id) ?? null
      // 队列主动作:待叫号 → 叫号;已叫号 → 开始接诊;诊疗中 → 继续问诊
      const primaryAction = row.status === 'waiting' ? 'call' : row.status === 'called' ? 'start' : row.status === 'in_consultation' ? 'continue' : 'view'
      return {
        ...buildWorkbenchRow(row, 'queue'),
        appointment: appointmentMap.get(row.appointment_id) ?? null,
        encounter,
        triage,
        primaryAction,
        allowedActions: encounter && ['closed', 'cancelled', 'transferred'].includes(encounter.clinical_status)
          ? ['view']
          : [primaryAction, 'view'],
      }
    })
  }
  else if (role === 'cashier') {
    list = enriched.map((row) => {
      const primaryAction = derivePrimaryAction(role, row)
      return { ...buildWorkbenchRow(row, 'charge'), primaryAction, allowedActions: deriveAllowedActions(role, row, primaryAction) }
    })
  }
  else if (['frontdesk', 'triage', 'manager'].includes(role)) {
    list = enriched.map((row) => {
      const primaryAction = derivePrimaryAction(role, row)
      return { ...buildWorkbenchRow(row, 'queue'), primaryAction, allowedActions: deriveAllowedActions(role, row, primaryAction) }
    })
  }
  else {
    list = enriched.map((row) => {
      const primaryAction = derivePrimaryAction(role, row)
      return { ...buildWorkbenchRow(row, 'task'), primaryAction, allowedActions: deriveAllowedActions(role, row, primaryAction) }
    })
  }

  return ok(c, { role, counts, total, page, pageSize, list })
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
  const [queue, triage, tasks, charges, events, prescriptions, labs, imaging, medicalOrders, petRows, customerRows, recentRows, safetyChecks] = await Promise.all([
    service.from('clinical_queue_entries').select('*').eq('encounter_id', id).maybeSingle(),
    service.from('triage_assessments').select('*').eq('encounter_id', id).maybeSingle(),
    service.from('workflow_tasks').select('*').eq('encounter_id', id).order('created_at'),
    service.from('encounter_charge_items').select('*').eq('encounter_id', id).order('created_at'),
    service.from('patient_journey_events').select('*').eq('encounter_id', id).order('occurred_at'),
    service.from('prescriptions').select('*, items:prescription_items(*)').eq('encounter_id', id).order('created_at'),
    service.from('lab_orders').select('*').eq('encounter_id', id).order('requested_at'),
    service.from('imaging_orders').select('*').eq('encounter_id', id).order('created_at'),
    service.from('medical_orders').select('*').eq('encounter_id', id).order('created_at'),
    service.from('pets').select('*').eq('id', encounter.pet_id).maybeSingle(),
    service.from('customers').select('*').eq('id', encounter.customer_id).maybeSingle(),
    // 当前宠物最近病历摘要(排除本次),供医生对照历史诊断/方案
    service.from('encounters')
      .select('id,status,clinical_status,archive_status,version,chief_complaint,diagnosis_text,treatment_plan,follow_up_date,started_at,created_at')
      .eq('pet_id', encounter.pet_id)
      .neq('id', id)
      .order('started_at', { ascending: false })
      .limit(10),
    // 本次就诊已触发的用药安全检查(含豁免状态),前端据此展示阻断
    service.from('medication_safety_checks')
      .select('id,rule_code,rule_type,severity,blocking,status,message_snapshot,recommendation_snapshot,prescription_id,item_index')
      .eq('encounter_id', id)
      .order('created_at', { ascending: false })
      .limit(100),
  ])
  const openTasks = (tasks.data ?? []).filter((task: any) => ['pending', 'claimed', 'in_progress'].includes(task.status))
  const unpaidCharges = (charges.data ?? []).filter((charge: any) => ['pending', 'invoiced'].includes(charge.status))
  // 收费汇总:待收金额、无价格项目、已付金额
  const pendingAmount = (unpaidCharges as any[]).reduce((sum, charge) => sum + Number(charge.amount ?? 0), 0)
  const noPriceCount = (unpaidCharges as any[]).filter(charge => Number(charge.unit_price ?? 0) === 0).length
  // 用药安全:未处理的阻断/警告
  const triggeredChecks = (safetyChecks.data ?? []).filter((check: any) => check.status === 'triggered')
  const blockingChecks = triggeredChecks.filter((check: any) => check.blocking)
  const warningChecks = triggeredChecks.filter((check: any) => !check.blocking)
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
    ...blockingChecks.map((check: any) => ({ type: 'medication_safety', id: check.id, label: check.message_snapshot })),
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
    medicalOrders: medicalOrders.data ?? [],
    // P0-4:患者临床上下文(宠物/主人安全摘要)
    pet: petRows.data ?? null,
    customer: customerRows.data ?? null,
    recentEncounters: recentRows.data ?? [],
    // P0-6:诊疗方案整体摘要(项目数、待收金额、无价格项、用药安全)
    billing: {
      pendingAmount,
      noPriceCount,
      pendingCount: unpaidCharges.length,
      paidAmount: (charges.data ?? []).filter((charge: any) => charge.status === 'paid').reduce((sum, charge) => sum + Number(charge.amount ?? 0), 0),
    },
    medicationSafety: {
      blockingChecks,
      warningChecks,
      hasBlocking: blockingChecks.length > 0,
    },
    journeyStage,
    blockers,
    warnings: [],
    nextOwnerRole: openTasks[0]?.owner_role ?? (unpaidCharges.length ? 'cashier' : 'doctor'),
    allowedActions: encounter.clinical_status === 'active'
      ? ['save', 'finish_consultation', 'transfer']
      : encounter.clinical_status === 'plan_ready' && blockers.length === 0 ? ['close', 'transfer'] : ['view'],
    // 各实体的最新更新时间戳,前端据此判断是否需要后台刷新校准
    workspaceVersion: Math.max(
      0,
      ...[
        encounter.updated_at,
        queue.data?.updated_at,
        triage.data?.updated_at,
        ...(tasks.data ?? []).map((row: any) => row.updated_at ?? row.created_at),
        ...(charges.data ?? []).map((row: any) => row.updated_at ?? row.created_at),
        ...(events.data ?? []).map((row: any) => row.occurred_at ?? row.created_at),
        ...(prescriptions.data ?? []).map((row: any) => row.updated_at ?? row.created_at),
        ...(labs.data ?? []).map((row: any) => row.updated_at ?? row.requested_at ?? row.created_at),
        ...(imaging.data ?? []).map((row: any) => row.updated_at ?? row.created_at),
        ...(medicalOrders.data ?? []).map((row: any) => row.updated_at ?? row.created_at),
      ]
        .filter(Boolean)
        .map(value => new Date(value as string).getTime()),
    ),
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

const planCommitItemSchema = z.object({
  catalogItemId: z.string().uuid().optional(),
  drugName: z.string().max(200).optional(),
  dosage: z.string().max(200).optional(),
  frequency: z.string().max(200).optional(),
  durationDays: z.number().int().positive().optional(),
  quantity: z.number().positive().optional(),
  unit: z.string().max(50).optional(),
  instructions: z.string().max(2000).optional(),
})

const planCommitLabSchema = z.object({
  catalogItemId: z.string().uuid(),
  remark: z.string().max(1000).optional(),
  /** 临床问题(检验目的描述,随申请单落库) */
  clinicalQuestion: z.string().max(2000).optional(),
})

const planCommitImagingSchema = z.object({
  catalogItemId: z.string().uuid(),
  imagingType: z.enum(['ultrasound', 'xray', 'cr', 'ct', 'mri', 'other']),
  clinicalQuestion: z.string().max(2000).optional(),
})

const planCommitMedicalOrderSchema = z.object({
  orderType: z.enum(['injection', 'infusion', 'treatment', 'disposal', 'nursing', 'medication', 'other']),
  itemName: z.string().trim().min(1).max(500),
  dosage: z.string().max(200).optional(),
  frequency: z.string().max(200).optional(),
  quantity: z.number().positive().default(1),
  unit: z.string().max(50).optional(),
  instructions: z.string().max(2000).optional(),
  /** 计划执行时间(可选,缺省立即执行) */
  scheduledAt: z.string().optional(),
  /** 指定执行护士(auth.users.id,空=待分派) */
  assigneeId: z.string().uuid().optional(),
})

const planCommitSchema = actorSchema.extend({
  /** 病历乐观锁版本:不匹配返回 409,防止覆盖其他窗口的修改 */
  expectedVersion: z.number().int().positive(),
  /** 病历字段更新(与保存草稿同源,服务端按版本原子落库) */
  encounterUpdates: z.object({
    chiefComplaint: z.string().max(2000).optional(),
    historyPresent: z.string().max(5000).optional(),
    examFindings: z.string().max(5000).optional(),
    diagnosisText: z.string().max(2000).optional(),
    treatmentPlan: z.string().max(5000).optional(),
    followUpDate: z.string().date().optional(),
  }).default({}),
  /** 处方药品行(同一次开具;受控药/用药安全门禁由服务端 issue 规则执行) */
  prescriptions: z.array(planCommitItemSchema).max(100).default([]),
  labs: z.array(planCommitLabSchema).max(50).default([]),
  imaging: z.array(planCommitImagingSchema).max(50).default([]),
  medicalOrders: z.array(planCommitMedicalOrderSchema).max(100).default([]),
  /** 提交后是否将 encounter 推进到 plan_ready(下游岗位待办保留) */
  finishConsultation: z.boolean().default(true),
})

/**
 * 诊疗方案原子提交(Stage-04 Phase 4)
 * 单一 Hono Command 调用统一 PostgreSQL RPC,在一个事务中完成
 * 病历更新、处方开具、检验/影像/医嘱创建、收费/任务/事件生成与 encounter 推进,
 * 任何一步失败整体回滚,幂等键支持网络重试。
 */
patientJourneyRoutes.post('/clinical/encounters/:id/plan/commit', async (c) => {
  const encounterId = z.string().uuid().parse(c.req.param('id'))
  const input = await parseJsonBody(c, planCommitSchema)
  const service = createServiceClient()
  const { data: encounter } = await service.from('encounters').select('tenant_id,store_id').eq('id', encounterId).maybeSingle()
  if (!encounter?.store_id) { throw err.notFound('就诊或就诊门店不存在') }
  const scope = await requireScopedPermission(c, { code: 'encounter.work', tenantId: encounter.tenant_id, storeId: encounter.store_id })
  const actorRole = await resolveActorRole(service, scope.employeeId, encounter.tenant_id, encounter.store_id, input.actorRole)
  const { data, error } = await service.rpc('commit_clinical_plan', {
    p_encounter_id: encounterId,
    p_expected_version: input.expectedVersion,
    p_encounter_updates: {
      chief_complaint: input.encounterUpdates.chiefComplaint,
      history_present: input.encounterUpdates.historyPresent,
      exam_findings: input.encounterUpdates.examFindings,
      diagnosis_text: input.encounterUpdates.diagnosisText,
      treatment_plan: input.encounterUpdates.treatmentPlan,
      follow_up_date: input.encounterUpdates.followUpDate,
    },
    p_prescription_items: input.prescriptions.map((item, index) => ({
      catalog_item_id: item.catalogItemId,
      drug_name: item.drugName,
      dosage: item.dosage,
      frequency: item.frequency,
      duration_days: item.durationDays,
      quantity: item.quantity,
      unit: item.unit,
      instructions: item.instructions,
      sort_order: index,
    })),
    p_labs: input.labs.map((lab, index) => ({
      seq: index,
      catalog_item_id: lab.catalogItemId,
      remark: lab.remark,
      clinical_question: lab.clinicalQuestion,
    })),
    p_imaging: input.imaging.map((img, index) => ({
      seq: index,
      catalog_item_id: img.catalogItemId,
      imaging_type: img.imagingType,
      clinical_question: img.clinicalQuestion,
    })),
    p_medical_orders: input.medicalOrders.map((order, index) => ({
      seq: index,
      order_type: order.orderType,
      item_name: order.itemName,
      dosage: order.dosage,
      frequency: order.frequency,
      quantity: order.quantity,
      unit: order.unit,
      instructions: order.instructions,
      scheduled_at: order.scheduledAt,
      assignee_id: order.assigneeId,
    })),
    p_finish_consultation: input.finishConsultation,
    p_actor_employee_id: scope.employeeId,
    p_actor_role: actorRole,
    p_source_workbench: input.sourceWorkbench,
    p_request_id: getContext(c).requestId,
    p_idempotency_key: idem(c, input.idempotencyKey),
  })
  if (error) { throw mapJourneyRpcError(error) }
  return ok(c, data)
})

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

/** 保存员工岗位偏好；平台管理员没有租户员工档案，其选择由前端偏好存储持久化。 */
patientJourneyRoutes.post('/workbenches/preference', async (c) => {
  const input = await parseJsonBody(c, preferenceSchema)
  const tenantId = resolveRequestedTenant(c)
  const storeId = resolveRequestedStore(c, input.storeId)
  if (!tenantId) { throw err.badRequest('缺少租户上下文') }
  const scope = await requireWorkbenchAccess(c, input.activeRole, tenantId, storeId)
  if (!scope.employeeId) {
    return ok(c, {
      tenant_id: tenantId,
      employee_id: null,
      store_id: storeId ?? null,
      active_role: input.activeRole,
      updated_at: new Date().toISOString(),
    })
  }
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
