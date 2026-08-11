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
    | 'count_gain'
    | 'count_loss'
    | 'write_off'
    | 'scrap'
    | 'expired'

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
  count_gain: '盘盈',
  count_loss: '盘亏',
  write_off: '报损',
  scrap: '报废',
  expired: '过期',
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
  writeOff: 'inventory.write_off',
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

// ============================================================
// 采购申请(Stage-04 Agent-07)
// 状态机:draft → submitted → approved → converted_to_po;submitted → rejected;draft/submitted 可取消
// ============================================================

/** 采购申请状态 */
export type PurchaseRequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'converted_to_po' | 'cancelled'

/** purchase_request_items 表记录 */
export interface PurchaseRequestItem {
  id: string
  tenant_id: string
  purchase_request_id: string
  catalog_item_id: string
  requested_qty: number
  unit: string | null
  estimated_unit_cost: number
  note: string | null
  created_at: string
  updated_at: string
}

/** purchase_requests 表记录 */
export interface PurchaseRequest {
  id: string
  tenant_id: string
  store_id: string
  warehouse_id: string
  supplier_id: string | null
  request_no: string
  requester_id: string | null
  reason: string | null
  required_at: string | null
  status: PurchaseRequestStatus
  version: number
  converted_po_id: string | null
  reject_reason: string | null
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  rejected_by: string | null
  rejected_at: string | null
  converted_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

/** 采购申请明细输入项(草稿阶段) */
export interface PurchaseRequestItemInput {
  catalogItemId: string
  requestedQty: number
  unit?: string
  estimatedUnitCost?: number
  note?: string
}

/** 采购申请状态标签映射(UI 显示用) */
export const PURCHASE_REQUEST_STATUS_LABELS: Record<PurchaseRequestStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  approved: '已审核',
  rejected: '已驳回',
  converted_to_po: '已转采购单',
  cancelled: '已取消',
}

/** 采购申请权限码常量 */
export const PURCHASE_REQUEST_PERMISSIONS = {
  view: 'purchase_request.view',
  create: 'purchase_request.create',
  submit: 'purchase_request.submit',
  approve: 'purchase_request.approve',
  convert: 'purchase_request.convert',
} as const

// ============================================================
// 采购退货(Stage-04 Agent-07)
// 状态机:draft → submitted → approved → posted;draft/submitted 可取消
// 过账走正式库存 Command(movement_type='return'),财务仅记录金额快照
// ============================================================

/** 采购退货状态 */
export type PurchaseReturnStatus = 'draft' | 'submitted' | 'approved' | 'posted' | 'cancelled'

/** purchase_return_items 表记录 */
export interface PurchaseReturnItem {
  id: string
  tenant_id: string
  purchase_return_id: string
  catalog_item_id: string
  batch_id: string | null
  source_po_item_id: string | null
  quantity: number
  unit_cost: number
  amount: number
  note: string | null
  created_at: string
  updated_at: string
}

/** purchase_returns 表记录 */
export interface PurchaseReturn {
  id: string
  tenant_id: string
  store_id: string
  warehouse_id: string
  supplier_id: string | null
  source_po_id: string | null
  return_no: string
  reason: string | null
  status: PurchaseReturnStatus
  version: number
  return_amount_snapshot: number
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  posted_by: string | null
  posted_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** 采购退货明细输入项(草稿阶段) */
export interface PurchaseReturnItemInput {
  catalogItemId: string
  batchId: string
  sourcePoItemId?: string
  quantity: number
  unitCost?: number
  note?: string
}

/** 采购退货状态标签映射(UI 显示用) */
export const PURCHASE_RETURN_STATUS_LABELS: Record<PurchaseReturnStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  approved: '已审核',
  posted: '已过账',
  cancelled: '已取消',
}

/** 采购退货权限码常量 */
export const PURCHASE_RETURN_PERMISSIONS = {
  view: 'purchase_return.view',
  create: 'purchase_return.create',
  submit: 'purchase_return.submit',
  approve: 'purchase_return.approve',
  post: 'purchase_return.post',
} as const

// ============================================================
// 入库单(R-1/R-2/R-3)
// 状态机:draft → submitted → approved → posted;draft/submitted 可取消
// ============================================================

/** 入库单状态 */
export type GoodsReceiptStatus = 'draft' | 'submitted' | 'approved' | 'posted' | 'cancelled'

