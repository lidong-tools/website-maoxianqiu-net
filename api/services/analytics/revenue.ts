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
 * P0-B 修复(审计 #14~#19):
 *   - 核心 KPI(Gross/Refund/Net/Count)改为 DB 侧聚合 RPC
 *     get_analytics_revenue_summary,规避 PostgREST 行数上限静默截断;
 *   - 明细/趋势行分页拉全(fetchAll),保证 JS 侧聚合数据完整;
 *   - Refund 维度归属:store 按发票门店、payment_channel 按退款关联支付渠道,
 *     使各维度 Net 合计可对账;
 *   - payment_channel 基于真实 payments(按 method),不再用 invoices.payment_method;
 *   - catalog_type 的 invoiceCount 改为"包含该分类的发票数"(去重)。
 *
 * 维度:store(门店) / payment_channel(收款渠道) / catalog_type(目录类型) / doctor(医生)。
 * 对账口径(审计 v2 §15/§16):
 *   - store / doctor 维度:退款按发票归属(门店 / 关联 encounter 的医生)计入,Net 合计可对账;
 *   - catalog_type 维度:退款按发票明细金额占比分摊到目录类型,Net 合计可对账;
 *   - payment_channel 为"收款渠道",按实际收款时间(payments.created_at)统计,
 *     与 Overall 的发票开账(应计)口径不同,属 KPI 会计基础差异,不是对账 Bug(§16)。
 */
import type { ServiceClient } from './common'
import { bucketKey, chunk, loadStoreNameMap, toNum, UUID_CHUNK_SIZE } from './common'
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

interface RefundRow {
  amount: number
  created_at: string
  store_id: string | null
  /** 退款关联发票(用于 doctor/catalog 维度退款归属,审计 v2 §15) */
  invoice_id: string | null
}

/** 分页大小:低于 PostgREST 单次上限,循环拉全避免静默截断 */
const PAGE_SIZE = 500

/**
 * 分页拉全有效发票(含收入维度所需字段)
 * @param service service-role 客户端
 * @param f       收入过滤条件
 */
async function fetchValidInvoices(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<InvoiceRow[]> {
  const out: InvoiceRow[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await service
      .from('invoices')
      .select('id, store_id, payment_method, total, created_at, customer_id, encounter_id')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .in('status', VALID_INVOICE_STATUSES)
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      throw new Error(`收入数据查询失败: ${error.message}`)
    }
    const rows = (data as InvoiceRow[] | null) ?? []
    out.push(...rows)
    if (rows.length < PAGE_SIZE) {
      break
    }
  }
  return out
}

/**
 * 分页拉全当期退款(经 invoices 收敛门店范围,附门店归属供维度对账)
 * @param service service-role 客户端
 * @param f       收入过滤条件
 */
async function fetchRefunds(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<RefundRow[]> {
  const out: RefundRow[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await service
      .from('refunds')
      .select('amount, created_at, invoice_id, invoices!inner(store_id)')
      .eq('tenant_id', f.tenantId)
      .in('invoices.store_id', f.storeIds)
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      throw new Error(`退款数据查询失败: ${error.message}`)
    }
    // 审计 Full12 §11/§13:refunds→invoices 为 many-to-one 嵌套关系,
    // PostgREST 对 Embedded Relation 返回对象而非数组;client 泛型仍按数组推断,
    // 经 unknown 桥接修正真实形状。
    const rows = (data as unknown as Array<{ amount: number; created_at: string; invoice_id: string | null; invoices?: { store_id: string | null } | null }> | null) ?? []
    for (const r of rows) {
      out.push({ amount: toNum(r.amount), created_at: r.created_at, store_id: r.invoices?.store_id ?? null, invoice_id: r.invoice_id ?? null })
    }
    if (rows.length < PAGE_SIZE) {
      break
    }
  }
  return out
}

export interface RevenueSummary {
  gross: number
  refund: number
  net: number
  invoiceCount: number
  averageTicket: number
}

/**
 * 计算时间段内的收入汇总(驾驶舱与收入页共用)
 * 走 DB 侧聚合 RPC,避免把全量发票/退款行搬到 JS 内存
 * @param service service-role 客户端
 * @param f       收入过滤条件
 */
export async function computeRevenueSummary(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<RevenueSummary> {
  const { data, error } = await service.rpc('get_analytics_revenue_summary', {
    p_tenant_id: f.tenantId,
    p_store_ids: f.storeIds,
    p_start: f.period.startISO,
    p_end: f.period.endISO,
  })
  if (error) {
    throw new Error(`收入汇总查询失败: ${error.message}`)
  }
  const s = (data as { gross?: number; refund?: number; net?: number; invoiceCount?: number } | null) ?? {}
  const gross = toNum(s.gross)
  const refund = toNum(s.refund)
  const net = toNum(s.net)
  const invoiceCount = toNum(s.invoiceCount)
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

/** 维度中间累计值(含退款归属) */
interface DimensionAcc {
  key: string
  label: string
  gross: number
  refund: number
  count: number
}

/** 渠道维度固定顺序与标签 */
const CHANNEL_LABELS: Record<string, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  card: '银行卡',
  stored_value: '储值',
  other: '其他',
}

/** 目录类型标签 */
const CATEGORY_LABELS: Record<string, string> = {
  service: '服务',
  drug: '药品',
  vaccine: '疫苗',
  exam: '检查检验',
  product: '商品',
}

/**
 * 按门店维度聚合(发票应收 + 退款归属),Net 合计可对账
 * @param invoices 有效发票行
 * @param refunds  当期退款行(含门店归属)
 */
async function buildStoreDimension(
  service: ServiceClient,
  invoices: InvoiceRow[],
  refunds: RefundRow[],
  f: RevenueFilters,
): Promise<RevenueDimensionRow[]> {
  const accMap = new Map<string, DimensionAcc>()
  for (const inv of invoices) {
    const key = inv.store_id ?? 'unassigned'
    const acc = accMap.get(key) ?? { key, label: key, gross: 0, refund: 0, count: 0 }
    acc.gross += toNum(inv.total)
    acc.count += 1
    accMap.set(key, acc)
  }
  for (const r of refunds) {
    const key = r.store_id ?? 'unassigned'
    const acc = accMap.get(key) ?? { key, label: key, gross: 0, refund: 0, count: 0 }
    acc.refund += toNum(r.amount)
    accMap.set(key, acc)
  }
  const nameMap = await loadStoreNameMap(service, f.tenantId, f.storeIds)
  return finalizeDimensionRows([...accMap.values()].map(acc => ({
    ...acc,
    label: acc.key === 'unassigned' ? '未指定门店' : (nameMap.get(acc.key) ?? acc.key.slice(0, 8)),
  })))
}

/**
 * 按支付渠道维度聚合(真实 payments 实收 + 退款按关联支付渠道归属)
 * 不再使用 invoices.payment_method 单渠道字段
 * @param service service-role 客户端
 * @param f       收入过滤条件
 */
async function buildPaymentChannelDimension(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<RevenueDimensionRow[]> {
  const payByChannel = new Map<string, number>()
  const countByChannel = new Map<string, Set<string>>()
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await service
      .from('payments')
      .select('method, amount, invoice_id, invoices!inner(store_id, status)')
      .eq('tenant_id', f.tenantId)
      .in('invoices.store_id', f.storeIds)
      .in('invoices.status', VALID_INVOICE_STATUSES)
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      throw new Error(`支付渠道维度查询失败: ${error.message}`)
    }
    const rows = (data as Array<{ method: string | null; amount: number; invoice_id: string }> | null) ?? []
    for (const r of rows) {
      const ch = r.method ?? 'other'
      payByChannel.set(ch, (payByChannel.get(ch) ?? 0) + toNum(r.amount))
      const set = countByChannel.get(ch) ?? new Set<string>()
      set.add(r.invoice_id)
      countByChannel.set(ch, set)
    }
    if (rows.length < PAGE_SIZE) {
      break
    }
  }

  // 退款按关联支付渠道归属(payment_id → payments.method),无关联归 other
  const refundByChannel = new Map<string, number>()
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await service
      .from('refunds')
      .select('amount, invoices!inner(store_id), payments!left(method)')
      .eq('tenant_id', f.tenantId)
      .in('invoices.store_id', f.storeIds)
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      throw new Error(`退款渠道归属查询失败: ${error.message}`)
    }
    // 审计 Full12 §11/§13:refunds→invoices / refunds→payments 均为 many-to-one
    // 嵌套关系,PostgREST 对 Embedded Relation 返回对象而非数组;client 泛型仍
    // 按数组推断,经 unknown 桥接修正真实形状。
    const rows = (data as unknown as Array<{ amount: number; invoices?: { store_id: string | null } | null; payments?: { method: string | null } | null }> | null) ?? []
    for (const r of rows) {
      const ch = r.payments?.method ?? 'other'
      refundByChannel.set(ch, (refundByChannel.get(ch) ?? 0) + toNum(r.amount))
    }
    if (rows.length < PAGE_SIZE) {
      break
    }
  }

  const channelKeys = new Set([...payByChannel.keys(), ...refundByChannel.keys()])
  const accs: DimensionAcc[] = [...channelKeys].map((ch) => ({
    key: ch,
    label: CHANNEL_LABELS[ch] ?? ch,
    gross: payByChannel.get(ch) ?? 0,
    refund: refundByChannel.get(ch) ?? 0,
    count: countByChannel.get(ch)?.size ?? 0,
  }))
  return finalizeDimensionRows(accs)
}

