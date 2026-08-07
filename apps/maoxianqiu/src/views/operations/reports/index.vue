<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { ReportCategory } from '@/types/operations'
import apiOperations from '@/api/modules/operations'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { REPORT_CATEGORY_LABELS } from '@/types/operations'

defineOptions({
  name: 'OperationsReports',
})

interface ReportDefRow {
  id: string
  code: string
  name: string
  category: ReportCategory
  is_active: boolean
  created_at: string
}

interface SnapshotRow {
  id: string
  report_id: string
  period_start: string
  period_end: string
  generated_by: string | null
  created_at: string
  /** 关联报表定义的分类（查询时填充） */
  report_category?: ReportCategory
  report_name?: string
}

/** 快照详情弹窗中的表格行 */
interface DetailRow {
  [key: string]: unknown
  /** 内部标记:是否为合计行 */
  __isSummary?: boolean
}

const tenantStore = useAppTenantStore()
const tabActive = ref<'definitions' | 'snapshots'>('definitions')

const defLoading = ref(false)
const defList = ref<ReportDefRow[]>([])
const snapshotLoading = ref(false)
const snapshotList = ref<SnapshotRow[]>([])
const selectedReportId = ref('')

const filters = ref({
  category: '' as '' | ReportCategory,
  periodStart: '',
  periodEnd: '',
})

// ===== 快照详情弹窗 =====
const snapshotDetailVisible = ref(false)
const snapshotDetailLoading = ref(false)
const snapshotDetailTitle = ref('')
const snapshotDetailData = ref<DetailRow[]>([])
const snapshotDetailColumns = ref<TableColumn<DetailRow>[]>([])

// ===== 实时报表生成弹窗 =====
const reportDataVisible = ref(false)
const reportDataLoading = ref(false)
const reportDataTitle = ref('')
const reportDataList = ref<DetailRow[]>([])
const reportDataColumns = ref<TableColumn<DetailRow>[]>([])
/** 当前正在查看的报表定义行（用于导出） */
const currentReportDefRow = ref<ReportDefRow | null>(null)

/**
 * 拉取报表定义列表
 */
function loadDefinitions() {
  if (!tenantStore.currentTenantId) {
    defList.value = []
    return
  }
  defLoading.value = true
  apiOperations.listReports({
    tenantId: tenantStore.currentTenantId,
    category: filters.value.category || undefined,
    onlyActive: true,
  }).then((res: any) => {
    defLoading.value = false
    defList.value = (res.data.list ?? []) as ReportDefRow[]
  }).catch(() => {
    defLoading.value = false
  })
}

/**
 * 拉取报表快照列表
 */
function loadSnapshots() {
  if (!tenantStore.currentTenantId) {
    snapshotList.value = []
    return
  }
  snapshotLoading.value = true
  apiOperations.listReportSnapshots({
    tenantId: tenantStore.currentTenantId,
    reportId: selectedReportId.value || undefined,
  }).then((res: any) => {
    snapshotLoading.value = false
    snapshotList.value = (res.data.list ?? []) as SnapshotRow[]
  }).catch(() => {
    snapshotLoading.value = false
  })
}

onMounted(() => {
  loadDefinitions()
  loadSnapshots()
})

function onSearchDefs() {
  loadDefinitions()
}

function onSearchSnapshots() {
  loadSnapshots()
}

function onResetDefs() {
  filters.value.category = ''
  loadDefinitions()
}

function onResetSnapshots() {
  selectedReportId.value = ''
  filters.value.periodStart = ''
  filters.value.periodEnd = ''
  loadSnapshots()
}

/**
 * 触发生成报表快照(MXQ-12008)
 * 走 Hono Command + generate_report_snapshot RPC
 */
function onGenerate(row: ReportDefRow) {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  // 默认按本月生成
  const now = new Date()
  const periodStart = filters.value.periodStart || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  const periodEnd = filters.value.periodEnd || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10)

  apiOperations.generateReport({
    tenantId: tenantStore.currentTenantId,
    reportCode: row.code,
    periodStart,
    periodEnd,
  }).then(() => {
    useFaToast().success(`报表「${row.name}」生成成功`)
    loadSnapshots()
  }).catch(() => {
    // 错误由 axios 拦截器统一处理
  })
}

