import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { requireScopedPermission } from '../lib/permission.js'
import { getContext, loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * CRM Growth 领域路由(Stage-04 Agent-05)
 *
 * 路由清单:
 *   GET    /crm-growth/segments                  (分层定义列表)
 *   POST   /crm-growth/segments                  (创建分层定义)
 *   PATCH  /crm-growth/segments/:id              (更新分层定义)
 *   DELETE /crm-growth/segments/:id              (删除分层定义)
 *   POST   /crm-growth/segments/refresh          (批量重算物化成员)
 *   GET    /crm-growth/segments/:id/customers    (分层成员列表)
 *   GET    /crm-growth/churn                     (流失风险列表)
 *   POST   /crm-growth/churn/refresh             (批量重算流失评分)
 *   GET    /crm-growth/customers/:id/insights    (客户洞察聚合)
 *
 * 原则:
 *   - Segment/Churn 计算走 service-role-only RPC,禁止前端算
 *   - Churn 默认 Tenant-wide(客户是 Tenant 级关系)
 *   - 所有结果带 explanation,可解释
 */
const crmGrowthRoutes = new Hono<AppEnv>()

crmGrowthRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

// ===== Segment 规则条件 schema =====
const segmentConditionSchema = z.object({
  dim: z.enum([
    'recency_days', 'visits_total', 'visits_last_365', 'spend_total', 'spend_last_365',
    'pet_count', 'member_tier_code', 'member_points', 'vaccination_due',
    'deworming_due', 'no_show_count', 'followup_overdue',
  ]),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
  value: z.union([z.number(), z.string(), z.boolean()]),
})

const segmentSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().trim().min(1, '编码不能为空').max(64),
  name: z.string().trim().min(1, '名称不能为空').max(64),
  description: z.string().max(500).optional(),
  ruleJson: z.object({
    logic: z.enum(['and', 'or']).default('and'),
    conditions: z.array(segmentConditionSchema).min(1, '至少一个条件'),
  }),
  priority: z.number().int().min(0).max(9999).default(100),
  active: z.boolean().default(true),
})

// ===== GET /segments 分层定义列表 =====
crmGrowthRoutes.get('/segments', async (c) => {
  const parsed = z.object({
    tenantId: z.string().uuid(),
    storeId: z.string().uuid().optional(),
  }).safeParse({ ...c.req.query(), tenantId: c.req.query('tenantId') ?? '' })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { tenantId: parsed.error.issues.map(i => i.message) })
  }

  const scope = await requireScopedPermission(c, {
    code: 'crm.segment.view',
    tenantId: parsed.data.tenantId,
    storeId: parsed.data.storeId,
    dataScope: true,
  })

  const service = createServiceClient()
  const { data, error } = await service
    .from('customer_segment_definitions')
    .select('*')
    .eq('tenant_id', scope.tenantId)
    .order('priority', { ascending: true })

  if (error) {
    throw err.internal(`查询分层定义失败: ${error.message}`)
  }

  // 物化成员计数(批量统计)
  const { data: counts, error: countErr } = await service
    .from('customer_segment_memberships')
    .select('segment_id')
    .eq('tenant_id', scope.tenantId)
  if (countErr) {
    throw err.internal(`查询分层成员失败: ${countErr.message}`)
  }
  const countMap: Record<string, number> = {}
  ;(counts ?? []).forEach((row: any) => {
    countMap[row.segment_id] = (countMap[row.segment_id] ?? 0) + 1
  })

  return ok(c, {
    list: (data ?? []).map((s: any) => ({
      ...s,
      member_count: countMap[s.id] ?? 0,
    })),
  })
})

