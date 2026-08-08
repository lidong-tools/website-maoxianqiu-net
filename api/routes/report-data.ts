import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import { loadContext, resolveRequestedTenant } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * 报表数据查询路由(P0-06 统一报表真源)
 *
 * GET /api/operations/report-data/:reportCode?tenantId=&periodStart=&periodEnd=&storeId=
 *
 * 设计原则:
 *   - 唯一真源:Hono Query → 服务端聚合 → 类型化 ReportDataPayload → Vue 渲染
 *   - 浏览器不再直接跨表 JOIN 聚合(前端只需渲染服务端返回的 rows)
 *   - 租户强制过滤:scope.tenantId 由 requireScopedPermission 解析,客户端不能自由指定
 *   - 时间范围受限:单次查询最多 366 天,防止大数据一次性拉取
 *   - 支持的报表类别:revenue / refund / inventory / customer / medical
 *   - 报表快照仍由 generate_report_snapshot RPC 生成;本接口提供实时明细
 */
const reportDataRoutes = new Hono<AppEnv>()

reportDataRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/** 报表数据行(动态列,兼容前端动态表格渲染) */
type ReportRow = Record<string, unknown>

/** 报表数据 DTO(P0-06) */
interface ReportDataPayload {
  category: string
  reportCode: string
  period: { start: string, end: string }
  rows: ReportRow[]
}

/** 最大查询区间(天) */
const MAX_PERIOD_DAYS = 366

/** 数值归一化(兼容 numeric 字符串) */
function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0) || 0
}

/** 格式化日期为 YYYY-MM-DD(取本地时区) */
function toDateStr(v: string): string {
  return v?.slice(0, 10) ?? '-'
}

/**
 * 解析时间范围:默认本月,单次查询不超过 MAX_PERIOD_DAYS
 * @param start 起始日期(YYYY-MM-DD)
 * @param end 结束日期(YYYY-MM-DD)
 * @returns { startISO, endISO } ISO 时间字符串
 */
function resolvePeriod(start?: string, end?: string): { start: string, end: string } {
  const now = new Date()
  const s = start
    ? new Date(start)
    : new Date(now.getFullYear(), now.getMonth(), 1)
  const e = end
    ? new Date(`${end}T23:59:59`)
    : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

  const dayDiff = Math.round((e.getTime() - s.getTime()) / 86_400_000)
  if (dayDiff > MAX_PERIOD_DAYS) {
    throw err.badRequest(`单次查询时间范围不可超过 ${MAX_PERIOD_DAYS} 天`)
  }
  return { start: s.toISOString(), end: e.toISOString() }
}

/**
 * 按报表 code 推断类别(与 generate_report_snapshot RPC 的关键词推断保持一致)
 * @param code 报表编码
 * @returns 报表类别
 */
function inferCategory(code: string): string {
  if (/revenue|income|收入/i.test(code)) {
    return 'revenue'
  }
  if (/refund|退款/i.test(code)) {
    return 'refund'
  }
  if (/inventory|stock|库存/i.test(code)) {
    return 'inventory'
  }
  if (/customer|member|客户/i.test(code)) {
    return 'customer'
  }
  if (/medical|clinical|医疗/i.test(code)) {
    return 'medical'
  }
  return 'customer'
}

/**
 * 解析报表类别:优先取 report_definitions 定义,缺失时按 code 关键词推断
 * @param service supabase service client
 * @param tenantId 租户 id
 * @param code 报表编码
 * @returns 报表类别
 */
async function resolveCategory(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  code: string,
): Promise<string> {
  const { data } = await service
    .from('report_definitions')
    .select('category')
    .eq('tenant_id', tenantId)
    .eq('code', code)
    .maybeSingle()
  return (data?.category as string | undefined) ?? inferCategory(code)
}

/**
 * 报表查询上下文(P0-06 数据范围)
 * allowedStoreIds 由 requireScopedPermission 解析的 scope 提供,
 * 所有 builder 必须在查询层强制 store_id ∈ allowedStoreIds,不得只过滤 tenant。
 */
