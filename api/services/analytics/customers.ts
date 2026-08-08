/**
 * S32-B 客户分析(customers)
 *
 * 口径(S32-B 规格 §6 + KPI-DEFINITIONS.md):
 *   - 新增客户 = 查询周期内建档(customers.created_at)的客户数;
 *   - 活跃客户 = 查询周期内有就诊(encounters)或消费(invoices)的客户数;
 *   - 复诊客户 = 查询周期内就诊次数 ≥ 2 的客户数;
 *   - 复诊率    = 复诊客户 ÷ 查询周期内有就诊(≥1 次)的客户数
 *               (分母不含仅消费未就诊的客户;定义见文档与页面 Tooltip);
 *   - 客户消费分层 = 按客户本期净消费区间分桶;
 *   - 会员客户贡献 = 各会员层级客户的本期消费合计。
 */
import type { ServiceClient } from './common'
import { toNum } from './common'
import type { CustomerConsumptionTier, CustomerReport, CustomerTierRow, RevenueFilters } from './types'

const MEMBER_TIER_LABELS: Record<string, string> = {
  normal: '普通客户',
  silver: '银卡会员',
  gold: '金卡会员',
  diamond: '钻石会员',
}

/** 消费分层桶(净消费,元) */
const CONSUMPTION_BUCKETS: Array<{ key: string; label: string; min: number; max: number }> = [
  { key: 'none', label: '未消费', min: 0, max: 0 },
  { key: 'lt500', label: '1–500', min: 1, max: 500 },
  { key: 'lt2000', label: '501–2000', min: 500.01, max: 2000 },
  { key: 'lt5000', label: '2001–5000', min: 2000.01, max: 5000 },
  { key: 'gt5000', label: '5000 以上', min: 5000.01, max: Number.POSITIVE_INFINITY },
]

/** 复诊率定义(常量,供文档/页面 Tooltip 引用) */
export const REPEAT_RATE_DEFINITION = '复诊率 = 查询周期内就诊次数 ≥ 2 的客户数 ÷ 查询周期内就诊次数 ≥ 1 的客户数(分母不含仅消费未就诊的客户)。'

export async function buildCustomerReport(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<CustomerReport> {
  const [custRes, encRes, invRes] = await Promise.all([
    service.from('customers')
      .select('id, member_level, created_at')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .lte('created_at', f.period.endISO),
    service.from('encounters')
      .select('customer_id')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO),
    service.from('invoices')
      .select('customer_id, total')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .in('status', ['confirmed', 'paid', 'partially_paid', 'refunded'])
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO),
  ])
  if (custRes.error) {
    throw new Error(`客户资料查询失败: ${custRes.error.message}`)
  }
  if (encRes.error) {
    throw new Error(`就诊记录查询失败: ${encRes.error.message}`)
  }
  if (invRes.error) {
    throw new Error(`消费记录查询失败: ${invRes.error.message}`)
  }

  const customers = (custRes.data as Array<{ id: string; member_level: string | null; created_at: string }> | null) ?? []
  const encounters = (encRes.data as Array<{ customer_id: string }> | null) ?? []
  const invoices = (invRes.data as Array<{ customer_id: string | null; total: number }> | null) ?? []

  // 新客户(周期内建档)
  const newCustomers = customers.filter(c => c.created_at >= f.period.startISO).length

  // 就诊客户:客户 → 就诊次数
  const encCountByCustomer = new Map<string, number>()
  for (const e of encounters) {
    encCountByCustomer.set(e.customer_id, (encCountByCustomer.get(e.customer_id) ?? 0) + 1)
  }
  // 消费客户:客户 → 消费合计
  const spendByCustomer = new Map<string, number>()
  for (const inv of invoices) {
    if (!inv.customer_id) {
      continue
    }
    spendByCustomer.set(inv.customer_id, (spendByCustomer.get(inv.customer_id) ?? 0) + toNum(inv.total))
  }

  const activeCustomerIds = new Set<string>([
    ...encCountByCustomer.keys(),
    ...spendByCustomer.keys(),
  ])
  const activeCustomers = activeCustomerIds.size
  const repeatCustomers = [...encCountByCustomer.values()].filter(n => n >= 2).length
  const visitedCustomers = encCountByCustomer.size
  const repeatRate = visitedCustomers > 0 ? repeatCustomers / visitedCustomers : 0

  // 会员层级贡献(用客户表 member_level)
  const memberContributionByTier = new Map<string, number>()
  const memberCountByTier = new Map<string, number>()
  const memberLevelByCustomer = new Map<string, string>()
  for (const c of customers) {
    if (c.member_level && c.member_level !== 'normal') {
      memberLevelByCustomer.set(c.id, c.member_level)
    }
  }
  for (const [cid, spend] of spendByCustomer) {
    const tier = memberLevelByCustomer.get(cid)
    if (tier) {
      memberContributionByTier.set(tier, (memberContributionByTier.get(tier) ?? 0) + spend)
      memberCountByTier.set(tier, (memberCountByTier.get(tier) ?? 0) + 1)
    }
  }
  const memberContribution = [...memberContributionByTier.values()].reduce((s, v) => s + v, 0)

  // 会员层级明细(含 count=该层级客户总数,contribution=该层级本期消费)
  const tierBreakdown: CustomerTierRow[] = (['normal', 'silver', 'gold', 'diamond'] as const).map((tier) => {
    const tierCustomers = customers.filter(c => (c.member_level ?? 'normal') === tier)
    const tierSpend = tierCustomers.reduce((s, c) => s + (spendByCustomer.get(c.id) ?? 0), 0)
    return {
      tier,
      label: MEMBER_TIER_LABELS[tier] ?? tier,
      count: tierCustomers.length,
      contribution: Math.round(tierSpend * 100) / 100,
    }
  })

  // 客户消费分层
  const consumptionTiers: CustomerConsumptionTier[] = CONSUMPTION_BUCKETS.map((b) => {
    const customersInBucket = [...spendByCustomer.entries()].filter(([, spend]) => spend >= b.min && spend <= b.max)
    const amount = customersInBucket.reduce((s, [, v]) => s + v, 0)
    return {
      key: b.key,
      label: b.label,
      min: b.min,
      max: Number.isFinite(b.max) ? b.max : 0,
      count: customersInBucket.length,
      amount: Math.round(amount * 100) / 100,
    }
  })

  return {
    period: f.period,
    kpis: [
      {
        key: 'newCustomers',
        label: '新增客户',
        value: newCustomers,
        format: 'integer',
        definition: '查询周期内建档的客户数(customers.created_at)。',
      },
      {
        key: 'activeCustomers',
        label: '活跃客户',
        value: activeCustomers,
        format: 'integer',
        definition: '查询周期内有就诊或消费的客户数(去重)。',
      },
      {
        key: 'repeatCustomers',
        label: '复诊客户',
        value: repeatCustomers,
        format: 'integer',
        definition: '查询周期内就诊次数 ≥ 2 的客户数。',
      },
      {
        key: 'repeatRate',
        label: '复诊率',
        value: Math.round(repeatRate * 1000) / 10,
        format: 'percent',
        definition: REPEAT_RATE_DEFINITION,
      },
      {
        key: 'memberContribution',
        label: '会员贡献',
        value: Math.round(memberContribution * 100) / 100,
        format: 'money',
        definition: '各会员层级客户(银卡/金卡/钻石)本期消费合计。',
      },
    ],
    repeatRateDefinition: REPEAT_RATE_DEFINITION,
    tierBreakdown,
    consumptionTiers,
  }
}