/**
 * 按目录类型维度聚合(经 invoice_items.category,去重发票计数)
 * 退款归属:按发票明细金额占比分摊到各目录类型,使维度 Net 合计可与 Overall Net 对账
 * (审计 v2 §15;原实现 refund=0 导致维度合计对不上)。
 * @param service  service-role 客户端
 * @param invoices 有效发票行(用于派生 invoice_id 集合)
 * @param refunds  当期退款行(含发票归属)
 */
async function buildCatalogDimension(
  service: ServiceClient,
  invoices: InvoiceRow[],
  refunds: RefundRow[],
): Promise<RevenueDimensionRow[]> {
  if (invoices.length === 0) {
    return []
  }
  const invoiceIds = invoices.map(i => i.id)
  const grossByCat = new Map<string, number>()
  const invoiceByCat = new Map<string, Set<string>>()
  // 发票 → 明细金额合计(供退款分摊比例)
  const invoiceTotalByItem = new Map<string, Map<string, number>>()
  // 发票 → 明细小计总额(供发票级 discount/tax 按权重分配,审计 Full12 §14 方案 A)
  const invoiceSubtotal = new Map<string, number>()
  // 大 IN 分批(审计 v3 §11 + v4 §4 + v5 §5):invoiceIds 量级可能很大,按 UUID_CHUNK_SIZE 分批
  for (const chunkIds of chunk(invoiceIds, UUID_CHUNK_SIZE)) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await service
        .from('invoice_items')
        .select('invoice_id, category, amount')
        .in('invoice_id', chunkIds)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
      if (error) {
        throw new Error(`目录类型维度查询失败: ${error.message}`)
      }
      const items = (data as Array<{ invoice_id: string; category: string; amount: number }> | null) ?? []
      for (const it of items) {
        grossByCat.set(it.category, (grossByCat.get(it.category) ?? 0) + toNum(it.amount))
        const set = invoiceByCat.get(it.category) ?? new Set<string>()
        set.add(it.invoice_id)
        invoiceByCat.set(it.category, set)
        const byInvoice = invoiceTotalByItem.get(it.invoice_id) ?? new Map<string, number>()
        byInvoice.set(it.category, (byInvoice.get(it.category) ?? 0) + toNum(it.amount))
        invoiceTotalByItem.set(it.invoice_id, byInvoice)
        invoiceSubtotal.set(it.invoice_id, (invoiceSubtotal.get(it.invoice_id) ?? 0) + toNum(it.amount))
      }
      if (items.length < PAGE_SIZE) {
        break
      }
    }
  }
  // 发票级 discount/tax 按各分类小计权重分配(审计 Full12 §14/§15 方案 A):
  // invoice.total = 小计 − discount + tax;diff = total − 小计 即折扣与税的净效果,
  // 按各分类小计占比分摊,使 Catalog Gross 合计与 Overall Gross 对账。
  for (const inv of invoices) {
    const invTotal = toNum(inv.total)
    const sub = invoiceSubtotal.get(inv.id) ?? 0
    const diff = invTotal - sub
    if (diff === 0) {
      continue
    }
    if (sub > 0) {
      const byInvoice = invoiceTotalByItem.get(inv.id) ?? new Map<string, number>()
      for (const [cat, amount] of byInvoice) {
        grossByCat.set(cat, (grossByCat.get(cat) ?? 0) + diff * (amount / sub))
      }
    }
    else if (invTotal !== 0) {
      // 无明细但发票有金额(如纯折扣/手工调整):归"未归因"承载,保证维度合计可对账
      grossByCat.set('unassigned', (grossByCat.get('unassigned') ?? 0) + invTotal)
    }
  }
  // 退款分摊:按退款发票的明细金额占比计入各目录类型;无明细的退款归"未归因"
  const refundByCat = new Map<string, number>()
  let unassignedRefund = 0
  for (const r of refunds) {
    const byInvoice = r.invoice_id ? invoiceTotalByItem.get(r.invoice_id) : undefined
    if (!byInvoice || byInvoice.size === 0) {
      unassignedRefund += r.amount
      continue
    }
    const total = [...byInvoice.values()].reduce((s, v) => s + v, 0)
    if (total <= 0) {
      unassignedRefund += r.amount
      continue
    }
    for (const [cat, amount] of byInvoice) {
      refundByCat.set(cat, (refundByCat.get(cat) ?? 0) + r.amount * (amount / total))
    }
  }
  const rows = new Map<string, DimensionAcc>([...grossByCat.entries()].map(([k, gross]) => [
    k,
    { key: k, label: k === 'unassigned' ? '未归因' : (CATEGORY_LABELS[k] ?? k), gross, refund: refundByCat.get(k) ?? 0, count: invoiceByCat.get(k)?.size ?? 0 },
  ]))
  if (unassignedRefund > 0) {
    const acc = rows.get('unassigned') ?? { key: 'unassigned', label: '未归因', gross: 0, refund: 0, count: 0 }
    acc.refund += unassignedRefund
    rows.set('unassigned', acc)
  }
  return finalizeDimensionRows([...rows.values()])
}

