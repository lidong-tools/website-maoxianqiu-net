import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { requirePermission } from '../lib/permission'
import { loadContext } from '../lib/request-context'
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
  await requirePermission(c, { code: 'customer.view', storeId: input.storeId })

  const service = createServiceClient()
  let query = service
    .from('customers')
    .select('id, customer_no, name, gender, phone, email, store_id, member_level, member_points, balance, status, created_at, updated_at, archived_at', { count: 'exact' })

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

/**
 * 客户详情(MXQ-5002 / MXQ-5004)
 * - 权限:customer.view
 * - 返回客户基本信息 + 宠物列表
 */
customerRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  await requirePermission(c, { code: 'customer.view' })

  const service = createServiceClient()
  const { data: customer, error } = await service
    .from('customers')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !customer) {
    throw err.notFound('客户不存在')
  }

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
  await requirePermission(c, { code: 'customer.create', storeId: input.storeId })

  const service = createServiceClient()
  const _user = c.get('user')
  const { data, error: rpcError } = await service.rpc('create_customer', {
    p_tenant_id: input.tenantId,
    p_store_id: input.storeId ?? null,
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
  await requirePermission(c, { code: 'customer.update' })

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
  await requirePermission(c, { code: 'customer.update', storeId: existing.store_id ?? undefined })

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
  await requirePermission(c, { code: 'customer.archive' })

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
  await requirePermission(c, { code: 'customer.archive', storeId: existing.store_id ?? undefined })

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
  await requirePermission(c, { code: 'customer.merge' })

  const service = createServiceClient()
  const user = c.get('user')

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
  await requirePermission(c, { code: 'customer.import', storeId: input.storeId })

  const service = createServiceClient()
  const results: Array<{ rowIndex: number, success: boolean, customerId?: string, customerNo?: string, error?: string }> = []

  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i]
    const { data, error: rpcError } = await service.rpc('create_customer', {
      p_tenant_id: input.tenantId,
      p_store_id: input.storeId ?? null,
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
  await requirePermission(c, { code: 'customer.import', storeId: input.storeId })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error: rpcError } = await service.rpc('create_import_job', {
    p_tenant_id: input.tenantId,
    p_store_id: input.storeId ?? null,
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
  await requirePermission(c, { code: 'customer.import' })

  const service = createServiceClient()
  const { data: job, error } = await service
    .from('import_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !job) {
    throw err.notFound('导入任务不存在')
  }

  // 门店范围校验
  if (job.store_id) {
    await requirePermission(c, { code: 'customer.import', storeId: job.store_id })
  }

  return ok(c, job)
})

export default customerRoutes
