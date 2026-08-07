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
 * 宠物 CRM 路由(MXQ-5006 / MXQ-5008 / MXQ-5010)
 *
 * 分层:
 *   - Query(list/detail/weights):Hono 聚合查询 + pet.view 权限
 *   - Command(create/update/archive/add-weight):Hono 调 PostgreSQL RPC,禁止前端直连写
 *
 * 状态机:
 *   active → deceased(死亡) / lost(走失) / archived(归档)
 *   deceased/lost/archived 不可再变更(仅可归档归档态以外的状态)
 *
 * 体重记录(pet_weights):
 *   - create_pet / update_pet 体重变化时自动落记录
 *   - 也提供独立的 add-weight / list-weights 接口供体检/就诊录入
 */
const petRoutes = new Hono<AppEnv>()

petRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const listSchema = z.object({
  customerId: z.string().uuid('客户 id 格式错误'),
  status: z.enum(['active', 'deceased', 'lost', 'archived']).optional(),
})

/**
 * 宠物列表(按客户)(MXQ-5006)
 * - 权限:pet.view
 * - 查询指定客户下的宠物列表
 */
petRoutes.get('/', async (c) => {
  const input = listSchema.parse(c.req.query())

  const service = createServiceClient()

  // 先取客户做门店范围校验
  const { data: customer, error: custError } = await service
    .from('customers')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.customerId)
    .maybeSingle()

  if (custError || !customer) {
    throw err.notFound('客户不存在')
  }
  // P0-02 scoped:按客户租户/门店做作用域授权
  const scope = await requireScopedPermission(c, {
    code: 'pet.view',
    tenantId: customer.tenant_id,
    storeId: customer.store_id ?? undefined,
  })

  let query = service
    .from('pets')
    .select('*')
    .eq('customer_id', input.customerId)
    .eq('tenant_id', scope.tenantId)

  if (input.status) {
    query = query.eq('status', input.status)
  }
  else {
    query = query.neq('status', 'archived')
  }

  const { data, error } = await query.order('created_at', { ascending: true })

  if (error) {
    throw err.internal(`查询宠物列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [] })
})

/**
 * 宠物详情(MXQ-5006 / MXQ-5007)
 * - 权限:pet.view
 * - 返回宠物基本信息 + 最近体重记录(用于趋势展示)
 */
petRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  const { data: pet, error } = await service
    .from('pets')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !pet) {
    throw err.notFound('宠物不存在')
  }

  // 取客户做门店范围校验
  const { data: customer } = await service
    .from('customers')
    .select('id, tenant_id, store_id')
    .eq('id', pet.customer_id)
    .maybeSingle()

  // P0-02 scoped:按宠物租户/门店做作用域授权(客户缺失时仍校验租户)
  await requireScopedPermission(c, {
    code: 'pet.view',
    tenantId: pet.tenant_id,
    storeId: customer?.store_id ?? undefined,
  })

  // 最近 30 条体重记录(按时间倒序)
  const { data: weights, error: weightsError } = await service
    .from('pet_weights')
    .select('id, weight, recorded_at, recorded_by, note')
    .eq('pet_id', id)
    .order('recorded_at', { ascending: false })
    .limit(30)

  if (weightsError) {
    throw err.internal(`查询体重记录失败: ${weightsError.message}`)
  }

  return ok(c, { pet, weights: weights ?? [] })
})

const createSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
  name: z.string().min(1, '宠物名称不能为空').max(100),
  species: z.string().max(50).optional(),
  breed: z.string().max(100).optional(),
  gender: z.enum(['male', 'female', 'unknown']).optional(),
  birthDate: z.string().date().optional(),
  weight: z.number().positive().max(9999).optional(),
  isNeutered: z.boolean().optional(),
  microchip: z.string().max(50).optional(),
  color: z.string().max(50).optional(),
  photoFileId: z.string().uuid().optional(),
  riskTags: z.array(z.string().max(50)).max(20).optional(),
  temperament: z.string().max(500).optional(),
  medicalNotes: z.string().max(2000).optional(),
})

/**
 * 创建宠物(MXQ-5006)
 * - 权限:pet.create
 * - 行为:调 create_pet RPC(若提供初始体重,同步落体重记录)
 */
petRoutes.post('/', async (c) => {
  const input = await parseJsonBody(c, createSchema)

  const service = createServiceClient()

  // 校验客户归属与门店范围
  const { data: customer, error: custError } = await service
    .from('customers')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.customerId)
    .maybeSingle()

  if (custError || !customer) {
    throw err.notFound('客户不存在')
  }
  if (customer.status !== 'active') {
    throw err.conflict('客户已归档或已合并,不可新增宠物')
  }
  // P0-02 scoped:按输入租户 + 客户门店做作用域授权
  const scope = await requireScopedPermission(c, {
    code: 'pet.create',
    tenantId: input.tenantId,
    storeId: customer.store_id ?? undefined,
  })

  const { data, error: rpcError } = await service.rpc('create_pet', {
    p_tenant_id: scope.tenantId,
    p_customer_id: input.customerId,
    p_name: input.name,
    p_species: input.species ?? null,
    p_breed: input.breed ?? null,
    p_gender: input.gender ?? null,
    p_birth_date: input.birthDate ?? null,
    p_weight: input.weight ?? null,
    p_is_neutered: input.isNeutered ?? false,
    p_microchip: input.microchip ?? null,
    p_color: input.color ?? null,
    p_photo_file_id: input.photoFileId ?? null,
    p_risk_tags: input.riskTags ?? [],
    p_temperament: input.temperament ?? null,
    p_medical_notes: input.medicalNotes ?? null,
  })

  if (rpcError) {
    if (rpcError.message.includes('CUSTOMER_NOT_FOUND')) {
      throw err.notFound('客户不存在')
    }
    if (rpcError.message.includes('PET_TENANT_MISMATCH')) {
      throw err.badRequest('宠物与客户租户不匹配')
    }
    throw err.internal(`创建宠物失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'pet.create',
    entityType: 'pet',
    entityId: data?.id,
    tenantId: input.tenantId,
    storeId: customer.store_id ?? undefined,
    metadata: { name: input.name, customerId: input.customerId },
  })

  return ok(c, data)
})

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  species: z.string().max(50).optional(),
  breed: z.string().max(100).optional(),
  gender: z.enum(['male', 'female', 'unknown']).optional(),
  birthDate: z.string().date().optional(),
  weight: z.number().positive().max(9999).optional(),
  isNeutered: z.boolean().optional(),
  microchip: z.string().max(50).optional(),
  color: z.string().max(50).optional(),
  photoFileId: z.string().uuid().optional(),
  riskTags: z.array(z.string().max(50)).max(20).optional(),
  temperament: z.string().max(500).optional(),
  medicalNotes: z.string().max(2000).optional(),
  status: z.enum(['active', 'deceased', 'lost', 'archived']).optional(),
})