/**
 * 按医生维度聚合(经 encounters.doctor_id 归因)
 * 退款归属:按发票关联 encounter 归到医生,无 encounter 的退款归"未归因",
 * 使维度 Net 合计可与 Overall Net 对账(审计 v2 §15)。
 */
async function buildDoctorDimension(
  service: ServiceClient,
  invoices: InvoiceRow[],
  refunds: RefundRow[],
  f: RevenueFilters,
): Promise<RevenueDimensionRow[]> {
  const byEncounter = new Map<string, number>()
  for (const inv of invoices) {
    if (inv.encounter_id) {
      byEncounter.set(inv.encounter_id, (byEncounter.get(inv.encounter_id) ?? 0) + toNum(inv.total))
    }
  }
  const group = new Map<string, DimensionAcc>()
  const encounterIds = invoices.map(i => i.encounter_id).filter((x): x is string => !!x)
  // 函数级声明:refund 归属需复用 encounter→doctor 映射(审计 v2 §15)
  let encs: Array<{ id: string; doctor_id: string | null }> = []
  if (encounterIds.length > 0) {
    // 大 IN 分批(审计 v3 §11 + v4 §4 + v5 §5):encounterIds 量级可能很大,按 UUID_CHUNK_SIZE 分批
    const encOut: Array<{ id: string; doctor_id: string | null }> = []
    for (const chunkIds of chunk(encounterIds, UUID_CHUNK_SIZE)) {
      const { data } = await service
        .from('encounters')
        .select('id, doctor_id')
        .in('id', chunkIds)
      encOut.push(...((data as Array<{ id: string; doctor_id: string | null }> | null) ?? []))
    }
    encs = encOut
    const doctorIds = [...new Set(encs.map((e: { doctor_id: string | null }) => e.doctor_id).filter(Boolean))] as string[]
    const doctorMap = new Map<string, string>()
    if (doctorIds.length > 0) {
      const empOut: Array<{ user_id: string; name: string | null }> = []
      for (const chunkIds of chunk(doctorIds, UUID_CHUNK_SIZE)) {
        const { data: employees } = await service
          .from('employees')
          .select('user_id, name')
          .eq('tenant_id', f.tenantId)
          .in('user_id', chunkIds)
        empOut.push(...((employees ?? []) as Array<{ user_id: string; name: string | null }>))
      }
      for (const emp of empOut) {
        doctorMap.set(emp.user_id, emp.name ?? emp.user_id.slice(0, 8))
      }
    }
    for (const e of encs) {
      const gross = byEncounter.get(e.id) ?? 0
      const key = e.doctor_id ?? 'unassigned'
      const acc = group.get(key) ?? {
        key,
        label: e.doctor_id ? (doctorMap.get(e.doctor_id) ?? e.doctor_id.slice(0, 8)) : '未分配医生',
        gross: 0,
        refund: 0,
        count: 0,
      }
      acc.gross += gross
      acc.count += 1
      group.set(key, acc)
    }
  }
  // 无 encounter 关联的发票归到"未归因"(审计 Full12 §16:构造移出
  // if (encounterIds.length > 0),避免查询周期内所有发票均无 encounter 时丢失未归因金额)
  const unassignedGross = invoices.filter(i => !i.encounter_id).reduce((s, i) => s + toNum(i.total), 0)
  if (unassignedGross > 0) {
    const acc = group.get('unassigned') ?? { key: 'unassigned', label: '未归因', gross: 0, refund: 0, count: 0 }
    acc.gross += unassignedGross
    acc.count += 1
    group.set('unassigned', acc)
  }
  // 退款归属:经发票 encounter 归到医生
  const refundByDoctor = new Map<string, number>()
  let unassignedRefund = 0
  const invoiceToEncounter = new Map(invoices.map(i => [i.id, i.encounter_id]))
  for (const r of refunds) {
    const encounterId = r.invoice_id ? invoiceToEncounter.get(r.invoice_id) : undefined
    if (!encounterId) {
      unassignedRefund += r.amount
      continue
    }
    // 找该 encounter 的 doctor(经已加载的 encounters 行)
    const doc = encs.find(e => e.id === encounterId)
    const key = doc?.doctor_id ?? 'unassigned'
    refundByDoctor.set(key, (refundByDoctor.get(key) ?? 0) + r.amount)
  }
  for (const [key, refund] of refundByDoctor) {
    const acc = group.get(key) ?? { key, label: key === 'unassigned' ? '未归因' : key.slice(0, 8), gross: 0, refund: 0, count: 0 }
    acc.refund += refund
    group.set(key, acc)
  }
  if (unassignedRefund > 0) {
    const acc = group.get('unassigned') ?? { key: 'unassigned', label: '未归因', gross: 0, refund: 0, count: 0 }
    acc.refund += unassignedRefund
    group.set('unassigned', acc)
  }
  return finalizeDimensionRows([...group.values()])
}

