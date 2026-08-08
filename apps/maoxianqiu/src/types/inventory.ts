/**
 * Inventory 领域类型定义(MXQ-9001~9008)
 * 与 supabase/migrations/20260806000017_inventory.sql 对齐
 */

/** 批次状态机:active → exhausted(quantity_remaining=0) / expired(expiry_date<now) */
export type BatchStatus = 'active' | 'exhausted' | 'expired'

/** 流水类型:正数入库/负数出库 */
export type MovementType
  = | 'receive'
    | 'dispense'
    | 'adjust'
    | 'transfer_in'
    | 'transfer_out'
    | 'return'
    | 'reserve'
    | 'confirm'
    | 'release'

/** warehouses 表记录(仓库) */
export interface Warehouse {
  id: string
  tenant_id: string
  store_id: string
  name: string
  code: string
  is_default: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

/** inventory_batches 表记录(库存批次) */
export interface InventoryBatch {
  id: string
  tenant_id: string
  warehouse_id: string
  catalog_item_id: string
  batch_no: string | null
  received_date: string
  expiry_date: string | null
  quantity_received: number
  quantity_remaining: number
  unit_cost: number
  supplier: string | null
  status: BatchStatus
  created_at: string
}

/** inventory_balances 表记录(库存余额) */
export interface InventoryBalance {
  id: string
  tenant_id: string
  warehouse_id: string
  catalog_item_id: string
  quantity_on_hand: number
  quantity_reserved: number
  updated_at: string
}

/** inventory_movements 表记录(不可变流水) */
export interface InventoryMovement {
  id: string
  tenant_id: string
  warehouse_id: string
  catalog_item_id: string
  batch_id: string | null
  movement_type: MovementType
  quantity: number
  balance_after: number
  reference_type: string | null
  reference_id: string | null
  idempotency_key: string | null
  operator_id: string | null
  created_at: string
}

/** 近效期预警视图记录 */
export interface NearExpiryItem {
  batch_id: string
  tenant_id: string
  warehouse_id: string
  store_id: string
  warehouse_name: string
  catalog_item_id: string
  batch_no: string | null
  expiry_date: string
  quantity_remaining: number
  unit_cost: number
  supplier: string | null
  status: BatchStatus
  days_to_expiry: number
}

/**
 * 入库请求(MXQ-9003)
 * 走 Hono Command + post_goods_receipt RPC,事务化创建批次/余额/流水
 */
export interface GoodsReceiptInput {
  tenantId: string
  warehouseId: string
  catalogItemId: string
  batchNo?: string
  quantity: number
  unitCost?: number
  expiryDate?: string
  supplier?: string
  referenceId?: string
}

/** 入库响应 */
export interface GoodsReceiptResult {
  batchId: string
  balanceId: string
  movementId: string
  quantityOnHand: number
}

/**
 * 发药请求(MXQ-9004)
 * 走 Hono Command + dispense_inventory RPC,FEFO 扣减批次
 */
export interface DispenseInput {
  tenantId: string
  warehouseId: string
  catalogItemId: string
  quantity: number
  referenceType?: string
  referenceId?: string
}

/** 发药响应 */
export interface DispenseResult {
  balanceId: string
  movementId: string
  quantityOnHand: number
  dispensed: number
}

/** 盘点单项 */
export interface StockCountItem {
  catalogItemId: string
  countedQuantity: number
}

/**
 * 盘点请求(MXQ-9005)
 * 走 Hono Command + post_stock_count RPC,逐项对比余额写 adjust 流水
 */
export interface StockCountInput {
  tenantId: string
  warehouseId: string
  items: StockCountItem[]
}

/** 盘点结果项 */
export interface StockCountResultItem {
  catalogItemId: string
  adjusted: boolean
  diff?: number
  movementId?: string
}

/** 盘点响应 */
export interface StockCountResult {
  warehouseId: string
  items: StockCountResultItem[]
}

/**
 * 调拨请求(MXQ-9006)
 * 走 Hono Command + transfer_inventory RPC,原子扣源增目标
 */
export interface TransferInput {
  tenantId: string
  fromWarehouseId: string
  toWarehouseId: string
  catalogItemId: string
  quantity: number
}

/** 调拨响应 */
export interface TransferResult {
  fromBalanceId: string
  toBalanceId: string
  outMovementId: string
  inMovementId: string
  fromOnHand: number
  toOnHand: number
}

/**
 * 预留请求(MXQ-9008,挂单/下单冻结库存)
 * 走 Hono Command + reserve_inventory RPC,按可用量(on_hand - reserved)校验
 */
export interface ReserveInput {
  tenantId: string
  warehouseId: string
  catalogItemId: string
  quantity: number
  referenceType?: string
  referenceId?: string
}

/** 预留响应 */
export interface ReserveResult {
  balanceId: string
  movementId: string
  quantityOnHand: number
  quantityReserved: number
  reserved: number
}

/**
 * 预留确认/释放请求(MXQ-9008)
 * reservationId 为 reserve 流水产生的 movement id(预留凭证)
 */
export interface ReservationProcessInput {
  tenantId: string
  reservationId: string
}

/** 确认预留响应(预留转正式扣减,在库量与预留量同步减少) */
export interface ConfirmReservationResult {
  balanceId: string
  movementId: string
  quantityOnHand: number
  quantityReserved: number
  confirmed: number
}

/** 释放预留响应(仅减少预留量) */
export interface ReleaseReservationResult {
  balanceId: string
  movementId: string
  quantityOnHand: number
  quantityReserved: number
  released: number
}

/** 仓库新建/编辑请求 */
export interface WarehouseUpsertInput {
  tenantId: string
  storeId: string
  name: string
  code: string
  isDefault?: boolean
  isActive?: boolean
}

/** 批次状态机转换矩阵 */
export const BATCH_STATUS_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  active: ['exhausted', 'expired'],
  exhausted: [],
  expired: [],
}

