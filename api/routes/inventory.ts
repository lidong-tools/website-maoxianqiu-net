import type { Context } from 'hono'
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

/**
 * Inventory 领域 Command 路由(MXQ-9003~9008)
 *
 * 状态机:
 *   batch: active → exhausted(quantity_remaining=0) / expired(expiry_date<now)
 *   预留:reserve(冻结可用库存) → confirm(支付确认转正式扣减) / release(取消释放)
 *   调拨无独立状态,由 transfer_inventory RPC 原子事务保证一致性
 *
 * 安全:
 *   - 入库须 inventory.receive 权限
 *   - 发药须 inventory.dispense 权限
 *   - 盘点须 inventory.count 权限
 *   - 调拨须 inventory.transfer 权限
 *   - 预留/确认/释放须 inventory.reserve / inventory.confirm / inventory.release 权限
 *   - 近效期查询须 inventory.view 权限
 *   - 所有库存过账走 Hono Command + PostgreSQL RPC,禁止前端直连改余额
 *   - 幂等:请求须带 idempotency-key(Header 或 body.idempotencyKey),RPC 内 SELECT FOR UPDATE + 唯一键防超卖
 */
const inventoryRoutes = new Hono<AppEnv>()

inventoryRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/** 从 Header 或 body 解析幂等键;关键写操作必须提供,缺失返回 400 防止绕过幂等 */
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
  if (msg.includes('WAREHOUSE_NOT_FOUND') || msg.includes('FROM_WAREHOUSE_NOT_FOUND') || msg.includes('TO_WAREHOUSE_NOT_FOUND')) {
    return err.notFound('仓库不存在')
  }
  if (msg.includes('WAREHOUSE_INACTIVE') || msg.includes('FROM_WAREHOUSE_INACTIVE') || msg.includes('TO_WAREHOUSE_INACTIVE')) {
    return err.conflict('仓库已停用')
  }
  if (msg.includes('INSUFFICIENT_STOCK')) {
    return err.conflict('库存不足')
  }
  if (msg.includes('RESERVATION_NOT_FOUND')) {
    return err.notFound('预留记录不存在')
  }
  if (msg.includes('RESERVATION_ALREADY_CONFIRMED')) {
    return err.conflict('该预留已被确认')
  }
  if (msg.includes('RESERVATION_ALREADY_RELEASED')) {
    return err.conflict('该预留已被释放')
  }
  if (msg.includes('RESERVATION_EXPIRED')) {
    return err.conflict('该预留已过期,请重新预留或释放')
  }
  if (msg.includes('INVALID_QUANTITY') || msg.includes('EMPTY_ITEMS') || msg.includes('SAME_WAREHOUSE')) {
    return err.badRequest(msg.replace(/^ERROR:\s*/, ''))
  }
  // 采购模块错误映射
  if (msg.includes('PURCHASE_ORDER_NOT_FOUND')) {
    return err.notFound('采购单不存在')
  }
  if (msg.includes('STORE_NOT_FOUND')) {
    return err.notFound('门店不存在')
  }
  if (msg.includes('SUPPLIER_NOT_FOUND')) {
    return err.notFound('供应商不存在或已停用')
  }
  if (msg.includes('ITEM_NOT_FOUND')) {
    return err.notFound('采购明细不存在')
  }
  if (msg.includes('NOT_DRAFT')) {
    return err.conflict('仅草稿状态可编辑')
  }
  if (msg.includes('INVALID_STATUS')) {
    return err.conflict('当前状态不允许该操作')
  }
  if (msg.includes('INVALID_RECEIVED_QTY')) {
    return err.badRequest('实收数量须在 0 与订购数量之间')
  }
  // 不透传底层 DB 错误消息,避免泄露内部信息(保留业务码由 HTTP 状态映射)
  return err.internal('库存操作失败')
}

const goodsReceiptSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  warehouseId: z.string().uuid('仓库 id 格式错误'),
  catalogItemId: z.string().uuid('商品 id 格式错误'),
  batchNo: z.string().max(100).optional(),
  quantity: z.number().positive('数量必须大于 0'),
  unitCost: z.number().nonnegative().optional(),
  expiryDate: z.string().optional(),
  supplier: z.string().max(200).optional(),
  referenceId: z.string().max(100).optional(),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 入库(MXQ-9003)
 * - 权限:inventory.receive
 * - 行为:调 post_goods_receipt RPC,事务化创建批次/余额/流水
 * - 幂等:同一 idempotency-key 重复请求返回原结果
 */
