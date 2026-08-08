/**
 * S32-B 经营报表与驾驶舱 — 前端类型与展示字典
 *
 * 与 api/services/analytics/types.ts 保持一一对应。
 * 金额统一为 number,仅展示不参与业务计算。
 */

export type AnalyticsGroupBy = 'day' | 'month'
export type RevenueDimension = 'store' | 'payment_channel' | 'catalog_type' | 'doctor'
export type AnalyticsValueFormat = 'money' | 'integer' | 'percent' | 'ratio'

export interface AnalyticsKpi {
  key: string
  label: string
  value: number
  format: AnalyticsValueFormat
  hint?: string
  definition: string
}

export interface AnalyticsPeriod {
  startDate: string
  endDate: string
  startISO: string
  endISO: string
  timezone: string
}

/** ===== Dashboard ===== */
export interface RevenueTrendRow {
  bucket: string
  label: string
  gross: number
  refund: number
  net: number
  invoiceCount: number
  averageTicket: number
}

export interface DashboardReport {
  period: AnalyticsPeriod
  kpis: AnalyticsKpi[]
  revenueTrend: RevenueTrendRow[]
  lowStockCount: number
  expiringCount: number
}

/** ===== Revenue ===== */
export interface RevenueDimensionRow {
  key: string
  label: string
  gross: number
  refund: number
  net: number
  invoiceCount: number
  averageTicket: number
  share: number
}

export interface RevenueReport {
  period: AnalyticsPeriod
  kpis: AnalyticsKpi[]
  groupBy: AnalyticsGroupBy
  trend: RevenueTrendRow[]
  dimension: RevenueDimension
  dimensionRows: RevenueDimensionRow[]
  summary: {
    gross: number
    refund: number
    net: number
    invoiceCount: number
    averageTicket: number
  }
}

/** ===== Customer ===== */
export interface CustomerTierRow {
  tier: string
  label: string
  count: number
  contribution: number
}

export interface CustomerConsumptionTier {
  key: string
  label: string
  min: number
  max: number
  count: number
  amount: number
}

export interface CustomerReport {
  period: AnalyticsPeriod
  kpis: AnalyticsKpi[]
  repeatRateDefinition: string
  tierBreakdown: CustomerTierRow[]
  consumptionTiers: CustomerConsumptionTier[]
}

/** ===== Clinical ===== */
export interface ClinicalDailyRow {
  date: string
  appointments: number
  showUps: number
  noShows: number
  encounters: number
  signedEncounters: number
}

export interface ClinicalReport {
  period: AnalyticsPeriod
  kpis: AnalyticsKpi[]
  dailyRows: ClinicalDailyRow[]
}

/** ===== Inventory ===== */
export interface LowStockRow {
  warehouseId: string
  warehouseName: string
  catalogItemId: string
  code: string
  name: string
  unit: string | null
  quantityOnHand: number
  quantityReserved: number
  available: number
  lowStockThreshold: number
  stockValue: number
}

export interface ExpiringRow {
  warehouseId: string
  warehouseName: string
  batchId: string
  batchNo: string | null
  catalogItemId: string
  code: string
  name: string
  quantityRemaining: number
  unitCost: number
  value: number
  expiryDate: string
  daysToExpiry: number
}

export interface InventoryReport {
  period: AnalyticsPeriod
  kpis: AnalyticsKpi[]
  lowStockRows: LowStockRow[]
  expiringRows: ExpiringRow[]
}

/** ===== 展示字典 ===== */
export const REVENUE_DIMENSION_LABELS: Record<RevenueDimension, string> = {
  store: '门店',
  payment_channel: '支付渠道',
  catalog_type: '目录类型',
  doctor: '医生',
}

export const GROUP_BY_LABELS: Record<AnalyticsGroupBy, string> = {
  day: '按日',
  month: '按月',
}

export const PAYMENT_CHANNEL_LABELS: Record<string, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  card: '银行卡',
  stored_value: '储值卡',
  other: '其他',
}

export const CATALOG_TYPE_LABELS: Record<string, string> = {
  service: '服务',
  drug: '药品',
  vaccine: '疫苗',
  exam: '检查检验',
  product: '商品',
}

export const REPEAT_RATE_DEFINITION = '复诊率 = 查询周期内就诊次数 ≥ 2 的客户数 ÷ 查询周期内就诊次数 ≥ 1 的客户数(分母不含仅消费未就诊的客户)。'
