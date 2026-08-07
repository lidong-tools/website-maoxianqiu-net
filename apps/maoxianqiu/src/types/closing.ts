/**
 * Daily Closing + Reconciliation 领域类型定义(S31-并发任务B 日结与对账)
 */

/** 日结状态:open(待结算)/calculating(结算中)/closed(已关闭)/adjusted(已调整) */
export type DailyClosingStatus = 'open' | 'calculating' | 'closed' | 'adjusted'

/** 支付渠道:现金/银行卡/微信/支付宝/储值卡(预留)/其他 */
export type PaymentChannel = 'cash' | 'card' | 'wechat' | 'alipay' | 'stored_value' | 'other'

/** 日结调整类型:现金多款/现金短款/人工更正/其他 */
export type ClosingAdjustmentType = 'cash_over' | 'cash_short' | 'manual_correction' | 'other'

/** 对账状态:pending(待确认,有差异)/matched(无差异未确认)/confirmed(无差异已确认)/difference_confirmed(有差异已确认) */
export type ReconciliationStatus = 'pending' | 'matched' | 'confirmed' | 'difference_confirmed'

/** 日结快照-支付方式拆分(渠道 -> 金额) */
export interface PaymentMethodBreakdown {
  cash: number
  card: number
  wechat: number
  alipay: number
  stored_value: number
  other: number
}

/** 日结快照-金额汇总 */
export interface ClosingSnapshotTotals {
  gross_amount: number
  paid_amount: number
  refund_amount: number
  receivable_amount: number
  invoice_count: number
}

/** 日结固化快照(关闭后历史读取只读它,不重新实时计算) */
export interface DailyClosingSnapshot {
  business_date: string
  computed_at: string
  source: string
  totals: ClosingSnapshotTotals
  payment_method_breakdown: PaymentMethodBreakdown
  invoice_status_breakdown: Record<string, number>
  adjustment_summary: ClosingAdjustmentSummary
}

/** 日结调整汇总(追加式) */
export interface ClosingAdjustmentSummary {
  count: number
  total: number
  items: ClosingAdjustmentItem[]
}

/** 日结调整流水项 */
export interface ClosingAdjustmentItem {
  id: string
  type: ClosingAdjustmentType
  amount: number
  reason: string
  operator_employee_id: string | null
  created_at: string
}

/** 日结记录(浏览器直连 daily_closings 返回行) */
export interface DailyClosingRecord {
  id: string
  tenant_id: string
  store_id: string
  business_date: string
  status: DailyClosingStatus
  gross_amount: number
  paid_amount: number
  refund_amount: number
  receivable_amount: number
  cash_amount: number
  card_amount: number
  wechat_amount: number
  alipay_amount: number
  stored_value_amount: number
  other_amount: number
  invoice_count: number
  snapshot: DailyClosingSnapshot
  adjustment_summary: ClosingAdjustmentSummary
  closed_at: string | null
  closed_by: string | null
  adjusted_at: string | null
  adjusted_by: string | null
  created_at: string
  updated_at: string
  stores?: { name?: string, code?: string } | null
}

/** 日结调整流水记录(浏览器直连 closing_adjustments 返回行) */
export interface ClosingAdjustmentRecord {
  id: string
  tenant_id: string
  store_id: string
  business_date: string
  closing_id: string
  adjustment_type: ClosingAdjustmentType
  amount: number
  reason: string
  operator_employee_id: string | null
  created_at: string
}

/** 执行日结入参(走 Hono Command,权限 daily_closing.close) */
export interface CloseDailyBusinessInput {
  storeId: string
  businessDate: string
  idempotencyKey?: string
}

/** 执行日结结果 */
export interface CloseDailyBusinessResult {
  duplicate: boolean
  closingId: string
  status: DailyClosingStatus
  snapshot: DailyClosingSnapshot
}

/** 调整日结入参(走 Hono Command,权限 daily_closing.adjust) */
export interface AdjustDailyClosingInput {
  closingId: string
  adjustmentType: ClosingAdjustmentType
  amount: number
  reason: string
}

/** 调整日结结果 */
export interface AdjustDailyClosingResult {
  closingId: string
  status: DailyClosingStatus
  adjustmentId: string
  adjustment_summary: ClosingAdjustmentSummary
  snapshot: DailyClosingSnapshot
}

/** 对账记录(浏览器直连 reconciliation_records 返回行) */
export interface ReconciliationRecord {
  id: string
  tenant_id: string
  store_id: string
  business_date: string
  closing_id: string | null
  channel: PaymentChannel
  system_expected: number
  actual_amount: number
  difference: number
  difference_reason: string | null
  status: ReconciliationStatus
  confirmed_by: string | null
  confirmed_at: string | null
  created_at: string
  updated_at: string
  stores?: { name?: string, code?: string } | null
}

/** 对账录入入参(走 Hono Command,权限 reconciliation.edit) */
export interface SaveReconciliationActualInput {
  storeId: string
  businessDate: string
  channel: PaymentChannel
  actualAmount: number
  closingId?: string | null
}

/** 对账录入结果 */
export interface SaveReconciliationActualResult {
  recordId: string
  channel: PaymentChannel
  businessDate: string
  systemExpected: number
  actualAmount: number
  difference: number
  status: ReconciliationStatus
}

/** 差异确认入参(走 Hono Command,权限 reconciliation.confirm) */
export interface ConfirmReconciliationInput {
  differenceReason?: string | null
}

/** 差异确认结果 */
export interface ConfirmReconciliationResult {
  recordId: string
  channel: PaymentChannel
  businessDate: string
  difference: number
  differenceReason: string | null
  status: ReconciliationStatus
  confirmedAt: string | null
}

/** 渠道汇总单项 */
export interface ChannelSummaryItem {
  channel: PaymentChannel
  payment: number
  refund: number
  net: number
  closingExpected: number
}

/** 支付渠道汇总(服务端聚合,前端只渲染) */
export interface PaymentChannelSummary {
  tenantId: string
  storeId: string
  businessDate: string
  closingStatus: DailyClosingStatus | null
  channels: ChannelSummaryItem[]
  totals: {
    payment: number
    refund: number
    net: number
  }
}

/** 渠道展示配置 */
export const PAYMENT_CHANNEL_OPTIONS: { label: string, value: PaymentChannel }[] = [
  { label: '现金', value: 'cash' },
  { label: '银行卡', value: 'card' },
  { label: '微信', value: 'wechat' },
  { label: '支付宝', value: 'alipay' },
  { label: '储值卡', value: 'stored_value' },
  { label: '其他', value: 'other' },
]

/** 渠道中文名 */
export const PAYMENT_CHANNEL_LABELS: Record<PaymentChannel, string> = {
  cash: '现金',
  card: '银行卡',
  wechat: '微信',
  alipay: '支付宝',
  stored_value: '储值卡',
  other: '其他',
}

/** 日结状态中文名 */
export const DAILY_CLOSING_STATUS_LABELS: Record<DailyClosingStatus, string> = {
  open: '待结算',
  calculating: '结算中',
  closed: '已关闭',
  adjusted: '已调整',
}

/** 调整类型中文名 */
export const ADJUSTMENT_TYPE_LABELS: Record<ClosingAdjustmentType, string> = {
  cash_over: '现金多款',
  cash_short: '现金短款',
  manual_correction: '人工更正',
  other: '其他',
}

/** 对账状态中文名 */
export const RECONCILIATION_STATUS_LABELS: Record<ReconciliationStatus, string> = {
  pending: '待确认',
  matched: '无差异',
  confirmed: '已确认',
  difference_confirmed: '差异已确认',
}
