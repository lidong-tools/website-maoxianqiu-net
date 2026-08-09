import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * Marketing 领域路由(Stage-04 Agent-05)
 *
 * 路由清单:
 *   优惠券:  GET/POST /marketing/coupons  PATCH /marketing/coupons/:id
 *            POST /marketing/coupons/:id/issue(发放)
 *            GET /marketing/coupon-issues
 *            POST /marketing/coupon-issues/:id/preview(报价预览)
 *            POST /marketing/coupon-issues/:id/redeem(核销)
 *            POST /marketing/coupon-issues/:id/cancel(作废)
 *   套餐:    GET/POST /marketing/packages  PATCH /marketing/packages/:id
 *            POST /marketing/packages/:id/purchase(开卡)
 *            GET /marketing/customer-packages
 *            POST /marketing/customer-packages/:id/redeem(核销)
 *            POST /marketing/customer-packages/:id/refund(退款)
 *            POST /marketing/package-redemptions/:id/reverse(冲正)
 *   Campaign:GET/POST /marketing/campaigns  PATCH/DELETE /marketing/campaigns/:id
 *            POST /marketing/campaigns/:id/publish(发布,marketing.publish)
 *            GET /marketing/campaigns/:id/audience-preview(Audience 预览)
 *            GET /marketing/campaigns/:id/runs(运行记录)
 *   Referral:POST /marketing/referral-codes(生成推荐码)
 *            POST /marketing/referral-events(登记推荐关系)
 *
 * 原则:
 *   - 券/套餐核销走 service-role-only RPC(锁 + 幂等),禁止前端算
 *   - Campaign 只负责 Audience/OFFER/Channel,消息发送走 Agent-08 Messaging Contract
 */
const marketingRoutes = new Hono<AppEnv>()

marketingRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

// ============================================================
// 优惠券 Coupons
// ============================================================

const couponSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().trim().min(1, '编码不能为空').max(64),
  name: z.string().trim().min(1, '名称不能为空').max(64),
  type: z.enum(['fixed', 'percentage']),
  value: z.number().min(0),
  minSpend: z.number().min(0).default(0),
  maxDiscount: z.number().min(0).nullish(),
  catalogType: z.enum(['service', 'product', 'drug', 'vaccine', 'exam']).nullish(),
  catalogItemId: z.string().uuid().nullish(),
  storeId: z.string().uuid().nullish(),
  validFrom: z.string().datetime({ offset: true }).nullish(),
  validUntil: z.string().datetime({ offset: true }).nullish(),
  quota: z.number().int().min(0).default(0),
  perCustomerLimit: z.number().int().min(1).default(1),
  stackingPolicy: z.enum(['single', 'stackable']).default('single'),
  isActive: z.boolean().default(true),
})

/** 将 API 输入映射为 coupons 表行 */
function mapCouponInput(input: z.infer<typeof couponSchema>, tenantId: string) {
  return {
    tenant_id: tenantId,
    code: input.code,
    name: input.name,
    type: input.type,
    value: input.value,
    min_spend: input.minSpend,
    max_discount: input.maxDiscount ?? null,
    catalog_type: input.catalogType ?? null,
    catalog_item_id: input.catalogItemId ?? null,
    store_id: input.storeId ?? null,
    valid_from: input.validFrom ?? null,
    valid_until: input.validUntil ?? null,
    quota: input.quota,
    per_customer_limit: input.perCustomerLimit,
    stacking_policy: input.stackingPolicy,
    is_active: input.isActive,
  }
}

// GET /marketing/coupons 优惠券模板列表
marketingRoutes.get('/coupons', async (c) => {
  const parsed = z.object({
    tenantId: z.string().uuid(),
  }).safeParse({ ...c.req.query(), tenantId: c.req.query('tenantId') ?? '' })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { tenantId: parsed.error.issues.map(i => i.message) })
  }
  const scope = await requireScopedPermission(c, { code: 'marketing.view', tenantId: parsed.data.tenantId, dataScope: true })

  const service = createServiceClient()
  const { data, error } = await service
    .from('coupons')
    .select('*')
    .eq('tenant_id', scope.tenantId)
    .order('created_at', { ascending: false })
  if (error) {
    throw err.internal(`查询优惠券失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

// POST /marketing/coupons 创建优惠券
marketingRoutes.post('/coupons', async (c) => {
  const input = await parseJsonBody(c, couponSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.manage', tenantId: input.tenantId })
  const service = createServiceClient()
  const user = c.get('user')

  const { data, error } = await service
    .from('coupons')
    .insert({ ...mapCouponInput(input, scope.tenantId), created_by: user.id })
    .select()
    .single()
  if (error) {
    if (error.message.includes('duplicate key')) {
      throw err.conflict('优惠券编码已存在')
    }
    throw err.internal(`创建优惠券失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'coupon.create',
    entityType: 'coupon',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { code: input.code, name: input.name },
  })
  return ok(c, data)
})

