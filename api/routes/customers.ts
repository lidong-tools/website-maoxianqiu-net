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
 * 客户 CRM 路由(MXQ-5002 / MXQ-5009 / MXQ-5010)
 *
 * 分层:
 *   - Query(list/detail):Hono 聚合查询 + customer.view 权限
 *   - Command(create/update/archive/merge/batch-import):Hono 调 PostgreSQL RPC,禁止前端直连写
 *
 * 状态机:
 *   active --archive--> archived
 *   active --merge--> merged(源客户,merged_into 指向目标)
 *   archived/merged 不可再变更
 */
const customerRoutes = new Hono<AppEnv>()

customerRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const listSchema = z.object({
  keyword: z.string().max(100).optional(),
  storeId: z.string().uuid().optional(),
  memberLevel: z.enum(['normal', 'silver', 'gold', 'diamond']).optional(),
  status: z.enum(['active', 'archived', 'merged']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/**
 * 客户列表(MXQ-5002)
 * - 权限:customer.view
 * - 支持 keyword(姓名/手机/编号)、storeId、memberLevel、status 筛选
 * - 走 service client 聚合查询,服务端控制数据边界
 */
customerRoutes.get('/', async (c) => {
  const input = listSchema.parse(c.req.query())

  // P0-02 scoped:tenantId 缺失时取调用者默认租户,强制按授权租户过滤
  const scope = await requireScopedPermission(c, {
    code: 'customer.view',
    tenantId: getContext(c).memberships[0]?.tenant_id ?? '',
    storeId: input.storeId,
  })

  const service = createServiceClient()
  let query = service
    .from('customers')
    .select('id, customer_no, name, gender, phone, email, store_id, member_level, member_points, balance, status, created_at, updated_at, archived_at', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.status) {
    query = query.eq('status', input.status)
  }
  else {
    // 默认不展示已归档
    query = query.neq('status', 'archived')
  }
  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.memberLevel) {
    query = query.eq('member_level', input.memberLevel)
  }
  if (input.keyword) {
    query = query.or(`name.ilike.%${input.keyword}%,phone.ilike.%${input.keyword}%,customer_no.ilike.%${input.keyword}%`)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询客户列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

// ============================================================
// 客户回访任务 followup_tasks(S3.1-AGENT-04)
// 状态机:pending → in_progress → completed;pending/in_progress → cancelled
// 权限:view=查看 / manage=创建/修改/开始/取消 / complete=登记完成结果
// 注意:所有 /followups 路由必须注册在 GET /:id 之前,否则会被动态段吞并
// ============================================================

const followupSelect = [
  'id', 'tenant_id', 'store_id', 'customer_id', 'pet_id', 'source_type', 'source_id',
  'task_type', 'scheduled_at', 'assignee_employee_id', 'channel', 'status',
  'result_code', 'result_note', 'started_at', 'completed_at', 'completed_by',
  'cancel_reason', 'next_followup_at', 'created_by', 'created_at', 'updated_at',
].join(', ')

/**
 * followup_tasks 表尚未进入生成的 supabase types(Database 快照),
 * 此处以 any 统一关闭该表的查询器类型推导,避免 GenericStringError 干扰。
 * 待 db:gen-types 重新生成后可将此 helper 移除。
 */
function followupTable(service: ReturnType<typeof createServiceClient>) {
  return service.from('followup_tasks') as any
}

const followupDatetime = (msg = '时间格式错误') => z
  .string()
  .max(40)
  .refine(v => !Number.isNaN(new Date(v).getTime()), msg)

/** 批量回填客户/宠物/负责人名称,供列表与详情展示 */
async function enrichFollowups(
  service: ReturnType<typeof createServiceClient>,
  rows: Array<Record<string, any>>,
): Promise<Record<string, any>[]> {
  if (rows.length === 0) {
    return []
  }
  const customerIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))]
  const petIds = [...new Set(rows.map(r => r.pet_id).filter(Boolean))]
  const empIds = [...new Set(rows.map(r => r.assignee_employee_id).filter(Boolean))]

  const [custRes, petRes, empRes] = await Promise.all([
    service.from('customers').select('id, name, customer_no, phone').in('id', customerIds),
    petIds.length > 0
      ? service.from('pets').select('id, name, species').in('id', petIds)
      : Promise.resolve({ data: [] }),
    empIds.length > 0
      ? service.from('employees').select('id, name, title').in('id', empIds)
      : Promise.resolve({ data: [] }),
  ])

  const cMap = new Map((custRes.data ?? []).map(c => [c.id, c]))
  const pMap = new Map((petRes.data ?? []).map(p => [p.id, p]))
  const eMap = new Map((empRes.data ?? []).map(e => [e.id, e]))

  return rows.map(r => ({
    ...r,
    customer_name: r.customer_id ? (cMap.get(r.customer_id)?.name ?? null) : null,
    customer_no: r.customer_id ? (cMap.get(r.customer_id)?.customer_no ?? null) : null,
    customer_phone: r.customer_id ? (cMap.get(r.customer_id)?.phone ?? null) : null,
    pet_name: r.pet_id ? (pMap.get(r.pet_id)?.name ?? null) : null,
    pet_species: r.pet_id ? (pMap.get(r.pet_id)?.species ?? null) : null,
    assignee_name: r.assignee_employee_id ? (eMap.get(r.assignee_employee_id)?.name ?? null) : null,
  }))
}

const followupListSchema = z.object({
  // 时间桶:逾期/今天/未来/已完成/全部;与 status 二选一,status 优先
  bucket: z.enum(['overdue', 'today', 'upcoming', 'finished', 'all']).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
  keyword: z.string().max(100).optional(),
  customerId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})

/**
 * 回访任务列表
 * - 权限:followup.view
 * - 支持时间桶/状态/客户关键词/负责人/门店筛选,服务端聚合客户/宠物/负责人名称
 */
customerRoutes.get('/followups', async (c) => {
  const input = followupListSchema.parse(c.req.query())

  const scope = await requireScopedPermission(c, {
    code: 'followup.view',
    tenantId: getContext(c).memberships[0]?.tenant_id ?? '',
    storeId: input.storeId,
  })

  const service = createServiceClient()
  let query = followupTable(service)
    .select(followupSelect, { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.storeId) {
    query = query.eq('store_id', input.storeId)
  }
  if (input.customerId) {
    query = query.eq('customer_id', input.customerId)
  }
  if (input.assigneeId) {
    query = query.eq('assignee_employee_id', input.assigneeId)
  }
  if (input.keyword) {
    const k = input.keyword.trim()
    if (!k) {
      return ok(c, { list: [], total: 0, page: input.page, pageSize: input.pageSize })
    }
    const { data: matched } = await service
      .from('customers')
      .select('id')
      .eq('tenant_id', scope.tenantId)
      .or(`name.ilike.%${k}%,phone.ilike.%${k}%,customer_no.ilike.%${k}%`)
      .limit(200)
    const ids = (matched ?? []).map((m: any) => m.id)
    if (ids.length === 0) {
      return ok(c, { list: [], total: 0, page: input.page, pageSize: input.pageSize })
    }
    query = query.in('customer_id', ids)
  }

  const now = new Date()
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  let statusFilter: string[] | null = null
  if (input.status) {
    statusFilter = [input.status]
  }
  else {
    switch (input.bucket ?? 'all') {
      case 'overdue':
        query = query.in('status', ['pending', 'in_progress']).lt('scheduled_at', now.toISOString())
        break
      case 'today':
        query = query
          .in('status', ['pending', 'in_progress'])
          .gte('scheduled_at', dayStart.toISOString())
          .lt('scheduled_at', dayEnd.toISOString())
        break
      case 'upcoming':
        query = query
          .in('status', ['pending', 'in_progress'])
          .gte('scheduled_at', dayEnd.toISOString())
        break
      case 'finished':
        statusFilter = ['completed', 'cancelled']
        break
      default:
        break
    }
  }
  if (statusFilter) {
    query = query.in('status', statusFilter)
  }

  const from = (input.page - 1) * input.pageSize
  const finished = input.status === 'completed' || input.status === 'cancelled' || input.bucket === 'finished'
  if (finished) {
    query = query.order('completed_at', { ascending: false, nullsFirst: false })
  }
  else {
    query = query.order('scheduled_at', { ascending: true })
  }
  const { data, error, count } = await query.range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询回访任务失败: ${error.message}`)
  }

  const enriched = await enrichFollowups(service, (data ?? []) as Array<Record<string, any>>)
  return ok(c, { list: enriched, total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

const followupCreateSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  customerId: z.string().uuid('客户 id 格式错误'),
  petId: z.string().uuid().optional(),
  sourceType: z.enum(['manual', 'encounter', 'discharge', 'reminder', 'complaint']).optional().default('manual'),
  sourceId: z.string().uuid().optional(),
  taskType: z.enum(['post_visit', 'post_discharge', 'medication', 'recheck', 'customer_care', 'other']).optional().default('customer_care'),
  scheduledAt: followupDatetime().optional(),
  assigneeEmployeeId: z.string().uuid().optional(),
  channel: z.enum(['phone', 'wechat', 'sms', 'in_person', 'other']).optional(),
})

/**
 * 创建回访任务
 * - 权限:followup.manage
 * - 仅支持手动创建;encounter/discharge 自动触发走 Handoff 由对应域 Owner 集成
 */
customerRoutes.post('/followups', async (c) => {
  const input = await parseJsonBody(c, followupCreateSchema)

  // P0-02 scoped:校验目标客户属于输入租户/门店,防跨租户创建
  const service = createServiceClient()
  const { data: customer, error: custError } = await service
    .from('customers')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.customerId)
    .maybeSingle()
  if (custError || !customer) {
    throw err.notFound('客户不存在')
  }
  if (customer.status === 'archived' || customer.status === 'merged') {
    throw err.conflict('客户已归档或已合并,不可创建回访')
  }
  const scope = await requireScopedPermission(c, {
    code: 'followup.manage',
    tenantId: customer.tenant_id,
    storeId: input.storeId ?? customer.store_id ?? undefined,
  })

  const user = c.get('user')
  const { data, error: insertError } = await followupTable(service)
    .insert({
      tenant_id: scope.tenantId,
      store_id: scope.storeId ?? null,
      customer_id: input.customerId,
      pet_id: input.petId ?? null,
      source_type: input.sourceType,
      source_id: input.sourceId ?? null,
      task_type: input.taskType,
      scheduled_at: input.scheduledAt ? new Date(input.scheduledAt).toISOString() : new Date().toISOString(),
      assignee_employee_id: input.assigneeEmployeeId ?? null,
      channel: input.channel ?? null,
      status: 'pending',
      created_by: user.id,
    })
    .select(followupSelect)
    .single()

  if (insertError) {
    throw err.internal(`创建回访任务失败: ${insertError.message}`)
  }

  await writeAudit(c, {
    action: 'followup.create',
    entityType: 'followup_task',
    entityId: data?.id,
    tenantId: scope.tenantId,
    storeId: scope.storeId,
    metadata: {
      customerId: input.customerId,
      petId: input.petId ?? null,
      taskType: input.taskType,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      scheduledAt: data?.scheduled_at,
      assigneeEmployeeId: input.assigneeEmployeeId ?? null,
    },
  })

  const [enriched] = await enrichFollowups(service, [data as Record<string, any>])
  return ok(c, enriched)
})

/** 回访详情(S3.1-AGENT-04) */
customerRoutes.get('/followups/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const { data: row, error } = await followupTable(service)
    .select(followupSelect)
    .eq('id', id)
    .maybeSingle()

  if (error || !row) {
    throw err.notFound('回访任务不存在')
  }

  await requireScopedPermission(c, {
    code: 'followup.view',
    tenantId: row.tenant_id,
    storeId: row.store_id ?? undefined,
  })

  const [enriched] = await enrichFollowups(service, [row as Record<string, any>])
  return ok(c, enriched)
})

const followupUpdateSchema = z.object({
  scheduledAt: followupDatetime().optional(),
  assigneeEmployeeId: z.string().uuid().optional().nullable(),
  channel: z.enum(['phone', 'wechat', 'sms', 'in_person', 'other']).optional().nullable(),
  taskType: z.enum(['post_visit', 'post_discharge', 'medication', 'recheck', 'customer_care', 'other']).optional(),
})

/**
 * 更新回访任务(仅 pending 可改:改期/改负责人/改渠道/改类型)
 * - 权限:followup.manage
 */
customerRoutes.patch('/followups/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, followupUpdateSchema)

  const service = createServiceClient()
  const { data: existing, error: fetchError } = await followupTable(service)
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('回访任务不存在')
  }
  await requireScopedPermission(c, {
    code: 'followup.manage',
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
  })
  if (existing.status !== 'pending') {
    throw err.conflict('仅待处理回访可修改,请先取消或完成后重新创建')
  }

  const patch: Record<string, any> = { updated_at: new Date().toISOString() }
  if (input.scheduledAt !== undefined) {
    patch.scheduled_at = new Date(input.scheduledAt).toISOString()
  }
  if (input.assigneeEmployeeId !== undefined) {
    patch.assignee_employee_id = input.assigneeEmployeeId
  }
  if (input.channel !== undefined) {
    patch.channel = input.channel
  }
  if (input.taskType !== undefined) {
    patch.task_type = input.taskType
  }

  const { data, error: updateError } = await followupTable(service)
    .update(patch)
    .eq('id', id)
    .select(followupSelect)
    .single()

  if (updateError) {
    throw err.internal(`更新回访任务失败: ${updateError.message}`)
  }

  await writeAudit(c, {
    action: 'followup.update',
    entityType: 'followup_task',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
    metadata: patch,
  })

  const [enriched] = await enrichFollowups(service, [data as Record<string, any>])
  return ok(c, enriched)
})

/**
 * 开始回访(pending → in_progress)
 * - 权限:followup.manage
 */
customerRoutes.post('/followups/:id/start', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const { data: existing, error: fetchError } = await followupTable(service)
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('回访任务不存在')
  }
  await requireScopedPermission(c, {
    code: 'followup.manage',
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
  })
  if (existing.status !== 'pending') {
    throw err.conflict('仅待处理回访可开始')
  }

  const { data, error: updateError } = await followupTable(service)
    .update({ status: 'in_progress', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(followupSelect)
    .single()

  if (updateError) {
    throw err.internal(`开始回访失败: ${updateError.message}`)
  }

  await writeAudit(c, {
    action: 'followup.start',
    entityType: 'followup_task',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
    metadata: {},
  })

  const [enriched] = await enrichFollowups(service, [data as Record<string, any>])
  return ok(c, enriched)
})

const followupCompleteSchema = z.object({
  resultCode: z.enum(['contacted', 'unreachable', 'rescheduled', 'other']).optional(),
  resultNote: z.string().max(1000).optional(),
  nextFollowupAt: followupDatetime().optional().nullable(),
})

/**
 * 登记回访结果(in_progress → completed)
 * - 权限:followup.complete
 * - 完成必须登记 result(resultCode 或 resultNote 至少其一)
 * - 消息发送成功 ≠ 回访完成
 */
customerRoutes.post('/followups/:id/complete', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, followupCompleteSchema)

  if (!input.resultCode && !input.resultNote) {
    throw err.badRequest('完成回访必须登记结果')
  }

  const service = createServiceClient()
  const { data: existing, error: fetchError } = await followupTable(service)
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('回访任务不存在')
  }
  await requireScopedPermission(c, {
    code: 'followup.complete',
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
  })
  if (existing.status !== 'in_progress') {
    throw err.conflict('仅进行中的回访可登记结果')
  }

  const user = c.get('user')
  const { data, error: updateError } = await followupTable(service)
    .update({
      status: 'completed',
      result_code: input.resultCode ?? null,
      result_note: input.resultNote ?? null,
      completed_at: new Date().toISOString(),
      completed_by: user.id,
      next_followup_at: input.nextFollowupAt ? new Date(input.nextFollowupAt).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(followupSelect)
    .single()

  if (updateError) {
    throw err.internal(`登记回访结果失败: ${updateError.message}`)
  }

  await writeAudit(c, {
    action: 'followup.complete',
    entityType: 'followup_task',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
    metadata: {
      resultCode: input.resultCode ?? null,
      resultNote: input.resultNote ?? null,
      nextFollowupAt: data?.next_followup_at ?? null,
    },
  })

  const [enriched] = await enrichFollowups(service, [data as Record<string, any>])
  return ok(c, enriched)
})

const followupCancelSchema = z.object({
  reason: z.string().min(1, '取消必须填写原因').max(500),
})

/**
 * 取消回访(pending/in_progress → cancelled)
 * - 权限:followup.manage
 * - 取消必须给原因
 */
customerRoutes.post('/followups/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, followupCancelSchema)

  const service = createServiceClient()
  const { data: existing, error: fetchError } = await followupTable(service)
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('回访任务不存在')
  }
  await requireScopedPermission(c, {
    code: 'followup.manage',
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
  })
  if (existing.status === 'completed' || existing.status === 'cancelled') {
    throw err.conflict('已完成或已取消的回访不可再取消')
  }

  const { data, error: updateError } = await followupTable(service)
    .update({
      status: 'cancelled',
      cancel_reason: input.reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(followupSelect)
    .single()

  if (updateError) {
    throw err.internal(`取消回访失败: ${updateError.message}`)
  }

  await writeAudit(c, {
    action: 'followup.cancel',
    entityType: 'followup_task',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
    metadata: { reason: input.reason },
  })

  const [enriched] = await enrichFollowups(service, [data as Record<string, any>])
  return ok(c, enriched)
})

/**
 * 客户详情(MXQ-5002 / MXQ-5004)
 * - 权限:customer.view
 * - 返回客户基本信息 + 宠物列表
 */
customerRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const { data: customer, error } = await service
    .from('customers')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !customer) {
    throw err.notFound('客户不存在')
  }

  // P0-02 scoped:按客户租户/门店做作用域授权
  await requireScopedPermission(c, {
    code: 'customer.view',
    tenantId: customer.tenant_id,
    storeId: customer.store_id ?? undefined,
  })

  // 并行查询宠物列表
  const { data: pets, error: petsError } = await service
    .from('pets')
    .select('id, name, species, breed, gender, birth_date, weight, is_neutered, color, status, photo_file_id, risk_tags')
    .eq('customer_id', id)
    .order('created_at', { ascending: true })

  if (petsError) {
    throw err.internal(`查询宠物列表失败: ${petsError.message}`)
  }

  return ok(c, { customer, pets: pets ?? [] })
})

/**
 * 客户 360 聚合(S3.1-AGENT-04)
 * - 权限:customer.view
 * - 返回客户 + 宠物 + 最近就诊 + 最近消费 + 回访任务(替代"就诊历史开发中"占位)
 * - 只读聚合,不修改任何临床/计费数据
 */
customerRoutes.get('/:id/360', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const { data: customer, error } = await service
    .from('customers')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !customer) {
    throw err.notFound('客户不存在')
  }

  await requireScopedPermission(c, {
    code: 'customer.view',
    tenantId: customer.tenant_id,
    storeId: customer.store_id ?? undefined,
  })

  const [petsRes, visitsRes, invoicesRes, followupsRes, followupCount] = await Promise.all([
    service
      .from('pets')
      .select('id, name, species, breed, gender, birth_date, weight, status, photo_file_id')
      .eq('customer_id', id)
      .order('created_at', { ascending: true }),
    service
      .from('encounters')
      .select('id, pet_id, started_at, ended_at, status, chief_complaint, follow_up_date, doctor_id')
      .eq('customer_id', id)
      .order('started_at', { ascending: false })
      .limit(10),
    service
      .from('invoices')
      .select('id, invoice_no, total, paid_amount, status, created_at')
      .eq('customer_id', id)
      .order('created_at', { ascending: false })
      .limit(10),
    followupTable(service)
      .select(followupSelect)
      .eq('customer_id', id)
      .order('scheduled_at', { ascending: false })
      .limit(10),
    followupTable(service)
      .select('status')
      .eq('customer_id', id),
  ])

  if (petsRes.error || visitsRes.error || invoicesRes.error || followupsRes.error || followupCount.error) {
    throw err.internal('查询客户 360 聚合失败')
  }

  const statusCounts: Record<string, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  }
  ;(followupCount.data ?? []).forEach((row: any) => {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1
  })

  const followups = await enrichFollowups(service, (followupsRes.data ?? []) as Array<Record<string, any>>)

  return ok(c, {
    customer,
    pets: petsRes.data ?? [],
    recentEncounters: visitsRes.data ?? [],
    recentInvoices: invoicesRes.data ?? [],
    followups,
    followupCounts: statusCounts,
  })
})

const createSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  name: z.string().min(1, '客户姓名不能为空').max(100),
  gender: z.enum(['male', 'female', 'unknown']).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email('邮箱格式错误').optional().or(z.literal('')),
  address: z.string().max(500).optional(),
  birthday: z.string().date().optional(),
  source: z.string().max(50).optional(),
  memberLevel: z.enum(['normal', 'silver', 'gold', 'diamond']).optional(),
  remark: z.string().max(1000).optional(),
  customerNo: z.string().max(50).optional(),
})

/**
 * 创建客户(MXQ-5002)
 * - 权限:customer.create
 * - 行为:调 create_customer RPC(自动生成 customer_no)
 */
customerRoutes.post('/', async (c) => {
  const input = await parseJsonBody(c, createSchema)

  // P0-02 scoped:按输入租户/门店做作用域授权
  const scope = await requireScopedPermission(c, {
    code: 'customer.create',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })

  const service = createServiceClient()
  const _user = c.get('user')
  const { data, error: rpcError } = await service.rpc('create_customer', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_name: input.name,
    p_gender: input.gender ?? null,
    p_phone: input.phone ?? null,
    p_email: input.email || null,
    p_address: input.address ?? null,
    p_birthday: input.birthday ?? null,
    p_source: input.source ?? null,
    p_member_level: input.memberLevel ?? 'normal',
    p_remark: input.remark ?? null,
    p_customer_no: input.customerNo ?? null,
  })

  if (rpcError) {
    throw err.internal(`创建客户失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'customer.create',
    entityType: 'customer',
    entityId: data?.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { name: input.name, customerNo: data?.customer_no },
  })

  return ok(c, data)
})

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  gender: z.enum(['male', 'female', 'unknown']).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email('邮箱格式错误').optional().or(z.literal('')),
  address: z.string().max(500).optional(),
  birthday: z.string().date().optional(),
  source: z.string().max(50).optional(),
  memberLevel: z.enum(['normal', 'silver', 'gold', 'diamond']).optional(),
  memberPoints: z.number().int().min(0).optional(),
  balance: z.number().min(0).optional(),
  remark: z.string().max(1000).optional(),
})