interface ReportQuery {
  tenantId: string
  allowedStoreIds: string[]
  start: string
  end: string
}

/**
 * 收入报表:按日期+门店分组汇总(排除草稿/已取消,含合计行)
 * @param service supabase service client
 * @param query 报表查询上下文(含允许门店集合)
 * @returns 明细行(含合计)
 */
async function buildRevenueRows(
  service: ReturnType<typeof createServiceClient>,
  query: ReportQuery,
): Promise<ReportRow[]> {
  const { data, error } = await service
    .from('invoices')
    .select('id, store_id, total, paid_amount, status, created_at')
    .eq('tenant_id', query.tenantId)
    .in('store_id', query.allowedStoreIds)
    .gte('created_at', query.start)
    .lte('created_at', query.end)
  if (error) {
    throw err.internal(`收入报表查询失败: ${error.message}`)
  }

  // 门店名称映射
  const storeIds = [...new Set((data ?? []).map(inv => inv.store_id).filter(Boolean))] as string[]
  const storeMap = new Map<string, string>()
  if (storeIds.length > 0) {
    const { data: stores } = await service
      .from('stores')
      .select('id, name')
      .in('id', storeIds)
    for (const s of (stores ?? [])) {
      storeMap.set(s.id, s.name ?? s.id)
    }
  }

  // 按 日期+门店 分组(排除草稿与已取消)
  const groups = new Map<string, { 日期: string, 门店: string, 发票数: number, 开票金额: number, 已收金额: number }>()
  for (const inv of (data ?? [])) {
    if (inv.status === 'draft' || inv.status === 'cancelled') {
      continue
    }
    const date = toDateStr(inv.created_at)
    const storeName = inv.store_id ? (storeMap.get(inv.store_id) ?? inv.store_id.slice(0, 8)) : '未指定'
    const k = `${date}||${inv.store_id ?? '__none__'}`
    const existing = groups.get(k)
    if (existing) {
      existing.发票数 += 1
      existing.开票金额 += toNum(inv.total)
      existing.已收金额 += toNum(inv.paid_amount)
    }
    else {
      groups.set(k, { 日期: date, 门店: storeName, 发票数: 1, 开票金额: toNum(inv.total), 已收金额: toNum(inv.paid_amount) })
    }
  }

  const rows: ReportRow[] = Array.from(groups.values())
    .sort((a, b) => a.日期.localeCompare(b.日期) || a.门店.localeCompare(b.门店))
    .map(r => ({ ...r, 应收余额: r.开票金额 - r.已收金额 }))

  if (rows.length > 0) {
    const totalCount = rows.reduce((s, r) => s + (r.发票数 as number), 0)
    const totalAmount = rows.reduce((s, r) => s + (r.开票金额 as number), 0)
    const totalPaid = rows.reduce((s, r) => s + (r.已收金额 as number), 0)
    rows.push({
      日期: '合计',
      门店: '',
      发票数: totalCount,
      开票金额: totalAmount,
      已收金额: totalPaid,
      应收余额: totalAmount - totalPaid,
      __isSummary: true,
    })
  }
  return rows
}

/**
 * 退款报表:按日期分组汇总 refunds 表(含合计行)
 * refunds 无 store_id 字段,通过 invoices 的 store_id 收敛数据范围(审计 5.2)
 * @param service supabase service client
 * @param query 报表查询上下文(含允许门店集合)
 * @returns 明细行(含合计)
 */
