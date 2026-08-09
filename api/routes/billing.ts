import type { Context } from 'hono'
import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { ApiError, err } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * Billing 领域 Command 路由(MXQ-8001~8007)
 *
 * 状态机:
 *   发票:  draft → confirmed → paid → refunded
 *          draft → cancelled
 *          confirmed → partially_paid → paid
 *   支付/退款:单次原子操作,幂等防重复(idempotency_key)
 *
 * 安全:
 *   - 创建发票须 invoice.create 权限
 *   - 确认发票须 invoice.confirm 权限(大额折扣需先审批)
 *   - 取消发票须 invoice.cancel 权限
 *   - 处理支付须 payment.process 权限
 *   - 处理退款须 refund.process 权限
 *   - 生成小票须 receipt.print 权限
 *   - 所有收费/退款走 Hono Command + PostgreSQL RPC,禁止前端直连改状态/已付金额
 *   - 幂等:支付/退款/创建发票须带 idempotency-key(Header 或 body.idempotencyKey),
 *     RPC 内 SELECT FOR UPDATE + 唯一索引防重复
 */
const billingRoutes = new Hono<AppEnv>()

billingRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/** 从 Header 或 body 解析幂等键,缺失时生成 uuid 保证 RPC 总有 key */
function resolveIdempotencyKey(c: Context<AppEnv>, bodyKey?: string): string {
  return getRequestIdempotencyKey(c) || bodyKey || crypto.randomUUID()
}

/** 将 RPC 抛出的业务错误码映射为 HTTP 错误 */
function mapRpcError(error: { message: string }) {
  const msg = error.message
  if (msg.includes('INVOICE_NOT_FOUND') || msg.includes('APPROVAL_NOT_FOUND')) {
    return err.notFound('资源不存在')
  }
  if (msg.includes('INVOICE_STATUS_INVALID')) {
    return err.conflict('发票状态不允许该操作')
  }
  if (msg.includes('INVOICE_ALREADY_CANCELLED')) {
    return err.conflict('发票已取消')
  }
  if (msg.includes('DISCOUNT_APPROVAL_PENDING')) {
    return new ApiError(409, 'DISCOUNT_APPROVAL_PENDING', '大额折扣审批待处理,无法确认发票')
  }
  if (msg.includes('DISCOUNT_APPROVAL_REQUIRED')) {
    return new ApiError(409, 'DISCOUNT_APPROVAL_REQUIRED', '大额折扣需 manager 审批后才能确认')
  }
  if (msg.includes('SELF_APPROVAL_FORBIDDEN')) {
    return new ApiError(422, 'SELF_APPROVAL_FORBIDDEN', '不可审批本人发起的申请')
  }
  if (msg.includes('APPROVAL_ALREADY_PROCESSED')) {
    return err.conflict('审批已处理,不可重复操作')
  }
  if (msg.includes('AMOUNT_EXCEEDS_DUE')) {
    return new ApiError(409, 'AMOUNT_EXCEEDS_DUE', '支付金额超过未付余额')
  }
  if (msg.includes('REFUND_EXCEEDS_PAID')) {
    return err.conflict('退款金额超过已付金额')
  }
  if (msg.includes('REFUND_REASON_REQUIRED')) {
    return err.badRequest('退款原因不能为空')
  }
  // Agent-03 储值支付/退款集成错误映射
  if (msg.includes('WALLET_ACCOUNT_NOT_FOUND')) {
    return err.notFound('储值账户不存在')
  }
  if (msg.includes('WALLET_ACCOUNT_FROZEN')) {
    return err.conflict('储值账户已冻结')
  }
  if (msg.includes('WALLET_ACCOUNT_CLOSED')) {
    return err.conflict('储值账户已销户')
  }
  if (msg.includes('INSUFFICIENT_WALLET_BALANCE')) {
    return err.conflict('储值余额不足')
  }
  if (msg.includes('INVOICE_NO_CUSTOMER')) {
    return err.badRequest('储值支付须先为发票绑定客户')
  }
  if (msg.includes('INVALID_AMOUNT') || msg.includes('INVALID_METHOD')) {
    return err.badRequest(msg.replace(/^ERROR:\s*/, ''))
  }
  if (msg.includes('EMPTY_ITEMS')) {
    return err.badRequest('发票明细不能为空')
  }
  if (msg.includes('ITEM_AMOUNT_MISMATCH')) {
    return err.badRequest('明细金额不一致(amount 应等于 unit_price * quantity - discount_amount)')
  }
  if (msg.includes('DISCOUNT_EXCEEDS_SUBTOTAL')) {
    return err.badRequest('折扣金额不可超过小计')
  }
  if (msg.includes('INVALID_DISCOUNT') || msg.includes('INVALID_TAX') || msg.includes('INVALID_APPROVAL_STATUS')) {
    return err.badRequest(msg.replace(/^ERROR:\s*/, ''))
  }
  if (msg.includes('STORE_NOT_FOUND')) {
    return err.notFound('门店不存在')
  }
  return err.internal(`收费操作失败: ${msg}`)
}