// PATCH /marketing/coupons/:id 更新优惠券
marketingRoutes.patch('/coupons/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, couponSchema.partial())
  const service = createServiceClient()

  const { data: existing, error: fetchErr } = await service
    .from('coupons')
    .select('id, tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr || !existing) {
    throw err.notFound('优惠券不存在')
  }
  await requireScopedPermission(c, { code: 'marketing.manage', tenantId: existing.tenant_id })

  const patch: Record<string, unknown> = {}
  if (input.code !== undefined) patch.code = input.code
  if (input.name !== undefined) patch.name = input.name
  if (input.type !== undefined) patch.type = input.type
  if (input.value !== undefined) patch.value = input.value
  if (input.minSpend !== undefined) patch.min_spend = input.minSpend
  if (input.maxDiscount !== undefined) patch.max_discount = input.maxDiscount ?? null
  if (input.catalogType !== undefined) patch.catalog_type = input.catalogType ?? null
  if (input.catalogItemId !== undefined) patch.catalog_item_id = input.catalogItemId ?? null
  if (input.storeId !== undefined) patch.store_id = input.storeId ?? null
  if (input.validFrom !== undefined) patch.valid_from = input.validFrom ?? null
  if (input.validUntil !== undefined) patch.valid_until = input.validUntil ?? null
  if (input.quota !== undefined) patch.quota = input.quota
  if (input.perCustomerLimit !== undefined) patch.per_customer_limit = input.perCustomerLimit
  if (input.stackingPolicy !== undefined) patch.stacking_policy = input.stackingPolicy
  if (input.isActive !== undefined) patch.is_active = input.isActive

  const { data, error } = await service.from('coupons').update(patch).eq('id', id).select().single()
  if (error) {
    throw err.internal(`更新优惠券失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'coupon.update',
    entityType: 'coupon',
    entityId: id,
    tenantId: existing.tenant_id,
    metadata: patch,
  })
  return ok(c, data)
})

// POST /marketing/coupons/:id/issue 发放优惠券
const issueSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  customerIds: z.array(z.string().uuid()).min(1, '至少选择一个客户'),
})
marketingRoutes.post('/coupons/:id/issue', async (c) => {
  const couponId = c.req.param('id')
  const input = await parseJsonBody(c, issueSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.adjust_entitlement', tenantId: input.tenantId })
  const service = createServiceClient()
  const user = c.get('user')

  const { data, error: rpcError } = await service.rpc('issue_coupons', {
    p_tenant_id: scope.tenantId,
    p_coupon_id: couponId,
    p_customer_ids: input.customerIds,
    p_operator_id: user.id,
  })
  if (rpcError) {
    if (rpcError.message.includes('COUPON_NOT_FOUND_OR_INACTIVE')) {
      throw err.notFound('优惠券不存在或已停用')
    }
    throw err.internal(`发放优惠券失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'coupon.issue',
    entityType: 'coupon_issue',
    tenantId: input.tenantId,
    metadata: { couponId, issued: data?.issued },
  })
  return ok(c, data)
})

