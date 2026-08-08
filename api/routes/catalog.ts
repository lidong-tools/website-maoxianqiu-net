import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import { loadContext, resolveRequestedTenant } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * Catalog 领域路由(MXQ-6001~6010)
 *
 * 分层:
 *   - 批量迁移(MXQ-6005):Hono Command + migrate_catalog_to_store RPC,跨表事务
 *   - 问诊问题库 / 诊断字典 / 检验 panel/analyte:Hono 聚合 CRUD(统一鉴权 + 审计)
 *   - 类目 / 统一目录 / 门店价格 / 药品疫苗扩展:前端直连,RLS 兜底,不走本路由
 *
 * 状态机:
 *   - catalog_items.is_active:active ↔ inactive
 *   - store_catalog_items.is_active:active ↔ inactive
 */
const catalogRoutes = new Hono<AppEnv>()

catalogRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

// ==================== MXQ-6005 批量迁移 ====================

const migrateSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  categoryCode: z.string().max(50).optional(),
})

/**
 * 批量迁移租户目录到门店(MXQ-6005)
 * - 权限:catalog.storePrice.manage
 * - 行为:调 migrate_catalog_to_store RPC,事务化批量插入 store_catalog_items(幂等)
 * - 门店不存在或已归档时返回 404
 */
catalogRoutes.post('/migrate-to-store', async (c) => {
  const input = await parseJsonBody(c, migrateSchema)
  // P0-02 scoped:租户/门店作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'catalog.storePrice.manage',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error: rpcError } = await service.rpc('migrate_catalog_to_store', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_category_code: input.categoryCode ?? null,
    p_operator_id: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('STORE_NOT_FOUND')) {
      throw err.notFound('门店不存在或已归档')
    }
    throw err.internal(`批量迁移失败: ${rpcError.message}`)
  }

  // RPC 返回 returns table,数据为数组,取首行
  const row = Array.isArray(data) ? data[0] : data

  await writeAudit(c, {
    action: 'catalog.migrateToStore',
    entityType: 'store_catalog_items',
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: {
      categoryCode: input.categoryCode,
      insertedCount: row?.inserted_count ?? 0,
      totalCount: row?.total_count ?? 0,
    },
  })

  return ok(c, {
    insertedCount: Number(row?.inserted_count ?? 0),
    skippedCount: Number(row?.skipped_count ?? 0),
    totalCount: Number(row?.total_count ?? 0),
  })
})

// ==================== MXQ-6007 问诊问题库 ====================

const intakeQuestionListSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  category: z.string().max(50).optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
})

/**
 * 问诊问题列表(MXQ-6007)
 * - 权限:catalog.view
 * - 走 service client 聚合查询
 */
catalogRoutes.get('/intake-questions', async (c) => {
  const input = intakeQuestionListSchema.parse(c.req.query())
  // P0-02 scoped:校验 tenant 归属,缺失时取调用者默认租户
  const scope = await requireScopedPermission(c, {
    code: 'catalog.view',
    tenantId: resolveRequestedTenant(c, input.tenantId) ?? '',
  })

  const service = createServiceClient()
  let query = service
    .from('intake_questions')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.category) {
    query = query.eq('category', input.category)
  }
  if (input.isActive !== undefined) {
    query = query.eq('is_active', input.isActive)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询问诊问题失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

const createIntakeQuestionSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  category: z.string().min(1, '分类不能为空').max(50),
  question: z.string().min(1, '问题不能为空').max(500),
  sortOrder: z.number().int().min(0).default(0),
})

/**
 * 创建问诊问题(MXQ-6007)
 * - 权限:catalog.manage
 */