/**
 * 释放就诊下所有处方的未处理预留(取消发票时调用,防止库存永久占用)
 * 仅处理尚未 confirm/release 的 reserve 流水,已发药(confirm 已扣减)的不受影响
 * @param service supabase service client
 * @param tenantId 租户 id
 * @param encounterId 就诊 id
 * @param operatorId 操作人 id
 * @returns 释放条数
 */
async function releasePrescriptionReservationsByEncounter(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  encounterId: string,
  operatorId: string,
) {
  const { data: rxs, error: rxErr } = await service
    .from('prescriptions')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('encounter_id', encounterId)
  if (rxErr) {
    throw err.internal(`查询就诊处方失败: ${rxErr.message}`)
  }
  const rxIds = (rxs ?? []).map(r => r.id as string)
  if (rxIds.length === 0) {
    return 0
  }
  const { data: reserves, error: rErr } = await service
    .from('inventory_movements')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('movement_type', 'reserve')
    .eq('reference_type', 'prescription')
    .in('reference_id', rxIds)
  if (rErr) {
    throw err.internal(`查询处方预留失败: ${rErr.message}`)
  }
  const reserveIds = (reserves ?? []).map(r => r.id as string)
  if (reserveIds.length === 0) {
    return 0
  }
  // 已被 confirm/release 处理的预留 id 集合(并发/重复取消时跳过)
  const { data: processed } = await service
    .from('inventory_movements')
    .select('reference_id')
    .eq('reference_type', 'inventory_reservation')
    .in('movement_type', ['confirm', 'release'])
    .in('reference_id', reserveIds)
  const processedIds = new Set((processed ?? []).map(p => p.reference_id as string))
  let released = 0
  for (const reserveId of reserveIds) {
    if (processedIds.has(reserveId)) {
      continue
    }
    const { error: relErr } = await service.rpc('release_inventory_reservation', {
      p_tenant_id: tenantId,
      p_reservation_id: reserveId,
      p_operator_id: operatorId,
    })
    if (relErr && !relErr.message.includes('RESERVATION_ALREADY')) {
      throw err.internal(`释放预留失败: ${relErr.message}`)
    }
    released += 1
  }
  return released
}

const createInvoiceSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  customerId: z.string().uuid().optional().nullable(),
  petId: z.string().uuid().optional().nullable(),
  encounterId: z.string().uuid().optional().nullable(),
  items: z.array(z.object({
    catalogItemId: z.string().uuid().optional(),
    storeCatalogItemId: z.string().uuid().optional(),
    name: z.string().min(1, '明细名称不能为空'),
    unitPrice: z.number().nonnegative('单价不能为负'),
    quantity: z.number().positive('数量必须大于 0'),
    discountAmount: z.number().nonnegative().optional(),
    amount: z.number().nonnegative('金额不能为负'),
    sortOrder: z.number().int().optional(),
    category: z.enum(['service', 'drug', 'vaccine', 'exam', 'product']).optional(),
  })).min(1, '至少一条明细'),
  discountAmount: z.number().nonnegative().optional(),
  discountReason: z.string().max(500).optional(),
  taxAmount: z.number().nonnegative().optional(),
  paymentMethod: z.enum(['cash', 'wechat', 'alipay', 'card', 'other', 'stored_value']).optional(),
  dueDate: z.string().optional(),
  idempotencyKey: z.string().max(200).optional(),
  applyMembershipDiscount: z.boolean().optional(),
})

