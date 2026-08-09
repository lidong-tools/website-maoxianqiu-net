import type { Context } from 'hono'
import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * 采购申请 Command 路由(Stage-04 Agent-07)
 *
 * 状态机:
 *   draft → submitted → approved → converted_to_po
 *   submitted → rejected
 *   draft / submitted → cancelled
 *
 * 安全:
 *   - 创建/编辑须 purchase_request.create;提交须 .submit;审核须 .approve;转单须 .convert
 *   - 全部写操作走 Hono Command + service-role RPC(状态机 + 行锁),禁止前端直连写
 *   - 审核禁止自审(SELF_APPROVAL_FORBIDDEN,由 RPC 保证)
 *   - 转换(convert)复用现有 create_purchase_order,幂等(重复调用返回同一个 PO)
 */
const purchaseRequestRoutes = new Hono<AppEnv>()

purchaseRequestRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/** 将 RPC 抛出的业务错误码映射为 HTTP 错误 */
function mapRpcError(error: { message: string }) {
  const msg = error.message
  if (msg.includes('PURCHASE_REQUEST_NOT_FOUND')) {
    return err.notFound('采购申请不存在')
  }
  if (msg.includes('STORE_NOT_FOUND')) {
    return err.notFound('门店不存在')
  }
  if (msg.includes('WAREHOUSE_NOT_FOUND')) {
    return err.notFound('仓库不存在或不属于该门店')
  }
  if (msg.includes('SUPPLIER_NOT_FOUND')) {
    return err.notFound('供应商不存在或已停用')
  }
  if (msg.includes('CATALOG_ITEM_NOT_FOUND')) {
    return err.notFound('商品不存在或不属于该租户')
  }
  if (msg.includes('NOT_DRAFT')) {
    return err.conflict('仅草稿状态可编辑')
  }
  if (msg.includes('INVALID_STATUS')) {
    return err.conflict('当前状态不允许该操作')
  }
  if (msg.includes('SELF_APPROVAL_FORBIDDEN')) {
    return err.forbidden('申请人不允许审核自己的申请')
  }
  if (msg.includes('SUPPLIER_REQUIRED_FOR_CONVERT')) {
    return err.conflict('转换为采购单前必须指定供应商')
  }
  if (msg.includes('EMPTY_ITEMS') || msg.includes('INVALID_QUANTITY')) {
    return err.badRequest(msg.replace(/^ERROR:\s*/, ''))
  }
  // 不透传底层 DB 错误消息,避免泄露内部信息
  return err.internal('采购申请操作失败')
}

const itemSchema = z.object({
  catalogItemId: z.string().uuid('商品 id 格式错误'),
  requestedQty: z.number().positive('申请数量必须大于 0'),
  unit: z.string().max(50).optional(),
  estimatedUnitCost: z.number().nonnegative('预估单价不能为负').optional(),
  note: z.string().max(500).optional(),
})

const createSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  warehouseId: z.string().uuid('仓库 id 格式错误'),
  supplierId: z.string().uuid('供应商 id 格式错误').optional(),
  requesterId: z.string().uuid('申请人 id 格式错误').optional(),
  reason: z.string().max(500).optional(),
  requiredAt: z.string().optional(),
  items: z.array(itemSchema).min(1, '至少一项申请明细'),
})

const updateDraftSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  requestId: z.string().uuid('申请 id 格式错误'),
  warehouseId: z.string().uuid('仓库 id 格式错误'),
  supplierId: z.string().uuid('供应商 id 格式错误').optional(),
  requesterId: z.string().uuid('申请人 id 格式错误').optional(),
  reason: z.string().max(500).optional(),
  requiredAt: z.string().optional(),
  items: z.array(itemSchema).min(1, '至少一项申请明细'),
})

const actionSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  requestId: z.string().uuid('申请 id 格式错误'),
})

const rejectSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  requestId: z.string().uuid('申请 id 格式错误'),
  rejectReason: z.string().max(500).optional(),
})

/** 查采购申请取 store_id 做作用域授权(创建外的所有流转共用) */
async function resolvePurchaseRequest(c: Context<AppEnv>, tenantId: string, requestId: string) {
  const service = createServiceClient()
  const { data, error } = await service
    .from('purchase_requests')
    .select('id, tenant_id, store_id, warehouse_id, request_no, status')
    .eq('id', requestId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (error || !data) {
    throw err.notFound('采购申请不存在')
  }
  return data
}

/**
 * 创建采购申请草稿
 * - 权限:purchase_request.create(门店作用域)
 * - 行为:调 create_purchase_request RPC,生成 request_no 与明细
 */
purchaseRequestRoutes.post('/', async (c) => {
  const input = await parseJsonBody(c, createSchema)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_request.create',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('create_purchase_request', {
    p_tenant_id: scope.tenantId,
    p_store_id: input.storeId,
    p_warehouse_id: input.warehouseId,
    p_supplier_id: input.supplierId ?? null,
    p_requester_id: input.requesterId ?? null,
    p_reason: input.reason ?? null,
    p_required_at: input.requiredAt ?? null,
    p_items: input.items.map(i => ({
      catalog_item_id: i.catalogItemId,
      requested_qty: i.requestedQty,
      unit: i.unit ?? null,
      estimated_unit_cost: i.estimatedUnitCost ?? 0,
      note: i.note ?? null,
    })),
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseRequestCreate',
    entityType: 'purchase_request',
    entityId: (data as { id?: string })?.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { requestNo: (data as { requestNo?: string })?.requestNo, itemCount: input.items.length },
  })

  return ok(c, data)
})