catalogRoutes.post('/intake-questions', async (c) => {
  const input = await parseJsonBody(c, createIntakeQuestionSchema)
  // P0-02 scoped:租户作用域授权(含跨租户隔离校验),替代 requirePermission + assertTenantAccess
  const scope = await requireScopedPermission(c, { code: 'catalog.manage', tenantId: input.tenantId })

  const service = createServiceClient()
  const { data, error } = await service
    .from('intake_questions')
    .insert({
      tenant_id: scope.tenantId,
      category: input.category,
      question: input.question,
      sort_order: input.sortOrder,
    })
    .select()
    .single()

  if (error) {
    throw err.internal(`创建问诊问题失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'catalog.intakeQuestion.create',
    entityType: 'intake_questions',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { category: input.category },
  })

  return ok(c, data)
})

const updateIntakeQuestionSchema = z.object({
  category: z.string().min(1).max(50).optional(),
  question: z.string().min(1).max(500).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
})

/**
 * 更新问诊问题(MXQ-6007)
 * - 权限:catalog.manage
 */
catalogRoutes.patch('/intake-questions/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateIntakeQuestionSchema)

  const patch: Record<string, string | number | boolean> = {}
  if (input.category !== undefined) {
    patch.category = input.category
  }
  if (input.question !== undefined) {
    patch.question = input.question
  }
  if (input.sortOrder !== undefined) {
    patch.sort_order = input.sortOrder
  }
  if (input.isActive !== undefined) {
    patch.is_active = input.isActive
  }

  const service = createServiceClient()
  // 跨租户隔离:先查记录归属再校验调用者访问权
  const { data: existing, error: findErr } = await service
    .from('intake_questions')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (findErr || !existing) {
    throw err.notFound('问诊问题不存在')
  }
  // P0-02 scoped:按实体租户做作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, { code: 'catalog.manage', tenantId: existing.tenant_id })

  const { data, error } = await service
    .from('intake_questions')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle()

  if (error) {
    throw err.internal(`更新问诊问题失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('问诊问题不存在')
  }

  await writeAudit(c, {
    action: 'catalog.intakeQuestion.update',
    entityType: 'intake_questions',
    entityId: id,
    metadata: input,
  })

  return ok(c, data)
})

/**
 * 删除问诊问题(MXQ-6007)
 * - 权限:catalog.manage
 */
catalogRoutes.delete('/intake-questions/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  // 跨租户隔离:先查记录归属再校验调用者访问权
  const { data: existing, error: findErr } = await service
    .from('intake_questions')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (findErr || !existing) {
    throw err.notFound('问诊问题不存在')
  }
  // P0-02 scoped:按实体租户做作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, { code: 'catalog.manage', tenantId: existing.tenant_id })

  const { error } = await service.from('intake_questions').delete().eq('id', id)
  if (error) {
    throw err.internal(`删除问诊问题失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'catalog.intakeQuestion.delete',
    entityType: 'intake_questions',
    entityId: id,
  })

  return ok(c, { isSuccess: true })
})

// ==================== MXQ-6008 诊断字典 ====================

const diagnosisListSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  keyword: z.string().max(100).optional(),
  category: z.string().max(50).optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
})

/**
 * 诊断字典列表(MXQ-6008)
 * - 权限:catalog.view
 */
catalogRoutes.get('/diagnosis-dict', async (c) => {
  const input = diagnosisListSchema.parse(c.req.query())
  // P0-02 scoped:校验 tenant 归属,缺失时取调用者默认租户
  const scope = await requireScopedPermission(c, {
    code: 'catalog.view',
    tenantId: resolveRequestedTenant(c, input.tenantId) ?? '',
  })

  const service = createServiceClient()
  let query = service
    .from('diagnosis_dict')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.category) {
    query = query.eq('category', input.category)
  }
  if (input.isActive !== undefined) {
    query = query.eq('is_active', input.isActive)
  }
  if (input.keyword) {
    query = query.or(`name.ilike.%${input.keyword}%,code.ilike.%${input.keyword}%`)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('code', { ascending: true })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询诊断字典失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

const createDiagnosisSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().min(1, '编码不能为空').max(50),
  name: z.string().min(1, '名称不能为空').max(100),
  category: z.string().max(50).optional(),
  description: z.string().max(1000).optional(),
})

/**
 * 创建诊断字典(MXQ-6008)
 * - 权限:catalog.manage
 */
catalogRoutes.post('/diagnosis-dict', async (c) => {
  const input = await parseJsonBody(c, createDiagnosisSchema)
  // P0-02 scoped:租户作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, { code: 'catalog.manage', tenantId: input.tenantId })

  const service = createServiceClient()
  const { data, error } = await service
    .from('diagnosis_dict')
    .insert({
      tenant_id: scope.tenantId,
      code: input.code,
      name: input.name,
      category: input.category ?? null,
      description: input.description ?? null,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      throw err.conflict('诊断编码已存在')
    }
    throw err.internal(`创建诊断字典失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'catalog.diagnosis.create',
    entityType: 'diagnosis_dict',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { code: input.code },
  })

  return ok(c, data)
})

const updateDiagnosisSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  category: z.string().max(50).optional(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
})