async function buildRefundRows(
  service: ReturnType<typeof createServiceClient>,
  query: ReportQuery,
): Promise<ReportRow[]> {
  // 先按允许门店收敛 invoice id 集合
  const { data: invData, error: invError } = await service
    .from('invoices')
    .select('id')
    .eq('tenant_id', query.tenantId)
    .in('store_id', query.allowedStoreIds)
    .gte('created_at', query.start)
    .lte('created_at', query.end)
  if (invError) {
    throw err.internal(`退款报表查询失败: ${invError.message}`)
  }
  const invoiceIds = ((invData as { id: string }[] | null) ?? []).map(i => i.id)

  let data: Array<{ amount: unknown, reason: string | null, created_at: string }> | null = []
  if (invoiceIds.length > 0) {
    const { data: refunds, error } = await service
      .from('refunds')
      .select('amount, reason, created_at')
      .eq('tenant_id', query.tenantId)
      .in('invoice_id', invoiceIds)
      .gte('created_at', query.start)
      .lte('created_at', query.end)
    if (error) {
      throw err.internal(`退款报表查询失败: ${error.message}`)
    }
    data = refunds
  }

  const dailyMap = new Map<string, { 日期: string, 退款笔数: number, 退款总额: number, reasons: Set<string> }>()
  for (const r of (data ?? [])) {
    const date = toDateStr(r.created_at)
    const existing = dailyMap.get(date)
    if (existing) {
      existing.退款笔数 += 1
      existing.退款总额 += toNum(r.amount)
      if (r.reason) {
        existing.reasons.add(r.reason)
      }
    }
    else {
      dailyMap.set(date, { 日期: date, 退款笔数: 1, 退款总额: toNum(r.amount), reasons: r.reason ? new Set([r.reason]) : new Set() })
    }
  }

  const rows: ReportRow[] = Array.from(dailyMap.values())
    .sort((a, b) => a.日期.localeCompare(b.日期))
    .map(r => ({
      日期: r.日期,
      退款笔数: r.退款笔数,
      退款总额: r.退款总额,
      退款原因分类: r.reasons.size > 0 ? [...r.reasons].slice(0, 3).join('; ') : '-',
    }))

  if (rows.length > 0) {
    const totalCount = rows.reduce((s, r) => s + (r.退款笔数 as number), 0)
    const totalAmount = rows.reduce((s, r) => s + (r.退款总额 as number), 0)
    rows.push({ 日期: '合计', 退款笔数: totalCount, 退款总额: totalAmount, 退款原因分类: '', __isSummary: true })
  }
  return rows
}

/**
 * 库存报表:库存余额 × 目录项 × 仓库(含合计行)
 * inventory_balances 无 store_id,通过 warehouses.store_id 收敛数据范围(审计 5.2)
 * @param service supabase service client
 * @param query 报表查询上下文(含允许门店集合)
 * @returns 明细行(含合计)
 */
