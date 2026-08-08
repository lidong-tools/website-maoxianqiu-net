/**
 * S32-B 收入分析(revenue)
 *
 * 口径(S32-B 规格 §5 + KPI-DEFINITIONS.md):
 *   - Gross Revenue = 有效发票 SUM(total):状态 ∈ (confirmed, paid, partially_paid, refunded),
 *     排除 draft / cancelled;
 *   - Refund = 当期退款 SUM(amount),通过 invoices 收敛门店范围;
 *   - Net Revenue = Gross - Refund;
 *   - Invoice Count = 有效发票数;
 *   - Average Ticket(客单价) = Net Revenue / Invoice Count。
 *
 * 维度:store(门店) / payment_channel(支付渠道) / catalog_type(目录类型) / doctor(医生)。
 * 说明:退款不拆分到 catalog_type 与 doctor,因此这两个维度的 net = gross。
 */
import type { ServiceClient } from './common'
import { bucketKey, loadStoreNameMap, toNum } from './common'
import type {
  AnalyticsGroupBy,
  RevenueDimension,
  RevenueDimensionRow,
  RevenueFilters,
  RevenueReport,
  RevenueTrendRow,
} from './types'

/** 有效收入发票状态(排除草稿与取消) */
export const VALID_INVOICE_STATUSES = ['confirmed', 'paid', 'partially_paid', 'refunded']

interface InvoiceRow {
  id: string
  store_id: string | null
  payment_method: string | null
  total: number
  created_at: string
  customer_id: string | null
  encounter_id: string | null
}