/**
 * 更新客户(MXQ-5002)
 * - 权限:customer.update
 * - 行为:调 update_customer RPC(仅 active 客户可改)
 */
customerRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateSchema)

  const service = createServiceClient()

  // 先取记录做门店范围校验
  const { data: existing, error: fetchError } = await service
    .from('customers')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('客户不存在')
  }
  // P0-02 scoped:按客户租户/门店做作用域授权
  await requireScopedPermission(c, {
    code: 'customer.update',
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
  })

  const { data, error: rpcError } = await service.rpc('update_customer', {
    p_customer_id: id,
    p_name: input.name ?? null,
    p_gender: input.gender ?? null,
    p_phone: input.phone ?? null,
    p_email: input.email || null,
    p_address: input.address ?? null,
    p_birthday: input.birthday ?? null,
    p_source: input.source ?? null,
    p_member_level: input.memberLevel ?? null,
    p_member_points: input.memberPoints ?? null,
    p_balance: input.balance ?? null,
    p_remark: input.remark ?? null,
  })

  if (rpcError) {
    if (rpcError.message.includes('CUSTOMER_NOT_FOUND')) {
      throw err.notFound('客户不存在')
    }
    if (rpcError.message.includes('CUSTOMER_NOT_ACTIVE')) {
      throw err.conflict('客户已归档或已合并,不可修改')
    }
    throw err.internal(`更新客户失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'customer.update',
    entityType: 'customer',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
    metadata: input,
  })

  return ok(c, data)
})

const archiveSchema = z.object({
  reason: z.string().max(500).optional(),
})

/**
 * 归档客户(MXQ-5002)
 * - 权限:customer.archive
 * - 行为:调 archive_customer RPC,active → archived
 */
customerRoutes.post('/:id/archive', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, archiveSchema)

  const service = createServiceClient()
  const user = c.get('user')

  const { data: existing, error: fetchError } = await service
    .from('customers')
    .select('id, tenant_id, store_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('客户不存在')
  }
  // P0-02 scoped:按客户租户/门店做作用域授权
  await requireScopedPermission(c, {
    code: 'customer.archive',
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
  })

  const { data, error: rpcError } = await service.rpc('archive_customer', {
    p_customer_id: id,
    p_archived_by: user.id,
    p_reason: input.reason ?? null,
  })

  if (rpcError) {
    if (rpcError.message.includes('CUSTOMER_NOT_FOUND')) {
      throw err.notFound('客户不存在')
    }
    if (rpcError.message.includes('CUSTOMER_ALREADY_ARCHIVED')) {
      throw err.conflict('客户已归档')
    }
    if (rpcError.message.includes('CUSTOMER_ALREADY_MERGED')) {
      throw err.conflict('客户已合并,不可归档')
    }
    throw err.internal(`归档客户失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'customer.archive',
    entityType: 'customer',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
    metadata: { reason: input.reason },
  })

  return ok(c, data)
})