// ============================================================
// 快照详情
// ============================================================

/**
 * 根据 JSON 数据生成表格列定义
 * 忽略 __isSummary 等内部标记字段,数值列右对齐
 * @param data 数据行数组(可能含合计行)
 * @returns 动态列定义
 */
function buildColumnsFromData(data: DetailRow[]): TableColumn<DetailRow>[] {
  if (!data || data.length === 0) {
    return []
  }

  // 取第一个非合计行解析列
  const firstRow = data.find(r => !r.__isSummary) ?? data[0]
  return Object.keys(firstRow)
    .filter(key => !key.startsWith('__'))
    .map((key) => {
      const value = firstRow[key]
      const isNumber = typeof value === 'number'
      return {
        accessorKey: key,
        header: key,
        align: isNumber ? ('right' as const) : ('left' as const),
        cell: (info) => {
          const row = info.row.original as DetailRow
          const v = info.getValue()
          if (v === null || v === undefined) {
            return '-'
          }
          if (typeof v === 'number') {
            const formatted = /amount|price|total|fee|cost|revenue|balance|value/i.test(key)
              ? v.toFixed(2)
              : String(v)
            return row.__isSummary ? `<strong>${formatted}</strong>` : formatted
          }
          if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
            return row.__isSummary ? `<strong>${v.slice(0, 10)}</strong>` : v.slice(0, 10)
          }
          return row.__isSummary ? `<strong>${String(v)}</strong>` : String(v)
        },
      }
    })
}

/**
 * 打开快照详情弹窗
 * 从 report_snapshots 表拉取 data(jsonb) 并解析展示
 * @param row 快照行数据
 */
async function openSnapshotDetail(row: SnapshotRow) {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }

  snapshotDetailVisible.value = true
  snapshotDetailLoading.value = true
  snapshotDetailTitle.value = `快照详情（${row.period_start} ~ ${row.period_end}）`
  snapshotDetailData.value = []
  snapshotDetailColumns.value = []

  try {
    // 查询快照数据（含 jsonb data 字段）
    const { data: snapData, error: snapErr } = await supabase
      .from('report_snapshots')
      .select('data, report_id')
      .eq('id', row.id)
      .single()

    if (snapErr) {
      throw new Error(snapErr.message)
    }

    const rawData = (snapData?.data ?? {}) as Record<string, unknown>

    // 如果 data 中有 rows 数组则直接使用，否则尝试将整个 data 展开为表格
    let rows: DetailRow[] = []
    if (Array.isArray(rawData.rows)) {
      rows = rawData.rows as DetailRow[]
    }
    else if (Array.isArray(rawData)) {
      rows = rawData as unknown as DetailRow[]
    }
    else {
      // 将对象的 key 列表展为单行
      const flatRow: DetailRow = {}
      for (const [k, v] of Object.entries(rawData)) {
        flatRow[k] = v
      }
      rows = [flatRow]
    }

    snapshotDetailData.value = rows
    snapshotDetailColumns.value = buildColumnsFromData(rows)
  }
  catch (err: unknown) {
    useFaToast().error(err?.message || '加载快照详情失败')
    snapshotDetailData.value = []
    snapshotDetailColumns.value = []
  }
  finally {
    snapshotDetailLoading.value = false
  }
}

// ============================================================
// 实时报表生成
// ============================================================

/**
 * 实时生成报表数据
 * 根据报表定义类型从对应的业务表聚合数据,所有类型均返回真实数据
 * @param row 报表定义行
 */
async function generateReportData(row: ReportDefRow) {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }

  currentReportDefRow.value = row
  reportDataVisible.value = true
  reportDataLoading.value = true
  reportDataTitle.value = `${REPORT_CATEGORY_LABELS[row.category]}报表 - ${row.name}`
  reportDataList.value = []
  reportDataColumns.value = []

  try {
    const tenantId = tenantStore.currentTenantId
    let rows: DetailRow[] = []

    switch (row.category) {
      case 'revenue':
        rows = await fetchRevenueReport(tenantId)
        break
      case 'refund':
        rows = await fetchRefundReport(tenantId)
        break
      case 'inventory':
        rows = await fetchInventoryReport(tenantId)
        break
      case 'customer':
        rows = await fetchCustomerReport(tenantId)
        break
      case 'medical':
        rows = await fetchMedicalReport(tenantId)
        break
      default:
        rows = []
    }

    reportDataList.value = rows
    reportDataColumns.value = buildColumnsFromData(rows)
  }
  catch (err: unknown) {
    useFaToast().error(err?.message || '生成报表数据失败')
    reportDataList.value = []
    reportDataColumns.value = []
  }
  finally {
    reportDataLoading.value = false
  }
}