/**
 * 校验批次状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 * @returns 是否允许转换
 */
export function canTransitionBatchStatus(from: BatchStatus, to: BatchStatus): boolean {
  return BATCH_STATUS_TRANSITIONS[from].includes(to)
}

/** 批次状态标签映射(UI 显示用) */
export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  active: '在用',
  exhausted: '已耗尽',
  expired: '已过期',
}

/** 流水类型标签映射(UI 显示用) */
export const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  receive: '入库',
  dispense: '发药',
  adjust: '盘点调整',
  transfer_in: '调拨入',
  transfer_out: '调拨出',
  return: '退货',
  reserve: '预留',
  confirm: '确认预留',
  release: '释放预留',
}

/** 权限码常量 */
export const INVENTORY_PERMISSIONS = {
  view: 'inventory.view',
  receive: 'inventory.receive',
  dispense: 'inventory.dispense',
  count: 'inventory.count',
  transfer: 'inventory.transfer',
  manage: 'inventory.manage',
  reserve: 'inventory.reserve',
  confirm: 'inventory.confirm',
  release: 'inventory.release',
} as const

// ============================================================
// 供应商 + 采购订单(MXQ-P05)
// ============================================================

/** 供应商状态 */
export type SupplierStatus = 'active' | 'inactive'

/** suppliers 表记录(租户级主数据) */
export interface Supplier {
  id: string
  tenant_id: string
  supplier_no: string
  name: string
  contact_name: string | null
  phone: string | null
  address: string | null
  unified_credit_code: string | null
  payment_terms: string | null
  status: SupplierStatus
  categories: string[] | null
  notes: string | null
  created_at: string
  updated_at: string
}

/** 供应商新建/编辑请求(编辑时带 id) */
export interface SupplierInput {
  id?: string
  tenantId: string
  name: string
  contactName?: string
  phone?: string
  address?: string
  unifiedCreditCode?: string
  paymentTerms?: string
  categories?: string[]
  notes?: string
}

/** 采购订单状态机:draft → submitted → approved → received → posted;draft/submitted 可取消 */
export type PurchaseOrderStatus = 'draft' | 'submitted' | 'approved' | 'received' | 'posted' | 'cancelled'

/** purchase_order_items 表记录 */
export interface PurchaseOrderItem {
  id: string
  tenant_id: string
  purchase_order_id: string
  catalog_item_id: string
  ordered_qty: number
  received_qty: number
  unit_cost: number
  batch_no: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

/** purchase_orders 表记录 */
export interface PurchaseOrder {
  id: string
  tenant_id: string
  store_id: string
  warehouse_id: string
  po_no: string
  supplier_id: string | null
  status: PurchaseOrderStatus
  expected_at: string | null
  total_cost: number
  note: string | null
  created_by: string | null
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  received_by: string | null
  received_at: string | null
  posted_by: string | null
  posted_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

/** 采购单明细输入项(草稿阶段) */
export interface PurchaseOrderItemInput {
  catalogItemId: string
  orderedQty: number
  unitCost?: number
}

/** 收货明细输入项 */
export interface PurchaseReceiveItemInput {
  id: string
  receivedQty: number
  batchNo?: string
  expiresAt?: string
}

/** 采购单状态标签映射(UI 显示用) */
export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  approved: '已审核',
  received: '已收货',
  posted: '已过账',
  cancelled: '已取消',
}

/** 供应商状态标签映射 */
export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
  active: '在用',
  inactive: '停用',
}

/** 供应商权限码常量 */
export const SUPPLIER_PERMISSIONS = {
  view: 'supplier.view',
  manage: 'supplier.manage',
} as const

/** 采购权限码常量 */
export const PURCHASE_PERMISSIONS = {
  view: 'purchase.view',
  create: 'purchase.create',
  submit: 'purchase.submit',
  approve: 'purchase.approve',
  receive: 'purchase.receive',
  post: 'purchase.post',
} as const