/**
 * 创建发票(MXQ-8001)
 * - 权限:invoice.create
 * - 行为:调 create_invoice RPC,事务化建发票+明细+审批记录,校验金额一致性
 * - 大额折扣(>10%)自动建 approval 记录,需 manager 审批后才能 confirm
 * - 幂等:同一 idempotency-key 重复请求返回原结果
 */
billingRoutes.post('/invoices', async (c) => {
  const input = await parseJsonBody(c, createInvoiceSchema)
  // P0-02 scoped:租户/门店作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'invoice.create',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })

  const service = createServiceClient()
  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  // service role 写入前校验业务归属,避免客户、宠物或目录项目跨租户/跨门店串单。
  if (input.customerId) {
    const { data: customer } = await service
      .from('customers')
      .select('id')
      .eq('id', input.customerId)
      .eq('tenant_id', scope.tenantId)
      .neq('status', 'archived')
      .neq('status', 'merged')
      .maybeSingle()
    if (!customer) {
      throw err.badRequest('客户不存在、已归档或不属于当前租户')
    }
  }

  if (input.petId) {
    if (!input.customerId) {
      throw err.badRequest('选择宠物时必须同时绑定客户')
    }
    const { data: pet } = await service
      .from('pets')
      .select('id')
      .eq('id', input.petId)
      .eq('tenant_id', scope.tenantId)
      .eq('customer_id', input.customerId)
      .neq('status', 'archived')
      .maybeSingle()
    if (!pet) {
      throw err.badRequest('宠物不存在、已归档或不属于所选客户')
    }
  }

  const storeCatalogIds = [...new Set(input.items.flatMap(item => item.storeCatalogItemId ? [item.storeCatalogItemId] : []))]
  if (storeCatalogIds.length > 0) {
    const { data: storeItems, error: storeItemsError } = await service
      .from('store_catalog_items')
      .select('id')
      .eq('tenant_id', scope.tenantId)
      .eq('store_id', scope.storeId)
      .eq('is_active', true)
      .in('id', storeCatalogIds)
    if (storeItemsError || (storeItems ?? []).length !== storeCatalogIds.length) {
      throw err.badRequest('收费项目已停用或不属于当前门店,请刷新后重试')
    }
  }

  // 把 items 转为 RPC 期望的 jsonb 数组
  const itemsJson = input.items.map((item, idx) => ({
    catalog_item_id: item.catalogItemId ?? null,
    store_catalog_item_id: item.storeCatalogItemId ?? null,
    name: item.name,
    unit_price: item.unitPrice,
    quantity: item.quantity,
    discount_amount: item.discountAmount ?? 0,
    amount: item.amount,
    sort_order: item.sortOrder ?? idx,
    category: item.category ?? 'service',
    catalog_type: item.category ?? null,
  }))

  const { data, error } = await service.rpc('create_invoice', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_customer_id: input.customerId ?? null,
    p_pet_id: input.petId ?? null,
    p_encounter_id: input.encounterId ?? null,
    p_items: itemsJson,
    p_discount_amount: input.discountAmount ?? 0,
    p_discount_reason: input.discountReason ?? null,
    p_tax_amount: input.taxAmount ?? 0,
    p_payment_method: input.paymentMethod ?? null,
    p_due_date: input.dueDate ?? null,
    p_operator_id: user.id,
    p_apply_membership_discount: input.applyMembershipDiscount ?? false,
  })

  if (error) {
    throw mapRpcError(error)
  }

  const result = data as { invoiceId?: string, invoiceNo?: string, total?: number, itemsCount?: number }

  await writeAudit(c, {
    action: 'invoice.create',
    entityType: 'invoice',
    entityId: result.invoiceId,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: {
      invoiceNo: result.invoiceNo,
      total: result.total,
      itemsCount: result.itemsCount,
      idempotencyKey,
    },
  })

  return ok(c, result)
})

/**
 * 确认发票(MXQ-8002)
 * - 权限:invoice.confirm
 * - 行为:调 confirm_invoice RPC,大额折扣(>10%)需先审批
 * - 状态:draft → confirmed
 */