/**
 * 更新诊断字典(MXQ-6008)
 * - 权限:catalog.manage
 */
catalogRoutes.patch('/diagnosis-dict/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateDiagnosisSchema)

  const patch: Record<string, string | boolean | null> = {}
  if (input.name !== undefined) {
    patch.name = input.name
  }
  if (input.category !== undefined) {
    patch.category = input.category
  }
  if (input.description !== undefined) {
    patch.description = input.description
  }
  if (input.isActive !== undefined) {
    patch.is_active = input.isActive
  }

  const service = createServiceClient()
  // 跨租户隔离:先查记录归属再校验调用者访问权
  const { data: existing, error: findErr } = await service
    .from('diagnosis_dict')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (findErr || !existing) {
    throw err.notFound('诊断字典不存在')
  }
  // P0-02 scoped:按实体租户做作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, { code: 'catalog.manage', tenantId: existing.tenant_id })

  const { data, error } = await service
    .from('diagnosis_dict')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle()

  if (error) {
    throw err.internal(`更新诊断字典失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('诊断字典不存在')
  }

  await writeAudit(c, {
    action: 'catalog.diagnosis.update',
    entityType: 'diagnosis_dict',
    entityId: id,
    metadata: input,
  })

  return ok(c, data)
})

/**
 * 删除诊断字典(MXQ-6008)
 * - 权限:catalog.manage
 */
catalogRoutes.delete('/diagnosis-dict/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  // 跨租户隔离:先查记录归属再校验调用者访问权
  const { data: existing, error: findErr } = await service
    .from('diagnosis_dict')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (findErr || !existing) {
    throw err.notFound('诊断字典不存在')
  }
  // P0-02 scoped:按实体租户做作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, { code: 'catalog.manage', tenantId: existing.tenant_id })

  const { error } = await service.from('diagnosis_dict').delete().eq('id', id)
  if (error) {
    throw err.internal(`删除诊断字典失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'catalog.diagnosis.delete',
    entityType: 'diagnosis_dict',
    entityId: id,
  })

  return ok(c, { isSuccess: true })
})

// ==================== MXQ-6009 检验 panel ====================

const labPanelListSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  category: z.enum(['blood', 'urine', 'biochem', 'endocrine', 'other']).optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
})

/**
 * 检验 panel 列表(MXQ-6009)
 * - 权限:catalog.view
 */
catalogRoutes.get('/lab-panels', async (c) => {
  const input = labPanelListSchema.parse(c.req.query())
  // P0-02 scoped:校验 tenant 归属,缺失时取调用者默认租户
  const scope = await requireScopedPermission(c, {
    code: 'catalog.view',
    tenantId: resolveRequestedTenant(c, input.tenantId) ?? '',
  })

  const service = createServiceClient()
  let query = service
    .from('lab_panels')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)

  if (input.category) {
    query = query.eq('category', input.category)
  }
  if (input.isActive !== undefined) {
    query = query.eq('is_active', input.isActive)
  }

  const from = (input.page - 1) * input.pageSize
  const { data, error, count } = await query
    .order('code', { ascending: true })
    .range(from, from + input.pageSize - 1)

  if (error) {
    throw err.internal(`查询检验 panel 失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0, page: input.page, pageSize: input.pageSize })
})

const createLabPanelSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().min(1, '编码不能为空').max(50),
  name: z.string().min(1, '名称不能为空').max(100),
  category: z.enum(['blood', 'urine', 'biochem', 'endocrine', 'other']).default('other'),
  sampleType: z.string().max(50).optional(),
})

/**
 * 创建检验 panel(MXQ-6009)
 * - 权限:catalog.manage
 */
catalogRoutes.post('/lab-panels', async (c) => {
  const input = await parseJsonBody(c, createLabPanelSchema)
  // P0-02 scoped:租户作用域授权(含跨租户隔离校验),替代 requirePermission + assertTenantAccess
  const scope = await requireScopedPermission(c, { code: 'catalog.manage', tenantId: input.tenantId })

  const service = createServiceClient()
  const { data, error } = await service
    .from('lab_panels')
    .insert({
      tenant_id: scope.tenantId,
      code: input.code,
      name: input.name,
      category: input.category,
      sample_type: input.sampleType ?? null,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      throw err.conflict('检验 panel 编码已存在')
    }
    throw err.internal(`创建检验 panel 失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'catalog.labPanel.create',
    entityType: 'lab_panels',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { code: input.code, category: input.category },
  })

  return ok(c, data)
})

const updateLabPanelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  category: z.enum(['blood', 'urine', 'biochem', 'endocrine', 'other']).optional(),
  sampleType: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
})

/**
 * 更新检验 panel(MXQ-6009)
 * - 权限:catalog.manage
 */
catalogRoutes.patch('/lab-panels/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateLabPanelSchema)

  const patch: Record<string, string | boolean | null> = {}
  if (input.name !== undefined) {
    patch.name = input.name
  }
  if (input.category !== undefined) {
    patch.category = input.category
  }
  if (input.sampleType !== undefined) {
    patch.sample_type = input.sampleType
  }
  if (input.isActive !== undefined) {
    patch.is_active = input.isActive
  }

  const service = createServiceClient()
  // 跨租户隔离:先查记录归属再校验调用者访问权
  const { data: existing, error: findErr } = await service
    .from('lab_panels')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (findErr || !existing) {
    throw err.notFound('检验 panel 不存在')
  }
  // P0-02 scoped:按实体租户做作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, { code: 'catalog.manage', tenantId: existing.tenant_id })

  const { data, error } = await service
    .from('lab_panels')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle()

  if (error) {
    throw err.internal(`更新检验 panel 失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('检验 panel 不存在')
  }

  await writeAudit(c, {
    action: 'catalog.labPanel.update',
    entityType: 'lab_panels',
    entityId: id,
    metadata: input,
  })

  return ok(c, data)
})

/**
 * 删除检验 panel(MXQ-6009)
 * - 权限:catalog.manage
 * - 级联删除 panel 下的 analytes(on delete cascade)
 */
catalogRoutes.delete('/lab-panels/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  // 跨租户隔离:先查记录归属再校验调用者访问权
  const { data: existing, error: findErr } = await service
    .from('lab_panels')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (findErr || !existing) {
    throw err.notFound('检验 panel 不存在')
  }
  // P0-02 scoped:按实体租户做作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, { code: 'catalog.manage', tenantId: existing.tenant_id })

  const { error } = await service.from('lab_panels').delete().eq('id', id)
  if (error) {
    throw err.internal(`删除检验 panel 失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'catalog.labPanel.delete',
    entityType: 'lab_panels',
    entityId: id,
  })

  return ok(c, { isSuccess: true })
})

// ==================== MXQ-6009 检验 analyte ====================

const labAnalyteListSchema = z.object({
  panelId: z.string().uuid('panel id 格式错误'),
})

/**
 * 检验 analyte 列表(MXQ-6009)
 * - 权限:catalog.view
 * - 按 panelId 查询
 */
catalogRoutes.get('/lab-analytes', async (c) => {
  const input = labAnalyteListSchema.parse(c.req.query())
  // P0-02 scoped:无 tenantId 参数,以调用者默认租户做作用域授权
  await requireScopedPermission(c, {
    code: 'catalog.view',
    tenantId: resolveRequestedTenant(c) ?? '',
  })

  const service = createServiceClient()
  const { data, error } = await service
    .from('lab_analytes')
    .select('*')
    .eq('panel_id', input.panelId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    throw err.internal(`查询检验 analyte 失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [] })
})

const createLabAnalyteSchema = z.object({
  panelId: z.string().uuid('panel id 格式错误'),
  code: z.string().min(1, '编码不能为空').max(50),
  name: z.string().min(1, '名称不能为空').max(100),
  unit: z.string().max(50).optional(),
  refRangeLow: z.number().nullable().optional(),
  refRangeHigh: z.number().nullable().optional(),
  refRangeText: z.string().max(200).optional(),
  isCritical: z.boolean().default(false),
  sortOrder: z.number().int().min(0).default(0),
})

/**
 * 创建检验 analyte(MXQ-6009)
 * - 权限:catalog.manage
 */
catalogRoutes.post('/lab-analytes', async (c) => {
  const input = await parseJsonBody(c, createLabAnalyteSchema)

  const service = createServiceClient()
  // 跨租户隔离:通过 panel 归属校验调用者租户访问权
  const { data: panel, error: panelErr } = await service
    .from('lab_panels')
    .select('tenant_id')
    .eq('id', input.panelId)
    .maybeSingle()
  if (panelErr || !panel) {
    throw err.notFound('检验 panel 不存在')
  }
  // P0-02 scoped:按 panel 租户做作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, { code: 'catalog.manage', tenantId: panel.tenant_id })

  const { data, error } = await service
    .from('lab_analytes')
    .insert({
      panel_id: input.panelId,
      code: input.code,
      name: input.name,
      unit: input.unit ?? null,
      ref_range_low: input.refRangeLow ?? null,
      ref_range_high: input.refRangeHigh ?? null,
      ref_range_text: input.refRangeText ?? null,
      is_critical: input.isCritical,
      sort_order: input.sortOrder,
    })
    .select()
    .single()

  if (error) {
    throw err.internal(`创建检验 analyte 失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'catalog.labAnalyte.create',
    entityType: 'lab_analytes',
    entityId: data.id,
    metadata: { panelId: input.panelId, code: input.code },
  })

  return ok(c, data)
})

const updateLabAnalyteSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  unit: z.string().max(50).optional(),
  refRangeLow: z.number().nullable().optional(),
  refRangeHigh: z.number().nullable().optional(),
  refRangeText: z.string().max(200).optional(),
  isCritical: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

/**
 * 更新检验 analyte(MXQ-6009)
 * - 权限:catalog.manage
 */
catalogRoutes.patch('/lab-analytes/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateLabAnalyteSchema)

  const patch: Record<string, string | number | boolean | null> = {}
  if (input.name !== undefined) {
    patch.name = input.name
  }
  if (input.unit !== undefined) {
    patch.unit = input.unit
  }
  if (input.refRangeLow !== undefined) {
    patch.ref_range_low = input.refRangeLow
  }
  if (input.refRangeHigh !== undefined) {
    patch.ref_range_high = input.refRangeHigh
  }
  if (input.refRangeText !== undefined) {
    patch.ref_range_text = input.refRangeText
  }
  if (input.isCritical !== undefined) {
    patch.is_critical = input.isCritical
  }
  if (input.sortOrder !== undefined) {
    patch.sort_order = input.sortOrder
  }

  const service = createServiceClient()
  // 跨租户隔离:先查 analyte 归属 panel,再校验 panel 租户访问权
  const { data: existing, error: findErr } = await service
    .from('lab_analytes')
    .select('panel_id')
    .eq('id', id)
    .maybeSingle()
  if (findErr || !existing) {
    throw err.notFound('检验 analyte 不存在')
  }
  const { data: panel, error: panelErr } = await service
    .from('lab_panels')
    .select('tenant_id')
    .eq('id', existing.panel_id)
    .maybeSingle()
  if (panelErr || !panel) {
    throw err.notFound('检验 panel 不存在')
  }
  // P0-02 scoped:按 panel 租户做作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, { code: 'catalog.manage', tenantId: panel.tenant_id })

  const { data, error } = await service
    .from('lab_analytes')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle()

  if (error) {
    throw err.internal(`更新检验 analyte 失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('检验 analyte 不存在')
  }

  await writeAudit(c, {
    action: 'catalog.labAnalyte.update',
    entityType: 'lab_analytes',
    entityId: id,
    metadata: input,
  })

  return ok(c, data)
})

/**
 * 删除检验 analyte(MXQ-6009)
 * - 权限:catalog.manage
 */
catalogRoutes.delete('/lab-analytes/:id', async (c) => {
  const id = c.req.param('id')

  const service = createServiceClient()
  // 跨租户隔离:先查 analyte 归属 panel,再校验 panel 租户访问权
  const { data: existing, error: findErr } = await service
    .from('lab_analytes')
    .select('panel_id')
    .eq('id', id)
    .maybeSingle()
  if (findErr || !existing) {
    throw err.notFound('检验 analyte 不存在')
  }
  const { data: panel, error: panelErr } = await service
    .from('lab_panels')
    .select('tenant_id')
    .eq('id', existing.panel_id)
    .maybeSingle()
  if (panelErr || !panel) {
    throw err.notFound('检验 panel 不存在')
  }
  // P0-02 scoped:按 panel 租户做作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, { code: 'catalog.manage', tenantId: panel.tenant_id })

  const { error } = await service.from('lab_analytes').delete().eq('id', id)
  if (error) {
    throw err.internal(`删除检验 analyte 失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'catalog.labAnalyte.delete',
    entityType: 'lab_analytes',
    entityId: id,
  })

  return ok(c, { isSuccess: true })
})

export default catalogRoutes
