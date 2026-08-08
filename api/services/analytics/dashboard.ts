/**
 * S32-B 医院经营驾驶舱(dashboard)
 *
 * 第一版 KPI(S32-B 规格 §4),口径见 KPI-DEFINITIONS.md:
 *   今日收入 / 本月收入 = 有效发票合计(排除草稿与取消)
 *   今日门诊 = 今日(租户时区)开始的就诊数
 *   本月新增客户 = 本月建档客户数
 *   平均客单价 = 本月净收入 ÷ 本月有效发票数
 *   退款金额 = 本月退款合计
 *   住院收入 = 本月住院计费(inpatient_charges.amount)合计
 *   寄养收入 = 本月寄养计费(boarding_service_charges.amount)合计
 *   会员贡献 = 会员客户(银卡/金卡/钻石)本月消费合计
 *   低库存 / 近效期 = 见 inventory.ts
 */
import type { ServiceClient } from './common'
import {
  dayKeyInTz,
  localDateToUTC,
  resolvePeriod,
  toNum,
} from './common'
import { computeRevenueSummary, buildTrendFromRows } from './revenue'
import { countExpiring, countLowStock } from './inventory'
import type { DashboardReport, RevenueFilters } from './types'

const MEMBER_LEVELS = ['silver', 'gold', 'diamond']