// ===== POST /segments 创建分层定义 =====
crmGrowthRoutes.post('/segments', async (c) => {
  const input = await parseJsonBody(c, segmentSchema)
  const scope = await requireScopedPermission(c, { code: 'crm.segment.manage', tenantId: input.tenantId })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error } = await service
    .from('customer_segment_definitions')
    .insert({
      tenant_id: scope.tenantId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      rule_json: input.ruleJson as any,
      priority: input.priority,
      active: input.active,
      created_by: user.id,
    })
    .select()
    .single()

  if (error) {
    if (error.message.includes('duplicate key')) {
      throw err.conflict('分层编码已存在')
    }
    throw err.internal(`创建分层失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'segment.create',
    entityType: 'customer_segment_definition',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { code: input.code, name: input.name },
  })

  return ok(c, data)
})

// ===== PATCH /segments/:id 更新分层定义 =====
crmGrowthRoutes.patch('/segments/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, segmentSchema.partial())

  const service = createServiceClient()
  // 先查定义获取 tenant 做作用域授权
  const { data: existing, error: fetchErr } = await service
    .from('customer_segment_definitions')
    .select('id, tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr || !existing) {
    throw err.notFound('分层定义不存在')
  }
  await requireScopedPermission(c, { code: 'crm.segment.manage', tenantId: existing.tenant_id })

  const patch: Record<string, unknown> = {}
  if (input.code !== undefined) patch.code = input.code
  if (input.name !== undefined) patch.name = input.name
  if (input.description !== undefined) patch.description = input.description
  if (input.ruleJson !== undefined) patch.rule_json = input.ruleJson as any
  if (input.priority !== undefined) patch.priority = input.priority
  if (input.active !== undefined) patch.active = input.active

  const { data, error } = await service
    .from('customer_segment_definitions')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (error) {
    throw err.internal(`更新分层失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'segment.update',
    entityType: 'customer_segment_definition',
    entityId: id,
    tenantId: existing.tenant_id,
    metadata: patch,
  })

  return ok(c, data)
})

// ===== DELETE /segments/:id 删除分层定义 =====
crmGrowthRoutes.delete('/segments/:id', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()
  const { data: existing, error: fetchErr } = await service
    .from('customer_segment_definitions')
    .select('id, tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr || !existing) {
    throw err.notFound('分层定义不存在')
  }
  await requireScopedPermission(c, { code: 'crm.segment.manage', tenantId: existing.tenant_id })

  // 级联清理物化成员
  await service.from('customer_segment_memberships').delete().eq('segment_id', id)
  const { error } = await service.from('customer_segment_definitions').delete().eq('id', id)
  if (error) {
    throw err.internal(`删除分层失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'segment.delete',
    entityType: 'customer_segment_definition',
    entityId: id,
    tenantId: existing.tenant_id,
  })

  return ok(c, { id })
})

// ===== POST /segments/refresh 批量重算物化成员 =====
// 注意:注册在 /segments/:id/customers 之前,避免被动态段吞并
const refreshSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
})
crmGrowthRoutes.post('/segments/refresh', async (c) => {
  const input = await parseJsonBody(c, refreshSchema)
  const scope = await requireScopedPermission(c, { code: 'crm.segment.manage', tenantId: input.tenantId })

  const service = createServiceClient()
  const { data, error: rpcError } = await service.rpc('refresh_segment_memberships', {
    p_tenant_id: scope.tenantId,
  })
  if (rpcError) {
    throw err.internal(`重算分层成员失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'segment.refresh',
    entityType: 'customer_segment_membership',
    tenantId: input.tenantId,
    metadata: data,
  })

  return ok(c, data)
})