/**
 * 获取查询时间范围(本月默认)
 * @returns { start: ISO string, end: ISO string }
 */
function getDateRange(): { start: string, end: string } {
  const start = filters.value.periodStart
    ? new Date(filters.value.periodStart).toISOString()
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
  const end = filters.value.periodEnd
    ? new Date(`${filters.value.periodEnd}T23:59:59`).toISOString()
    : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59).toISOString()
  return { start, end }
}

// ============================================================
// 收入报表(revenue): 按日期+门店分组汇总
// ============================================================

/**
 * 拉取收入报表(从 invoices 表按日期+门店汇总)
 * 列: 日期 / 门店 / 发票数 / 开票金额 / 已收金额 / 应收余额
 * 含合计行
 * @param tenantId 租户 id
 */
async function fetchRevenueReport(tenantId: string): Promise<DetailRow[]> {
  const { start, end } = getDateRange()

  const { data, error } = await supabase
    .from('invoices')
    .select('id, store_id, total, paid_amount, status, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  // 查询门店名称映射
  const storeIds = [...new Set((data ?? []).map(inv => inv.store_id).filter(Boolean))]
  const storeMap = new Map<string, string>()
  if (storeIds.length > 0) {
    const { data: stores } = await supabase
      .from('stores')
      .select('id, name')
      .in('id', storeIds)
    for (const s of (stores ?? [])) {
      storeMap.set(s.id, s.name ?? s.id)
    }
  }

  // 按 日期+门店 分组
  const key = (date: string, storeId: string | null) => `${date}||${storeId ?? '__none__'}`
  const groups = new Map<string, { date: string, store_name: string, invoice_count: number, total_amount: number, paid_amount: number }>()
  for (const inv of (data ?? [])) {
    // 排除草稿和已取消
    if (inv.status === 'draft' || inv.status === 'cancelled') {
      continue
    }
    const date = inv.created_at?.slice(0, 10) ?? '-'
    const storeName = storeMap.get(inv.store_id) ?? (inv.store_id ? inv.store_id.slice(0, 8) : '未指定')
    const k = key(date, inv.store_id)
    const existing = groups.get(k)
    if (existing) {
      existing.invoice_count += 1
      existing.total_amount += Number(inv.total ?? 0)
      existing.paid_amount += Number(inv.paid_amount ?? 0)
    }
    else {
      groups.set(k, {
        date,
        store_name: storeName,
        invoice_count: 1,
        total_amount: Number(inv.total ?? 0),
        paid_amount: Number(inv.paid_amount ?? 0),
      })
    }
  }

  const rows = Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date) || a.store_name.localeCompare(b.store_name))

  // 添加余额列
  const detailRows = rows.map(r => ({
    日期: r.date,
    门店: r.store_name,
    发票数: r.invoice_count,
    开票金额: r.total_amount,
    已收金额: r.paid_amount,
    应收余额: r.total_amount - r.paid_amount,
  }))

  // 合计行
  const totalCount = detailRows.reduce((s, r) => s + r.发票数, 0)
  const totalAmount = detailRows.reduce((s, r) => s + r.开票金额, 0)
  const totalPaid = detailRows.reduce((s, r) => s + r.已收金额, 0)
  detailRows.push({
    日期: '合计',
    门店: '',
    发票数: totalCount,
    开票金额: totalAmount,
    已收金额: totalPaid,
    应收余额: totalAmount - totalPaid,
    __isSummary: true,
  })

  return detailRows
}

// ============================================================
// 退款报表(refund): 新增,查询 refunds 表+invoices refunded 状态
// ============================================================

