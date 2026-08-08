/**
 * S32-B 医院经营驾驶舱(dashboard)
 *
 * 第一版 KPI(S32-B 规格 §4),口径见 KPI-DEFINITIONS.md:
 *   今日收入 / 本月收入 = 有效发票合计(排除草稿与取消)
 *   今日门诊 = 今日(租户时区)开始的就诊数
 *   本月新增客户 = 本月建档客户数
 *   平均客单价 = 本月净收入 ÷ 本月有效发票数
 *   退款金额 = 本月退款合计
 *   住院计费额 = 本月住院计费(inpatient_charges.amount)合计(已计费 ≠ 已实现收入,审计 #23)
 *   寄养附加服务金额 = 本月寄养附加服务计费(boarding_service_charges.amount)合计(审计 #22)
 *   会员贡献 = 有效会员关系(customer_memberships,未过期)客户本月消费合计(审计 #21)
 *   缺货 SKU / 近效期 = 见 inventory.ts(审计 #25:可用数量 ≤ 0 为缺货而非低库存)
 */
import type { ServiceClient } from './common'
import {
  dayKeyInTz,
  fetchAll,
  localDateToUTC,
  resolvePeriod,
  toNum,
} from './common'
import { computeRevenueSummary, buildTrendFromRows } from './revenue'
import { countExpiring, countLowStock } from './inventory'
import type { DashboardReport, RevenueFilters } from './types'

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

  const [monthSummary, todaySummary, invoices, customers, encRes, inpatientCharges, boardingCharges, tierRes, membRes] = await Promise.all([
    computeRevenueSummary(service, f),
    computeRevenueSummary(service, todayFilters),
    // 本月发票(会员贡献 + 趋势)分页拉全(审计 v2 §14)
    fetchAll<{ customer_id: string | null; total: number; created_at: string }>('发票数据', (from, to) => service
      .from('invoices')
      .select('customer_id, total, created_at')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .in('status', ['confirmed', 'paid', 'partially_paid', 'refunded'])
      .gte('created_at', period.startISO)
      .lte('created_at', period.endISO)
      .order('id', { ascending: true })
      .range(from, to)),
    // 客户(会员贡献 + 本月新增)分页拉全(审计 v2 §14)
    fetchAll<{ id: string; created_at: string }>('客户数据', (from, to) => service
      .from('customers')
      .select('id, created_at')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .lte('created_at', period.endISO)
      .order('id', { ascending: true })
      .range(from, to)),
    // 今日门诊(仅 count,无聚合错误风险,head 计数)
    service.from('encounters')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('started_at', todayStart.toISOString())
      .lte('started_at', todayEnd.toISOString()),
    // 本月住院计费(分页拉全,审计 v2 §14)
    fetchAll<{ amount: number }>('住院计费数据', (from, to) => service
      .from('inpatient_charges')
      .select('amount')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('charge_date', period.startDate)
      .lte('charge_date', period.endDate)
      .order('id', { ascending: true })
      .range(from, to)),
    // 本月寄养附加服务计费(分页拉全,审计 v2 §14)
    fetchAll<{ amount: number }>('寄养计费数据', (from, to) => service
      .from('boarding_service_charges')
      .select('amount')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('charge_date', period.startDate)
      .lte('charge_date', period.endDate)
      .order('id', { ascending: true })
      .range(from, to)),
    // 会员层级定义(审计 #21 会员口径;层级数有限,无截断风险)
    service.from('membership_tiers')
      .select('id, is_active')
      .eq('tenant_id', f.tenantId),
    // 当前有效会员关系(审计 #21 会员口径;分页拉全,审计 v2 §14)
    fetchAll<{ customer_id: string; tier_id: string | null; expires_at: string | null }>('会员关系数据', (from, to) => service
      .from('customer_memberships')
      .select('customer_id, tier_id, expires_at')
      .eq('tenant_id', f.tenantId)
      .order('id', { ascending: true })
      .range(from, to)),
  ])
  if (encRes.error) {
    throw new Error(`就诊查询失败: ${encRes.error.message}`)
  }
  if (tierRes.error) {
    throw new Error(`会员层级查询失败: ${tierRes.error.message}`)
  }

  const todayEncounters = encRes.count ?? 0
  const inpatientRevenue = inpatientCharges.reduce((s, r) => s + toNum(r.amount), 0)
  const boardingRevenue = boardingCharges.reduce((s, r) => s + toNum(r.amount), 0)

  // 本月新增客户
  const newCustomersMonth = customers.filter(c => c.created_at >= period.startISO).length

  // 会员贡献:有效会员关系(customer_memberships,未过期)客户的本月消费
  const activeTierIds = new Set(
    ((tierRes.data as Array<{ id: string; is_active: boolean }> | null) ?? [])
      .filter(t => t.is_active)
      .map(t => t.id),
  )
  const customerIdSet = new Set(customers.map(c => c.id))
  const nowISO = new Date().toISOString()
  const memberCustomerIds = new Set<string>()
  for (const m of membRes) {
    if (!m.tier_id || !customerIdSet.has(m.customer_id)) {
      continue
    }
    if (!activeTierIds.has(m.tier_id)) {
      continue
    }
    // 过期会员不计入当前有效关系
    if (m.expires_at && m.expires_at <= nowISO) {
      continue
    }
    memberCustomerIds.add(m.customer_id)
  }
  const memberContribution = invoices
    .filter(inv => inv.customer_id && memberCustomerIds.has(inv.customer_id))
    .reduce((s, inv) => s + toNum(inv.total), 0)

  // 本月每日趋势(迷你图):退款分页拉全(审计 v2 §14);refunds 无 store_id,经发票 join 收敛门店
  const refundRows = await fetchAll<{ amount: number; created_at: string }>('退款数据', (from, to) => service
    .from('refunds')
    .select('amount, created_at, invoices!inner(store_id)')
    .eq('tenant_id', f.tenantId)
    .in('invoices.store_id', f.storeIds)
    .gte('created_at', period.startISO)
    .lte('created_at', period.endISO)
    .order('id', { ascending: true })
    .range(from, to))

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
        label: '住院计费额',
        value: Math.round(inpatientRevenue * 100) / 100,
        format: 'money',
        definition: '本月住院计费(inpatient_charges)合计;已计费 ≠ 已实现收入(审计 #23)。',
      },
      {
        key: 'boardingRevenue',
        label: '寄养附加服务金额',
        value: Math.round(boardingRevenue * 100) / 100,
        format: 'money',
        definition: '本月寄养附加服务计费(boarding_service_charges)合计;基础房费在退房结算时进入发票,未包含在本指标(审计 #22)。',
      },
      {
        key: 'memberContribution',
        label: '会员贡献',
        value: Math.round(memberContribution * 100) / 100,
        format: 'money',
        definition: '有效会员关系(customer_memberships,未过期)客户本月消费合计(审计 #21)。',
      },
      {
        key: 'lowStock',
        label: '缺货 SKU',
        value: lowStockCount,
        format: 'integer',
        definition: '可用数量(在库−预留) ≤ 0 的 SKU 数(断货/不可售口径,审计 #25)。',
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