const mergeSchema = z.object({
  sourceId: z.string().uuid('源客户 id 格式错误'),
  targetId: z.string().uuid('目标客户 id 格式错误'),
})

/**
 * 合并客户(MXQ-5009)
 * - 权限:customer.merge
 * - 行为:调 merge_customers RPC,事务化迁移宠物/附件/积分/余额,源客户标记 merged
 * - 限制:同租户、两者均 active、不可自合并
 */
customerRoutes.post('/merge', async (c) => {
  const input = await parseJsonBody(c, mergeSchema)

  const service = createServiceClient()
  const user = c.get('user')

  // P0-02 scoped:先查源客户获取租户/门店,再做作用域授权(防跨租户合并)
  const { data: source, error: sourceError } = await service
    .from('customers')
    .select('id, tenant_id, store_id')
    .eq('id', input.sourceId)
    .maybeSingle()

  if (sourceError || !source) {
    throw err.notFound('源客户不存在')
  }
  await requireScopedPermission(c, {
    code: 'customer.merge',
    tenantId: source.tenant_id,
    storeId: source.store_id ?? undefined,
  })

  const { data, error: rpcError } = await service.rpc('merge_customers', {
    p_source_id: input.sourceId,
    p_target_id: input.targetId,
    p_operator_id: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('SOURCE_NOT_FOUND') || rpcError.message.includes('TARGET_NOT_FOUND')) {
      throw err.notFound('客户不存在')
    }
    if (rpcError.message.includes('MERGE_SAME_CUSTOMER')) {
      throw err.badRequest('不可合并同一客户')
    }
    if (rpcError.message.includes('SOURCE_NOT_ACTIVE') || rpcError.message.includes('TARGET_NOT_ACTIVE')) {
      throw err.conflict('仅活跃客户可合并')
    }
    if (rpcError.message.includes('MERGE_TENANT_MISMATCH')) {
      throw err.badRequest('跨租户客户不可合并')
    }
    throw err.internal(`合并客户失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'customer.merge',
    entityType: 'customer',
    entityId: input.targetId,
    metadata: { sourceId: input.sourceId, targetId: input.targetId },
  })

  return ok(c, data)
})

const batchImportRowSchema = z.object({
  name: z.string().min(1, '姓名不能为空').max(100),
  gender: z.enum(['male', 'female', 'unknown']).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().max(500).optional(),
  birthday: z.string().date().optional(),
  source: z.string().max(50).optional(),
  memberLevel: z.enum(['normal', 'silver', 'gold', 'diamond']).optional(),
  remark: z.string().max(1000).optional(),
})

const batchImportSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  rows: z.array(batchImportRowSchema).min(1, '导入数据不能为空').max(500, '单次最多导入 500 行'),
})

/**
 * 批量导入客户(MXQ-5010)
 * - 权限:customer.import
 * - 行为:逐行调 create_customer RPC,收集成功/失败结果
 * - 不做整事务(部分成功可用),失败行返回错误原因
 */
customerRoutes.post('/batch-import', async (c) => {
  const input = await parseJsonBody(c, batchImportSchema)

  // P0-02 scoped:按输入租户/门店做作用域授权
  const scope = await requireScopedPermission(c, {
    code: 'customer.import',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })

  const service = createServiceClient()
  const results: Array<{ rowIndex: number, success: boolean, customerId?: string, customerNo?: string, error?: string }> = []

  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i]
    const { data, error: rpcError } = await service.rpc('create_customer', {
      p_tenant_id: scope.tenantId,
      p_store_id: scope.storeId ?? null,
      p_name: row.name,
      p_gender: row.gender ?? null,
      p_phone: row.phone ?? null,
      p_email: row.email || null,
      p_address: row.address ?? null,
      p_birthday: row.birthday ?? null,
      p_source: row.source ?? 'import',
      p_member_level: row.memberLevel ?? 'normal',
      p_remark: row.remark ?? null,
    })

    if (rpcError) {
      results.push({ rowIndex: i, success: false, error: rpcError.message })
    }
    else {
      results.push({ rowIndex: i, success: true, customerId: data?.id, customerNo: data?.customer_no })
    }
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.length - succeeded

  await writeAudit(c, {
    action: 'customer.batchImport',
    entityType: 'customer',
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { total: results.length, succeeded, failed },
  })

  return ok(c, { total: results.length, succeeded, failed, results })
})

const importSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  fileId: z.string().uuid().optional(),
  totalRows: z.number().int().nonnegative().default(0),
})

/**
 * 创建导入任务(MXQ-5010)
 * - 权限:customer.import
 * - 行为:调 create_import_job RPC,创建 pending 状态的导入任务
 * - 文件上传走 files 模块(前端先上传再传 fileId)
 */
customerRoutes.post('/import', async (c) => {
  const input = await parseJsonBody(c, importSchema)

  // P0-02 scoped:按输入租户/门店做作用域授权
  const scope = await requireScopedPermission(c, {
    code: 'customer.import',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error: rpcError } = await service.rpc('create_import_job', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_type: 'customer',
    p_total_rows: input.totalRows,
    p_source_file_id: input.fileId ?? null,
    p_created_by: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('INVALID_IMPORT_TYPE')) {
      throw err.badRequest('导入类型无效')
    }
    throw err.internal(`创建导入任务失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'customer.import.create',
    entityType: 'import_job',
    entityId: data?.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { type: 'customer', totalRows: input.totalRows, fileId: input.fileId },
  })

  return ok(c, data)
})

/**
 * 查询导入任务状态(MXQ-5010)
 * - 权限:customer.import
 * - 返回导入任务详情(含进度)
 */
customerRoutes.get('/import/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const { data: job, error } = await service
    .from('import_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !job) {
    throw err.notFound('导入任务不存在')
  }

  // P0-02 scoped:按任务租户/门店做作用域授权
  await requireScopedPermission(c, {
    code: 'customer.import',
    tenantId: job.tenant_id,
    storeId: job.store_id ?? undefined,
  })

  return ok(c, job)
})

export default customerRoutes