// ===== GET /segments/:id/customers 分层成员列表 =====
crmGrowthRoutes.get('/segments/:id/customers', async (c) => {
  const id = c.req.param('id')
  const parsed = z.object({
    tenantId: z.string().uuid(),
    page: z.coerce.number().int().positive().max(1000).default(1),
    pageSize: z.coerce.number().int().positive().max(200).default(20),
  }).safeParse({ ...c.req.query(), tenantId: c.req.query('tenantId') ?? '' })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { tenantId: parsed.error.issues.map(i => i.message) })
  }

  const service = createServiceClient()
  const { data: seg, error: segErr } = await service
    .from('customer_segment_definitions')
    .select('id, tenant_id, name')
    .eq('id', id)
    .maybeSingle()
  if (segErr || !seg) {
    throw err.notFound('分层定义不存在')
  }
  await requireScopedPermission(c, { code: 'crm.segment.view', tenantId: seg.tenant_id })

  const from = (parsed.data.page - 1) * parsed.data.pageSize
  const { data, error, count } = await service
    .from('customer_segment_memberships')
    .select('customer_id, matched_at, explanation, customers(id, name, phone, store_id)', { count: 'exact' })
    .eq('segment_id', id)
    .order('matched_at', { ascending: false })
    .range(from, from + parsed.data.pageSize - 1)
  if (error) {
    throw err.internal(`查询分层成员失败: ${error.message}`)
  }

  return ok(c, {
    list: data ?? [],
    total: count ?? 0,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    segment: { id: seg.id, name: seg.name },
  })
})

// ===== GET /churn 流失风险列表 =====
const churnListSchema = z.object({
  tenantId: z.string().uuid(),
  storeId: z.string().uuid().optional(),
  level: z.enum(['high', 'medium', 'low']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})
crmGrowthRoutes.get('/churn', async (c) => {
  const parsed = churnListSchema.safeParse({
    ...c.req.query(),
    tenantId: c.req.query('tenantId') ?? '',
  })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { tenantId: parsed.error.issues.map(i => i.message) })
  }

  const scope = await requireScopedPermission(c, {
    code: 'crm.churn.view',
    tenantId: parsed.data.tenantId,
    storeId: parsed.data.storeId,
    dataScope: true,
  })

  const service = createServiceClient()
  let query = service
    .from('customer_risk_scores')
    .select('id, customer_id, risk_type, score, level, explanation, calculated_at, model_version, customers(id, name, phone, store_id)', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
    .eq('risk_type', 'churn')

  // Churn 默认 Tenant-wide;storeId 仅作为列表筛选(客户归属门店),不改变评分口径
  if (parsed.data.level) {
    query = query.eq('level', parsed.data.level)
  }

  const from = (parsed.data.page - 1) * parsed.data.pageSize
  const { data, error, count } = await query
    .order('score', { ascending: false })
    .range(from, from + parsed.data.pageSize - 1)
  if (error) {
    throw err.internal(`查询流失风险失败: ${error.message}`)
  }

  return ok(c, {
    list: data ?? [],
    total: count ?? 0,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  })
})

