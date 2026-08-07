/**
 * Billing 领域类型定义(MXQ-8001~8007)
 * 与 supabase/migrations/20260806000020_billing.sql 对齐
 */

/**
 * 发票状态机:
 *   draft → confirmed → paid → refunded
 *   draft → cancelled
 *   confirmed → partially_paid → paid
 */
export type InvoiceStatus
  = | 'draft'
    | 'confirmed'
    | 'paid'
    | 'partially_paid'
    | 'refunded'
    | 'cancelled'

/** 支付方式 */
export type PaymentMethod = 'cash' | 'wechat' | 'alipay' | 'card' | 'other'

/** 发票明细分类(与 catalog_items.billing_type 对齐) */
export type InvoiceItemCategory
  = | 'service'
    | 'drug'
    | 'vaccine'
    | 'exam'
    | 'product'

/** 审批实体类型 */
export type ApprovalEntityType = 'invoice_discount' | 'refund' | 'other'

/** 审批状态 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

/** billing_sequences 表记录(业务序号,独立表名避免与 CRM 的 business_sequences 冲突) */
export interface BusinessSequence {
  id: string
  tenant_id: string
  store_id: string
  sequence_type: 'invoice_no' | 'order_no' | 'refund_no' | 'other'
  period: string
  current_value: number
  updated_at: string
}