/**
 * 拉取退款报表(从 refunds 表和 invoices refunded 状态合并)
 * 列: 日期 / 退款笔数 / 退款总额 / 退款原因
 * 含合计行
 * @param tenantId 租户 id
 */
async function fetchRefundReport(tenantId: string): Promise<DetailRow[]> {
  const { start, end } = getDateRange()

  // 方案1: 优先从 refunds 表查询
  const { data: refunds, error: refundErr } = await supabase
    .from('refunds')
    .select('id, amount, reason, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: false })

  if (refundErr) {
    throw new Error(refundErr.message)
  }

  // 方案2: 从 invoices 中筛选 status='refunded' 的记录作为补充
  const { data: refundedInvs, error: invErr } = await supabase
    .from('invoices')
    .select('id, total, paid_amount, updated_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'refunded')
    .gte('updated_at', start)
    .lte('updated_at', end)
    .order('updated_at', { ascending: false })

  if (invErr) {
    throw new Error(invErr.message)
  }

  // 按日期分组汇总
  const dailyMap = new Map<string, { date: string, refund_count: number, refund_amount: number, reasons: string[] }>()

  // 处理 refunds 表数据
  for (const r of (refunds ?? [])) {
    const date = r.created_at?.slice(0, 10) ?? '-'
    const existing = dailyMap.get(date)
    if (existing) {
      existing.refund_count += 1
      existing.refund_amount += Number(r.amount ?? 0)
      if (r.reason) {
        existing.reasons.push(r.reason)
      }
    }
    else {
      dailyMap.set(date, {
        date,
        refund_count: 1,
        refund_amount: Number(r.amount ?? 0),
        reasons: r.reason ? [r.reason] : [],
      })
    }
  }

  // 处理 invoices refunded 数据(已通过 refunds 表体现的退款不重复计数,这里只作为兜底)
  // 如果 refunds 表无数据但 invoices 有 refunded,说明是老数据未写入 refunds 表
  const hasRefundRecords = (refunds ?? []).length > 0
  if (!hasRefundRecords && (refundedInvs ?? []).length > 0) {
    // 按 updated_at 日期归入
    const invRefundReasons = new Map<string, { date: string, amount: number }>()
    for (const inv of (refundedInvs ?? [])) {
      const date = inv.updated_at?.slice(0, 10) ?? '-'
      const k = `${date}_${inv.id}`
      invRefundReasons.set(k, { date, amount: Number(inv.paid_amount ?? inv.total ?? 0) })
    }
    for (const [, v] of invRefundReasons) {
      const existing = dailyMap.get(v.date)
      if (existing) {
        existing.refund_count += 1
        existing.refund_amount += v.amount
      }
      else {
        dailyMap.set(v.date, { date: v.date, refund_count: 1, refund_amount: v.amount, reasons: ['已退款(旧数据)'] })
      }
    }
  }

  const rows = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date))

  const detailRows: DetailRow[] = rows.map(r => ({
    日期: r.date,
    退款笔数: r.refund_count,
    退款总额: r.refund_amount,
    退款原因分类: r.reasons.length > 0 ? [...new Set(r.reasons)].slice(0, 3).join('; ') : '-',
  }))

  // 合计行
  const totalCount = detailRows.reduce((s, r) => s + (r.退款笔数 as number), 0)
  const totalAmount = detailRows.reduce((s, r) => s + (r.退款总额 as number), 0)
  if (detailRows.length > 0) {
    detailRows.push({
      日期: '合计',
      退款笔数: totalCount,
      退款总额: totalAmount,
      退款原因分类: '',
      __isSummary: true,
    })
  }

  return detailRows
}

// ============================================================
// 库存报表(inventory): JOIN catalog_items + warehouses
// ============================================================

/**
 * 拉取库存报表(从 inventory_balances JOIN catalog_items + warehouses)
 * 列: 仓库 / 商品编码 / 名称 / 规格 / 单位 / 当前库存 / 预留数量 / 可用数量 / 成本单价 / 总成本价
 * 按仓库分组,含合计行
 * @param tenantId 租户 id
 */