export async function buildDashboardReport(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<DashboardReport> {
  const period = f.period
  const tz = period.timezone

  // 今日(租户时区)闭区间
  const todayKey = dayKeyInTz(new Date(), tz)
  const [ty, tm, td] = todayKey.split('-').map(Number)
  const todayStart = localDateToUTC(tz, ty, tm, td)
  const todayEnd = new Date(todayStart.getTime() + 86_400_000 - 1)
  const todayFilters: RevenueFilters = {
    tenantId: f.tenantId,
    storeIds: f.storeIds,
    period: { ...period, startISO: todayStart.toISOString(), endISO: todayEnd.toISOString() },
  }

  const [monthSummary, todaySummary, invRes, custRes, encRes, ipRes, bdRes] = await Promise.all([
    computeRevenueSummary(service, f),
    computeRevenueSummary(service, todayFilters),
    // 本月发票(会员贡献 + 趋势)
    service.from('invoices')
      .select('customer_id, total, created_at')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .in('status', ['confirmed', 'paid', 'partially_paid', 'refunded'])
      .gte('created_at', period.startISO)
      .lte('created_at', period.endISO),
    // 客户(会员贡献 + 本月新增)
    service.from('customers')
      .select('id, member_level, created_at')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .lte('created_at', period.endISO),
    // 今日门诊
    service.from('encounters')
      .select('id')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('started_at', todayStart.toISOString())
      .lte('started_at', todayEnd.toISOString()),
    // 本月住院计费
    service.from('inpatient_charges')
      .select('amount')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('charge_date', period.startDate)
      .lte('charge_date', period.endDate),
    // 本月寄养计费
    service.from('boarding_service_charges')
      .select('amount')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('charge_date', period.startDate)
      .lte('charge_date', period.endDate),
  ])
  if (invRes.error) {
    throw new Error(`发票查询失败: ${invRes.error.message}`)
  }
  if (custRes.error) {
    throw new Error(`客户查询失败: ${custRes.error.message}`)
  }
  if (encRes.error) {
    throw new Error(`就诊查询失败: ${encRes.error.message}`)
  }
  if (ipRes.error) {
    throw new Error(`住院计费查询失败: ${ipRes.error.message}`)
  }
  if (bdRes.error) {
    throw new Error(`寄养计费查询失败: ${bdRes.error.message}`)
  }

  const invoices = (invRes.data as Array<{ customer_id: string | null; total: number; created_at: string }> | null) ?? []
  const customers = (custRes.data as Array<{ id: string; member_level: string | null; created_at: string }> | null) ?? []
  const todayEncounters = (encRes.data as unknown[] | null)?.length ?? 0
  const inpatientRevenue = (ipRes.data as Array<{ amount: number }> | null)?.reduce((s, r) => s + toNum(r.amount), 0) ?? 0
  const boardingRevenue = (bdRes.data as Array<{ amount: number }> | null)?.reduce((s, r) => s + toNum(r.amount), 0) ?? 0

  // 本月新增客户
  const newCustomersMonth = customers.filter(c => c.created_at >= period.startISO).length

  // 会员贡献:会员客户的本月消费
  const memberLevelByCustomer = new Map<string, string>()
  for (const c of customers) {
    if (c.member_level && MEMBER_LEVELS.includes(c.member_level)) {
      memberLevelByCustomer.set(c.id, c.member_level)
    }
  }
  const memberContribution = invoices
    .filter(inv => inv.customer_id && memberLevelByCustomer.has(inv.customer_id))
    .reduce((s, inv) => s + toNum(inv.total), 0)

  // 本月每日趋势(迷你图)
  const refundRows = await (async () => {
    const { data } = await service
      .from('refunds')
      .select('amount, created_at, invoices!inner(store_id)')
      .eq('tenant_id', f.tenantId)
      .in('invoices.store_id', f.storeIds)
      .gte('created_at', period.startISO)
      .lte('created_at', period.endISO)
    return (data as Array<{ amount: number; created_at: string }> | null) ?? []
  })()

  const revenueTrend = buildTrendFromRows(invoices, refundRows, 'day', tz)

  const [lowStockCount, expiringCount] = await Promise.all([
    countLowStock(service, f),
    countExpiring(service, f, period.endDate),
  ])

  const avgTicket = monthSummary.invoiceCount > 0 ? monthSummary.net / monthSummary.invoiceCount : 0

  return {
    period,
    kpis: [
      {
        key: 'todayRevenue',
        label: '今日收入',
        value: Math.round(todaySummary.net * 100) / 100,
        format: 'money',
        hint: `本月 ${period.startDate} ~ ${period.endDate}`,
        definition: '今日(租户时区)有效发票合计 − 今日退款。',
      },
      {
        key: 'monthRevenue',
        label: '本月收入',
        value: Math.round(monthSummary.net * 100) / 100,
        format: 'money',
        hint: `退款 ${Math.round(monthSummary.refund * 100) / 100}`,
        definition: '本月有效发票合计 − 本月退款(净收入)。',
      },
      {
        key: 'todayEncounters',
        label: '今日门诊',
        value: todayEncounters,
        format: 'integer',
        definition: '今日(租户时区)开始就诊数。',
      },
      {
        key: 'newCustomersMonth',
        label: '本月新增客户',
        value: newCustomersMonth,
        format: 'integer',
        definition: '本月建档客户数。',
      },
      {
        key: 'averageTicket',
        label: '平均客单价',
        value: Math.round(avgTicket * 100) / 100,
        format: 'money',
        definition: '本月净收入 ÷ 本月有效发票数。',
      },
      {
        key: 'refund',
        label: '退款金额',
        value: Math.round(monthSummary.refund * 100) / 100,
        format: 'money',
        definition: '本月退款合计。',
      },
      {
        key: 'inpatientRevenue',
        label: '住院收入',
        value: Math.round(inpatientRevenue * 100) / 100,
        format: 'money',
        definition: '本月住院计费(inpatient_charges)合计。',
      },
      {
        key: 'boardingRevenue',
        label: '寄养收入',
        value: Math.round(boardingRevenue * 100) / 100,
        format: 'money',
        definition: '本月寄养计费(boarding_service_charges)合计。',
      },
      {
        key: 'memberContribution',
        label: '会员贡献',
        value: Math.round(memberContribution * 100) / 100,
        format: 'money',
        definition: '银卡/金卡/钻石会员客户本月消费合计。',
      },
      {
        key: 'lowStock',
        label: '低库存',
        value: lowStockCount,
        format: 'integer',
        definition: '可用数量 ≤ 0 的 SKU 数(断货/不可售)。',
      },
      {
        key: 'expiring',
        label: '近效期',
        value: expiringCount,
        format: 'integer',
        definition: `${period.endDate} 起 30 天内到期且有剩余库存的活跃批次。`,
      },
    ],
    revenueTrend,
    lowStockCount,
    expiringCount,
  }
}
