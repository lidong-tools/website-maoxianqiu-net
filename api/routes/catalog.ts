import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext, resolveRequestedTenant } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'
import { safeFilename, toCsv } from '../services/analytics/csv.js'

/**
 * Catalog 领域路由(MXQ-6001~6010)
 *
 * 分层:
 *   - 批量迁移(MXQ-6005):Hono Command + migrate_catalog_to_store RPC,跨表事务
 *   - 问诊问题库 / 诊断字典 / 检验 panel/analyte:Hono 聚合 CRUD(统一鉴权 + 审计)
 *   - 类目维护:Hono Command + PostgreSQL RPC(三级树约束、幂等、原子拖拽排序)
 *   - 统一目录 / 门店价格 / 药品疫苗扩展:前端直连,RLS 兜底
 *
 * 状态机:
 *   - catalog_items.is_active:active ↔ inactive
 *   - store_catalog_items.is_active:active ↔ inactive
 */
const catalogRoutes = new Hono<AppEnv>()

catalogRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

// ==================== MXQ-6001 三级类目树 ====================

const categoryIdempotencySchema = z.object({
  idempotencyKey: z.string().min(1).max(200).optional(),
})

/** 类目命令必须携带幂等键,避免重复点击造成重复节点或重复排序。 */
function resolveCategoryIdempotencyKey(c: Parameters<typeof getRequestIdempotencyKey>[0], bodyKey?: string): string {
  const key = getRequestIdempotencyKey(c) || bodyKey || ''
  if (!key) {
    throw err.badRequest('缺少幂等键(Idempotency-Key header 或 body.idempotencyKey)')
  }
  return key
}

/** 将类目 RPC 的业务异常转换为稳定的 HTTP 语义。 */
function throwCategoryRpcError(message: string): never {
  if (message.includes('CATEGORY_NOT_FOUND') || message.includes('PARENT_NOT_FOUND')) {
    throw err.notFound('类目或父类目不存在')
  }
  if (message.includes('CATEGORY_CODE_EXISTS')) {
    throw err.conflict('类目编码已存在')
  }
  if (message.includes('CATEGORY_NOT_EMPTY')) {
    throw err.conflict('类目下仍有子类目或目录项,请先迁移或删除后再操作')
  }
  if (message.includes('CATEGORY_MAX_DEPTH')) {
    throw err.unprocessable('类目最多支持三级,当前拖拽位置超出层级限制')
  }
  if (message.includes('CATEGORY_CYCLE')) {
    throw err.unprocessable('不能将类目移动到自身或其子类目下')
  }
  if (message.includes('CATEGORY_TENANT_MISMATCH')) {
    throw err.forbidden('父子类目必须属于同一租户')
  }
  throw err.internal(`维护类目失败: ${message}`)
}

const categoryListSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
})

/** 查询租户类目,按父级与顺序返回扁平数据,由独立树组件组装。 */
catalogRoutes.get('/categories', async (c) => {
  const input = categoryListSchema.parse(c.req.query())
  const scope = await requireScopedPermission(c, { code: 'catalog.view', tenantId: input.tenantId })
  const service = createServiceClient()
  const { data, error } = await service
    .from('catalog_categories')
    .select('*')
    .eq('tenant_id', scope.tenantId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) {
    throw err.internal(`查询类目失败: ${error.message}`)
  }
  return ok(c, data ?? [])
})

const createCategorySchema = categoryIdempotencySchema.extend({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().trim().min(1, '编码不能为空').max(50).regex(/^[a-z0-9][\w-]*$/i, '编码仅支持字母、数字、下划线和连字符'),
  name: z.string().trim().min(1, '名称不能为空').max(100),
  parentId: z.string().uuid('父类目 id 格式错误').nullable().optional(),
})