async function fetchInventoryReport(tenantId: string): Promise<DetailRow[]> {
  // 并行查询:库存余额 + 目录项 + 仓库
  const [balRes, catRes, whRes] = await Promise.all([
    supabase.from('inventory_balances').select('*').eq('tenant_id', tenantId).order('warehouse_id'),
    supabase.from('catalog_items').select('id, code, name, description, unit, cost_price').eq('tenant_id', tenantId),
    supabase.from('warehouses').select('id, name, code').eq('tenant_id', tenantId),
  ])

  if (balRes.error) {
    throw new Error(balRes.error.message)
  }
  if (catRes.error) {
    throw new Error(catRes.error.message)
  }

  const catalogMap = new Map<string, { code: string, name: string, description: string | null, unit: string | null, cost_price: number }>()
  for (const c of (catRes.data ?? [])) {
    catalogMap.set(c.id, { code: c.code, name: c.name, description: c.description, unit: c.unit, cost_price: Number(c.cost_price ?? 0) })
  }

  const warehouseMap = new Map<string, string>()
  for (const w of (whRes.data ?? [])) {
    warehouseMap.set(w.id, w.name ?? w.code ?? w.id.slice(0, 8))
  }

  const rows: DetailRow[] = []
  for (const bal of (balRes.data ?? [])) {
    const cat = catalogMap.get(bal.catalog_item_id)
    const whName = warehouseMap.get(bal.warehouse_id) ?? (bal.warehouse_id?.slice(0, 8) ?? '未知')
    const onHand = Number(bal.quantity_on_hand ?? 0)
    const reserved = Number(bal.quantity_reserved ?? 0)
    const costPrice = cat?.cost_price ?? 0
    rows.push({
      仓库: whName,
      商品编码: cat?.code ?? '-',
      名称: cat?.name ?? '-',
      规格: cat?.description ?? '-',
      单位: cat?.unit ?? '-',
      当前库存: onHand,
      预留数量: reserved,
      可用数量: onHand - reserved,
      成本单价: costPrice,
      总成本价: onHand * costPrice,
    })
  }

  // 按仓库排序
  rows.sort((a, b) => String(a.仓库).localeCompare(String(b.仓库)) || String(a.商品编码).localeCompare(String(b.商品编码)))

  // 合计行
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

// ============================================================
// 客户报表(customer): 总客户/新增/活跃/分级/欠款
// ============================================================

/**
 * 拉取客户报表(汇总统计)
 * 列: 统计项 / 数值
 * 增强:总客户数/本月新增/活跃客户(近30天就诊)/VIP分级/欠款客户
 * @param tenantId 租户 id
 */
async function fetchCustomerReport(tenantId: string): Promise<DetailRow[]> {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // 并行查询
  const [custRes, encRes] = await Promise.all([
    supabase.from('customers').select('id, member_level, balance, status, created_at').eq('tenant_id', tenantId),
    supabase.from('encounters').select('customer_id').eq('tenant_id', tenantId).gte('created_at', thirtyDaysAgo),
  ])

  if (custRes.error) {
    throw new Error(custRes.error.message)
  }
  if (encRes.error) {
    throw new Error(encRes.error.message)
  }

  const customers = custRes.data ?? []

  // 总客户数(排除 archived/merged)
  const activeCustomers = customers.filter(c => c.status === 'active')
  const totalCustomers = activeCustomers.length

  // 本月新增
  const newThisMonth = activeCustomers.filter(c => c.created_at && c.created_at >= monthStart).length

  // 活跃客户(近30天有就诊)
  const activeEncounterIds = new Set((encRes.data ?? []).map(e => e.customer_id))
  const active30d = activeCustomers.filter(c => activeEncounterIds.has(c.id)).length

  // 按会员等级统计
  const levelCounts: Record<string, number> = { normal: 0, silver: 0, gold: 0, diamond: 0 }
  for (const c of activeCustomers) {
    const lv = c.member_level ?? 'normal'
    levelCounts[lv] = (levelCounts[lv] ?? 0) + 1
  }

  // 欠款客户(unpaid balance > 0)
  const unpaidCount = activeCustomers.filter(c => Number(c.balance ?? 0) > 0).length

  // 有宠物的客户数
  const custIds = activeCustomers.map(c => c.id)
  let petOwnerCount = 0
  if (custIds.length > 0) {
    const { data: pets, error: petErr } = await supabase
      .from('pets')
      .select('customer_id')
      .eq('tenant_id', tenantId)
      .in('customer_id', custIds)
    if (!petErr) {
      petOwnerCount = new Set((pets ?? []).map(p => p.customer_id)).size
    }
  }

  const rows: DetailRow[] = [
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

  return rows
}

// ============================================================
// 医疗工作量报表(medical): 按日期+医生分组 + 处方/检验/疫苗 + 排名
// ============================================================

/**
 * 拉取医疗工作量报表(按日期+医生分组统计)
 * 列: 日期 / 医生 / 就诊数 / 处方数 / 检验数 / 疫苗数
 * 按医生+日期分组,含合计行
 * @param tenantId 租户 id
 */
async function fetchMedicalReport(tenantId: string): Promise<DetailRow[]> {
  const { start, end } = getDateRange()

  // 查询时间段内的就诊
  const { data: encounters, error: encErr } = await supabase
    .from('encounters')
    .select('id, doctor_id, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: false })

  if (encErr) {
    throw new Error(encErr.message)
  }
  if (!encounters || encounters.length === 0) {
    return []
  }

  const encIds = encounters.map(e => e.id)

  // 医生名称映射
  const doctorIds = [...new Set(encounters.map(e => e.doctor_id).filter(Boolean))]
  const doctorMap = new Map<string, string>()
  if (doctorIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', doctorIds)
    for (const p of (profiles ?? [])) {
      doctorMap.set(p.id, p.display_name ?? p.id.slice(0, 8))
    }
  }

  // 并行查询处方/检验/疫苗
  const [presRes, labRes, vaccRes] = await Promise.all([
    supabase.from('prescriptions').select('id, encounter_id').in('encounter_id', encIds),
    supabase.from('lab_orders').select('id, encounter_id').in('encounter_id', encIds),
    supabase.from('vaccinations').select('id, encounter_id').in('encounter_id', encIds),
  ])

  // 建立 encounter → 数量映射
  const presCountMap = new Map<string, number>()
  for (const p of (presRes.data ?? [])) {
    presCountMap.set(p.encounter_id, (presCountMap.get(p.encounter_id) ?? 0) + 1)
  }
  const labCountMap = new Map<string, number>()
  for (const l of (labRes.data ?? [])) {
    labCountMap.set(l.encounter_id, (labCountMap.get(l.encounter_id) ?? 0) + 1)
  }
  const vaccCountMap = new Map<string, number>()
  for (const v of (vaccRes.data ?? [])) {
    vaccCountMap.set(v.encounter_id, (vaccCountMap.get(v.encounter_id) ?? 0) + 1)
  }

  // 按 日期+医生 分组
  const groupKey = (date: string, doctorId: string | null) => `${date}||${doctorId ?? '__none__'}`
  const groups = new Map<string, { date: string, doctor: string, encounter_count: number, prescription_count: number, lab_count: number, vaccine_count: number }>()

  for (const enc of encounters) {
    const date = enc.created_at?.slice(0, 10) ?? '-'
    const doctor = doctorMap.get(enc.doctor_id) ?? (enc.doctor_id ? enc.doctor_id.slice(0, 8) : '未分配')
    const k = groupKey(date, enc.doctor_id)
    const existing = groups.get(k)
    if (existing) {
      existing.encounter_count += 1
      existing.prescription_count += presCountMap.get(enc.id) ?? 0
      existing.lab_count += labCountMap.get(enc.id) ?? 0
      existing.vaccine_count += vaccCountMap.get(enc.id) ?? 0
    }
    else {
      groups.set(k, {
        date,
        doctor,
        encounter_count: 1,
        prescription_count: presCountMap.get(enc.id) ?? 0,
        lab_count: labCountMap.get(enc.id) ?? 0,
        vaccine_count: vaccCountMap.get(enc.id) ?? 0,
      })
    }
  }

  const rows = Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date) || a.doctor.localeCompare(b.doctor))

  const detailRows: DetailRow[] = rows.map((r, idx) => ({
    排名: idx + 1,
    日期: r.date,
    医生: r.doctor,
    就诊数: r.encounter_count,
    处方数: r.prescription_count,
    检验数: r.lab_count,
    疫苗数: r.vaccine_count,
  }))

  // 合计行
  if (detailRows.length > 0) {
    const totalEnc = detailRows.reduce((s, r) => s + (r.就诊数 as number), 0)
    const totalPres = detailRows.reduce((s, r) => s + (r.处方数 as number), 0)
    const totalLab = detailRows.reduce((s, r) => s + (r.检验数 as number), 0)
    const totalVacc = detailRows.reduce((s, r) => s + (r.疫苗数 as number), 0)
    detailRows.push({
      排名: 0,
      日期: '',
      医生: '合计',
      就诊数: totalEnc,
      处方数: totalPres,
      检验数: totalLab,
      疫苗数: totalVacc,
      __isSummary: true,
    })
  }

  return detailRows
}

// ============================================================
// CSV 导出
// ============================================================

/**
 * 导出当前报表数据为 CSV 并触发浏览器下载
 * @param data 报表数据行数组
 * @param filename 导出文件名（不含扩展名）
 */
function exportCSV(data?: DetailRow[], filename?: string) {
  const targetData = data ?? reportDataList.value
  const targetColumns = reportDataColumns.value

  if (!targetData || targetData.length === 0) {
    useFaToast().warning('没有可导出的数据')
    return
  }

  // 获取列头
  const headers = targetColumns.map(col => col.accessorKey ?? (col as any).id ?? '')

  // 构建 CSV 内容
  const csvRows: string[] = []
  // 表头行
  csvRows.push(headers.map(h => escapeCSVField(h)).join(','))
  // 数据行
  for (const row of targetData) {
    const cells = headers.map((key) => {
      const val = row[key]
      if (val === null || val === undefined) {
        return ''
      }
      if (typeof val === 'object') {
        return escapeCSVField(JSON.stringify(val))
      }
      return escapeCSVField(String(val))
    })
    csvRows.push(cells.join(','))
  }

  const csvContent = csvRows.join('\n')
  const bom = '\uFEFF' // BOM for Excel UTF-8 compatibility
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)

  // 触发下载
  const defaultName = filename
    ?? (currentReportDefRow.value?.name ?? 'report')
  const dateStr = new Date().toISOString().slice(0, 10)
  const link = document.createElement('a')
  link.href = url
  link.download = `${defaultName}_${dateStr}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * 转义 CSV 字段值（处理引号、换行、逗号）
 * @param val 原始字段值
 * @returns 转义后的字段值
 */
function escapeCSVField(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
    return `"${val.replace(/"/g, '""')}"`
  }
  return val
}