async function buildInventoryRows(
  service: ReturnType<typeof createServiceClient>,
  query: ReportQuery,
): Promise<ReportRow[]> {
  // 1) 按允许门店收敛仓库 id 集合
  const { data: whData, error: whError } = await service
    .from('warehouses')
    .select('id, name, code')
    .eq('tenant_id', query.tenantId)
    .in('store_id', query.allowedStoreIds)
  if (whError) {
    throw err.internal(`仓库查询失败: ${whError.message}`)
  }
  const warehouseIds = ((whData as Array<{ id: string }> | null) ?? []).map(w => w.id)

  // 2) 余额/目录/仓库查询(空仓库集合直接返回空报表)
  const [balRes, catRes] = await Promise.all([
    warehouseIds.length > 0
      ? service.from('inventory_balances').select('*').eq('tenant_id', query.tenantId).in('warehouse_id', warehouseIds)
      : Promise.resolve({ data: [], error: null }),
    service.from('catalog_items').select('id, code, name, description, unit, cost_price').eq('tenant_id', query.tenantId),
  ])

  if (balRes.error) {
    throw err.internal(`库存余额查询失败: ${balRes.error.message}`)
  }
  if (catRes.error) {
    throw err.internal(`目录项查询失败: ${catRes.error.message}`)
  }

  const catalogMap = new Map<string, { code: string, name: string, description: string | null, unit: string | null, cost_price: number }>()
  for (const c of (catRes.data ?? [])) {
    catalogMap.set(c.id, { code: c.code, name: c.name, description: c.description, unit: c.unit, cost_price: toNum(c.cost_price) })
  }
  const warehouseMap = new Map<string, string>()
  for (const w of (whData ?? [])) {
    warehouseMap.set(w.id, w.name ?? w.code ?? w.id.slice(0, 8))
  }

  const rows: ReportRow[] = (balRes.data ?? []).map((bal) => {
    const cat = catalogMap.get(bal.catalog_item_id)
    const onHand = toNum(bal.quantity_on_hand)
    const reserved = toNum(bal.quantity_reserved)
    const costPrice = cat?.cost_price ?? 0
    return {
      仓库: bal.warehouse_id ? (warehouseMap.get(bal.warehouse_id) ?? bal.warehouse_id.slice(0, 8)) : '未知',
      商品编码: cat?.code ?? '-',
      名称: cat?.name ?? '-',
      规格: cat?.description ?? '-',
      单位: cat?.unit ?? '-',
      当前库存: onHand,
      预留数量: reserved,
      可用数量: onHand - reserved,
      成本单价: costPrice,
      总成本价: onHand * costPrice,
    }
  })

  rows.sort((a, b) => String(a.仓库).localeCompare(String(b.仓库)) || String(a.商品编码).localeCompare(String(b.商品编码)))

  if (rows.length > 0) {
    const totalOnHand = rows.reduce((s, r) => s + (r.当前库存 as number), 0)
    const totalReserved = rows.reduce((s, r) => s + (r.预留数量 as number), 0)
    const totalCost = rows.reduce((s, r) => s + (r.总成本价 as number), 0)
    rows.push({
      仓库: '',
      商品编码: '',
      名称: '合计',
      规格: '',
      单位: '',
      当前库存: totalOnHand,
      预留数量: totalReserved,
      可用数量: totalOnHand - totalReserved,
      成本单价: 0,
      总成本价: totalCost,
      __isSummary: true,
    })
  }
  return rows
}

/**
 * 客户报表:客户总量/新增/活跃/分级/欠款/有宠物(汇总行)
 * @param service supabase service client
 * @param query 报表查询上下文(含允许门店集合)
 * @returns 汇总明细行
 */
async function buildCustomerRows(
  service: ReturnType<typeof createServiceClient>,
  query: ReportQuery,
): Promise<ReportRow[]> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [custRes, encRes] = await Promise.all([
    service.from('customers').select('id, member_level, balance, status, created_at').eq('tenant_id', query.tenantId).in('store_id', query.allowedStoreIds),
    service.from('encounters').select('customer_id').eq('tenant_id', query.tenantId).in('store_id', query.allowedStoreIds).gte('created_at', thirtyDaysAgo),
  ])
  if (custRes.error) {
    throw err.internal(`客户报表查询失败: ${custRes.error.message}`)
  }
  if (encRes.error) {
    throw err.internal(`就诊记录查询失败: ${encRes.error.message}`)
  }

  const activeCustomers = (custRes.data ?? []).filter(c => c.status === 'active')
  const totalCustomers = activeCustomers.length
  const newThisMonth = activeCustomers.filter(c => c.created_at && c.created_at >= monthStart).length
  const activeEncounterIds = new Set((encRes.data ?? []).map(e => e.customer_id))
  const active30d = activeCustomers.filter(c => activeEncounterIds.has(c.id)).length

  const levelCounts: Record<string, number> = { normal: 0, silver: 0, gold: 0, diamond: 0 }
  for (const c of activeCustomers) {
    const lv = c.member_level ?? 'normal'
    levelCounts[lv] = (levelCounts[lv] ?? 0) + 1
  }
  const unpaidCount = activeCustomers.filter(c => toNum(c.balance) > 0).length

  // 有宠物客户数
  let petOwnerCount = 0
  const custIds = activeCustomers.map(c => c.id)
  if (custIds.length > 0) {
    const { data: pets, error: petErr } = await service
      .from('pets')
      .select('customer_id')
      .eq('tenant_id', query.tenantId)
      .in('customer_id', custIds)
    if (!petErr) {
      petOwnerCount = new Set((pets ?? []).map(p => p.customer_id)).size
    }
  }

  return [
    { 统计项: '总客户数', 数值: totalCustomers },
    { 统计项: '本月新增', 数值: newThisMonth },
    { 统计项: '活跃客户(近30天就诊)', 数值: active30d },
    { 统计项: 'VIP银卡客户', 数值: levelCounts.silver ?? 0 },
    { 统计项: 'VIP金卡客户', 数值: levelCounts.gold ?? 0 },
    { 统计项: 'VIP钻石卡客户', 数值: levelCounts.diamond ?? 0 },
    { 统计项: '普通客户', 数值: levelCounts.normal ?? 0 },
    { 统计项: '欠款客户(balance>0)', 数值: unpaidCount },
    { 统计项: '有宠物客户', 数值: petOwnerCount },
  ]
}