// ===== POST /churn/refresh 批量重算流失评分 =====
crmGrowthRoutes.post('/churn/refresh', async (c) => {
  const input = await parseJsonBody(c, refreshSchema)
  const scope = await requireScopedPermission(c, { code: 'crm.segment.manage', tenantId: input.tenantId })

  const service = createServiceClient()
  const { data, error: rpcError } = await service.rpc('refresh_churn_scores', {
    p_tenant_id: scope.tenantId,
  })
  if (rpcError) {
    throw err.internal(`重算流失评分失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'churn.refresh',
    entityType: 'customer_risk_score',
    tenantId: input.tenantId,
    metadata: data,
  })

  return ok(c, data)
})

// ===== GET /customers/:id/insights 客户洞察聚合 =====
// 聚合:Segment / Churn Risk / Active Coupons / Packages / Campaign History
// 权限:customer.view(与 Customer 360 一致)
crmGrowthRoutes.get('/customers/:id/insights', async (c) => {
  const customerId = c.req.param('id')
  const service = createServiceClient()

  const { data: customer, error: custErr } = await service
    .from('customers')
    .select('id, tenant_id, store_id, name, phone')
    .eq('id', customerId)
    .maybeSingle()
  if (custErr || !customer) {
    throw err.notFound('客户不存在')
  }
  await requireScopedPermission(c, {
    code: 'customer.view',
    tenantId: customer.tenant_id,
    storeId: customer.store_id ?? undefined,
  })

  // 并行:Segment 评估 / Churn 评分 / 有效券 / 有效套餐 / 活动历史
  const [segRes, churnRes, couponsRes, packagesRes, campaignsRes] = await Promise.all([
    service.rpc('evaluate_customer_segments', {
      p_tenant_id: customer.tenant_id,
      p_customer_id: customerId,
    }),
    service.rpc('compute_customer_churn', {
      p_tenant_id: customer.tenant_id,
      p_customer_id: customerId,
    }),
    service
      .from('coupon_issues')
      .select('id, coupon_id, code, status, issued_at, expires_at, redeemed_at')
      .eq('customer_id', customerId)
      .eq('tenant_id', customer.tenant_id)
      .in('status', ['available', 'redeemed'])
      .order('issued_at', { ascending: false })
      .limit(20),
    service
      .from('customer_packages')
      .select('id, package_id, total_quantity, remaining_quantity, valid_from, expires_at, status')
      .eq('customer_id', customerId)
      .eq('tenant_id', customer.tenant_id)
      .order('created_at', { ascending: false })
      .limit(20),
    service
      .from('marketing_campaign_audiences')
      .select('id, rule_version, matched_at, marketing_campaigns(id, name, type, channel, status, published_at)')
      .eq('customer_id', customerId)
      .eq('tenant_id', customer.tenant_id)
      .order('matched_at', { ascending: false })
      .limit(20),
  ])

  if (segRes.error && !segRes.error.message.includes('CUSTOMER_NOT_FOUND')) {
    throw err.internal(`评估分层失败: ${segRes.error.message}`)
  }
  if (churnRes.error && !churnRes.error.message.includes('CUSTOMER_NOT_FOUND')) {
    throw err.internal(`评估流失失败: ${churnRes.error.message}`)
  }
  if (couponsRes.error) {
    throw err.internal(`查询客户优惠券失败: ${couponsRes.error.message}`)
  }
  if (packagesRes.error) {
    throw err.internal(`查询客户套餐失败: ${packagesRes.error.message}`)
  }
  if (campaignsRes.error) {
    throw err.internal(`查询客户活动历史失败: ${campaignsRes.error.message}`)
  }

  // coupon_issues.coupon_id 和 customer_packages.package_id 在旧库中没有外键，
  // 显式查询并回填模板，避免 PostgREST 嵌套关联推断失败。
  const couponIds = [...new Set((couponsRes.data ?? []).map(item => item.coupon_id))]
  const packageIds = [...new Set((packagesRes.data ?? []).map(item => item.package_id))]
  const [couponTemplatesRes, packageTemplatesRes] = await Promise.all([
    couponIds.length
      ? service
          .from('coupons')
          .select('id, name, type, value, min_spend, valid_from, valid_until')
          .eq('tenant_id', customer.tenant_id)
          .in('id', couponIds)
      : Promise.resolve({ data: [], error: null }),
    packageIds.length
      ? service
          .from('service_packages')
          .select('id, name, description, price, validity_days')
          .eq('tenant_id', customer.tenant_id)
          .in('id', packageIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (couponTemplatesRes.error) {
    throw err.internal(`查询优惠券模板失败: ${couponTemplatesRes.error.message}`)
  }
  if (packageTemplatesRes.error) {
    throw err.internal(`查询套餐模板失败: ${packageTemplatesRes.error.message}`)
  }

  const couponTemplates = new Map((couponTemplatesRes.data ?? []).map(item => [item.id, item]))
  const packageTemplates = new Map((packageTemplatesRes.data ?? []).map(item => [item.id, item]))

  return ok(c, {
    customerId,
    segments: segRes.error ? [] : (segRes.data?.segments ?? []),
    churn: churnRes.error ? null : churnRes.data,
    activeCoupons: (couponsRes.data ?? []).map(item => ({
      ...item,
      coupons: couponTemplates.get(item.coupon_id) ?? null,
    })),
    packages: (packagesRes.data ?? []).map(item => ({
      ...item,
      service_packages: packageTemplates.get(item.package_id) ?? null,
    })),
    campaignHistory: campaignsRes.data ?? [],
  })
})

export default crmGrowthRoutes