billingRoutes.post('/invoices/:id/confirm', async (c) => {
  const invoiceId = c.req.param('id')
  const service = createServiceClient()

  // 取发票做归属校验
  const { data: invoice, error: fetchErr } = await service
    .from('invoices')
    .select('id, tenant_id, store_id, status')
    .eq('id', invoiceId)
    .maybeSingle()
  if (fetchErr || !invoice) {
    throw err.notFound('发票不存在')
  }
  // P0-02 scoped:按发票租户/门店做作用域授权,替代 requirePermission
  await requireScopedPermission(c, {
    code: 'invoice.confirm',
    tenantId: invoice.tenant_id,
    storeId: invoice.store_id ?? undefined,
  })

  const user = c.get('user')
  const { data, error } = await service.rpc('confirm_invoice', {
    p_invoice_id: invoiceId,
    p_operator_id: user.id,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'invoice.confirm',
    entityType: 'invoice',
    entityId: invoiceId,
    tenantId: invoice.tenant_id,
    storeId: invoice.store_id,
    metadata: { invoiceNo: (data as { invoice_no?: string })?.invoice_no },
  })

  return ok(c, data)
})

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
})

/**
 * 取消发票(MXQ-8001)
 * - 权限:invoice.cancel
 * - 行为:调 cancel_invoice RPC,仅 draft/confirmed 可取消
 */
billingRoutes.post('/invoices/:id/cancel', async (c) => {
  const invoiceId = c.req.param('id')
  const input = await parseJsonBody(c, cancelSchema)

  const service = createServiceClient()
  const { data: invoice, error: fetchErr } = await service
    .from('invoices')
    .select('id, tenant_id, store_id, status, encounter_id')
    .eq('id', invoiceId)
    .maybeSingle()
  if (fetchErr || !invoice) {
    throw err.notFound('发票不存在')
  }
  // P0-02 scoped:按发票租户/门店做作用域授权,替代 requirePermission
  await requireScopedPermission(c, {
    code: 'invoice.cancel',
    tenantId: invoice.tenant_id,
    storeId: invoice.store_id ?? undefined,
  })

  const user = c.get('user')
  const { data, error } = await service.rpc('cancel_invoice', {
    p_invoice_id: invoiceId,
    p_operator_id: user.id,
    p_reason: input.reason ?? null,
  })

  if (error) {
    throw mapRpcError(error)
  }

  // P0-08:发票关联就诊时,联动释放该就诊下处方的未处理预留,防止库存永久占用
  // 仅释放 pending 的 reserve 流水,已发药(confirm 已扣减)的不受影响
  if (invoice.encounter_id) {
    await releasePrescriptionReservationsByEncounter(service, invoice.tenant_id, invoice.encounter_id, user.id)
  }

  await writeAudit(c, {
    action: 'invoice.cancel',
    entityType: 'invoice',
    entityId: invoiceId,
    tenantId: invoice.tenant_id,
    storeId: invoice.store_id,
    metadata: { reason: input.reason },
  })

  return ok(c, data)
})

const approvalSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reason: z.string().max(500).optional(),
})

/**
 * 大额折扣审批(MXQ-8002)
 * - 权限:invoice.confirm(manager 角色)
 * - 行为:调 approve_discount RPC
 */
billingRoutes.post('/approvals/:id/decide', async (c) => {
  const approvalId = c.req.param('id')
  const input = await parseJsonBody(c, approvalSchema)

  const service = createServiceClient()
  const { data: approval, error: fetchErr } = await service
    .from('approvals')
    .select('id, tenant_id, store_id, status')
    .eq('id', approvalId)
    .maybeSingle()
  if (fetchErr || !approval) {
    throw err.notFound('审批记录不存在')
  }
  // P0-02 scoped:按审批租户/门店做作用域授权,替代 requirePermission
  await requireScopedPermission(c, {
    code: 'invoice.confirm',
    tenantId: approval.tenant_id,
    storeId: approval.store_id ?? undefined,
  })

  const user = c.get('user')
  const { data, error } = await service.rpc('approve_discount', {
    p_approval_id: approvalId,
    p_status: input.status,
    p_approved_by: user.id,
    p_reason: input.reason ?? null,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'invoice.approveDiscount',
    entityType: 'approval',
    entityId: approvalId,
    tenantId: approval.tenant_id,
    storeId: approval.store_id,
    metadata: { status: input.status, reason: input.reason },
  })

  return ok(c, data)
})