/** 创建类目,层级和同租户约束由 RPC 在事务内校验。 */
catalogRoutes.post('/categories', async (c) => {
  const input = await parseJsonBody(c, createCategorySchema)
  const scope = await requireScopedPermission(c, { code: 'catalog.manage', tenantId: input.tenantId })
  const idempotencyKey = resolveCategoryIdempotencyKey(c, input.idempotencyKey)
  const service = createServiceClient()
  const user = c.get('user')
  const { data, error } = await service.rpc('catalog_category_command', {
    p_tenant_id: scope.tenantId,
    p_action: 'create',
    p_category_id: null,
    p_code: input.code,
    p_name: input.name,
    p_parent_id: input.parentId ?? null,
    p_is_active: null,
    p_position: null,
    p_idempotency_key: idempotencyKey,
    p_operator_id: user.id,
  })
  if (error) {
    throwCategoryRpcError(error.message)
  }
  const result = data as { id?: string }
  await writeAudit(c, {
    action: 'catalog.category.create',
    entityType: 'catalog_categories',
    entityId: result.id,
    tenantId: scope.tenantId,
    idempotencyKey,
    metadata: { code: input.code, parentId: input.parentId ?? null },
  })
  return ok(c, result)
})

const updateCategorySchema = categoryIdempotencySchema.extend({
  tenantId: z.string().uuid('租户 id 格式错误'),
  name: z.string().trim().min(1, '名称不能为空').max(100).optional(),
  isActive: z.boolean().optional(),
}).refine(input => input.name !== undefined || input.isActive !== undefined, '至少提供一个需要修改的字段')

/** 编辑类目基础信息;树位置统一通过 move 命令维护。 */
catalogRoutes.patch('/categories/:id', async (c) => {
  const id = z.string().uuid('类目 id 格式错误').parse(c.req.param('id'))
  const input = await parseJsonBody(c, updateCategorySchema)
  const scope = await requireScopedPermission(c, { code: 'catalog.manage', tenantId: input.tenantId })
  const idempotencyKey = resolveCategoryIdempotencyKey(c, input.idempotencyKey)
  const service = createServiceClient()
  const user = c.get('user')
  const { data, error } = await service.rpc('catalog_category_command', {
    p_tenant_id: scope.tenantId,
    p_action: 'update',
    p_category_id: id,
    p_code: null,
    p_name: input.name ?? null,
    p_parent_id: null,
    p_is_active: input.isActive ?? null,
    p_position: null,
    p_idempotency_key: idempotencyKey,
    p_operator_id: user.id,
  })
  if (error) {
    throwCategoryRpcError(error.message)
  }
  await writeAudit(c, {
    action: 'catalog.category.update',
    entityType: 'catalog_categories',
    entityId: id,
    tenantId: scope.tenantId,
    idempotencyKey,
    metadata: input,
  })
  return ok(c, data)
})

const moveCategorySchema = categoryIdempotencySchema.extend({
  tenantId: z.string().uuid('租户 id 格式错误'),
  categoryId: z.string().uuid('类目 id 格式错误'),
  parentId: z.string().uuid('父类目 id 格式错误').nullable(),
  position: z.number().int().min(0),
})

/** 拖拽移动类目,在单个 RPC 事务中锁定并规范化新旧同级顺序。 */
catalogRoutes.post('/categories/move', async (c) => {
  const input = await parseJsonBody(c, moveCategorySchema)
  const scope = await requireScopedPermission(c, { code: 'catalog.manage', tenantId: input.tenantId })
  const idempotencyKey = resolveCategoryIdempotencyKey(c, input.idempotencyKey)
  const service = createServiceClient()
  const user = c.get('user')
  const { data, error } = await service.rpc('catalog_category_command', {
    p_tenant_id: scope.tenantId,
    p_action: 'move',
    p_category_id: input.categoryId,
    p_code: null,
    p_name: null,
    p_parent_id: input.parentId,
    p_is_active: null,
    p_position: input.position,
    p_idempotency_key: idempotencyKey,
    p_operator_id: user.id,
  })
  if (error) {
    throwCategoryRpcError(error.message)
  }
  await writeAudit(c, {
    action: 'catalog.category.move',
    entityType: 'catalog_categories',
    entityId: input.categoryId,
    tenantId: scope.tenantId,
    idempotencyKey,
    metadata: { parentId: input.parentId, position: input.position },
  })
  return ok(c, data)
})