// GET /marketing/coupon-issues 发放记录列表
const issueListSchema = z.object({
  tenantId: z.string().uuid(),
  couponId: z.string().uuid().optional(),
  status: z.enum(['available', 'redeemed', 'expired', 'cancelled']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})
marketingRoutes.get('/coupon-issues', async (c) => {
  const parsed = issueListSchema.safeParse({
    ...c.req.query(),
    tenantId: c.req.query('tenantId') ?? '',
  })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { tenantId: parsed.error.issues.map(i => i.message) })
  }
  const scope = await requireScopedPermission(c, { code: 'marketing.view', tenantId: parsed.data.tenantId, dataScope: true })
  const service = createServiceClient()

  let query = service
    .from('coupon_issues')
    .select('*, coupons(id, name, type, value, min_spend, valid_from, valid_until), customers(id, name, phone)', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
  if (parsed.data.couponId) {
    query = query.eq('coupon_id', parsed.data.couponId)
  }
  if (parsed.data.status) {
    query = query.eq('status', parsed.data.status)
  }
  const from = (parsed.data.page - 1) * parsed.data.pageSize
  const { data, error, count } = await query
    .order('issued_at', { ascending: false })
    .range(from, from + parsed.data.pageSize - 1)
  if (error) {
    throw err.internal(`查询发放记录失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0, page: parsed.data.page, pageSize: parsed.data.pageSize })
})

// POST /marketing/coupon-issues/:id/preview 报价预览(只读)
const previewSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  subtotal: z.number().min(0, '金额不可为负'),
})
marketingRoutes.post('/coupon-issues/:id/preview', async (c) => {
  const issueId = c.req.param('id')
  const input = await parseJsonBody(c, previewSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.view', tenantId: input.tenantId, storeId: input.storeId })
  const service = createServiceClient()

  const { data, error: rpcError } = await service.rpc('preview_coupon_discount', {
    p_tenant_id: scope.tenantId,
    p_issue_id: issueId,
    p_store_id: scope.storeId ?? input.storeId,
    p_subtotal: input.subtotal,
  })
  if (rpcError) {
    throw err.unprocessable(mapCouponError(rpcError.message))
  }
  return ok(c, data)
})

// POST /marketing/coupon-issues/:id/redeem 核销(权威,锁 + 幂等)
const redeemSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  subtotal: z.number().min(0, '金额不可为负'),
  invoiceId: z.string().uuid().nullish(),
  idempotencyKey: z.string().trim().max(64).optional(),
})
marketingRoutes.post('/coupon-issues/:id/redeem', async (c) => {
  const issueId = c.req.param('id')
  const input = await parseJsonBody(c, redeemSchema)
  const scope = await requireScopedPermission(c, {
    code: 'marketing.adjust_entitlement',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const service = createServiceClient()
  const user = c.get('user')
  const idemKey = input.idempotencyKey ?? getRequestIdempotencyKey(c) ?? undefined

  const { data, error: rpcError } = await service.rpc('redeem_coupon', {
    p_tenant_id: scope.tenantId,
    p_issue_id: issueId,
    p_customer_id: input.customerId,
    p_store_id: scope.storeId ?? input.storeId,
    p_subtotal: input.subtotal,
    p_invoice_id: input.invoiceId ?? null,
    p_idempotency_key: idemKey ?? null,
    p_operator_id: user.id,
  })
  if (rpcError) {
    throw err.unprocessable(mapCouponError(rpcError.message))
  }

  await writeAudit(c, {
    action: 'coupon.redeem',
    entityType: 'coupon_redemption',
    entityId: data?.redemption_id ?? null,
    tenantId: input.tenantId,
    storeId: input.storeId,
    idempotencyKey: idemKey ?? null,
    metadata: { issueId, customerId: input.customerId, discountAmount: data?.discount_amount },
  })
  return ok(c, data)
})

// POST /marketing/coupon-issues/:id/cancel 作废
const cancelSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  reason: z.string().max(200).default(''),
})
marketingRoutes.post('/coupon-issues/:id/cancel', async (c) => {
  const issueId = c.req.param('id')
  const input = await parseJsonBody(c, cancelSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.adjust_entitlement', tenantId: input.tenantId })
  const service = createServiceClient()
  const user = c.get('user')

  const { data, error: rpcError } = await service.rpc('cancel_coupon_issue', {
    p_tenant_id: scope.tenantId,
    p_issue_id: issueId,
    p_reason: input.reason,
    p_operator_id: user.id,
  })
  if (rpcError) {
    throw err.unprocessable(mapCouponError(rpcError.message))
  }
  await writeAudit(c, {
    action: 'coupon.cancel',
    entityType: 'coupon_issue',
    entityId: issueId,
    tenantId: input.tenantId,
    metadata: { reason: input.reason },
  })
  return ok(c, data)
})

/** 优惠券 RPC 错误码 → 中文提示 */
function mapCouponError(message: string): string {
  if (message.includes('ISSUE_NOT_FOUND')) return '优惠券记录不存在'
  if (message.includes('COUPON_NOT_AVAILABLE')) return '优惠券不可用(可能已核销)'
  if (message.includes('COUPON_EXPIRED')) return '优惠券已过期'
  if (message.includes('COUPON_WRONG_STORE')) return '优惠券不适用于当前门店'
  if (message.includes('COUPON_MIN_SPEND_NOT_MET')) return '未达到使用门槛金额'
  if (message.includes('COUPON_QUOTA_EXHAUSTED')) return '优惠券额度已用完'
  if (message.includes('COUPON_CUSTOMER_MISMATCH')) return '优惠券不属于该客户'
  if (message.includes('ISSUE_NOT_CANCELLABLE')) return '当前状态不可作废'
  return message
}

// ============================================================
// 套餐/次卡 Packages
// ============================================================

const packageSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().trim().min(1, '编码不能为空').max(64),
  name: z.string().trim().min(1, '名称不能为空').max(64),
  description: z.string().max(500).nullish(),
  price: z.number().min(0).default(0),
  validityDays: z.number().int().positive().nullish(),
  storeId: z.string().uuid().nullish(),
  isActive: z.boolean().default(true),
  items: z.array(z.object({
    catalogItemId: z.string().uuid().nullish(),
    name: z.string().trim().min(1, '项目名称不能为空').max(100),
    quantity: z.number().int().positive().default(1),
  })).min(1, '至少一个核销项目'),
})

/** 将 API 输入映射为 service_packages 表行 */
function mapPackageInput(input: z.infer<typeof packageSchema>, tenantId: string) {
  return {
    tenant_id: tenantId,
    code: input.code,
    name: input.name,
    description: input.description ?? null,
    price: input.price,
    validity_days: input.validityDays ?? null,
    store_id: input.storeId ?? null,
    is_active: input.isActive,
  }
}

// GET /marketing/packages 套餐模板列表
marketingRoutes.get('/packages', async (c) => {
  const parsed = z.object({
    tenantId: z.string().uuid(),
  }).safeParse({ ...c.req.query(), tenantId: c.req.query('tenantId') ?? '' })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { tenantId: parsed.error.issues.map(i => i.message) })
  }
  const scope = await requireScopedPermission(c, { code: 'marketing.view', tenantId: parsed.data.tenantId, dataScope: true })
  const service = createServiceClient()

  const { data, error } = await service
    .from('service_packages')
    .select('*')
    .eq('tenant_id', scope.tenantId)
    .order('created_at', { ascending: false })
  if (error) {
    throw err.internal(`查询套餐失败: ${error.message}`)
  }

  // 附加套餐明细
  const ids = (data ?? []).map((p: any) => p.id)
  let items: any[] = []
  if (ids.length > 0) {
    const { data: itemsData, error: itemsErr } = await service
      .from('service_package_items')
      .select('*')
      .in('package_id', ids)
      .order('sort_order', { ascending: true })
    if (itemsErr) {
      throw err.internal(`查询套餐明细失败: ${itemsErr.message}`)
    }
    items = itemsData ?? []
  }
  const itemsMap: Record<string, any[]> = {}
  items.forEach((it: any) => {
    ;(itemsMap[it.package_id] ??= []).push(it)
  })

  return ok(c, {
    list: (data ?? []).map((p: any) => ({ ...p, items: itemsMap[p.id] ?? [] })),
  })
})

// POST /marketing/packages 创建套餐(含明细,事务在 Hono 层两段写)
marketingRoutes.post('/packages', async (c) => {
  const input = await parseJsonBody(c, packageSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.manage', tenantId: input.tenantId })
  const service = createServiceClient()
  const user = c.get('user')

  const { data, error } = await service
    .from('service_packages')
    .insert({ ...mapPackageInput(input, scope.tenantId), created_by: user.id })
    .select()
    .single()
  if (error) {
    if (error.message.includes('duplicate key')) {
      throw err.conflict('套餐编码已存在')
    }
    throw err.internal(`创建套餐失败: ${error.message}`)
  }

  const rows = input.items.map((it, idx) => ({
    tenant_id: scope.tenantId,
    package_id: data.id,
    catalog_item_id: it.catalogItemId ?? null,
    name: it.name,
    quantity: it.quantity,
    sort_order: idx,
  }))
  const { error: itemsErr } = await service.from('service_package_items').insert(rows)
  if (itemsErr) {
    // 明细写入失败,回滚套餐(两段写兜底)
    await service.from('service_packages').delete().eq('id', data.id)
    throw err.internal(`创建套餐明细失败: ${itemsErr.message}`)
  }

  await writeAudit(c, {
    action: 'package.create',
    entityType: 'service_package',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { code: input.code, name: input.name, itemCount: input.items.length },
  })
  return ok(c, { ...data, items: rows })
})

// PATCH /marketing/packages/:id 更新套餐(仅主信息,明细重写走 create)
marketingRoutes.patch('/packages/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, packageSchema.partial())
  const service = createServiceClient()

  const { data: existing, error: fetchErr } = await service
    .from('service_packages')
    .select('id, tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr || !existing) {
    throw err.notFound('套餐不存在')
  }
  await requireScopedPermission(c, { code: 'marketing.manage', tenantId: existing.tenant_id })

  const patch: Record<string, unknown> = {}
  if (input.code !== undefined) patch.code = input.code
  if (input.name !== undefined) patch.name = input.name
  if (input.description !== undefined) patch.description = input.description ?? null
  if (input.price !== undefined) patch.price = input.price
  if (input.validityDays !== undefined) patch.validity_days = input.validityDays ?? null
  if (input.storeId !== undefined) patch.store_id = input.storeId ?? null
  if (input.isActive !== undefined) patch.is_active = input.isActive

  // 若携带 items,整体重写明细(先删后插,配置数据低频变更可接受)
  if (input.items && input.items.length > 0) {
    await service.from('service_package_items').delete().eq('package_id', id)
    const rows = input.items.map((it, idx) => ({
      tenant_id: existing.tenant_id,
      package_id: id,
      catalog_item_id: it.catalogItemId ?? null,
      name: it.name,
      quantity: it.quantity,
      sort_order: idx,
    }))
    const { error: itemsErr } = await service.from('service_package_items').insert(rows)
    if (itemsErr) {
      throw err.internal(`更新套餐明细失败: ${itemsErr.message}`)
    }
  }

  const { data, error } = await service.from('service_packages').update(patch).eq('id', id).select().single()
  if (error) {
    throw err.internal(`更新套餐失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'package.update',
    entityType: 'service_package',
    entityId: id,
    tenantId: existing.tenant_id,
    metadata: patch,
  })
  return ok(c, data)
})