/**
 * 医疗工作量报表:按日期+医生分组(就诊/处方/检验/疫苗,含合计行)
 * @param service supabase service client
 * @param query 报表查询上下文(含允许门店集合)
 * @returns 明细行(含合计)
 */
async function buildMedicalRows(
  service: ReturnType<typeof createServiceClient>,
  query: ReportQuery,
): Promise<ReportRow[]> {
  const { data: encounters, error: encErr } = await service
    .from('encounters')
    .select('id, doctor_id, created_at')
    .eq('tenant_id', query.tenantId)
    .in('store_id', query.allowedStoreIds)
    .gte('created_at', query.start)
    .lte('created_at', query.end)
  if (encErr) {
    throw err.internal(`医疗报表查询失败: ${encErr.message}`)
  }
  if (!encounters || encounters.length === 0) {
    return []
  }

  const encIds = encounters.map(e => e.id)

  // 医生名称映射(优先 employees.name,回退 profiles.display_name)
  const doctorIds = [...new Set(encounters.map(e => e.doctor_id).filter(Boolean))] as string[]
  const doctorMap = new Map<string, string>()
  if (doctorIds.length > 0) {
    const { data: employees } = await service
      .from('employees')
      .select('user_id, name')
      .eq('tenant_id', query.tenantId)
      .in('user_id', doctorIds)
    for (const emp of (employees ?? [])) {
      doctorMap.set(emp.user_id, emp.name ?? emp.user_id.slice(0, 8))
    }
    const missing = doctorIds.filter(id => !doctorMap.has(id))
    if (missing.length > 0) {
      const { data: profiles } = await service
        .from('profiles')
        .select('id, display_name')
        .in('id', missing)
      for (const p of (profiles ?? [])) {
        doctorMap.set(p.id, p.display_name ?? p.id.slice(0, 8))
      }
    }
  }

  // 关联处方/检验/疫苗数量
  const [presRes, labRes, vaccRes] = await Promise.all([
    service.from('prescriptions').select('id, encounter_id').in('encounter_id', encIds),
    service.from('lab_orders').select('id, encounter_id').in('encounter_id', encIds),
    service.from('vaccinations').select('id, encounter_id').in('encounter_id', encIds),
  ])

  const countMap = (rows: Array<{ encounter_id: string }>) => {
    const map = new Map<string, number>()
    for (const r of rows) {
      map.set(r.encounter_id, (map.get(r.encounter_id) ?? 0) + 1)
    }
    return map
  }
  const presCountMap = countMap(presRes.data ?? [])
  const labCountMap = countMap(labRes.data ?? [])
  const vaccCountMap = countMap(vaccRes.data ?? [])

  // 按 日期+医生 分组
  const groups = new Map<string, { 日期: string, 医生: string, 就诊数: number, 处方数: number, 检验数: number, 疫苗数: number }>()
  for (const enc of encounters) {
    const date = toDateStr(enc.created_at)
    const doctor = enc.doctor_id ? (doctorMap.get(enc.doctor_id) ?? enc.doctor_id.slice(0, 8)) : '未分配'
    const k = `${date}||${enc.doctor_id ?? '__none__'}`
    const existing = groups.get(k)
    if (existing) {
      existing.就诊数 += 1
      existing.处方数 += presCountMap.get(enc.id) ?? 0
      existing.检验数 += labCountMap.get(enc.id) ?? 0
      existing.疫苗数 += vaccCountMap.get(enc.id) ?? 0
    }
    else {
      groups.set(k, {
        日期: date,
        医生: doctor,
        就诊数: 1,
        处方数: presCountMap.get(enc.id) ?? 0,
        检验数: labCountMap.get(enc.id) ?? 0,
        疫苗数: vaccCountMap.get(enc.id) ?? 0,
      })
    }
  }

  const rows: ReportRow[] = Array.from(groups.values())
    .sort((a, b) => a.日期.localeCompare(b.日期) || a.医生.localeCompare(b.医生))
    .map((r, idx) => ({ 排名: idx + 1, ...r }))

  if (rows.length > 0) {
    const totalEnc = rows.reduce((s, r) => s + (r.就诊数 as number), 0)
    const totalPres = rows.reduce((s, r) => s + (r.处方数 as number), 0)
    const totalLab = rows.reduce((s, r) => s + (r.检验数 as number), 0)
    const totalVacc = rows.reduce((s, r) => s + (r.疫苗数 as number), 0)
    rows.push({ 排名: 0, 日期: '', 医生: '合计', 就诊数: totalEnc, 处方数: totalPres, 检验数: totalLab, 疫苗数: totalVacc, __isSummary: true })
  }
  return rows
}

