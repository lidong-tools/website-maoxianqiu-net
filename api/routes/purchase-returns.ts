import type { Context } from 'hono'
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
 * 采购退货 Command 路由(Stage-04 Agent-07)
 *
 * 状态机:
 *   draft → submitted → approved → posted
 *   draft / submitted → cancelled
 *
 * 安全:
 *   - 创建/编辑须 purchase_return.create;提交须 .submit;审核须 .approve;过账须 .post
 *   - 全部写操作走 Hono Command + service-role RPC(状态机 + 行锁)
 *   - 过账(post)走正式库存 Command:批次 FOR UPDATE + 不可变流水(movement_type='return'),
 *     幂等(Idempotency-Key header 或 body.idempotencyKey)
 *   - 财务边界:仅记录 return_amount_snapshot / supplier / source PO,不引入总账
 */
const purchaseReturnRoutes = new Hono<AppEnv>()

purchaseReturnRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/** 从 Header 或 body 解析幂等键;过账必须提供 */
function resolveIdempotencyKey(c: Context<AppEnv>, bodyKey?: string): string {
  const key = getRequestIdempotencyKey(c) || bodyKey
  if (!key) {
    throw err.badRequest('缺少幂等键(Idempotency-Key header 或 body.idempotencyKey)')
  }
  return key
}

/** 将 RPC 抛出的业务错误码映射为 HTTP 错误 */
function mapRpcError(error: { message: string }) {
  const msg = error.message
  if (msg.includes('PURCHASE_RETURN_NOT_FOUND')) {
    return err.notFound('采购退货单不存在')
  }
  if (msg.includes('PURCHASE_ORDER_NOT_FOUND')) {
    return err.notFound('来源采购单不存在')
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
  if (msg.includes('BATCH_NOT_FOUND')) {
    return err.notFound('批次不存在或不属于该仓库')
  }
  if (msg.includes('INSUFFICIENT_STOCK')) {
    return err.conflict('批次可退库存不足')
  }
  if (msg.includes('NOT_DRAFT')) {
    return err.conflict('仅草稿状态可编辑')
  }
  if (msg.includes('INVALID_STATUS')) {
    return err.conflict('当前状态不允许该操作')
  }
  if (msg.includes('EMPTY_ITEMS') || msg.includes('INVALID_QUANTITY')) {
    return err.badRequest(msg.replace(/^ERROR:\s*/, ''))
  }
  // 不透传底层 DB 错误消息,避免泄露内部信息
  return err.internal('采购退货操作失败')
}

const itemSchema = z.object({
  catalogItemId: z.string().uuid('商品 id 格式错误'),
  batchId: z.string().uuid('批次 id 格式错误'),
  sourcePoItemId: z.string().uuid('来源明细 id 格式错误').optional(),
  quantity: z.number().positive('退货数量必须大于 0'),
  unitCost: z.number().nonnegative('单价不能为负').optional(),
  note: z.string().max(500).optional(),
})

const createSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  warehouseId: z.string().uuid('仓库 id 格式错误'),
  supplierId: z.string().uuid('供应商 id 格式错误').optional(),
  sourcePoId: z.string().uuid('来源采购单 id 格式错误').optional(),
  reason: z.string().max(500).optional(),
  items: z.array(itemSchema).min(1, '至少一项退货明细'),
})

const updateDraftSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  returnId: z.string().uuid('退货单 id 格式错误'),
  warehouseId: z.string().uuid('仓库 id 格式错误'),
  supplierId: z.string().uuid('供应商 id 格式错误').optional(),
  sourcePoId: z.string().uuid('来源采购单 id 格式错误').optional(),
  reason: z.string().max(500).optional(),
  items: z.array(itemSchema).min(1, '至少一项退货明细'),
})

const actionSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  returnId: z.string().uuid('退货单 id 格式错误'),
})

const postSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  returnId: z.string().uuid('退货单 id 格式错误'),
  idempotencyKey: z.string().max(200).optional(),
})

/** 查退货单取 store_id 做作用域授权(创建外的所有流转共用) */
async function resolvePurchaseReturn(c: Context<AppEnv>, tenantId: string, returnId: string) {
  const service = createServiceClient()
  const { data, error } = await service
    .from('purchase_returns')
    .select('id, tenant_id, store_id, warehouse_id, return_no, status')
    .eq('id', returnId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (error || !data) {
    throw err.notFound('采购退货单不存在')
  }
  return data
}

/**
 * 创建采购退货草稿
 * - 权限:purchase_return.create(门店作用域)
 * - 行为:调 create_purchase_return RPC,生成 return_no 与明细
 */
purchaseReturnRoutes.post('/', async (c) => {
  const input = await parseJsonBody(c, createSchema)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_return.create',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('create_purchase_return', {
    p_tenant_id: scope.tenantId,
    p_store_id: input.storeId,
    p_warehouse_id: input.warehouseId,
    p_supplier_id: input.supplierId ?? null,
    p_source_po_id: input.sourcePoId ?? null,
    p_reason: input.reason ?? null,
    p_items: input.items.map(i => ({
      catalog_item_id: i.catalogItemId,
      batch_id: i.batchId,
      source_po_item_id: i.sourcePoItemId ?? null,
      quantity: i.quantity,
      unit_cost: i.unitCost ?? 0,
      note: i.note ?? null,
    })),
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseReturnCreate',
    entityType: 'purchase_return',
    entityId: (data as { id?: string })?.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { returnNo: (data as { returnNo?: string })?.returnNo, itemCount: input.items.length },
  })

  return ok(c, data)
})