// POST /marketing/packages/:id/purchase 客户购卡(开卡)
const purchaseSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  invoiceId: z.string().uuid().nullish(),
  idempotencyKey: z.string().trim().max(64).optional(),
})
marketingRoutes.post('/packages/:id/purchase', async (c) => {
  const packageId = c.req.param('id')
  const input = await parseJsonBody(c, purchaseSchema)
  const scope = await requireScopedPermission(c, {
    code: 'marketing.adjust_entitlement',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const service = createServiceClient()
  const user = c.get('user')
  const idemKey = input.idempotencyKey ?? getRequestIdempotencyKey(c) ?? undefined

  const { data, error: rpcError } = await service.rpc('purchase_package', {
    p_tenant_id: scope.tenantId,
    p_customer_id: input.customerId,
    p_package_id: packageId,
    p_store_id: scope.storeId ?? input.storeId,
    p_invoice_id: input.invoiceId ?? null,
    p_idempotency_key: idemKey ?? null,
    p_operator_id: user.id,
  })
  if (rpcError) {
    if (rpcError.message.includes('PACKAGE_NOT_FOUND_OR_INACTIVE')) {
      throw err.notFound('套餐不存在或已停用')
    }
    if (rpcError.message.includes('CUSTOMER_NOT_FOUND')) {
      throw err.notFound('客户不存在')
    }
    throw err.internal(`购卡失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'package.purchase',
    entityType: 'customer_package',
    entityId: data?.customer_package_id ?? null,
    tenantId: input.tenantId,
    storeId: input.storeId,
    idempotencyKey: idemKey ?? null,
    metadata: { packageId, customerId: input.customerId },
  })
  return ok(c, data)
})

// GET /marketing/customer-packages 客户套餐列表
const cpListSchema = z.object({
  tenantId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  status: z.enum(['active', 'expired', 'refunded', 'cancelled']).optional(),
  page: z.coerce.number().int().positive().max(1000).default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
})
marketingRoutes.get('/customer-packages', async (c) => {
  const parsed = cpListSchema.safeParse({
    ...c.req.query(),
    tenantId: c.req.query('tenantId') ?? '',
  })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { tenantId: parsed.error.issues.map(i => i.message) })
  }
  const scope = await requireScopedPermission(c, { code: 'marketing.view', tenantId: parsed.data.tenantId, dataScope: true })
  const service = createServiceClient()

  let query = service
    .from('customer_packages')
    .select('*, service_packages(id, name, code, description, price, validity_days), customers(id, name, phone)', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
  if (parsed.data.customerId) {
    query = query.eq('customer_id', parsed.data.customerId)
  }
  if (parsed.data.status) {
    query = query.eq('status', parsed.data.status)
  }
  const from = (parsed.data.page - 1) * parsed.data.pageSize
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, from + parsed.data.pageSize - 1)
  if (error) {
    throw err.internal(`查询客户套餐失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0, page: parsed.data.page, pageSize: parsed.data.pageSize })
})

// POST /marketing/customer-packages/:id/redeem 套餐核销
const cpRedeemSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  packageItemId: z.string().uuid('核销项目 id 格式错误'),
  invoiceId: z.string().uuid().nullish(),
  idempotencyKey: z.string().trim().max(64).optional(),
})
marketingRoutes.post('/customer-packages/:id/redeem', async (c) => {
  const cpId = c.req.param('id')
  const input = await parseJsonBody(c, cpRedeemSchema)
  const scope = await requireScopedPermission(c, {
    code: 'marketing.adjust_entitlement',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const service = createServiceClient()
  const user = c.get('user')
  const idemKey = input.idempotencyKey ?? getRequestIdempotencyKey(c) ?? undefined

  const { data, error: rpcError } = await service.rpc('redeem_package', {
    p_tenant_id: scope.tenantId,
    p_customer_package_id: cpId,
    p_package_item_id: input.packageItemId,
    p_customer_id: input.customerId,
    p_store_id: scope.storeId ?? input.storeId,
    p_invoice_id: input.invoiceId ?? null,
    p_idempotency_key: idemKey ?? null,
    p_operator_id: user.id,
  })
  if (rpcError) {
    throw err.unprocessable(mapPackageError(rpcError.message))
  }

  await writeAudit(c, {
    action: 'package.redeem',
    entityType: 'package_redemption',
    entityId: data?.redemption_id ?? null,
    tenantId: input.tenantId,
    storeId: input.storeId,
    idempotencyKey: idemKey ?? null,
    metadata: { customerPackageId: cpId, packageItemId: input.packageItemId },
  })
  return ok(c, data)
})

// POST /marketing/customer-packages/:id/refund 套餐退款
const cpRefundSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  reason: z.string().max(200).default(''),
  idempotencyKey: z.string().trim().max(64).optional(),
})
marketingRoutes.post('/customer-packages/:id/refund', async (c) => {
  const cpId = c.req.param('id')
  const input = await parseJsonBody(c, cpRefundSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.adjust_entitlement', tenantId: input.tenantId })
  const service = createServiceClient()
  const user = c.get('user')
  const idemKey = input.idempotencyKey ?? getRequestIdempotencyKey(c) ?? undefined

  const { data, error: rpcError } = await service.rpc('refund_package', {
    p_tenant_id: scope.tenantId,
    p_customer_package_id: cpId,
    p_reason: input.reason,
    p_idempotency_key: idemKey ?? null,
    p_operator_id: user.id,
  })
  if (rpcError) {
    throw err.unprocessable(mapPackageError(rpcError.message))
  }
  await writeAudit(c, {
    action: 'package.refund',
    entityType: 'customer_package',
    entityId: cpId,
    tenantId: input.tenantId,
    idempotencyKey: idemKey ?? null,
    metadata: { reason: input.reason },
  })
  return ok(c, data)
})

// POST /marketing/package-redemptions/:id/reverse 核销冲正(恢复次数)
const reverseSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  reason: z.string().max(200).default(''),
})
marketingRoutes.post('/package-redemptions/:id/reverse', async (c) => {
  const redemptionId = c.req.param('id')
  const input = await parseJsonBody(c, reverseSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.adjust_entitlement', tenantId: input.tenantId })
  const service = createServiceClient()
  const user = c.get('user')

  const { data, error: rpcError } = await service.rpc('reverse_package_redemption', {
    p_tenant_id: scope.tenantId,
    p_redemption_id: redemptionId,
    p_reason: input.reason,
    p_operator_id: user.id,
  })
  if (rpcError) {
    throw err.unprocessable(mapPackageError(rpcError.message))
  }
  await writeAudit(c, {
    action: 'package.redeem.reverse',
    entityType: 'package_redemption',
    entityId: redemptionId,
    tenantId: input.tenantId,
    metadata: { reason: input.reason },
  })
  return ok(c, data)
})

/** 套餐 RPC 错误码 → 中文提示 */
function mapPackageError(message: string): string {
  if (message.includes('CUSTOMER_PACKAGE_NOT_FOUND')) return '客户套餐不存在'
  if (message.includes('PACKAGE_NOT_ACTIVE')) return '套餐已失效'
  if (message.includes('PACKAGE_EXPIRED')) return '套餐已过期'
  if (message.includes('PACKAGE_QUANTITY_EXHAUSTED')) return '套餐剩余次数不足'
  if (message.includes('PACKAGE_ITEM_NOT_FOUND')) return '核销项目不属于该套餐'
  if (message.includes('PACKAGE_CUSTOMER_MISMATCH')) return '套餐不属于该客户'
  if (message.includes('PACKAGE_NOT_REFUNDABLE')) return '套餐当前状态不可退款'
  if (message.includes('REDEMPTION_NOT_FOUND')) return '核销记录不存在'
  if (message.includes('REDEMPTION_NOT_REVERSIBLE')) return '核销记录已冲正,不可重复操作'
  return message
}

// ============================================================
// Campaign 营销活动
// ============================================================

const campaignSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().trim().min(1, '编码不能为空').max(64),
  name: z.string().trim().min(1, '名称不能为空').max(64),
  description: z.string().max(500).nullish(),
  type: z.enum(['manual', 'segment', 'birthday', 'churn', 'referral']),
  segmentId: z.string().uuid().nullish(),
  storeId: z.string().uuid().nullish(),
  offerType: z.enum(['coupon', 'package', 'none']).nullish(),
  offerId: z.string().uuid().nullish(),
  channel: z.enum(['sms', 'email', 'wechat', 'work_wechat']).default('wechat'),
  messageTemplateId: z.string().uuid().nullish(),
  startsAt: z.string().datetime({ offset: true }).nullish(),
  endsAt: z.string().datetime({ offset: true }).nullish(),
  status: z.enum(['draft', 'scheduled', 'published', 'completed', 'cancelled']).default('draft'),
})