/** goods_receipts 表记录 */
export interface GoodsReceipt {
  id: string
  tenant_id: string
  store_id: string
  warehouse_id: string
  gr_no: string
  supplier: string | null
  status: GoodsReceiptStatus
  total_cost: number
  note: string | null
  created_by: string | null
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  posted_by: string | null
  posted_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

/** goods_receipt_items 表记录 */
export interface GoodsReceiptItem {
  id: string
  tenant_id: string
  goods_receipt_id: string
  catalog_item_id: string
  quantity: number
  unit_cost: number
  batch_no: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

/** 入库单创建输入项 */
export interface GoodsReceiptCreateInput {
  tenantId: string
  storeId: string
  warehouseId: string
  supplier?: string
  note?: string
  items: Array<{
    catalogItemId: string
    quantity: number
    unitCost?: number
    batchNo?: string
    expiresAt?: string
  }>
}

/** 入库单状态标签映射(UI 显示用) */
export const GOODS_RECEIPT_STATUS_LABELS: Record<GoodsReceiptStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  approved: '已审核',
  posted: '已过账',
  cancelled: '已取消',
}

// ============================================================
// 盘点单(R-5/R-6/R-7/R-8)
// 状态机:draft → counting → submitted → approved → posted;draft/counting/submitted 可取消
// ============================================================

/** 盘点单状态 */
export type StockCountStatus = 'draft' | 'counting' | 'submitted' | 'approved' | 'posted' | 'cancelled'

/** 盘点范围 */
export type StockCountScope = 'all' | 'category' | 'item'

/** stock_counts 表记录 */
export interface StockCount {
  id: string
  tenant_id: string
  store_id: string
  warehouse_id: string
  count_no: string
  status: StockCountStatus
  scope: StockCountScope
  category_id: string | null
  book_snapshot: StockCountSnapshotItem[]
  counting_items: StockCountSnapshotItem[]
  note: string | null
  created_by: string | null
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  posted_by: string | null
  posted_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

/** 盘点快照项(book_snapshot / counting_items 元素) */
export interface StockCountSnapshotItem {
  catalog_item_id: string
  book_quantity: number
  counted_quantity?: number | null
}

/** stock_count_items 表记录 */
export interface StockCountItemRow {
  id: string
  tenant_id: string
  stock_count_id: string
  catalog_item_id: string
  book_quantity: number
  counted_quantity: number | null
  created_at: string
  updated_at: string
}

/** 盘点单创建输入项 */
export interface StockCountCreateInput {
  tenantId: string
  storeId: string
  warehouseId: string
  scope: StockCountScope
  categoryId?: string
  itemIds?: string[]
  note?: string
}

/** 盘点单状态标签映射(UI 显示用) */
export const STOCK_COUNT_STATUS_LABELS: Record<StockCountStatus, string> = {
  draft: '草稿',
  counting: '盘点中',
  submitted: '待审核',
  approved: '已审核',
  posted: '已过账',
  cancelled: '已取消',
}

// ============================================================
// 调拨单(R-9/R-10/R-11/R-12/R-13)
// 状态机:draft → submitted → approved → outbound → received/partially_received
//   ;draft/submitted 可取消;partially_received 可继续收货
// ============================================================

/** 调拨单状态 */
export type TransferStatus = 'draft' | 'submitted' | 'approved' | 'outbound' | 'partially_received' | 'received' | 'cancelled'

/** transfers 表记录 */
export interface TransferOrder {
  id: string
  tenant_id: string
  store_id: string
  from_warehouse_id: string
  to_warehouse_id: string
  transfer_no: string
  status: TransferStatus
  note: string | null
  created_by: string | null
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  shipped_by: string | null
  shipped_at: string | null
  received_by: string | null
  received_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

/** transfer_items 表记录 */
export interface TransferItem {
  id: string
  tenant_id: string
  transfer_id: string
  catalog_item_id: string
  quantity: number
  shipped_qty: number
  received_qty: number
  batch_no: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

/** 调拨单创建输入项 */
export interface TransferCreateInput {
  tenantId: string
  storeId: string
  fromWarehouseId: string
  toWarehouseId: string
  note?: string
  items: Array<{
    catalogItemId: string
    quantity: number
  }>
}

/** 调拨收货明细输入项 */
export interface TransferReceiveItemInput {
  id: string
  receivedQuantity: number
  batchNo?: string
  expiresAt?: string
}

/** 调拨单状态标签映射(UI 显示用) */
export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  approved: '已审核',
  outbound: '在途',
  partially_received: '部分收货',
  received: '已收货',
  cancelled: '已取消',
}

// ============================================================
// 报损(B-R-2 / R-15)
// ============================================================

/** 报损原因类型(与 movement_type 对应) */
export type WriteOffReasonType = 'write_off' | 'scrap' | 'expired'

/** 报损请求 */
export interface WriteOffInput {
  tenantId: string
  warehouseId: string
  items: Array<{
    catalogItemId: string
    quantity: number
    reasonType?: WriteOffReasonType
    reason?: string
    batchId?: string
  }>
}

/** 报损原因类型标签映射(UI 显示用) */
export const WRITE_OFF_REASON_LABELS: Record<WriteOffReasonType, string> = {
  write_off: '报损',
  scrap: '报废',
  expired: '过期',
}