/**
 * 编辑草稿(仅 draft;替换全部明细)
 * - 权限:purchase_request.create
 */
purchaseRequestRoutes.post('/draft', async (c) => {
  const input = await parseJsonBody(c, updateDraftSchema)
  const req = await resolvePurchaseRequest(c, input.tenantId, input.requestId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_request.create',
    tenantId: req.tenant_id,
    storeId: req.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('update_purchase_request_draft', {
    p_tenant_id: scope.tenantId,
    p_request_id: input.requestId,
    p_warehouse_id: input.warehouseId,
    p_supplier_id: input.supplierId ?? null,
    p_requester_id: input.requesterId ?? null,
    p_reason: input.reason ?? null,
    p_required_at: input.requiredAt ?? null,
    p_items: input.items.map(i => ({
      catalog_item_id: i.catalogItemId,
      requested_qty: i.requestedQty,
      unit: i.unit ?? null,
      estimated_unit_cost: i.estimatedUnitCost ?? 0,
      note: i.note ?? null,
    })),
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseRequestDraftUpdate',
    entityType: 'purchase_request',
    entityId: input.requestId,
    tenantId: input.tenantId,
    storeId: req.store_id,
    metadata: { requestNo: req.request_no, itemCount: input.items.length },
  })

  return ok(c, data)
})

/**
 * 提交采购申请(draft → submitted)
 * - 权限:purchase_request.submit
 */
purchaseRequestRoutes.post('/submit', async (c) => {
  const input = await parseJsonBody(c, actionSchema)
  const req = await resolvePurchaseRequest(c, input.tenantId, input.requestId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_request.submit',
    tenantId: req.tenant_id,
    storeId: req.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('submit_purchase_request', {
    p_tenant_id: scope.tenantId,
    p_request_id: input.requestId,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseRequestSubmit',
    entityType: 'purchase_request',
    entityId: input.requestId,
    tenantId: input.tenantId,
    storeId: req.store_id,
    metadata: { requestNo: req.request_no },
  })

  return ok(c, data)
})

/**
 * 审核采购申请(submitted → approved;禁止自审)
 * - 权限:purchase_request.approve
 */
purchaseRequestRoutes.post('/approve', async (c) => {
  const input = await parseJsonBody(c, actionSchema)
  const req = await resolvePurchaseRequest(c, input.tenantId, input.requestId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_request.approve',
    tenantId: req.tenant_id,
    storeId: req.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('approve_purchase_request', {
    p_tenant_id: scope.tenantId,
    p_request_id: input.requestId,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseRequestApprove',
    entityType: 'purchase_request',
    entityId: input.requestId,
    tenantId: input.tenantId,
    storeId: req.store_id,
    metadata: { requestNo: req.request_no },
  })

  return ok(c, data)
})

/**
 * 驳回采购申请(submitted → rejected)
 * - 权限:purchase_request.approve
 */
purchaseRequestRoutes.post('/reject', async (c) => {
  const input = await parseJsonBody(c, rejectSchema)
  const req = await resolvePurchaseRequest(c, input.tenantId, input.requestId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_request.approve',
    tenantId: req.tenant_id,
    storeId: req.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('reject_purchase_request', {
    p_tenant_id: scope.tenantId,
    p_request_id: input.requestId,
    p_reject_reason: input.rejectReason ?? null,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseRequestReject',
    entityType: 'purchase_request',
    entityId: input.requestId,
    tenantId: input.tenantId,
    storeId: req.store_id,
    metadata: { requestNo: req.request_no, rejectReason: input.rejectReason },
  })

  return ok(c, data)
})

/**
 * 取消采购申请(draft / submitted → cancelled)
 * - 权限:purchase_request.submit
 */
purchaseRequestRoutes.post('/cancel', async (c) => {
  const input = await parseJsonBody(c, actionSchema)
  const req = await resolvePurchaseRequest(c, input.tenantId, input.requestId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_request.submit',
    tenantId: req.tenant_id,
    storeId: req.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('cancel_purchase_request', {
    p_tenant_id: scope.tenantId,
    p_request_id: input.requestId,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseRequestCancel',
    entityType: 'purchase_request',
    entityId: input.requestId,
    tenantId: input.tenantId,
    storeId: req.store_id,
    metadata: { requestNo: req.request_no },
  })

  return ok(c, data)
})

/**
 * 转换为采购单(approved → converted_to_po;幂等)
 * - 权限:purchase_request.convert
 * - 行为:复用 create_purchase_order 生成 PO 草稿,写 source_request_id 溯源;
 *        重复调用返回同一个 PO(idempotent=true)
 */
purchaseRequestRoutes.post('/convert', async (c) => {
  const input = await parseJsonBody(c, actionSchema)
  const req = await resolvePurchaseRequest(c, input.tenantId, input.requestId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_request.convert',
    tenantId: req.tenant_id,
    storeId: req.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('convert_purchase_request_to_po', {
    p_tenant_id: scope.tenantId,
    p_request_id: input.requestId,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  const result = data as { poId?: string, poNo?: string, idempotent?: boolean }
  await writeAudit(c, {
    action: 'inventory.purchaseRequestConvert',
    entityType: 'purchase_request',
    entityId: input.requestId,
    tenantId: input.tenantId,
    storeId: req.store_id,
    metadata: { requestNo: req.request_no, poId: result.poId, poNo: result.poNo, idempotent: result.idempotent },
  })

  return ok(c, data)
})

export default purchaseRequestRoutes