/** 删除空类目;数据库 FK 与 RPC 双重阻止误删非空分支。 */
catalogRoutes.delete('/categories/:id', async (c) => {
  const id = z.string().uuid('类目 id 格式错误').parse(c.req.param('id'))
  const input = await parseJsonBody(c, categoryIdempotencySchema.extend({
    tenantId: z.string().uuid('租户 id 格式错误'),
  }))
  const scope = await requireScopedPermission(c, { code: 'catalog.manage', tenantId: input.tenantId })
  const idempotencyKey = resolveCategoryIdempotencyKey(c, input.idempotencyKey)
  const service = createServiceClient()
  const user = c.get('user')
  const { data, error } = await service.rpc('catalog_category_command', {
    p_tenant_id: scope.tenantId,
    p_action: 'delete',
    p_category_id: id,
    p_code: null,
    p_name: null,
    p_parent_id: null,
    p_is_active: null,
    p_position: null,
    p_idempotency_key: idempotencyKey,
    p_operator_id: user.id,
  })
  if (error) {
    throwCategoryRpcError(error.message)
  }
  await writeAudit(c, {
    action: 'catalog.category.delete',
    entityType: 'catalog_categories',
    entityId: id,
    tenantId: scope.tenantId,
    idempotencyKey,
  })
  return ok(c, data)
})

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

// ==================== MXQ-6005 目录项跨类目批量迁移(B-R-1) ====================

const migrateItemsSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  sourceCategoryId: z.string().uuid('来源类目 id 格式错误'),
  itemIds: z.array(z.string().uuid('项目 id 格式错误')).min(1, '至少选择一个项目').max(500, '单次最多迁移 500 个项目'),
  targetCategoryId: z.string().uuid('目标类目 id 格式错误'),
})

/**
 * 目录项跨类目批量迁移(MXQ-6005,B-R-1)
 * - 权限:catalog.manage
 * - 行为:调 catalog_items_bulk_migrate RPC,事务内校验目标类目同租户、项目属于来源类目,
 *   批量 UPDATE catalog_items.category_id 并写审计日志(含跨租户目标类目拒绝)
 */
catalogRoutes.post('/items/migrate', async (c) => {
  const input = await parseJsonBody(c, migrateItemsSchema)
  // P0-02 scoped:租户作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, { code: 'catalog.manage', tenantId: input.tenantId })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error: rpcError } = await service.rpc('catalog_items_bulk_migrate', {
    p_tenant_id: scope.tenantId,
    p_source_category_id: input.sourceCategoryId,
    p_item_ids: input.itemIds,
    p_target_category_id: input.targetCategoryId,
    p_operator_id: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('SOURCE_CATEGORY_NOT_FOUND')) {
      throw err.notFound('来源类目不存在或不属于当前租户')
    }
    if (rpcError.message.includes('TARGET_CATEGORY_NOT_FOUND')) {
      throw err.forbidden('目标类目不存在或不属于当前租户')
    }
    throw err.internal(`批量迁移失败: ${rpcError.message}`)
  }

  // RPC 返回 returns table,数据为数组,取首行
  const row = Array.isArray(data) ? data[0] : data

  await writeAudit(c, {
    action: 'catalog.itemsBulkMigrate',
    entityType: 'catalog_items',
    tenantId: input.tenantId,
    metadata: {
      sourceCategoryId: input.sourceCategoryId,
      targetCategoryId: input.targetCategoryId,
      itemIds: input.itemIds,
      migratedCount: Number(row?.migrated_count ?? 0),
      skippedCount: Number(row?.skipped_count ?? 0),
    },
  })

  return ok(c, {
    migratedCount: Number(row?.migrated_count ?? 0),
    skippedCount: Number(row?.skipped_count ?? 0),
    totalCount: Number(row?.total_count ?? 0),
  })
})

// ==================== MXQ-6005 目录导出(B-R-3) ====================

const exportItemsSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  categoryId: z.string().uuid('类目 id 格式错误').optional(),
  keyword: z.string().max(100).optional(),
  billingType: z.string().max(50).optional(),
})

/** 收费类型中文标签(导出文件用) */
const EXPORT_BILLING_TYPE_LABELS: Record<string, string> = {
  service: '服务',
  product: '商品',
  drug: '药品',
  vaccine: '疫苗',
  exam: '检验',
  hospitalization: '住院费',
  boarding: '寄养费',
}