// GET /marketing/campaigns 活动列表
marketingRoutes.get('/campaigns', async (c) => {
  const parsed = z.object({
    tenantId: z.string().uuid(),
    status: z.enum(['draft', 'scheduled', 'published', 'completed', 'cancelled']).optional(),
  }).safeParse({ ...c.req.query(), tenantId: c.req.query('tenantId') ?? '' })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { tenantId: parsed.error.issues.map(i => i.message) })
  }
  const scope = await requireScopedPermission(c, { code: 'marketing.view', tenantId: parsed.data.tenantId, dataScope: true })
  const service = createServiceClient()

  let query = service.from('marketing_campaigns').select('*').eq('tenant_id', scope.tenantId)
  if (parsed.data.status) {
    query = query.eq('status', parsed.data.status)
  }
  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) {
    throw err.internal(`查询活动失败: ${error.message}`)
  }

  // 附加每个活动最新一次 run 的 audience 数
  const ids = (data ?? []).map((c: any) => c.id)
  let runs: any[] = []
  if (ids.length > 0) {
    const { data: runsData, error: runsErr } = await service
      .from('marketing_campaign_runs')
      .select('campaign_id, run_no, status, audience_count, completed_at')
      .in('campaign_id', ids)
      .order('run_no', { ascending: false })
    if (runsErr) {
      throw err.internal(`查询活动运行失败: ${runsErr.message}`)
    }
    runs = runsData ?? []
  }
  const runMap: Record<string, any> = {}
  runs.forEach((r: any) => {
    if (!runMap[r.campaign_id]) runMap[r.campaign_id] = r
  })

  return ok(c, {
    list: (data ?? []).map((camp: any) => ({ ...camp, latest_run: runMap[camp.id] ?? null })),
  })
})