const paymentSchema = z.object({
  invoiceId: z.string().uuid('发票 id 格式错误'),
  amount: z.number().positive('支付金额必须大于 0'),
  method: z.enum(['cash', 'wechat', 'alipay', 'card', 'other', 'stored_value']),
  transactionNo: z.string().max(200).optional(),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 处理支付(MXQ-8003)
 * - 权限:payment.process
 * - 行为:调 process_payment RPC,事务化记录支付+更新已付金额+状态机
 * - 幂等:同一 idempotency-key 重复请求返回原结果,paid_amount 不重复增加
 */
billingRoutes.post('/payments', async (c) => {
  const input = await parseJsonBody(c, paymentSchema)
  const service = createServiceClient()

  // 取发票做归属校验
  const { data: invoice, error: fetchErr } = await service
    .from('invoices')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.invoiceId)
    .maybeSingle()
  if (fetchErr || !invoice) {
    throw err.notFound('发票不存在')
  }
  // P0-02 scoped:按发票租户/门店做作用域授权,替代 requirePermission
  await requireScopedPermission(c, {
    code: 'payment.process',
    tenantId: invoice.tenant_id,
    storeId: invoice.store_id ?? undefined,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('process_payment', {
    p_invoice_id: input.invoiceId,
    p_amount: input.amount,
    p_method: input.method,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
    p_transaction_no: input.transactionNo ?? null,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'payment.process',
    entityType: 'payment',
    entityId: (data as { paymentId?: string })?.paymentId,
    tenantId: invoice.tenant_id,
    storeId: invoice.store_id,
    metadata: {
      invoiceId: input.invoiceId,
      amount: input.amount,
      method: input.method,
      transactionNo: input.transactionNo,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

const refundSchema = z.object({
  invoiceId: z.string().uuid('发票 id 格式错误'),
  amount: z.number().positive('退款金额必须大于 0'),
  reason: z.string().min(1, '退款原因不能为空').max(500),
  paymentId: z.string().uuid().optional(),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 处理退款(MXQ-8004)
 * - 权限:refund.process
 * - 行为:调 process_refund RPC,事务化记录退款+扣减已付金额+状态机
 * - 退款金额不可超过已付金额
 * - 幂等:同一 idempotency-key 重复请求返回原结果
 */
billingRoutes.post('/refunds', async (c) => {
  const input = await parseJsonBody(c, refundSchema)
  const service = createServiceClient()

  const { data: invoice, error: fetchErr } = await service
    .from('invoices')
    .select('id, tenant_id, store_id, status')
    .eq('id', input.invoiceId)
    .maybeSingle()
  if (fetchErr || !invoice) {
    throw err.notFound('发票不存在')
  }
  // P0-02 scoped:按发票租户/门店做作用域授权,替代 requirePermission
  await requireScopedPermission(c, {
    code: 'refund.process',
    tenantId: invoice.tenant_id,
    storeId: invoice.store_id ?? undefined,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('process_refund', {
    p_invoice_id: input.invoiceId,
    p_amount: input.amount,
    p_reason: input.reason,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
    p_payment_id: input.paymentId ?? null,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'refund.process',
    entityType: 'refund',
    entityId: (data as { refundId?: string })?.refundId,
    tenantId: invoice.tenant_id,
    storeId: invoice.store_id,
    metadata: {
      invoiceId: input.invoiceId,
      amount: input.amount,
      reason: input.reason,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

/**
 * 生成小票(MXQ-8007)
 * - 权限:receipt.print
 * - 行为:调 generate_receipt RPC,返回完整小票数据
 */
billingRoutes.post('/invoices/:id/receipt', async (c) => {
  const invoiceId = c.req.param('id')
  const service = createServiceClient()

  const { data: invoice, error: fetchErr } = await service
    .from('invoices')
    .select('id, tenant_id, store_id, status')
    .eq('id', invoiceId)
    .maybeSingle()
  if (fetchErr || !invoice) {
    throw err.notFound('发票不存在')
  }
  // P0-02 scoped:按发票租户/门店做作用域授权,替代 requirePermission
  await requireScopedPermission(c, {
    code: 'receipt.print',
    tenantId: invoice.tenant_id,
    storeId: invoice.store_id ?? undefined,
  })

  const { data, error } = await service.rpc('generate_receipt', {
    p_invoice_id: invoiceId,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'receipt.print',
    entityType: 'invoice',
    entityId: invoiceId,
    tenantId: invoice.tenant_id,
    storeId: invoice.store_id,
    metadata: {},
  })

  return ok(c, data)
})

export default billingRoutes
