import type { Context } from 'hono'
import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { err } from '../lib/errors.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext, resolveRequestedTenant } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * Medication Safety 用药安全域路由(Stage-04 Agent-04)
 *
 * 覆盖(深度文档 §11):
 *   GET    /medication-safety/rules                  规则列表(tenant-wide,含当前版本)
 *   POST   /medication-safety/rules                  创建规则
 *   PATCH  /medication-safety/rules/:id              更新规则(版本 +1)
 *   POST   /medication-safety/rules/:id/toggle       启停规则
 *   GET    /medication-safety/drug-profiles          药品安全档案列表
 *   POST   /medication-safety/drug-profiles          upsert 药品安全档案
 *   GET    /medication-safety/interactions           相互作用禁忌列表
 *   POST   /medication-safety/interactions           upsert 相互作用禁忌
 *   POST   /medication-safety/evaluate               对处方执行安全检查(draft/issue/dispense)
 *   GET    /medication-safety/checks?prescriptionId= 处方检查结果列表
 *   POST   /medication-safety/checks/:id/override    阻断豁免(reason 必填)
 *
 * 安全:
 *   - 查询走 supabase 直连(RLS 仅 SELECT + medication_safety.view);
 *   - 写操作走 service-role-only RPC(已登记 service-rpc-manifest);
 *   - 权限码:view / manage / override(系统角色授权见 migration 210);
 *   - 规则/档案/交互为 tenant-wide;evaluate/checks 按处方归属做作用域授权;
 *   - override 的 reason 由 DB RPC 强制必填 + 写审计。
 *
 * 注意:本文件为 Agent-04 自有路由,注册到 api/index.ts 由 Agent-09 集成
 * (INTEGRATION_REQUESTS,见 handoff)。
 */
const medicationSafetyRoutes = new Hono<AppEnv>()

medicationSafetyRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/**
 * 将用药安全 RPC 抛出的业务错误码映射为 HTTP 错误
 * - NOT_FOUND 类 → 404
 * - 状态/规则/豁免类 → 422
 * - 其余 → 500
 */
function mapRpcError(error: { message: string }) {
  const msg = error.message
  if ([
    'PRESCRIPTION_NOT_FOUND', 'CHECK_NOT_FOUND', 'RULE_NOT_FOUND',
    'CATALOG_ITEM_NOT_FOUND', 'OPERATOR_NOT_FOUND',
  ].some(k => msg.includes(k))) {
    return err.notFound('资源不存在')
  }
  if ([
    'MEDICATION_SAFETY_BLOCKED',       // 阻断检查未豁免
    'OVERRIDE_REASON_REQUIRED',        // 豁免必须填写理由
    'CHECK_NOT_TRIGGERED',             // 仅 triggered 可豁免
    'INVALID_CHECK_STAGE',
    'INVALID_RULE_TYPE',
    'INVALID_SEVERITY',
    'RULE_CODE_REQUIRED',
    'RULE_CODE_EXISTS',
    'INVALID_ROUTE',
    'INVALID_DOSE_RANGE',
    'INGREDIENT_REQUIRED',
    'SAME_INGREDIENT',
  ].some(k => msg.includes(k))) {
    return err.unprocessable(msg.replace(/^ERROR:\s*/, ''))
  }
  return err.internal(`用药安全检查失败: ${msg}`)
}

/** 规则/档案/交互的合法 rule_type(与 DB 枚举一致) */
const RULE_TYPES = [
  'duplicate_ingredient', 'duplicate_drug', 'dose_range', 'duration_limit',
  'frequency_limit', 'species_contraindication', 'age_constraint',
  'weight_constraint', 'antimicrobial_notice', 'drug_interaction',
] as const

const upsertRuleSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  ruleId: z.string().uuid('规则 id 格式错误').optional(),
  code: z.string().trim().min(1, '规则编码不能为空').max(64).optional(),
  name: z.string().trim().min(1, '规则名称不能为空').max(128).optional(),
  ruleType: z.enum(RULE_TYPES, '规则类型不合法'),
  severity: z.enum(['info', 'warning', 'error']).default('warning'),
  isBlocking: z.boolean().default(false),
  species: z.array(z.string()).default([]),
  active: z.boolean().default(true),
  condition: z.record(z.any()).default({}),
  message: z.string().max(500).optional(),
  recommendation: z.string().max(500).optional(),
})