/** 拉取有效发票(含收入维度所需字段) */
async function fetchValidInvoices(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<InvoiceRow[]> {
  const { data, error } = await service
    .from('invoices')
    .select('id, store_id, payment_method, total, created_at, customer_id, encounter_id')
    .eq('tenant_id', f.tenantId)
    .in('store_id', f.storeIds)
    .in('status', VALID_INVOICE_STATUSES)
    .gte('created_at', f.period.startISO)
    .lte('created_at', f.period.endISO)
  if (error) {
    throw new Error(`收入数据查询失败: ${error.message}`)
  }
  return (data as InvoiceRow[] | null) ?? []
}

/** 拉取当期退款(经 invoices 收敛门店范围) */
async function fetchRefunds(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<Array<{ amount: number; created_at: string }>> {
  const { data, error } = await service
    .from('refunds')
    .select('amount, created_at, invoices!inner(store_id)')
    .eq('tenant_id', f.tenantId)
    .in('invoices.store_id', f.storeIds)
    .gte('created_at', f.period.startISO)
    .lte('created_at', f.period.endISO)
  if (error) {
    throw new Error(`退款数据查询失败: ${error.message}`)
  }
  return (data as Array<{ amount: number; created_at: string }> | null) ?? []
}

export interface RevenueSummary {
  gross: number
  refund: number
  net: number
  invoiceCount: number
  averageTicket: number
}

/** 计算时间段内的收入汇总(驾驶舱与收入页共用) */
export async function computeRevenueSummary(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<RevenueSummary> {
  const [invoices, refunds] = await Promise.all([
    fetchValidInvoices(service, f),
    fetchRefunds(service, f),
  ])
  const gross = invoices.reduce((s, r) => s + toNum(r.total), 0)
  const refund = refunds.reduce((s, r) => s + toNum(r.amount), 0)
  const net = gross - refund
  const invoiceCount = invoices.length
  return {
    gross,
    refund,
    net,
    invoiceCount,
    averageTicket: invoiceCount > 0 ? net / invoiceCount : 0,
  }
}

/**
 * 由发票与退款行构建趋势(按 day/month 分组)。
 * refunds 需包含 created_at。
 */
export function buildTrendFromRows(
  invoices: Array<{ total: number; created_at: string }>,
  refunds: Array<{ amount: number; created_at: string }>,
  groupBy: AnalyticsGroupBy,
  tz: string,
): RevenueTrendRow[] {
  const grossMap = new Map<string, number>()
  const countMap = new Map<string, number>()
  for (const inv of invoices) {
    const k = bucketKey(groupBy, inv.created_at, tz)
    grossMap.set(k, (grossMap.get(k) ?? 0) + toNum(inv.total))
    countMap.set(k, (countMap.get(k) ?? 0) + 1)
  }
  const refundMap = new Map<string, number>()
  for (const r of refunds) {
    const k = bucketKey(groupBy, r.created_at, tz)
    refundMap.set(k, (refundMap.get(k) ?? 0) + toNum(r.amount))
  }

  const keys = new Set([...grossMap.keys(), ...refundMap.keys()])
  const rows: RevenueTrendRow[] = [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((k) => {
      const gross = grossMap.get(k) ?? 0
      const refund = refundMap.get(k) ?? 0
      const count = countMap.get(k) ?? 0
      const net = gross - refund
      return {
        bucket: k,
        label: groupBy === 'month' ? k : k,
        gross,
        refund,
        net,
        invoiceCount: count,
        averageTicket: count > 0 ? net / count : 0,
      }
    })
  return rows
}

/** 按维度构建明细行 */
async function buildDimensionRows(
  service: ServiceClient,
  invoices: InvoiceRow[],
  dimension: RevenueDimension,
  f: RevenueFilters,
): Promise<RevenueDimensionRow[]> {
  if (invoices.length === 0) {
    return []
  }

  // store / payment_channel:直接从发票行聚合
  if (dimension === 'store' || dimension === 'payment_channel') {
    const group = new Map<string, { key: string; label: string; gross: number; count: number }>()
    for (const inv of invoices) {
      const key = dimension === 'store' ? (inv.store_id ?? 'unassigned') : (inv.payment_method ?? 'other')
      const label = dimension === 'store' ? key : (inv.payment_method ?? 'other')
      const g = group.get(key) ?? { key, label, gross: 0, count: 0 }
      g.gross += toNum(inv.total)
      g.count += 1
      group.set(key, g)
    }
    if (dimension === 'store') {
      const nameMap = await loadStoreNameMap(service, f.tenantId, f.storeIds)
      for (const g of group.values()) {
        if (g.key === 'unassigned') {
          g.label = '未指定门店'
        }
        else {
          g.label = nameMap.get(g.key) ?? g.key.slice(0, 8)
        }
      }
    }
    return finalizeDimensionRows([...group.values()])
  }

  // catalog_type:经 invoice_items.category 聚合
  if (dimension === 'catalog_type') {
    const invoiceIds = invoices.map(i => i.id)
    const { data: items, error } = await service
      .from('invoice_items')
      .select('invoice_id, category, amount')
      .in('invoice_id', invoiceIds)
    if (error) {
      throw new Error(`目录类型维度查询失败: ${error.message}`)
    }
    const grossByCat = new Map<string, number>()
    for (const it of (items as Array<{ invoice_id: string; category: string; amount: number }> | null) ?? []) {
      grossByCat.set(it.category, (grossByCat.get(it.category) ?? 0) + toNum(it.amount))
    }
    const labelMap: Record<string, string> = {
      service: '服务',
      drug: '药品',
      vaccine: '疫苗',
      exam: '检查检验',
      product: '商品',
    }
    return finalizeDimensionRows([...grossByCat.entries()].map(([k, gross]) => ({
      key: k,
      label: labelMap[k] ?? k,
      gross,
      count: invoices.length,
    })))
  }

  // doctor:经 encounters.doctor_id 聚合
  const encounterIds = invoices.map(i => i.encounter_id).filter((x): x is string => !!x)
  const byEncounter = new Map<string, number>()
  for (const inv of invoices) {
    if (inv.encounter_id) {
      byEncounter.set(inv.encounter_id, (byEncounter.get(inv.encounter_id) ?? 0) + toNum(inv.total))
    }
  }
  const group = new Map<string, { key: string; label: string; gross: number; count: number }>()
  if (encounterIds.length > 0) {
    const { data: encs } = await service
      .from('encounters')
      .select('id, doctor_id')
      .in('id', encounterIds)
    const doctorIds = [...new Set((encs ?? []).map((e: { doctor_id: string | null }) => e.doctor_id).filter(Boolean))] as string[]
    const doctorMap = new Map<string, string>()
    if (doctorIds.length > 0) {
      const { data: employees } = await service
        .from('employees')
        .select('user_id, name')
        .eq('tenant_id', f.tenantId)
        .in('user_id', doctorIds)
      for (const emp of (employees ?? []) as Array<{ user_id: string; name: string | null }>) {
        doctorMap.set(emp.user_id, emp.name ?? emp.user_id.slice(0, 8))
      }
    }
    for (const e of (encs ?? []) as Array<{ id: string; doctor_id: string | null }>) {
      const gross = byEncounter.get(e.id) ?? 0
      const key = e.doctor_id ?? 'unassigned'
      const g = group.get(key) ?? { key, label: e.doctor_id ? (doctorMap.get(e.doctor_id) ?? e.doctor_id.slice(0, 8)) : '未分配医生', gross: 0, count: 0 }
      g.gross += gross
      g.count += 1
      group.set(key, g)
    }
    // 无 encounter 关联的发票归到"未归因"
    const unassignedGross = invoices.filter(i => !i.encounter_id).reduce((s, i) => s + toNum(i.total), 0)
    if (unassignedGross > 0) {
      const g = group.get('unassigned') ?? { key: 'unassigned', label: '未归因', gross: 0, count: 0 }
      g.gross += unassignedGross
      g.count += 1
      group.set('unassigned', g)
    }
  }
  return finalizeDimensionRows([...group.values()])
}

interface DimensionAcc {
  key: string
  label: string
  gross: number
  count: number
}

function finalizeDimensionRows(accs: DimensionAcc[]): RevenueDimensionRow[] {
  const totalNet = accs.reduce((s, a) => s + a.gross, 0)
  return accs
    .map((a) => {
      const net = a.gross
      return {
        key: a.key,
        label: a.label,
        gross: a.gross,
        refund: 0,
        net,
        invoiceCount: a.count,
        averageTicket: a.count > 0 ? net / a.count : 0,
        share: totalNet > 0 ? Math.round((net / totalNet) * 1000) / 10 : 0,
      }
    })
    .sort((a, b) => b.net - a.net)
}

/** 构建收入报表 */
export async function buildRevenueReport(
  service: ServiceClient,
  f: RevenueFilters,
  opts: { groupBy: AnalyticsGroupBy; dimension: RevenueDimension },
): Promise<RevenueReport> {
  const [invoices, refunds] = await Promise.all([
    fetchValidInvoices(service, f),
    fetchRefunds(service, f),
  ])
  const gross = invoices.reduce((s, r) => s + toNum(r.total), 0)
  const refund = refunds.reduce((s, r) => s + toNum(r.amount), 0)
  const net = gross - refund
  const invoiceCount = invoices.length

  const trend = buildTrendFromRows(invoices, refunds, opts.groupBy, f.period.timezone)
  const dimensionRows = await buildDimensionRows(service, invoices, opts.dimension, f)

  return {
    period: f.period,
    kpis: [
      {
        key: 'gross',
        label: 'Gross 收入',
        value: gross,
        format: 'money',
        definition: '有效发票(confirmed/paid/partially_paid/refunded)合计金额,排除草稿与取消。',
      },
      {
        key: 'refund',
        label: '退款',
        value: refund,
        format: 'money',
        definition: '当期退款合计,经发票收敛门店范围。',
      },
      {
        key: 'net',
        label: '净收入',
        value: net,
        format: 'money',
        definition: 'Gross 收入 − 退款。',
      },
      {
        key: 'invoiceCount',
        label: '发票数',
        value: invoiceCount,
        format: 'integer',
        definition: '有效发票张数。',
      },
      {
        key: 'averageTicket',
        label: '客单价',
        value: invoiceCount > 0 ? net / invoiceCount : 0,
        format: 'money',
        definition: '净收入 ÷ 有效发票数。',
      },
    ],
    groupBy: opts.groupBy,
    trend,
    dimension: opts.dimension,
    dimensionRows,
    summary: { gross, refund, net, invoiceCount, averageTicket: invoiceCount > 0 ? net / invoiceCount : 0 },
  }
}