/**
 * 更新宠物(MXQ-5006 / MXQ-5008)
 * - 权限:pet.update
 * - 行为:调 update_pet RPC(体重变化时自动落体重记录)
 * - risk_tags 通过 riskTags 字段管理(过敏/攻击性/慢性病等)
 */
petRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateSchema)

  const service = createServiceClient()

  const { data: existing, error: fetchError } = await service
    .from('pets')
    .select('id, tenant_id, customer_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('宠物不存在')
  }

  const { data: customer } = await service
    .from('customers')
    .select('id, store_id')
    .eq('id', existing.customer_id)
    .maybeSingle()
  // P0-02 scoped:按宠物租户/门店做作用域授权
  await requireScopedPermission(c, {
    code: 'pet.update',
    tenantId: existing.tenant_id,
    storeId: customer?.store_id ?? undefined,
  })

  const { data, error: rpcError } = await service.rpc('update_pet', {
    p_pet_id: id,
    p_name: input.name ?? null,
    p_species: input.species ?? null,
    p_breed: input.breed ?? null,
    p_gender: input.gender ?? null,
    p_birth_date: input.birthDate ?? null,
    p_weight: input.weight ?? null,
    p_is_neutered: input.isNeutered ?? null,
    p_microchip: input.microchip ?? null,
    p_color: input.color ?? null,
    p_photo_file_id: input.photoFileId ?? null,
    p_risk_tags: input.riskTags ?? null,
    p_temperament: input.temperament ?? null,
    p_medical_notes: input.medicalNotes ?? null,
    p_status: input.status ?? null,
  })

  if (rpcError) {
    if (rpcError.message.includes('PET_NOT_FOUND')) {
      throw err.notFound('宠物不存在')
    }
    if (rpcError.message.includes('PET_ALREADY_ARCHIVED')) {
      throw err.conflict('宠物已归档,不可修改')
    }
    throw err.internal(`更新宠物失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'pet.update',
    entityType: 'pet',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: customer?.store_id ?? undefined,
    metadata: input,
  })

  return ok(c, data)
})

const archiveSchema = z.object({
  reason: z.string().max(500).optional(),
})

/**
 * 归档宠物(MXQ-5006)
 * - 权限:pet.update(归档视为更新操作)
 * - 行为:调 archive_pet RPC,active/deceased/lost → archived
 */
petRoutes.post('/:id/archive', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, archiveSchema)

  const service = createServiceClient()
  const user = c.get('user')

  const { data: existing, error: fetchError } = await service
    .from('pets')
    .select('id, tenant_id, customer_id, status')
    .eq('id', id)
    .maybeSingle()

  if (fetchError || !existing) {
    throw err.notFound('宠物不存在')
  }

  // 取客户做门店范围校验
  const { data: customer } = await service
    .from('customers')
    .select('id, store_id')
    .eq('id', existing.customer_id)
    .maybeSingle()
  // P0-02 scoped:按宠物租户/门店做作用域授权
  await requireScopedPermission(c, {
    code: 'pet.update',
    tenantId: existing.tenant_id,
    storeId: customer?.store_id ?? undefined,
  })

  const { data, error: rpcError } = await service.rpc('archive_pet', {
    p_pet_id: id,
    p_archived_by: user.id,
    p_reason: input.reason ?? null,
  })

  if (rpcError) {
    if (rpcError.message.includes('PET_NOT_FOUND')) {
      throw err.notFound('宠物不存在')
    }
    if (rpcError.message.includes('PET_ALREADY_ARCHIVED')) {
      throw err.conflict('宠物已归档')
    }
    throw err.internal(`归档宠物失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'pet.archive',
    entityType: 'pet',
    entityId: id,
    tenantId: existing.tenant_id,
    storeId: customer?.store_id ?? undefined,
    metadata: { reason: input.reason },
  })

  return ok(c, data)
})

export default petRoutes
