import type { Context } from 'hono'
import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { getRequestIdempotencyKey } from '../lib/idempotency'
import { assertStoreTenant, assertTenantAccess, requirePermission } from '../lib/permission'
import { getContext, loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

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
  if (msg.includes('INVALID_QUANTITY') || msg.includes('EMPTY_ITEMS') || msg.includes('SAME_WAREHOUSE')) {
    return err.badRequest(msg.replace(/^ERROR:\s*/, ''))
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
  await requirePermission(c, { code: 'inventory.receive', storeId: wh.store_id })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('post_goods_receipt', {
    p_tenant_id: input.tenantId,
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
  await requirePermission(c, { code: 'inventory.dispense', storeId: wh.store_id })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('dispense_inventory', {
    p_tenant_id: input.tenantId,
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
  await requirePermission(c, { code: 'inventory.count', storeId: wh.store_id })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('post_stock_count', {
    p_tenant_id: input.tenantId,
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
  await requirePermission(c, { code: 'inventory.transfer', storeId: fromWh.store_id })

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
  await requirePermission(c, { code: 'inventory.transfer', storeId: toWh.store_id })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('transfer_inventory', {
    p_tenant_id: input.tenantId,
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
  await requirePermission(c, { code: 'inventory.reserve', storeId: wh.store_id })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('reserve_inventory', {
    p_tenant_id: input.tenantId,
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
  await requirePermission(c, { code: 'inventory.confirm', storeId: warehouse.store_id })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)
  const service = createServiceClient()

  const { data, error } = await service.rpc('confirm_inventory_reservation', {
    p_tenant_id: input.tenantId,
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
  await requirePermission(c, { code: 'inventory.release', storeId: warehouse.store_id })

  const user = c.get('user')
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)
  const service = createServiceClient()

  const { data, error } = await service.rpc('release_inventory_reservation', {
    p_tenant_id: input.tenantId,
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
 * 近效期预警(MXQ-9007)
 * - 权限:inventory.view
 * - 行为:查 inventory_near_expiry 视图,按当前工作租户/门店过滤
 */
inventoryRoutes.get('/near-expiry', async (c) => {
  await requirePermission(c, { code: 'inventory.view' })

  const service = createServiceClient()
  const tenantId = c.req.query('tenantId') ?? getContext(c).tenantId
  const storeId = c.req.query('storeId')
  const warehouseId = c.req.query('warehouseId')

  // 跨租户隔离:query tenantId 必须与调用者成员关系一致;缺失时回退请求上下文租户,两者皆无则 400
  assertTenantAccess(c, tenantId)

  let query = service.from('inventory_near_expiry').select('*')
  if (tenantId) {
    query = query.eq('tenant_id', tenantId)
  }
  if (storeId) {
    // 门店归属校验(内部会再次校验调用者对该门店所属租户的访问权)
    await assertStoreTenant(c, storeId)
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

export default inventoryRoutes