/** 按维度构建明细行 */
async function buildDimensionRows(
  service: ServiceClient,
  invoices: InvoiceRow[],
  refunds: RefundRow[],
  dimension: RevenueDimension,
  f: RevenueFilters,
): Promise<RevenueDimensionRow[]> {
  if (dimension === 'store') {
    return buildStoreDimension(service, invoices, refunds, f)
  }
  if (dimension === 'payment_channel') {
    return buildPaymentChannelDimension(service, f)
  }
  if (dimension === 'catalog_type') {
    return buildCatalogDimension(service, invoices, refunds)
  }
  return buildDoctorDimension(service, invoices, refunds, f)
}

/**
 * 汇总维度行:net = gross - refund,share 按净额合计计算
 * @param accs 已含 gross/refund/count 的中间累计
 */
function finalizeDimensionRows(accs: DimensionAcc[]): RevenueDimensionRow[] {
  const totalNet = accs.reduce((s, a) => s + (a.gross - a.refund), 0)
  return accs
    .map((a) => {
      const net = a.gross - a.refund
      return {
        key: a.key,
        label: a.label,
        gross: a.gross,
        refund: a.refund,
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
  const [summary, invoices, refunds] = await Promise.all([
    computeRevenueSummary(service, f),
    fetchValidInvoices(service, f),
    fetchRefunds(service, f),
  ])
  const gross = summary.gross
  const refund = summary.refund
  const net = summary.net
  const invoiceCount = summary.invoiceCount

  const trend = buildTrendFromRows(invoices, refunds, opts.groupBy, f.period.timezone)
  const dimensionRows = await buildDimensionRows(service, invoices, refunds, opts.dimension, f)

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