// POST /marketing/campaigns 创建活动
marketingRoutes.post('/campaigns', async (c) => {
  const input = await parseJsonBody(c, campaignSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.manage', tenantId: input.tenantId })
  const service = createServiceClient()
  const user = c.get('user')

  // segment 类型必须带 segment_id
  if (input.type === 'segment' && !input.segmentId) {
    throw err.badRequest('segment 类型活动必须指定分层')
  }

  const { data, error } = await service
    .from('marketing_campaigns')
    .insert({
      tenant_id: scope.tenantId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      segment_id: input.segmentId ?? null,
      store_id: input.storeId ?? null,
      offer_type: input.offerType ?? null,
      offer_id: input.offerId ?? null,
      channel: input.channel,
      message_template_id: input.messageTemplateId ?? null,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      status: input.status,
      created_by: user.id,
    })
    .select()
    .single()
  if (error) {
    if (error.message.includes('duplicate key')) {
      throw err.conflict('活动编码已存在')
    }
    throw err.internal(`创建活动失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'campaign.create',
    entityType: 'marketing_campaign',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { code: input.code, name: input.name, type: input.type },
  })
  return ok(c, data)
})

// PATCH /marketing/campaigns/:id 更新活动
marketingRoutes.patch('/campaigns/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, campaignSchema.partial())
  const service = createServiceClient()

  const { data: existing, error: fetchErr } = await service
    .from('marketing_campaigns')
    .select('id, tenant_id, status')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr || !existing) {
    throw err.notFound('活动不存在')
  }
  await requireScopedPermission(c, { code: 'marketing.manage', tenantId: existing.tenant_id })

  // 已发布活动禁止修改(保证 Snapshot 可审计)
  if (existing.status === 'published') {
    throw err.conflict('已发布的活动不可修改')
  }

  const patch: Record<string, unknown> = {}
  if (input.code !== undefined) patch.code = input.code
  if (input.name !== undefined) patch.name = input.name
  if (input.description !== undefined) patch.description = input.description ?? null
  if (input.type !== undefined) patch.type = input.type
  if (input.segmentId !== undefined) patch.segment_id = input.segmentId ?? null
  if (input.storeId !== undefined) patch.store_id = input.storeId ?? null
  if (input.offerType !== undefined) patch.offer_type = input.offerType ?? null
  if (input.offerId !== undefined) patch.offer_id = input.offerId ?? null
  if (input.channel !== undefined) patch.channel = input.channel
  if (input.messageTemplateId !== undefined) patch.message_template_id = input.messageTemplateId ?? null
  if (input.startsAt !== undefined) patch.starts_at = input.startsAt ?? null
  if (input.endsAt !== undefined) patch.ends_at = input.endsAt ?? null
  if (input.status !== undefined) patch.status = input.status

  const { data, error } = await service.from('marketing_campaigns').update(patch).eq('id', id).select().single()
  if (error) {
    throw err.internal(`更新活动失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'campaign.update',
    entityType: 'marketing_campaign',
    entityId: id,
    tenantId: existing.tenant_id,
    metadata: patch,
  })
  return ok(c, data)
})

// DELETE /marketing/campaigns/:id 删除活动
marketingRoutes.delete('/campaigns/:id', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()
  const { data: existing, error: fetchErr } = await service
    .from('marketing_campaigns')
    .select('id, tenant_id, status')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr || !existing) {
    throw err.notFound('活动不存在')
  }
  await requireScopedPermission(c, { code: 'marketing.manage', tenantId: existing.tenant_id })
  if (existing.status === 'published') {
    throw err.conflict('已发布的活动不可删除')
  }
  const { error } = await service.from('marketing_campaigns').delete().eq('id', id)
  if (error) {
    throw err.internal(`删除活动失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'campaign.delete',
    entityType: 'marketing_campaign',
    entityId: id,
    tenantId: existing.tenant_id,
  })
  return ok(c, { id })
})

// POST /marketing/campaigns/:id/publish 发布(Snapshot Audience + 建 Run)
const publishSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  customerIds: z.array(z.string().uuid()).optional(),
})
marketingRoutes.post('/campaigns/:id/publish', async (c) => {
  const campaignId = c.req.param('id')
  const input = await parseJsonBody(c, publishSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.publish', tenantId: input.tenantId })
  const service = createServiceClient()
  const user = c.get('user')

  const { data, error: rpcError } = await service.rpc('publish_campaign', {
    p_tenant_id: scope.tenantId,
    p_campaign_id: campaignId,
    p_customer_ids: input.customerIds ?? null,
    p_operator_id: user.id,
  })
  if (rpcError) {
    if (rpcError.message.includes('CAMPAIGN_NOT_FOUND')) {
      throw err.notFound('活动不存在')
    }
    if (rpcError.message.includes('CAMPAIGN_ALREADY_PUBLISHED')) {
      throw err.conflict('活动已发布,不可重复发布')
    }
    if (rpcError.message.includes('MANUAL_CAMPAIGN_REQUIRES_CUSTOMERS')) {
      throw err.badRequest('手动活动必须指定客户列表')
    }
    throw err.internal(`发布活动失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'campaign.publish',
    entityType: 'marketing_campaign',
    entityId: campaignId,
    tenantId: input.tenantId,
    metadata: data,
  })
  return ok(c, data)
})