inventoryRoutes.post('/goods-receipt', async (c) => {
  const input = await parseJsonBody(c, goodsReceiptSchema)
  const service = createServiceClient()

  // 查仓库获取 store_id 做权限校验
  const { data: wh, error: whErr } = await service
    .from('warehouses')
    .select('id, tenant_id, store_id, is_active')
    .eq('id', input.warehouseId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (whErr || !wh) {
    throw err.notFound('仓库不存在')
  }
  if (!wh.is_active) {
    throw err.conflict('仓库已停用')
  }
  // P0-02 scoped:仓库级作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'inventory.receive',
    tenantId: wh.tenant_id,
    storeId: wh.store_id ?? undefined,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('post_goods_receipt', {
    p_tenant_id: scope.tenantId,
    p_warehouse_id: input.warehouseId,
    p_catalog_item_id: input.catalogItemId,
    p_batch_no: input.batchNo ?? null,
    p_quantity: input.quantity,
    p_unit_cost: input.unitCost ?? 0,
    p_expiry_date: input.expiryDate ?? null,
    p_supplier: input.supplier ?? null,
    p_reference_id: input.referenceId ?? null,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.goodsReceipt',
    entityType: 'inventory_batch',
    entityId: (data as { batchId?: string })?.batchId,
    tenantId: input.tenantId,
    storeId: wh.store_id,
    metadata: {
      warehouseId: input.warehouseId,
      catalogItemId: input.catalogItemId,
      quantity: input.quantity,
      batchNo: input.batchNo,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

const dispenseSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  warehouseId: z.string().uuid('仓库 id 格式错误'),
  catalogItemId: z.string().uuid('商品 id 格式错误'),
  quantity: z.number().positive('数量必须大于 0'),
  referenceType: z.string().max(50).optional(),
  referenceId: z.string().max(100).optional(),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 发药(MXQ-9004)
 * - 权限:inventory.dispense
 * - 行为:调 dispense_inventory RPC,FEFO 扣减批次
 * - 库存不足返回 409
 */
inventoryRoutes.post('/dispense', async (c) => {
  const input = await parseJsonBody(c, dispenseSchema)
  const service = createServiceClient()

  const { data: wh, error: whErr } = await service
    .from('warehouses')
    .select('id, tenant_id, store_id, is_active')
    .eq('id', input.warehouseId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (whErr || !wh) {
    throw err.notFound('仓库不存在')
  }
  if (!wh.is_active) {
    throw err.conflict('仓库已停用')
  }
  // P0-02 scoped:仓库级作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'inventory.dispense',
    tenantId: wh.tenant_id,
    storeId: wh.store_id ?? undefined,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('dispense_inventory', {
    p_tenant_id: scope.tenantId,
    p_warehouse_id: input.warehouseId,
    p_catalog_item_id: input.catalogItemId,
    p_quantity: input.quantity,
    p_reference_type: input.referenceType ?? null,
    p_reference_id: input.referenceId ?? null,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.dispense',
    entityType: 'inventory_movement',
    entityId: (data as { movementId?: string })?.movementId,
    tenantId: input.tenantId,
    storeId: wh.store_id,
    metadata: {
      warehouseId: input.warehouseId,
      catalogItemId: input.catalogItemId,
      quantity: input.quantity,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

const stockCountItemSchema = z.object({
  catalogItemId: z.string().uuid('商品 id 格式错误'),
  countedQuantity: z.number().nonnegative('盘点数量不能为负'),
})

const stockCountSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  warehouseId: z.string().uuid('仓库 id 格式错误'),
  items: z.array(stockCountItemSchema).min(1, '至少盘点一项'),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 盘点(MXQ-9005)
 * - 权限:inventory.count
 * - 行为:调 post_stock_count RPC,逐项对比余额写 adjust 流水
 */
inventoryRoutes.post('/stock-count', async (c) => {
  const input = await parseJsonBody(c, stockCountSchema)
  const service = createServiceClient()

  const { data: wh, error: whErr } = await service
    .from('warehouses')
    .select('id, tenant_id, store_id, is_active')
    .eq('id', input.warehouseId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (whErr || !wh) {
    throw err.notFound('仓库不存在')
  }
  if (!wh.is_active) {
    throw err.conflict('仓库已停用')
  }
  // P0-02 scoped:仓库级作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'inventory.count',
    tenantId: wh.tenant_id,
    storeId: wh.store_id ?? undefined,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('post_stock_count', {
    p_tenant_id: scope.tenantId,
    p_warehouse_id: input.warehouseId,
    p_items: input.items.map(i => ({ catalog_item_id: i.catalogItemId, counted_quantity: i.countedQuantity })),
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.stockCount',
    entityType: 'inventory_balance',
    entityId: input.warehouseId,
    tenantId: input.tenantId,
    storeId: wh.store_id,
    metadata: {
      warehouseId: input.warehouseId,
      itemCount: input.items.length,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

const transferSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  fromWarehouseId: z.string().uuid('源仓库 id 格式错误'),
  toWarehouseId: z.string().uuid('目标仓库 id 格式错误'),
  catalogItemId: z.string().uuid('商品 id 格式错误'),
  quantity: z.number().positive('数量必须大于 0'),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 调拨(MXQ-9006)
 * - 权限:inventory.transfer(须同时有权访问源仓库与目标仓库门店)
 * - 行为:调 transfer_inventory RPC,原子扣源增目标,写两条流水
 */
inventoryRoutes.post('/transfer', async (c) => {
  const input = await parseJsonBody(c, transferSchema)
  const service = createServiceClient()

  if (input.fromWarehouseId === input.toWarehouseId) {
    throw err.badRequest('源仓库与目标仓库不能相同')
  }

  // 校验源仓库
  const { data: fromWh, error: fromErr } = await service
    .from('warehouses')
    .select('id, tenant_id, store_id, is_active')
    .eq('id', input.fromWarehouseId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (fromErr || !fromWh) {
    throw err.notFound('源仓库不存在')
  }
  if (!fromWh.is_active) {
    throw err.conflict('源仓库已停用')
  }
  // P0-02 scoped:源仓库作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'inventory.transfer',
    tenantId: fromWh.tenant_id,
    storeId: fromWh.store_id ?? undefined,
  })

  // 校验目标仓库(须同租户且调用者有权访问目标门店)
  const { data: toWh, error: toErr } = await service
    .from('warehouses')
    .select('id, tenant_id, store_id, is_active')
    .eq('id', input.toWarehouseId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (toErr || !toWh) {
    throw err.notFound('目标仓库不存在')
  }
  if (!toWh.is_active) {
    throw err.conflict('目标仓库已停用')
  }
  // P0-02 scoped:目标仓库同样须在调用者门店作用域内
  await requireScopedPermission(c, {
    code: 'inventory.transfer',
    tenantId: toWh.tenant_id,
    storeId: toWh.store_id ?? undefined,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('transfer_inventory', {
    p_tenant_id: scope.tenantId,
    p_from_warehouse_id: input.fromWarehouseId,
    p_to_warehouse_id: input.toWarehouseId,
    p_catalog_item_id: input.catalogItemId,
    p_quantity: input.quantity,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.transfer',
    entityType: 'inventory_movement',
    entityId: (data as { outMovementId?: string })?.outMovementId,
    tenantId: input.tenantId,
    storeId: fromWh.store_id,
    metadata: {
      fromWarehouseId: input.fromWarehouseId,
      toWarehouseId: input.toWarehouseId,
      catalogItemId: input.catalogItemId,
      quantity: input.quantity,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

const reserveSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  warehouseId: z.string().uuid('仓库 id 格式错误'),
  catalogItemId: z.string().uuid('商品 id 格式错误'),
  quantity: z.number().positive('数量必须大于 0'),
  referenceType: z.string().max(50).optional(),
  referenceId: z.string().max(100).optional(),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 预留库存(MXQ-9008 预留机制:挂单/下单冻结库存)
 * - 权限:inventory.reserve
 * - 行为:调 reserve_inventory RPC,按可用量(on_hand - reserved)校验,增加 quantity_reserved,写 reserve 流水
 * - 可用量不足返回 409 INSUFFICIENT_STOCK;幂等:同一 idempotency-key 重复请求返回原结果
 */
inventoryRoutes.post('/reserve', async (c) => {
  const input = await parseJsonBody(c, reserveSchema)
  const service = createServiceClient()

  // 查仓库获取 store_id 做权限校验
  const { data: wh, error: whErr } = await service
    .from('warehouses')
    .select('id, tenant_id, store_id, is_active')
    .eq('id', input.warehouseId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (whErr || !wh) {
    throw err.notFound('仓库不存在')
  }
  if (!wh.is_active) {
    throw err.conflict('仓库已停用')
  }
  // P0-02 scoped:仓库级作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'inventory.reserve',
    tenantId: wh.tenant_id,
    storeId: wh.store_id ?? undefined,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('reserve_inventory', {
    p_tenant_id: scope.tenantId,
    p_warehouse_id: input.warehouseId,
    p_catalog_item_id: input.catalogItemId,
    p_quantity: input.quantity,
    p_reference_type: input.referenceType ?? null,
    p_reference_id: input.referenceId ?? null,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.reserve',
    entityType: 'inventory_movement',
    entityId: (data as { movementId?: string })?.movementId,
    tenantId: input.tenantId,
    storeId: wh.store_id,
    metadata: {
      warehouseId: input.warehouseId,
      catalogItemId: input.catalogItemId,
      quantity: input.quantity,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

const reservationProcessSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  reservationId: z.string().uuid('预留流水 id 格式错误'),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 解析预留凭证并校验调用者对预留所属门店的访问权(供确认/释放共用)
 * @returns 预留流水、仓库信息与幂等键
 */
async function resolveReservation(c: Context<AppEnv>, input: { tenantId: string, reservationId: string }) {
  const service = createServiceClient()

  // 查预留流水(reserve 产生的 movement),取 warehouse_id 用于权限校验
  const { data: movement, error: mvErr } = await service
    .from('inventory_movements')
    .select('id, tenant_id, warehouse_id, catalog_item_id, movement_type, quantity')
    .eq('id', input.reservationId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (mvErr || !movement || movement.movement_type !== 'reserve') {
    throw err.notFound('预留记录不存在')
  }

  // 查仓库获取 store_id 做权限校验
  const { data: wh, error: whErr } = await service
    .from('warehouses')
    .select('id, tenant_id, store_id, is_active')
    .eq('id', movement.warehouse_id)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (whErr || !wh) {
    throw err.notFound('仓库不存在')
  }
  if (!wh.is_active) {
    throw err.conflict('仓库已停用')
  }
  return { movement, warehouse: wh }
}

/**
 * 确认预留(MXQ-9008 支付确认,预留转正式扣减)
 * - 权限:inventory.confirm
 * - 行为:调 confirm_inventory_reservation RPC,quantity_on_hand 与 quantity_reserved 同步减少,写 confirm 流水
 * - 同一预留只能被确认或释放一次,重复操作返回 409
 */
inventoryRoutes.post('/reserve/confirm', async (c) => {
  const input = await parseJsonBody(c, reservationProcessSchema)
  const { warehouse } = await resolveReservation(c, input)
  // P0-02 scoped:按预留所属仓库作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'inventory.confirm',
    tenantId: warehouse.tenant_id,
    storeId: warehouse.store_id ?? undefined,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)
  const service = createServiceClient()

  const { data, error } = await service.rpc('confirm_inventory_reservation', {
    p_tenant_id: scope.tenantId,
    p_reservation_id: input.reservationId,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.confirmReservation',
    entityType: 'inventory_movement',
    entityId: (data as { movementId?: string })?.movementId,
    tenantId: input.tenantId,
    storeId: warehouse.store_id,
    metadata: {
      reservationId: input.reservationId,
      confirmed: (data as { confirmed?: number })?.confirmed,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

/**
 * 释放预留(MXQ-9008 取消释放,仅减 quantity_reserved)
 * - 权限:inventory.release
 * - 行为:调 release_inventory_reservation RPC,仅减少 quantity_reserved(不得为负),写 release 流水
 * - 同一预留只能被确认或释放一次,重复操作返回 409
 */
inventoryRoutes.post('/reserve/release', async (c) => {
  const input = await parseJsonBody(c, reservationProcessSchema)
  const { warehouse } = await resolveReservation(c, input)
  // P0-02 scoped:按预留所属仓库作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'inventory.release',
    tenantId: warehouse.tenant_id,
    storeId: warehouse.store_id ?? undefined,
  })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)
  const service = createServiceClient()

  const { data, error } = await service.rpc('release_inventory_reservation', {
    p_tenant_id: scope.tenantId,
    p_reservation_id: input.reservationId,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.releaseReservation',
    entityType: 'inventory_movement',
    entityId: (data as { movementId?: string })?.movementId,
    tenantId: input.tenantId,
    storeId: warehouse.store_id,
    metadata: {
      reservationId: input.reservationId,
      released: (data as { released?: number })?.released,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

/**
 * 批量释放过期预留(P0-08,运维/定时触发;防支付失败等场景导致永久占用)
 * - 权限:inventory.release
 * - 行为:调 release_expired_reservations RPC,释放租户下所有已过 reserved_until 且未处理的 reserve 流水
 */
inventoryRoutes.post('/reserve/release-expired', async (c) => {
  // P0-02 scoped:租户作用域授权(tenantId 缺失时取调用者首个成员租户)
  const tenantId = resolveRequestedTenant(c, c.req.query('tenantId'))
  if (!tenantId) {
    throw err.forbidden('无法确定租户作用域')
  }
  const scope = await requireScopedPermission(c, {
    code: 'inventory.release',
    tenantId,
  })

  const user = c.get('user')
  const service = createServiceClient()
  const { data, error } = await service.rpc('release_expired_reservations', {
    p_tenant_id: scope.tenantId,
    p_operator_id: user.id,
  })
  if (error) {
    throw err.internal(`释放过期预留失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'inventory.releaseExpiredReservations',
    entityType: 'inventory_movement',
    tenantId: scope.tenantId,
    metadata: (data ?? {}) as Record<string, unknown>,
  })

  return ok(c, data)
})

/**
 * 近效期预警(MXQ-9007)
 * - 权限:inventory.view
 * - 行为:查 inventory_near_expiry 视图,按当前工作租户/门店过滤
 */
inventoryRoutes.get('/near-expiry', async (c) => {
  // P0-02 scoped:校验 tenant 归属(缺失取调用者默认租户),并强制按 scope.tenantId 过滤
  const tenantId = resolveRequestedTenant(c, c.req.query('tenantId'))
  const storeId = c.req.query('storeId')
  const warehouseId = c.req.query('warehouseId')
  const scope = await requireScopedPermission(c, {
    code: 'inventory.view',
    tenantId: tenantId ?? '',
    storeId: storeId ?? undefined,
  })

  const service = createServiceClient()
  let query = service.from('inventory_near_expiry').select('*').eq('tenant_id', scope.tenantId)
  if (storeId) {
    query = query.eq('store_id', storeId)
  }
  if (warehouseId) {
    query = query.eq('warehouse_id', warehouseId)
  }
  const { data, error } = await query.order('expiry_date', { ascending: true })
  if (error) {
    throw err.internal(`查询近效期预警失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [] })
})

// ============================================================
// 供应商(租户级主数据,MXQ-P05)
// 查询走浏览器直连(RLS 按 is_tenant_member);写入经 Hono Command + 审计
// ============================================================

const supplierCreateSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  name: z.string().min(1, '供应商名称必填').max(200),
  contactName: z.string().max(100).optional(),
  phone: z.string().max(50).optional(),
  address: z.string().max(500).optional(),
  unifiedCreditCode: z.string().max(50).optional(),
  paymentTerms: z.string().max(200).optional(),
  categories: z.array(z.string().max(50)).optional(),
  notes: z.string().max(1000).optional(),
})

const supplierUpdateSchema = supplierCreateSchema.extend({
  id: z.string().uuid('供应商 id 格式错误'),
})

const supplierStatusSchema = z.object({
  id: z.string().uuid('供应商 id 格式错误'),
  tenantId: z.string().uuid('租户 id 格式错误'),
  status: z.enum(['active', 'inactive']),
})

function generateSupplierNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `SUP-${date}-${rand}`
}

/**
 * 新增供应商
 * - 权限:supplier.manage(租户级)
 * - 行为:service role 直插 suppliers + 审计;不开放浏览器直连写
 */
inventoryRoutes.post('/suppliers', async (c) => {
  const input = await parseJsonBody(c, supplierCreateSchema)
  const scope = await requireScopedPermission(c, {
    code: 'supplier.manage',
    tenantId: input.tenantId,
  })
  const service = createServiceClient()

  const { data, error } = await service
    .from('suppliers')
    .insert({
      tenant_id: scope.tenantId,
      supplier_no: generateSupplierNo(),
      name: input.name,
      contact_name: input.contactName ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      unified_credit_code: input.unifiedCreditCode ?? null,
      payment_terms: input.paymentTerms ?? null,
      categories: input.categories ?? [],
      notes: input.notes ?? null,
    })
    .select()
    .single()
  if (error) {
    if (error.code === '23505') {
      throw err.conflict('供应商编码重复,请重试')
    }
    throw err.internal(`创建供应商失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'inventory.supplierCreate',
    entityType: 'supplier',
    entityId: (data as { id: string })?.id,
    tenantId: input.tenantId,
    metadata: { name: input.name },
  })

  return ok(c, data)
})

/**
 * 更新供应商
 * - 权限:supplier.manage(租户级)
 */
inventoryRoutes.post('/suppliers/update', async (c) => {
  const input = await parseJsonBody(c, supplierUpdateSchema)
  const scope = await requireScopedPermission(c, {
    code: 'supplier.manage',
    tenantId: input.tenantId,
  })
  const service = createServiceClient()

  const { data, error } = await service
    .from('suppliers')
    .update({
      name: input.name,
      contact_name: input.contactName ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      unified_credit_code: input.unifiedCreditCode ?? null,
      payment_terms: input.paymentTerms ?? null,
      categories: input.categories ?? [],
      notes: input.notes ?? null,
    })
    .eq('id', input.id)
    .eq('tenant_id', scope.tenantId)
    .select()
    .single()
  if (error) {
    if (error.code === 'PGRST116') {
      throw err.notFound('供应商不存在')
    }
    throw err.internal(`更新供应商失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'inventory.supplierUpdate',
    entityType: 'supplier',
    entityId: input.id,
    tenantId: input.tenantId,
    metadata: { name: input.name },
  })

  return ok(c, data)
})

/**
 * 停用/恢复供应商
 * - 权限:supplier.manage(租户级)
 */
inventoryRoutes.post('/suppliers/status', async (c) => {
  const input = await parseJsonBody(c, supplierStatusSchema)
  const scope = await requireScopedPermission(c, {
    code: 'supplier.manage',
    tenantId: input.tenantId,
  })
  const service = createServiceClient()

  const { data, error } = await service
    .from('suppliers')
    .update({ status: input.status })
    .eq('id', input.id)
    .eq('tenant_id', scope.tenantId)
    .select()
    .single()
  if (error) {
    if (error.code === 'PGRST116') {
      throw err.notFound('供应商不存在')
    }
    throw err.internal(`更新供应商状态失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'inventory.supplierStatus',
    entityType: 'supplier',
    entityId: input.id,
    tenantId: input.tenantId,
    metadata: { status: input.status },
  })

  return ok(c, data)
})

// ============================================================
// 仓库(门店级主数据)
// 查询走浏览器直连(RLS 按 can_access_store);写入经 Hono Command + 审计
// 约束:每个门店仅一个默认仓库(DB 部分唯一索引 idx_warehouses_default_per_store)
// 停用走 is_active,不物理删除(warehouses_delete 仅系统管理员)
// ============================================================

const warehouseCreateSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  name: z.string().min(1, '仓库名称必填').max(100),
  code: z.string().min(1, '仓库编码必填').max(50),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

const warehouseUpdateSchema = warehouseCreateSchema.extend({
  id: z.string().uuid('仓库 id 格式错误'),
})

const warehouseStatusSchema = z.object({
  id: z.string().uuid('仓库 id 格式错误'),
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  isActive: z.boolean(),
})

/** 将仓库写入的 DB 唯一约束错误映射为业务错误(默认仓库/编码唯一) */
function mapWarehouseWriteError(error: { code?: string, message: string }) {
  if (error.code === '23505') {
    if (error.message.includes('idx_warehouses_default_per_store')) {
      return err.conflict('该门店已存在默认仓库')
    }
    if (error.message.includes('idx_warehouses_tenant_store_code')) {
      return err.conflict('该门店下仓库编码已存在')
    }
    return err.conflict('仓库编码重复或默认仓库冲突')
  }
  return null
}

/** 查询门店现有仓库的默认/启用概况(用于默认仓库与停用约束校验) */
async function loadStoreWarehouseSummary(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  storeId: string,
): Promise<{ hasDefault: boolean, activeCount: number }> {
  const { data, error } = await service
    .from('warehouses')
    .select('id, is_default, is_active')
    .eq('tenant_id', tenantId)
    .eq('store_id', storeId)
  if (error) {
    throw err.internal(`查询仓库失败: ${error.message}`)
  }
  const list = (data ?? []) as { id: string, is_default: boolean, is_active: boolean }[]
  return {
    hasDefault: list.some(w => w.is_default),
    activeCount: list.filter(w => w.is_active).length,
  }
}

/**
 * 新增仓库
 * - 权限:inventory.manage(门店级)
 * - 行为:service role 直插 warehouses + 审计;不开放浏览器直连写
 * - 约束:门店须始终存在默认仓库(无默认时首仓必须设为默认)
 */
inventoryRoutes.post('/warehouses', async (c) => {
  const input = await parseJsonBody(c, warehouseCreateSchema)
  const scope = await requireScopedPermission(c, {
    code: 'inventory.manage',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const service = createServiceClient()

  const summary = await loadStoreWarehouseSummary(service, scope.tenantId, input.storeId)
  if (!summary.hasDefault && !(input.isDefault ?? false)) {
    throw err.conflict('该门店暂无默认仓库,请将该仓库设为默认仓库')
  }

  const { data, error } = await service
    .from('warehouses')
    .insert({
      tenant_id: scope.tenantId,
      store_id: input.storeId,
      name: input.name,
      code: input.code.trim(),
      is_default: input.isDefault ?? false,
      is_active: input.isActive ?? true,
    })
    .select()
    .single()
  if (error) {
    const mapped = mapWarehouseWriteError(error)
    throw mapped ?? err.internal(`创建仓库失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'inventory.warehouseCreate',
    entityType: 'warehouse',
    entityId: (data as { id: string })?.id,
    tenantId: input.tenantId,
    metadata: { name: input.name, code: input.code.trim(), storeId: input.storeId },
  })

  return ok(c, data)
})

/**
 * 编辑仓库(名称/编码/是否默认)
 * - 权限:inventory.manage(门店级)
 * - 约束:取消唯一默认仓库时须已存在其他默认;默认仓库唯一性由 DB 部分唯一索引兜底
 */
inventoryRoutes.post('/warehouses/update', async (c) => {
  const input = await parseJsonBody(c, warehouseUpdateSchema)
  const scope = await requireScopedPermission(c, {
    code: 'inventory.manage',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const service = createServiceClient()

  const { data: current, error: currentError } = await service
    .from('warehouses')
    .select('id, is_default')
    .eq('id', input.id)
    .eq('tenant_id', scope.tenantId)
    .eq('store_id', input.storeId)
    .single()
  if (currentError || !current) {
    throw err.notFound('仓库不存在')
  }

  // 取消唯一默认仓库 → 拦截,保证门店始终有默认仓库
  if (current.is_default && !(input.isDefault ?? false)) {
    const { data: otherDefaults, error: otherError } = await service
      .from('warehouses')
      .select('id')
      .eq('tenant_id', scope.tenantId)
      .eq('store_id', input.storeId)
      .eq('is_default', true)
      .neq('id', input.id)
      .limit(1)
    if (otherError) {
      throw err.internal(`查询仓库失败: ${otherError.message}`)
    }
    if ((otherDefaults ?? []).length === 0) {
      throw err.conflict('门店必须保留至少一个默认仓库')
    }
  }

  const { data, error } = await service
    .from('warehouses')
    .update({
      name: input.name,
      code: input.code.trim(),
      is_default: input.isDefault ?? false,
    })
    .eq('id', input.id)
    .eq('tenant_id', scope.tenantId)
    .eq('store_id', input.storeId)
    .select()
    .single()
  if (error) {
    const mapped = mapWarehouseWriteError(error)
    throw mapped ?? err.internal(`更新仓库失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'inventory.warehouseUpdate',
    entityType: 'warehouse',
    entityId: input.id,
    tenantId: input.tenantId,
    metadata: { name: input.name, code: input.code.trim(), storeId: input.storeId },
  })

  return ok(c, data)
})

/**
 * 停用/恢复仓库
 * - 权限:inventory.manage(门店级)
 * - 约束:默认仓库不可停用(须先切换默认);门店须保留至少一个启用中的仓库
 */
inventoryRoutes.post('/warehouses/status', async (c) => {
  const input = await parseJsonBody(c, warehouseStatusSchema)
  const scope = await requireScopedPermission(c, {
    code: 'inventory.manage',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const service = createServiceClient()

  const { data: current, error: currentError } = await service
    .from('warehouses')
    .select('id, is_default, is_active')
    .eq('id', input.id)
    .eq('tenant_id', scope.tenantId)
    .eq('store_id', input.storeId)
    .single()
  if (currentError || !current) {
    throw err.notFound('仓库不存在')
  }

  if (!input.isActive) {
    if (current.is_default) {
      throw err.conflict('默认仓库不可停用,请先将其切换为非默认或指定新的默认仓库')
    }
    if (current.is_active) {
      const summary = await loadStoreWarehouseSummary(service, scope.tenantId, input.storeId)
      if (summary.activeCount <= 1) {
        throw err.conflict('门店必须保留至少一个启用中的仓库')
      }
    }
  }

  const { data, error } = await service
    .from('warehouses')
    .update({ is_active: input.isActive })
    .eq('id', input.id)
    .eq('tenant_id', scope.tenantId)
    .eq('store_id', input.storeId)
    .select()
    .single()
  if (error) {
    throw err.internal(`更新仓库状态失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'inventory.warehouseStatus',
    entityType: 'warehouse',
    entityId: input.id,
    tenantId: input.tenantId,
    metadata: { isActive: input.isActive, storeId: input.storeId },
  })

  return ok(c, data)
})

// ============================================================
// 采购订单(MXQ-P05)
// 查询走浏览器直连(RLS 按 can_access_store);状态流转经 Hono Command + RPC
// 状态机:draft → submitted → approved → received → posted;draft/submitted 可取消
// ============================================================

const purchaseItemSchema = z.object({
  catalogItemId: z.string().uuid('商品 id 格式错误'),
  orderedQty: z.number().positive('订购数量必须大于 0'),
  unitCost: z.number().nonnegative().optional(),
})

/** 空字符串/undefined 统一转 null,避免 RPC 内 ''::date 报错 */
function dateOrNull(v?: string): string | null {
  return v || null
}

const purchaseCreateSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  warehouseId: z.string().uuid('仓库 id 格式错误'),
  supplierId: z.string().uuid('供应商 id 格式错误'),
  expectedAt: z.string().optional(),
  note: z.string().max(1000).optional(),
  items: z.array(purchaseItemSchema).min(1, '至少一项商品'),
})

const purchaseUpdateDraftSchema = purchaseCreateSchema.extend({
  poId: z.string().uuid('采购单 id 格式错误'),
})

const purchaseActionSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  poId: z.string().uuid('采购单 id 格式错误'),
})

const purchaseReceiveSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  poId: z.string().uuid('采购单 id 格式错误'),
  items: z.array(z.object({
    id: z.string().uuid('明细 id 格式错误'),
    receivedQty: z.number().min(0, '实收数量不能为负'),
    batchNo: z.string().max(100).optional(),
    expiresAt: z.string().optional(),
  })).min(1, '至少一项收货明细'),
})

/** 查采购单取 store_id 做作用域授权(创建外的所有流转共用) */
async function resolvePurchaseOrder(c: Context<AppEnv>, tenantId: string, poId: string) {
  const service = createServiceClient()
  const { data, error } = await service
    .from('purchase_orders')
    .select('id, tenant_id, store_id, warehouse_id, supplier_id, status, po_no')
    .eq('id', poId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (error || !data) {
    throw err.notFound('采购单不存在')
  }
  return data
}

/**
 * 创建采购单草稿
 * - 权限:purchase.create(门店作用域)
 * - 行为:调 create_purchase_order RPC,生成 po_no 与明细
 */
inventoryRoutes.post('/purchase-orders', async (c) => {
  const input = await parseJsonBody(c, purchaseCreateSchema)
  const scope = await requireScopedPermission(c, {
    code: 'purchase.create',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('create_purchase_order', {
    p_tenant_id: scope.tenantId,
    p_store_id: input.storeId,
    p_warehouse_id: input.warehouseId,
    p_supplier_id: input.supplierId,
    p_expected_at: dateOrNull(input.expectedAt),
    p_note: input.note ?? null,
    p_items: input.items.map(i => ({ catalog_item_id: i.catalogItemId, ordered_qty: i.orderedQty, unit_cost: i.unitCost ?? 0 })),
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseCreate',
    entityType: 'purchase_order',
    entityId: (data as { id?: string })?.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { poNo: (data as { poNo?: string })?.poNo, itemCount: input.items.length },
  })

  return ok(c, data)
})

/**
 * 编辑草稿(仅 draft;替换全部明细)
 * - 权限:purchase.create
 */
inventoryRoutes.post('/purchase-orders/draft', async (c) => {
  const input = await parseJsonBody(c, purchaseUpdateDraftSchema)
  const po = await resolvePurchaseOrder(c, input.tenantId, input.poId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase.create',
    tenantId: po.tenant_id,
    storeId: po.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('update_purchase_order_draft', {
    p_tenant_id: scope.tenantId,
    p_po_id: input.poId,
    p_warehouse_id: input.warehouseId,
    p_supplier_id: input.supplierId,
    p_expected_at: dateOrNull(input.expectedAt),
    p_note: input.note ?? null,
    p_items: input.items.map(i => ({ catalog_item_id: i.catalogItemId, ordered_qty: i.orderedQty, unit_cost: i.unitCost ?? 0 })),
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseDraftUpdate',
    entityType: 'purchase_order',
    entityId: input.poId,
    tenantId: input.tenantId,
    storeId: po.store_id,
    metadata: { poNo: po.po_no, itemCount: input.items.length },
  })

  return ok(c, data)
})

/**
 * 提交采购单(draft → submitted)
 * - 权限:purchase.submit
 */
inventoryRoutes.post('/purchase-orders/submit', async (c) => {
  const input = await parseJsonBody(c, purchaseActionSchema)
  const po = await resolvePurchaseOrder(c, input.tenantId, input.poId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase.submit',
    tenantId: po.tenant_id,
    storeId: po.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('submit_purchase_order', {
    p_tenant_id: scope.tenantId,
    p_po_id: input.poId,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseSubmit',
    entityType: 'purchase_order',
    entityId: input.poId,
    tenantId: input.tenantId,
    storeId: po.store_id,
    metadata: { poNo: po.po_no },
  })

  return ok(c, data)
})

/**
 * 审核采购单(submitted → approved)
 * - 权限:purchase.approve
 */
inventoryRoutes.post('/purchase-orders/approve', async (c) => {
  const input = await parseJsonBody(c, purchaseActionSchema)
  const po = await resolvePurchaseOrder(c, input.tenantId, input.poId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase.approve',
    tenantId: po.tenant_id,
    storeId: po.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('approve_purchase_order', {
    p_tenant_id: scope.tenantId,
    p_po_id: input.poId,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseApprove',
    entityType: 'purchase_order',
    entityId: input.poId,
    tenantId: input.tenantId,
    storeId: po.store_id,
    metadata: { poNo: po.po_no },
  })

  return ok(c, data)
})

/**
 * 取消采购单(draft / submitted → cancelled)
 * - 权限:purchase.submit
 */
inventoryRoutes.post('/purchase-orders/cancel', async (c) => {
  const input = await parseJsonBody(c, purchaseActionSchema)
  const po = await resolvePurchaseOrder(c, input.tenantId, input.poId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase.submit',
    tenantId: po.tenant_id,
    storeId: po.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('cancel_purchase_order', {
    p_tenant_id: scope.tenantId,
    p_po_id: input.poId,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseCancel',
    entityType: 'purchase_order',
    entityId: input.poId,
    tenantId: input.tenantId,
    storeId: po.store_id,
    metadata: { poNo: po.po_no },
  })

  return ok(c, data)
})

/**
 * 收货(approved / received → received;记录实收数量/批次/效期)
 * - 权限:purchase.receive
 * - 过账前可重复调整收货数据
 */
inventoryRoutes.post('/purchase-orders/receive', async (c) => {
  const input = await parseJsonBody(c, purchaseReceiveSchema)
  const po = await resolvePurchaseOrder(c, input.tenantId, input.poId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase.receive',
    tenantId: po.tenant_id,
    storeId: po.store_id,
  })
  const user = c.get('user')
  const service = createServiceClient()

  const { data, error } = await service.rpc('receive_purchase_order', {
    p_tenant_id: scope.tenantId,
    p_po_id: input.poId,
    p_items: input.items.map(i => ({
      id: i.id,
      received_qty: i.receivedQty,
      batch_no: i.batchNo ?? null,
      expires_at: dateOrNull(i.expiresAt),
    })),
    p_operator_id: user.id,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchaseReceive',
    entityType: 'purchase_order',
    entityId: input.poId,
    tenantId: input.tenantId,
    storeId: po.store_id,
    metadata: { poNo: po.po_no, itemCount: input.items.length },
  })

  return ok(c, data)
})

/**
 * 过账(received → posted;复用 post_goods_receipt 生成批次/余额/流水)
 * - 权限:purchase.post
 * - 幂等:Idempotency-Key 保证重复点击只产生一次入库
 */
inventoryRoutes.post('/purchase-orders/post', async (c) => {
  const input = await parseJsonBody(c, purchaseActionSchema)
  const po = await resolvePurchaseOrder(c, input.tenantId, input.poId)
  const scope = await requireScopedPermission(c, {
    code: 'purchase.post',
    tenantId: po.tenant_id,
    storeId: po.store_id,
  })
  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c)
  const service = createServiceClient()

  const { data, error } = await service.rpc('post_purchase_order', {
    p_tenant_id: scope.tenantId,
    p_po_id: input.poId,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'inventory.purchasePost',
    entityType: 'purchase_order',
    entityId: input.poId,
    tenantId: input.tenantId,
    storeId: po.store_id,
    metadata: {
      poNo: po.po_no,
      postedTotal: (data as { postedTotal?: number })?.postedTotal,
      idempotencyKey,
    },
  })

  return ok(c, data)
})

export default inventoryRoutes