const defColumns = computed<TableColumn<ReportDefRow>[]>(() => [
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'name', header: '名称' },
  {
    accessorKey: 'category',
    header: '分类',
    cell: info => REPORT_CATEGORY_LABELS[info.getValue() as ReportCategory] ?? info.getValue(),
  },
  {
    accessorKey: 'is_active',
    header: '启用',
    cell: info => (info.getValue() ? '是' : '否'),
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: info => info.getValue() ? new Date(info.getValue()).toLocaleDateString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 200,
    align: 'center',
    fixed: 'right',
  },
])

const snapshotColumns = computed<TableColumn<SnapshotRow>[]>(() => [
  {
    accessorKey: 'report_id',
    header: '报表 id',
    cell: info => info.getValue()?.slice(0, 8) ?? '-',
  },
  { accessorKey: 'period_start', header: '起始日期' },
  { accessorKey: 'period_end', header: '结束日期' },
  {
    accessorKey: 'created_at',
    header: '生成时间',
    cell: info => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 100,
    align: 'center',
    fixed: 'right',
  },
])

const reportOptions = computed(() => [
  { label: '全部报表', value: '' },
  ...defList.value.map(d => ({ label: d.name, value: d.id })),
])
</script>

<template>
  <div>
    <FaPageHeader title="报表中心" class="mb-0">
      <template #description>
        收入/库存/客户/医疗报表快照;走 Hono Command + generate_report_snapshot RPC,框架实现,业务规则后续补
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaTabs v-model="tabActive" :list="[{ label: '报表定义', value: 'definitions' }, { label: '历史快照', value: 'snapshots' }]">
        <template #definitions>
          <FaSearchBar :show-toggle="false">
            <template #default>
              <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
                <FaLabel label="分类" class="col-span-1">
                  <FaSelect
                    v-model="filters.category"
                    :options="[
                      { label: '全部', value: '' },
                      { label: '收入', value: 'revenue' },
                      { label: '退款', value: 'refund' },
                      { label: '库存', value: 'inventory' },
                      { label: '客户', value: 'customer' },
                      { label: '医疗', value: 'medical' },
                    ]"
                    class="w-full"
                    @change="onSearchDefs"
                  />
                </FaLabel>
                <div class="flex gap-2 col-end--1 justify-end">
                  <FaButton variant="outline" @click="onResetDefs">
                    重置
                  </FaButton>
                  <FaButton type="primary" @click="onSearchDefs">
                    <FaIcon name="i-ri:search-line" />
                    筛选
                  </FaButton>
                </div>
              </div>
            </template>
          </FaSearchBar>
          <div class="mx--4 my-3 border-t border-t-dashed" />
          <FaTable
            v-loading="defLoading"
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="defColumns"
            :data="defList"
          >
            <template #cell-operation="{ row }">
              <div class="flex-center gap-2">
                <FaButton variant="outline" size="sm" @click="onGenerate(row.original)">
                  <FaIcon name="i-ri:play-line" />
                  生成
                </FaButton>
                <FaButton variant="outline" size="sm" @click="generateReportData(row.original)">
                  <FaIcon name="i-ri:bar-chart-line" />
                  实时数据
                </FaButton>
              </div>
            </template>
          </FaTable>
        </template>
        <template #snapshots>
          <FaSearchBar :show-toggle="false">
            <template #default>
              <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
                <FaLabel label="报表" class="col-span-1">
                  <FaSelect v-model="selectedReportId" :options="reportOptions" class="w-full" @change="onSearchSnapshots" />
                </FaLabel>
                <FaLabel label="起始日期" class="col-span-1">
                  <FaInput v-model="filters.periodStart" type="date" class="w-full" placeholder="YYYY-MM-DD" />
                </FaLabel>
                <FaLabel label="结束日期" class="col-span-1">
                  <FaInput v-model="filters.periodEnd" type="date" class="w-full" placeholder="YYYY-MM-DD" />
                </FaLabel>
                <div class="flex gap-2 col-end--1 justify-end">
                  <FaButton variant="outline" @click="onResetSnapshots">
                    重置
                  </FaButton>
                  <FaButton type="primary" @click="onSearchSnapshots">
                    <FaIcon name="i-ri:search-line" />
                    筛选
                  </FaButton>
                </div>
              </div>
            </template>
          </FaSearchBar>
          <div class="mx--4 my-3 border-t border-t-dashed" />
          <FaTable
            v-loading="snapshotLoading"
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="snapshotColumns"
            :data="snapshotList"
          >
            <template #cell-operation="{ row }">
              <div class="flex-center gap-2">
                <FaButton variant="outline" size="icon-sm" @click="openSnapshotDetail(row.original)">
                  <FaIcon name="i-ri:eye-line" />
                </FaButton>
              </div>
            </template>
          </FaTable>
        </template>
      </FaTabs>

      <!-- 快照详情弹窗 -->
      <FaModal
        v-model="snapshotDetailVisible"
        :title="snapshotDetailTitle"
        width="80%"
        :footer="false"
      >
        <FaTable
          v-loading="snapshotDetailLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="snapshotDetailColumns"
          :data="snapshotDetailData"
        />
        <div v-if="!snapshotDetailLoading && snapshotDetailData.length === 0" class="text-gray-400 py-8 text-center">
          暂无数据
        </div>
      </FaModal>

      <!-- 实时报表数据弹窗 -->
      <FaModal
        v-model="reportDataVisible"
        :title="reportDataTitle"
        width="80%"
        :footer="false"
      >
        <template #header-extra>
          <FaButton variant="outline" size="sm" @click="exportCSV()">
            <FaIcon name="i-ri:file-download-line" />
            导出 CSV
          </FaButton>
        </template>
        <FaTable
          v-loading="reportDataLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="reportDataColumns"
          :data="reportDataList"
        />
        <div v-if="!reportDataLoading && reportDataList.length === 0" class="text-gray-400 py-8 text-center">
          暂无数据
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