/**
 * 查询报表实时数据(P0-06)
 * GET /api/operations/report-data/:reportCode
 * - 权限:reports.view(scoped,tenant 强制过滤)
 * - 行为:服务端聚合业务表返回标准 DTO,前端只负责渲染
 */
reportDataRoutes.get('/:reportCode', async (c) => {
  const reportCode = c.req.param('reportCode')
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  const periodStart = c.req.query('periodStart')
  const periodEnd = c.req.query('periodEnd')

  // 租户归属校验:tenantId 缺失时回退调用者首个成员关系
  // dataScope 模式:允许门店级角色查看其被授权门店的报表数据(审计 5.2)
  const scope = await requireScopedPermission(c, {
    code: 'reports.view',
    tenantId: resolveRequestedTenant(c, tenantId) ?? '',
    storeId: storeId ?? undefined,
    dataScope: true,
  })

  const period = resolvePeriod(periodStart, periodEnd)
  const service = createServiceClient()
  const category = await resolveCategory(service, scope.tenantId, reportCode)

  // 数据范围:显式传 storeId 时只查询该门店,避免跨门店数据泄漏(审计 5.2)
  const allowedStoreIds = storeId
    ? scope.allowedStoreIds.filter(id => id === storeId)
    : scope.allowedStoreIds

  const query: ReportQuery = {
    tenantId: scope.tenantId,
    allowedStoreIds,
    start: period.start,
    end: period.end,
  }

  let rows: ReportRow[]
  switch (category) {
    case 'revenue':
      rows = await buildRevenueRows(service, query)
      break
    case 'refund':
      rows = await buildRefundRows(service, query)
      break
    case 'inventory':
      rows = await buildInventoryRows(service, query)
      break
    case 'customer':
      rows = await buildCustomerRows(service, query)
      break
    case 'medical':
      rows = await buildMedicalRows(service, query)
      break
    default:
      rows = []
  }

  const payload: ReportDataPayload = {
    category,
    reportCode,
    period: { start: period.start.slice(0, 10), end: period.end.slice(0, 10) },
    rows,
  }
  return ok(c, payload)
})

export default reportDataRoutes