const toggleRuleSchema = z.object({
  active: z.boolean(),
})

const drugProfileSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  catalogItemId: z.string().uuid('目录商品 id 格式错误'),
  activeIngredient: z.string().trim().max(128).optional(),
  strength: z.string().trim().max(64).optional(),
  strengthUnit: z.string().trim().max(32).optional(),
  route: z.enum(['oral', 'injection', 'topical', 'other']).optional(),
  antimicrobialClass: z.string().trim().max(64).optional(),
  minDoseMgKg: z.number().positive().optional(),
  maxDoseMgKg: z.number().positive().optional(),
  minAgeMonths: z.number().int().positive().optional(),
  maxAgeMonths: z.number().int().positive().optional(),
  minWeightKg: z.number().positive().optional(),
  maxWeightKg: z.number().positive().optional(),
  maxDurationDays: z.number().int().positive().optional(),
  speciesContraindications: z.array(z.string()).default([]),
})

const interactionSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  ingredientA: z.string().trim().min(1, '成分 A 不能为空').max(128),
  ingredientB: z.string().trim().min(1, '成分 B 不能为空').max(128),
  severity: z.enum(['info', 'warning', 'error']).default('warning'),
  description: z.string().max(500).optional(),
  active: z.boolean().default(true),
})

const evaluateSchema = z.object({
  prescriptionId: z.string().uuid('处方 id 格式错误'),
  stage: z.enum(['draft', 'issue', 'dispense']).default('draft'),
})

const overrideSchema = z.object({
  reason: z.string().trim().min(1, '豁免理由必填').max(500),
})

/**
 * 解析请求级租户作用域(显式参数 → 请求头 → memberships 兜底)
 * @param c hono context
 * @param explicitTenantId 显式 tenantId(可为空)
 * @returns 可信的 tenantId
 */
function resolveTenantScope(c: Context<AppEnv>, explicitTenantId?: string): string {
  const tenantId = resolveRequestedTenant(c, explicitTenantId)
  if (!tenantId) {
    throw err.badRequest('缺少租户上下文')
  }
  return tenantId
}

/**
 * 按处方 id 查询归属(租户/门店),作为 evaluate/checks 的作用域来源
 * @param service supabase service client
 * @param prescriptionId 处方 id
 * @returns 处方的 tenantId/storeId
 */
async function fetchPrescriptionScope(
  service: ReturnType<typeof createServiceClient>,
  prescriptionId: string,
): Promise<{ tenantId: string, storeId: string | null }> {
  const { data, error } = await service
    .from('prescriptions')
    .select('tenant_id, store_id')
    .eq('id', prescriptionId)
    .maybeSingle()
  if (error || !data) {
    throw err.notFound('处方不存在')
  }
  return { tenantId: data.tenant_id, storeId: data.store_id ?? null }
}