/**
 * 编辑草稿(仅 draft;替换全部明细)
 * - 权限:purchase_return.create
 */
purchaseReturnRoutes.post('/draft', async (c) => {
  const input = await parseJsonBody(c, updateDraftSchema)
  const ret = await resolvePurchaseReturn(c, input.tenantId, input.returnId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_return.create',
    tenantId: ret.tenant_id,
    storeId: ret.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('update_purchase_return_draft', {
    p_tenant_id: scope.tenantId,
    p_return_id: input.returnId,
    p_warehouse_id: input.warehouseId,
    p_supplier_id: input.supplierId ?? null,
    p_source_po_id: input.sourcePoId ?? null,
    p_reason: input.reason ?? null,
    p_items: input.items.map(i => ({
      catalog_item_id: i.catalogItemId,
      batch_id: i.batchId,
      source_po_item_id: i.sourcePoItemId ?? null,
      quantity: i.quantity,
      unit_cost: i.unitCost ?? 0,
      note: i.note ?? null,
    })),
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseReturnDraftUpdate',
    entityType: 'purchase_return',
    entityId: input.returnId,
    tenantId: input.tenantId,
    storeId: ret.store_id,
    metadata: { returnNo: ret.return_no, itemCount: input.items.length },
  })

  return ok(c, data)
})

/**
 * 提交采购退货(draft → submitted)
 * - 权限:purchase_return.submit
 */
purchaseReturnRoutes.post('/submit', async (c) => {
  const input = await parseJsonBody(c, actionSchema)
  const ret = await resolvePurchaseReturn(c, input.tenantId, input.returnId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_return.submit',
    tenantId: ret.tenant_id,
    storeId: ret.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('submit_purchase_return', {
    p_tenant_id: scope.tenantId,
    p_return_id: input.returnId,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseReturnSubmit',
    entityType: 'purchase_return',
    entityId: input.returnId,
    tenantId: input.tenantId,
    storeId: ret.store_id,
    metadata: { returnNo: ret.return_no },
  })

  return ok(c, data)
})

/**
 * 审核采购退货(submitted → approved)
 * - 权限:purchase_return.approve
 */
purchaseReturnRoutes.post('/approve', async (c) => {
  const input = await parseJsonBody(c, actionSchema)
  const ret = await resolvePurchaseReturn(c, input.tenantId, input.returnId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_return.approve',
    tenantId: ret.tenant_id,
    storeId: ret.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('approve_purchase_return', {
    p_tenant_id: scope.tenantId,
    p_return_id: input.returnId,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseReturnApprove',
    entityType: 'purchase_return',
    entityId: input.returnId,
    tenantId: input.tenantId,
    storeId: ret.store_id,
    metadata: { returnNo: ret.return_no },
  })

  return ok(c, data)
})

/**
 * 取消采购退货(draft / submitted → cancelled)
 * - 权限:purchase_return.submit
 */
purchaseReturnRoutes.post('/cancel', async (c) => {
  const input = await parseJsonBody(c, actionSchema)
  const ret = await resolvePurchaseReturn(c, input.tenantId, input.returnId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_return.submit',
    tenantId: ret.tenant_id,
    storeId: ret.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('cancel_purchase_return', {
    p_tenant_id: scope.tenantId,
    p_return_id: input.returnId,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseReturnCancel',
    entityType: 'purchase_return',
    entityId: input.returnId,
    tenantId: input.tenantId,
    storeId: ret.store_id,
    metadata: { returnNo: ret.return_no },
  })

  return ok(c, data)
})

/**
 * 过账采购退货(approved → posted;正式库存 Command)
 * - 权限:purchase_return.post
 * - 行为:调 post_purchase_return RPC,批次 FOR UPDATE + 不可变流水(movement_type='return')
 * - 幂等:同一 Idempotency-Key 重复请求返回原结果
 */
purchaseReturnRoutes.post('/post', async (c) => {
  const input = await parseJsonBody(c, postSchema)
  const ret = await resolvePurchaseReturn(c, input.tenantId, input.returnId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase_return.post',
    tenantId: ret.tenant_id,
    storeId: ret.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('post_purchase_return', {
    p_tenant_id: scope.tenantId,
    p_return_id: input.returnId,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseReturnPost',
    entityType: 'purchase_return',
    entityId: input.returnId,
    tenantId: input.tenantId,
    storeId: ret.store_id,
    metadata: { returnNo: ret.return_no, returnAmountSnapshot: (data as { returnAmountSnapshot?: number })?.returnAmountSnapshot, idempotencyKey },
  })

  return ok(c, data)
})

export default purchaseReturnRoutes