// GET /marketing/campaigns/:id/audience-preview Audience 预览
marketingRoutes.get('/campaigns/:id/audience-preview', async (c) => {
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
  const { data: campaign, error: campErr } = await service
    .from('marketing_campaigns')
    .select('id, tenant_id, name, type, segment_id, status')
    .eq('id', id)
    .maybeSingle()
  if (campErr || !campaign) {
    throw err.notFound('活动不存在')
  }
  await requireScopedPermission(c, { code: 'marketing.view', tenantId: campaign.tenant_id })

  const from = (parsed.data.page - 1) * parsed.data.pageSize
  const { data, error, count } = await service
    .from('marketing_campaign_audiences')
    .select('id, customer_id, rule_version, matched_at, customers(id, name, phone, store_id)', { count: 'exact' })
    .eq('campaign_id', id)
    .order('matched_at', { ascending: false })
    .range(from, from + parsed.data.pageSize - 1)
  if (error) {
    throw err.internal(`查询活动 Audience 失败: ${error.message}`)
  }
  return ok(c, {
    list: data ?? [],
    total: count ?? 0,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    campaign: { id: campaign.id, name: campaign.name, type: campaign.type, status: campaign.status },
  })
})

// GET /marketing/campaigns/:id/runs 运行记录
marketingRoutes.get('/campaigns/:id/runs', async (c) => {
  const id = c.req.param('id')
  const parsed = z.object({
    tenantId: z.string().uuid(),
  }).safeParse({ ...c.req.query(), tenantId: c.req.query('tenantId') ?? '' })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { tenantId: parsed.error.issues.map(i => i.message) })
  }

  const service = createServiceClient()
  const { data: campaign, error: campErr } = await service
    .from('marketing_campaigns')
    .select('id, tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (campErr || !campaign) {
    throw err.notFound('活动不存在')
  }
  await requireScopedPermission(c, { code: 'marketing.view', tenantId: campaign.tenant_id })

  const { data, error } = await service
    .from('marketing_campaign_runs')
    .select('*')
    .eq('campaign_id', id)
    .order('run_no', { ascending: false })
  if (error) {
    throw err.internal(`查询活动运行记录失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

// ============================================================
// Referral 推荐
// ============================================================

// POST /marketing/referral-codes 生成推荐码
const refCodeSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
})
marketingRoutes.post('/referral-codes', async (c) => {
  const input = await parseJsonBody(c, refCodeSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.view', tenantId: input.tenantId })
  const service = createServiceClient()
  const user = c.get('user')

  const { data, error: rpcError } = await service.rpc('generate_referral_code', {
    p_tenant_id: scope.tenantId,
    p_customer_id: input.customerId,
    p_operator_id: user.id,
  })
  if (rpcError) {
    if (rpcError.message.includes('CUSTOMER_NOT_FOUND')) {
      throw err.notFound('客户不存在')
    }
    throw err.internal(`生成推荐码失败: ${rpcError.message}`)
  }
  return ok(c, data)
})

// POST /marketing/referral-events 登记推荐关系
const refEventSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().trim().min(1, '推荐码不能为空').max(32),
  refereeCustomerId: z.string().uuid('被推荐客户 id 格式错误'),
})
marketingRoutes.post('/referral-events', async (c) => {
  const input = await parseJsonBody(c, refEventSchema)
  const scope = await requireScopedPermission(c, { code: 'marketing.view', tenantId: input.tenantId })
  const service = createServiceClient()

  const { data, error: rpcError } = await service.rpc('register_referral', {
    p_tenant_id: scope.tenantId,
    p_code: input.code,
    p_referee_customer_id: input.refereeCustomerId,
  })
  if (rpcError) {
    if (rpcError.message.includes('REFERRAL_CODE_NOT_FOUND')) {
      throw err.notFound('推荐码不存在或已停用')
    }
    if (rpcError.message.includes('REFERRAL_SELF_REFERENCE')) {
      throw err.badRequest('不能自己推荐自己')
    }
    if (rpcError.message.includes('CUSTOMER_NOT_FOUND')) {
      throw err.notFound('被推荐客户不存在')
    }
    throw err.internal(`登记推荐失败: ${rpcError.message}`)
  }
  await writeAudit(c, {
    action: 'referral.register',
    entityType: 'referral_event',
    tenantId: input.tenantId,
    metadata: { code: input.code, refereeCustomerId: input.refereeCustomerId },
  })
  return ok(c, data)
})

export default marketingRoutes