// ===== GET /rules 规则列表(含当前版本条件) =====
medicationSafetyRoutes.get('/rules', async (c) => {
  const tenantId = resolveTenantScope(c, c.req.query('tenantId') ?? undefined)
  const scope = await requireScopedPermission(c, {
    code: 'medication_safety.view',
    tenantId,
  })

  const service = createServiceClient()
  const { data, error } = await service
    .from('medication_safety_rules')
    .select('*, rule_versions:medication_safety_rule_versions(*)')
    .eq('tenant_id', scope.tenantId)
    .order('created_at', { ascending: false })
  if (error) {
    throw err.internal(`查询规则列表失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

// ===== POST /rules 创建规则 =====
medicationSafetyRoutes.post('/rules', async (c) => {
  const input = await parseJsonBody(c, upsertRuleSchema)
  const tenantId = resolveTenantScope(c, input.tenantId)
  const scope = await requireScopedPermission(c, { code: 'medication_safety.manage', tenantId })

  const service = createServiceClient()
  const user = c.get('user') as { id: string } | undefined
  const { data, error } = await service.rpc('upsert_medication_safety_rule', {
    p_tenant_id: scope.tenantId,
    p_rule_id: null,
    p_code: input.code,
    p_name: input.name,
    p_rule_type: input.ruleType,
    p_severity: input.severity,
    p_is_blocking: input.isBlocking,
    p_species: input.species,
    p_active: input.active,
    p_condition: input.condition,
    p_message: input.message ?? null,
    p_recommendation: input.recommendation ?? null,
    p_operator_user_id: user?.id ?? null,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, { rule: data })
})

// ===== PATCH /rules/:id 更新规则(版本 +1,append-only) =====
medicationSafetyRoutes.patch('/rules/:id', async (c) => {
  const ruleId = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/i.test(ruleId)) {
    throw err.badRequest('规则 id 格式错误')
  }
  const input = await parseJsonBody(c, upsertRuleSchema)
  const tenantId = resolveTenantScope(c, input.tenantId)
  const scope = await requireScopedPermission(c, { code: 'medication_safety.manage', tenantId })

  const service = createServiceClient()
  const user = c.get('user') as { id: string } | undefined
  const { data, error } = await service.rpc('upsert_medication_safety_rule', {
    p_tenant_id: scope.tenantId,
    p_rule_id: ruleId,
    p_code: null,
    p_name: input.name ?? null,
    p_rule_type: input.ruleType,
    p_severity: input.severity,
    p_is_blocking: input.isBlocking,
    p_species: input.species,
    p_active: input.active,
    p_condition: input.condition,
    p_message: input.message ?? null,
    p_recommendation: input.recommendation ?? null,
    p_operator_user_id: user?.id ?? null,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, { rule: data })
})

// ===== POST /rules/:id/toggle 启停规则 =====
medicationSafetyRoutes.post('/rules/:id/toggle', async (c) => {
  const ruleId = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/i.test(ruleId)) {
    throw err.badRequest('规则 id 格式错误')
  }
  const input = await parseJsonBody(c, toggleRuleSchema)
  const tenantId = resolveTenantScope(c)
  const scope = await requireScopedPermission(c, { code: 'medication_safety.manage', tenantId })

  const service = createServiceClient()
  const user = c.get('user') as { id: string } | undefined
  const { data, error } = await service.rpc('set_medication_safety_rule_active', {
    p_rule_id: ruleId,
    p_active: input.active,
    p_operator_user_id: user?.id ?? null,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, { rule: data })
})

// ===== GET /drug-profiles 药品安全档案列表 =====
medicationSafetyRoutes.get('/drug-profiles', async (c) => {
  const tenantId = resolveTenantScope(c, c.req.query('tenantId') ?? undefined)
  const scope = await requireScopedPermission(c, {
    code: 'medication_safety.view',
    tenantId,
  })

  const service = createServiceClient()
  const { data, error } = await service
    .from('drug_profiles')
    .select('*, catalog_item:catalog_items(id, code, name, unit, billing_type)')
    .eq('tenant_id', scope.tenantId)
    .order('created_at', { ascending: false })
  if (error) {
    throw err.internal(`查询药品档案失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

// ===== POST /drug-profiles upsert 药品安全档案 =====
medicationSafetyRoutes.post('/drug-profiles', async (c) => {
  const input = await parseJsonBody(c, drugProfileSchema)
  const tenantId = resolveTenantScope(c, input.tenantId)
  const scope = await requireScopedPermission(c, { code: 'medication_safety.manage', tenantId })

  const service = createServiceClient()
  const user = c.get('user') as { id: string } | undefined
  const { data, error } = await service.rpc('upsert_drug_profile', {
    p_tenant_id: scope.tenantId,
    p_catalog_item_id: input.catalogItemId,
    p_active_ingredient: input.activeIngredient ?? null,
    p_strength: input.strength ?? null,
    p_strength_unit: input.strengthUnit ?? null,
    p_route: input.route ?? null,
    p_antimicrobial_class: input.antimicrobialClass ?? null,
    p_min_dose_mg_kg: input.minDoseMgKg ?? null,
    p_max_dose_mg_kg: input.maxDoseMgKg ?? null,
    p_min_age_months: input.minAgeMonths ?? null,
    p_max_age_months: input.maxAgeMonths ?? null,
    p_min_weight_kg: input.minWeightKg ?? null,
    p_max_weight_kg: input.maxWeightKg ?? null,
    p_max_duration_days: input.maxDurationDays ?? null,
    p_species_contraindications: input.speciesContraindications,
    p_operator_user_id: user?.id ?? null,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, { profile: data })
})

// ===== GET /interactions 相互作用禁忌列表 =====
medicationSafetyRoutes.get('/interactions', async (c) => {
  const tenantId = resolveTenantScope(c, c.req.query('tenantId') ?? undefined)
  const scope = await requireScopedPermission(c, {
    code: 'medication_safety.view',
    tenantId,
  })

  const service = createServiceClient()
  const { data, error } = await service
    .from('medication_drug_interactions')
    .select('*')
    .eq('tenant_id', scope.tenantId)
    .order('ingredient_a', { ascending: true })
  if (error) {
    throw err.internal(`查询相互作用禁忌失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

// ===== POST /interactions upsert 相互作用禁忌 =====
medicationSafetyRoutes.post('/interactions', async (c) => {
  const input = await parseJsonBody(c, interactionSchema)
  const tenantId = resolveTenantScope(c, input.tenantId)
  const scope = await requireScopedPermission(c, { code: 'medication_safety.manage', tenantId })

  const service = createServiceClient()
  const user = c.get('user') as { id: string } | undefined
  const { data, error } = await service.rpc('upsert_drug_interaction', {
    p_tenant_id: scope.tenantId,
    p_ingredient_a: input.ingredientA,
    p_ingredient_b: input.ingredientB,
    p_severity: input.severity,
    p_description: input.description ?? null,
    p_active: input.active,
    p_operator_user_id: user?.id ?? null,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, { interaction: data })
})

// ===== POST /evaluate 对处方执行安全检查 =====
// 医生保存草稿后可主动调用(draft 提示);issue/dispense 门禁由 DB RPC 强制,
// 本端点仅用于展示/预检,不构成安全边界。
medicationSafetyRoutes.post('/evaluate', async (c) => {
  const input = await parseJsonBody(c, evaluateSchema)
  const service = createServiceClient()
  const scope = await fetchPrescriptionScope(service, input.prescriptionId)
  await requireScopedPermission(c, {
    code: 'medication_safety.view',
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
  })

  const { data, error } = await service.rpc('evaluate_medication_safety', {
    p_prescription_id: input.prescriptionId,
    p_stage: input.stage,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, { result: data })
})

// ===== GET /checks 处方检查结果列表 =====
medicationSafetyRoutes.get('/checks', async (c) => {
  const parsed = z.object({
    prescriptionId: z.string().uuid('处方 id 格式错误'),
    stage: z.enum(['draft', 'issue', 'dispense']).optional(),
  }).safeParse(c.req.query())
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', {
      field: parsed.error.issues.map(i => i.message),
    })
  }

  const service = createServiceClient()
  const scope = await fetchPrescriptionScope(service, parsed.data.prescriptionId)
  await requireScopedPermission(c, {
    code: 'medication_safety.view',
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
  })

  let query = service
    .from('medication_safety_checks')
    .select('*, overrides:medication_safety_overrides(*)')
    .eq('prescription_id', parsed.data.prescriptionId)
    .order('item_index', { ascending: true })
    .order('created_at', { ascending: false })
  if (parsed.data.stage) {
    query = query.eq('check_stage', parsed.data.stage)
  }
  const { data, error } = await query
  if (error) {
    throw err.internal(`查询检查结果失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

// ===== POST /checks/:id/override 阻断豁免(reason 必填) =====
medicationSafetyRoutes.post('/checks/:id/override', async (c) => {
  const checkId = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/i.test(checkId)) {
    throw err.badRequest('检查 id 格式错误')
  }
  const input = await parseJsonBody(c, overrideSchema)

  const service = createServiceClient()
  const { data: checkRow, error: scopeErr } = await service
    .from('medication_safety_checks')
    .select('tenant_id, store_id')
    .eq('id', checkId)
    .maybeSingle()
  if (scopeErr || !checkRow) {
    throw err.notFound('检查记录不存在')
  }
  await requireScopedPermission(c, {
    code: 'medication_safety.override',
    tenantId: checkRow.tenant_id,
    storeId: checkRow.store_id ?? undefined,
  })

  const user = c.get('user') as { id: string } | undefined
  if (!user?.id) {
    throw err.unauthorized('未登录')
  }
  const { data, error } = await service.rpc('override_medication_safety_check', {
    p_check_id: checkId,
    p_operator_user_id: user.id,
    p_reason: input.reason,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, { check: data })
})

export default medicationSafetyRoutes
