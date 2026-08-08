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
 *
 * 会员口径(S32-B 审计 #21):统一以 customer_memberships(当前有效会员关系,
 * expires_at 为空或未过期)join membership_tiers 作为事实来源,
 * 不再读取旧字段 customers.member_level。
 */
import type { ServiceClient } from './common.js'
import { fetchAll, toNum } from './common.js'
import type { CustomerConsumptionTier, CustomerReport, CustomerTierRow, RevenueFilters } from './types.js'

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
  // 全部查询分页拉全,规避 PostgREST 行数上限导致静默少算(审计 v2 §14)
  const [customers, encounters, invoices, tierRes, memberships] = await Promise.all([
    fetchAll<{ id: string; created_at: string }>('客户数据', (from, to) => service
      .from('customers')
      .select('id, created_at')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .lte('created_at', f.period.endISO)
      .order('id', { ascending: true })
      .range(from, to)),
    fetchAll<{ customer_id: string }>('就诊记录', (from, to) => service
      .from('encounters')
      .select('customer_id')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO)
      .order('id', { ascending: true })
      .range(from, to)),
    fetchAll<{ customer_id: string | null; total: number }>('消费记录', (from, to) => service
      .from('invoices')
      .select('customer_id, total')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .in('status', ['confirmed', 'paid', 'partially_paid', 'refunded'])
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO)
      .order('id', { ascending: true })
      .range(from, to)),
    // 会员层级定义(真实层级,审计 #21;层级数有限,无截断风险)
    service.from('membership_tiers')
      .select('id, code, name, is_active')
      .eq('tenant_id', f.tenantId),
    // 当前有效会员关系(customer_memberships 为事实来源,审计 #21;分页拉全)
    fetchAll<{ customer_id: string; tier_id: string | null; expires_at: string | null }>('会员关系数据', (from, to) => service
      .from('customer_memberships')
      .select('customer_id, tier_id, expires_at')
      .eq('tenant_id', f.tenantId)
      .order('id', { ascending: true })
      .range(from, to)),
  ])
  if (tierRes.error) {
    throw new Error(`会员层级查询失败: ${tierRes.error.message}`)
  }

  const tiers = (tierRes.data as Array<{ id: string; code: string; name: string; is_active: boolean }> | null) ?? []

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

  // 有效会员关系:customer <-> tier.code(仅本报表覆盖门店 + 未过期)
  const activeTierById = new Map<string, { code: string; name: string }>()
  for (const t of tiers) {
    if (t.is_active) {
      activeTierById.set(t.id, { code: t.code, name: t.name })
    }
  }
  const customerIdSet = new Set(customers.map(c => c.id))
  const nowISO = new Date().toISOString()
  const tierCodeByCustomer = new Map<string, string>()
  for (const m of memberships) {
    if (!m.tier_id || !customerIdSet.has(m.customer_id)) {
      continue
    }
    // 过期会员不计入当前有效关系
    if (m.expires_at && m.expires_at <= nowISO) {
      continue
    }
    const tier = activeTierById.get(m.tier_id)
    if (tier) {
      tierCodeByCustomer.set(m.customer_id, tier.code)
    }
  }

  // 会员层级贡献(按有效会员关系 tier.code)
  const memberContributionByTier = new Map<string, number>()
  for (const [cid, spend] of spendByCustomer) {
    const code = tierCodeByCustomer.get(cid)
    if (code) {
      memberContributionByTier.set(code, (memberContributionByTier.get(code) ?? 0) + spend)
    }
  }
  const memberContribution = [...memberContributionByTier.values()].reduce((s, v) => s + v, 0)

  // 会员层级明细(真实层级 + 普通客户),count=该层级有效会员客户总数,contribution=该层级本期消费
  const memberCustomerIds = new Set(tierCodeByCustomer.keys())
  const tierBreakdown: CustomerTierRow[] = tiers
    .filter(t => t.is_active)
    .map((t) => {
      const code = t.code
      const ids = [...tierCodeByCustomer.entries()]
        .filter(([, c]) => c === code)
        .map(([cid]) => cid)
      const contribution = ids.reduce((s, cid) => s + (spendByCustomer.get(cid) ?? 0), 0)
      return {
        tier: code,
        label: t.name || code,
        count: ids.length,
        contribution: Math.round(contribution * 100) / 100,
      }
    })
  // 普通客户(无有效会员关系)附加行
  const normalCustomers = customers.filter(c => !memberCustomerIds.has(c.id))
  const normalContribution = normalCustomers.reduce((s, c) => s + (spendByCustomer.get(c.id) ?? 0), 0)
  tierBreakdown.push({
    tier: 'normal',
    label: '普通客户',
    count: normalCustomers.length,
    contribution: Math.round(normalContribution * 100) / 100,
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
        definition: '有效会员关系(customer_memberships,未过期)客户本期消费合计。',
      },
    ],
    repeatRateDefinition: REPEAT_RATE_DEFINITION,
    tierBreakdown,
    consumptionTiers,
  }
}