/**
 * 目录导出 CSV(B-R-3)
 * - 权限:catalog.view
 * - 按当前筛选条件(类目/关键词/收费类型)导出,复用 csv.ts 生成 CSV(UTF-8 BOM)
 * - 导出字段:编码/名称/类目/收费类型/单位/售价/成本价/状态/规格/厂家/条码
 */
catalogRoutes.get('/export', async (c) => {
  const input = exportItemsSchema.parse(c.req.query())
  const scope = await requireScopedPermission(c, {
    code: 'catalog.view',
    tenantId: resolveRequestedTenant(c, input.tenantId) ?? '',
  })

  const service = createServiceClient()
  let query = service
    .from('catalog_items')
    .select(`
      code, name, unit, default_price, cost_price, is_active, billing_type, barcode, manufacturer,
      category:catalog_categories(name),
      drug_extension:catalog_drug_extensions(strength, manufacturer, barcode),
      vaccine_extension:catalog_vaccine_extensions(manufacturer)
    `)
    .eq('tenant_id', scope.tenantId)

  if (input.categoryId) {
    query = query.eq('category_id', input.categoryId)
  }
  if (input.billingType) {
    query = query.eq('billing_type', input.billingType)
  }
  if (input.keyword) {
    query = query.or(`name.ilike.%${input.keyword}%,code.ilike.%${input.keyword}%`)
  }
  query = query.order('created_at', { ascending: true }).limit(10000)

  const { data, error } = await query
  if (error) {
    throw err.internal(`导出目录失败: ${error.message}`)
  }

  const rows = (data ?? []).map((item: any) => ({
    code: item.code ?? '',
    name: item.name ?? '',
    category: item.category?.name ?? '未分类',
    billingType: EXPORT_BILLING_TYPE_LABELS[item.billing_type] ?? item.billing_type ?? '',
    unit: item.unit ?? '',
    defaultPrice: item.default_price ?? 0,
    costPrice: item.cost_price ?? 0,
    status: item.is_active ? '启用' : '停用',
    strength: item.drug_extension?.strength ?? '',
    manufacturer: item.manufacturer ?? item.drug_extension?.manufacturer ?? item.vaccine_extension?.manufacturer ?? '',
    barcode: item.barcode ?? item.drug_extension?.barcode ?? '',
  }))

  const csv = toCsv([
    { label: '编码', key: 'code' },
    { label: '名称', key: 'name' },
    { label: '类目', key: 'category' },
    { label: '收费类型', key: 'billingType' },
    { label: '单位', key: 'unit' },
    { label: '售价', key: 'defaultPrice' },
    { label: '成本价', key: 'costPrice' },
    { label: '状态', key: 'status' },
    { label: '规格', key: 'strength' },
    { label: '厂家', key: 'manufacturer' },
    { label: '条码', key: 'barcode' },
  ], rows)

  const filename = safeFilename(`catalog-export-${new Date().toISOString().slice(0, 10)}`)
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}.csv"`,
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
    .select('*, catalog_item:catalog_items(id, code, name)', { count: 'exact' })
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
  catalogItemId: z.string().uuid('关联收费项 id 格式错误').nullable().optional(),
})

/**
 * 创建检验 panel(MXQ-6009)
 * - 权限:catalog.manage
 * - catalogItemId:关联收费目录项(billing_type=exam),panel 组合的收费入口
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
      catalog_item_id: input.catalogItemId ?? null,
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
  catalogItemId: z.string().uuid('关联收费项 id 格式错误').nullable().optional(),
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
  if (input.catalogItemId !== undefined) {
    patch.catalog_item_id = input.catalogItemId
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
  reportTemplate: z.string().max(1000).optional(),
  isOutsourced: z.boolean().default(false),
  sortOrder: z.number().int().min(0).default(0),
})

/**
 * 创建检验 analyte(MXQ-6009)
 * - 权限:catalog.manage
 * - reportTemplate:报告模板;isOutsourced:是否外送检测
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
      report_template: input.reportTemplate ?? null,
      is_outsourced: input.isOutsourced,
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
  reportTemplate: z.string().max(1000).optional(),
  isOutsourced: z.boolean().optional(),
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
  if (input.reportTemplate !== undefined) {
    patch.report_template = input.reportTemplate
  }
  if (input.isOutsourced !== undefined) {
    patch.is_outsourced = input.isOutsourced
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
