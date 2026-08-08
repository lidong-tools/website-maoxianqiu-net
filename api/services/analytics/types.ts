/**
 * S32-B 经营报表与驾驶舱 — DTO 类型
 *
 * 所有金额一律 numeric(12,2),传输为 number(前端仅展示,不做业务计算)。
 * 时间语义:
 *   - startAt/endAt 为业务日期(YYYY-MM-DD),在 Tenant Timezone 内解释为
 *     [start 00:00:00, end 23:59:59] 的闭区间;
 *   - 每日切片使用 Tenant Timezone(默认 Asia/Shanghai),禁止用 Server UTC 切天。
 */

/** 时间分组维度 */
export type AnalyticsGroupBy = 'day' | 'month'

/** 收入维度(按维度聚合时) */
export type RevenueDimension = 'store' | 'payment_channel' | 'catalog_type' | 'doctor'

/** 数值展示格式 */
export type AnalyticsValueFormat = 'money' | 'integer' | 'percent' | 'ratio'

/** 单个 KPI */
export interface AnalyticsKpi {
  key: string
  label: string
  value: number
  format: AnalyticsValueFormat
  /** 副标题/补充说明(如"较昨日") */
  hint?: string
  /** KPI 定义摘要(页面 Tooltip 展示) */
  definition: string
}

/** 解析后的时间范围 */
export interface AnalyticsPeriod {
  startDate: string
  endDate: string
  startISO: string
  endISO: string
  timezone: string
}

/** 通用报表响应外壳 */
export interface AnalyticsBaseReport {
  period: AnalyticsPeriod
  kpis: AnalyticsKpi[]
}

/** 报表查询过滤条件(服务层统一入参) */
export interface RevenueFilters {
  tenantId: string
  storeIds: string[]
  period: AnalyticsPeriod
}

/** ===== Dashboard 驾驶舱 ===== */
export interface DashboardReport extends AnalyticsBaseReport {
  /** 本月每日净收入趋势(供驾驶舱迷你图) */
  revenueTrend: RevenueTrendRow[]
  /** 缺货 SKU 数量(驾驶舱快捷提示,可用 ≤ 0,审计 #25) */
  lowStockCount: number
  /** 近效期数量(30 天内到期) */
  expiringCount: number
}

/** ===== Revenue 收入 ===== */
export interface RevenueTrendRow {
  bucket: string
  label: string
  gross: number
  refund: number
  net: number
  invoiceCount: number
  averageTicket: number
}

export interface RevenueDimensionRow {
  key: string
  label: string
  gross: number
  refund: number
  net: number
  invoiceCount: number
  averageTicket: number
  /** 占比(净额占比,0-100) */
  share: number
}

export interface RevenueReport extends AnalyticsBaseReport {
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

/** ===== Customer 客户 ===== */
export interface CustomerTierRow {
  tier: string
  label: string
  count: number
  /** 会员客户贡献金额(该层级客户的本期净消费) */
  contribution: number
}

/** 客户消费分层(按本期净消费区间) */
export interface CustomerConsumptionTier {
  key: string
  label: string
  min: number
  max: number
  count: number
  amount: number
}

export interface CustomerReport extends AnalyticsBaseReport {
  /** 复诊率定义(必须展示在 Tooltip 与文档) */
  repeatRateDefinition: string
  tierBreakdown: CustomerTierRow[]
  consumptionTiers: CustomerConsumptionTier[]
}

/** ===== Clinical 医疗运营 ===== */
export interface ClinicalDailyRow {
  date: string
  appointments: number
  showUps: number
  noShows: number
  encounters: number
  signedEncounters: number
}

export interface ClinicalReport extends AnalyticsBaseReport {
  dailyRows: ClinicalDailyRow[]
}

/** ===== Inventory 库存 ===== */
export interface LowStockRow {
  warehouseId: string
  warehouseName: string
  catalogItemId: string
  code: string
  name: string
  unit: string | null
  quantityOnHand: number
  quantityReserved: number
  /** 可用数量 = onHand - reserved */
  available: number
  /** 缺货阈值(来自批次/目录规则,默认取 0 表示未配置;当前口径:可用 ≤ 0 即缺货) */
  lowStockThreshold: number
  /** 当前库存成本价值 */
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
  /** 距今天数(负数=已过期) */
  daysToExpiry: number
}

export interface InventoryReport extends AnalyticsBaseReport {
  lowStockRows: LowStockRow[]
  expiringRows: ExpiringRow[]
}