/** invoices 表记录(发票) */
export interface Invoice {
  id: string
  tenant_id: string
  store_id: string
  invoice_no: string
  customer_id: string | null
  pet_id: string | null
  encounter_id: string | null
  subtotal: number
  discount_amount: number
  discount_reason: string | null
  tax_amount: number
  total: number
  paid_amount: number
  status: InvoiceStatus
  payment_method: PaymentMethod | null
  due_date: string | null
  confirmed_at: string | null
  confirmed_by: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** invoice_items 表记录(发票明细) */
export interface InvoiceItem {
  id: string
  tenant_id: string
  invoice_id: string
  catalog_item_id: string | null
  store_catalog_item_id: string | null
  name: string
  unit_price: number
  quantity: number
  discount_amount: number
  amount: number
  sort_order: number
  category: InvoiceItemCategory
}

/** approvals 表记录(审批) */
export interface Approval {
  id: string
  tenant_id: string
  store_id: string
  entity_type: ApprovalEntityType
  entity_id: string
  requested_by: string | null
  reason: string | null
  status: ApprovalStatus
  approved_by: string | null
  approved_at: string | null
  approval_metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** payments 表记录(支付) */
export interface Payment {
  id: string
  tenant_id: string
  invoice_id: string
  amount: number
  method: PaymentMethod
  transaction_no: string | null
  idempotency_key: string
  operator_id: string | null
  created_at: string
}

/** refunds 表记录(退款) */
export interface Refund {
  id: string
  tenant_id: string
  invoice_id: string
  payment_id: string | null
  amount: number
  reason: string | null
  idempotency_key: string
  operator_id: string | null
  created_at: string
}

/** 发票含明细(联表查询结果) */
export interface InvoiceWithItems extends Invoice {
  items?: InvoiceItem[]
  payments?: Payment[]
  refunds?: Refund[]
}

/**
 * 创建发票输入(MXQ-8001)
 * 走 Hono Command + create_invoice RPC,事务化建发票+明细+审批记录
 */
export interface CreateInvoiceItemInput {
  catalogItemId?: string
  storeCatalogItemId?: string
  name: string
  unitPrice: number
  quantity: number
  discountAmount?: number
  amount: number
  sortOrder?: number
  category?: InvoiceItemCategory
}

/** 创建发票请求 */
export interface CreateInvoiceInput {
  tenantId: string
  storeId: string
  customerId?: string
  petId?: string
  encounterId?: string
  items: CreateInvoiceItemInput[]
  discountAmount?: number
  discountReason?: string
  taxAmount?: number
  paymentMethod?: PaymentMethod
  dueDate?: string
}

/** 创建发票响应 */
export interface CreateInvoiceResult {
  invoiceId: string
  invoiceNo: string
  total: number
  itemsCount: number
}

/**
 * 支付请求(MXQ-8003)
 * 走 Hono Command + process_payment RPC,事务化记录支付+更新已付金额+状态机
 */
export interface ProcessPaymentInput {
  invoiceId: string
  amount: number
  method: PaymentMethod
  transactionNo?: string
}

/** 支付响应 */
export interface ProcessPaymentResult {
  paymentId: string
  invoiceId: string
  amount: number
  method: PaymentMethod
  paidAmount: number
  status: InvoiceStatus
  transactionNo: string | null
}

/**
 * 退款请求(MXQ-8004)
 * 走 Hono Command + process_refund RPC,事务化记录退款+扣减已付金额+状态机
 */
export interface ProcessRefundInput {
  invoiceId: string
  amount: number
  reason: string
  paymentId?: string
}

/** 退款响应 */
export interface ProcessRefundResult {
  refundId: string
  invoiceId: string
  amount: number
  reason: string
  paidAmount: number
  status: InvoiceStatus
}

/** 大额折扣审批请求 */
export interface ApproveDiscountInput {
  approvalId: string
  status: 'approved' | 'rejected'
  reason?: string
}

/** 小票门店信息 */
export interface ReceiptStore {
  id: string
  name: string
  code: string | null
  address: string | null
  phone: string | null
}

/** 小票明细项 */
export interface ReceiptItem {
  id: string
  name: string
  category: InvoiceItemCategory
  unitPrice: number
  quantity: number
  discountAmount: number
  amount: number
  sortOrder: number
}

/** 小票支付记录 */
export interface ReceiptPayment {
  id: string
  amount: number
  method: PaymentMethod
  transactionNo: string | null
  createdAt: string
}

/** 小票退款记录 */
export interface ReceiptRefund {
  id: string
  amount: number
  reason: string | null
  createdAt: string
}

/** 小票数据(generate_receipt RPC 返回) */
export interface ReceiptData {
  invoiceId: string
  invoiceNo: string
  status: InvoiceStatus
  store: ReceiptStore
  customerId: string | null
  petId: string | null
  encounterId: string | null
  subtotal: number
  discountAmount: number
  discountReason: string | null
  taxAmount: number
  total: number
  paidAmount: number
  change: number
  paymentMethod: PaymentMethod | null
  items: ReceiptItem[]
  payments: ReceiptPayment[]
  refunds: ReceiptRefund[]
  createdAt: string
  confirmedAt: string | null
}

/** 发票状态机转换矩阵 */
export const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['partially_paid', 'paid', 'cancelled'],
  partially_paid: ['paid', 'refunded'],
  paid: ['refunded'],
  refunded: [],
  cancelled: [],
}

/**
 * 校验发票状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 * @returns 是否允许转换
 */
export function canTransitionInvoiceStatus(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_STATUS_TRANSITIONS[from].includes(to)
}

/** 发票状态标签映射(UI 显示用) */
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: '草稿',
  confirmed: '已确认',
  paid: '已支付',
  partially_paid: '部分支付',
  refunded: '已退款',
  cancelled: '已取消',
}

/** 发票状态颜色映射(UI 显示用) */
export const INVOICE_STATUS_COLORS: Record<InvoiceStatus, string> = {
  draft: 'default',
  confirmed: 'primary',
  paid: 'success',
  partially_paid: 'warning',
  refunded: 'info',
  cancelled: 'error',
}

/** 支付方式标签映射(UI 显示用) */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  card: '银行卡',
  other: '其他',
}

/** 明细分类标签映射(UI 显示用) */
export const INVOICE_ITEM_CATEGORY_LABELS: Record<InvoiceItemCategory, string> = {
  service: '服务',
  drug: '药品',
  vaccine: '疫苗',
  exam: '检验',
  product: '商品',
}

/** 审批状态标签映射 */
export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已拒绝',
}

/** 权限码常量 */
export const BILLING_PERMISSIONS = {
  view: 'invoice.view',
  create: 'invoice.create',
  confirm: 'invoice.confirm',
  cancel: 'invoice.cancel',
  paymentProcess: 'payment.process',
  refundProcess: 'refund.process',
  receiptPrint: 'receipt.print',
} as const

/** 大额折扣阈值(超过此比例需 manager 审批) */
export const DISCOUNT_APPROVAL_THRESHOLD = 0.10
