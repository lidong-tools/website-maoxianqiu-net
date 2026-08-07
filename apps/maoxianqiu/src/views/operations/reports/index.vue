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
 * @param data 快照数据行数组
 * @returns 动态列定义
 */
function buildColumnsFromData(data: DetailRow[]): TableColumn<DetailRow>[] {
  if (!data || data.length === 0) {
    return []
  }

  const firstRow = data[0]
  return Object.keys(firstRow).map((key) => {
    const value = firstRow[key]
    // 数值列右对齐
    const isNumber = typeof value === 'number'
    return {
      accessorKey: key,
      header: key,
      align: isNumber ? ('right' as const) : ('left' as const),
      cell: (info) => {
        const v = info.getValue()
        if (v === null || v === undefined) {
          return '-'
        }
        if (typeof v === 'number') {
          // 金额类字段保留两位小数
          if (/amount|price|total|fee|cost|revenue|balance/i.test(key)) {
            return v.toFixed(2)
          }
          return String(v)
        }
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
          return v.slice(0, 10)
        }
        return String(v)
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
 * 根据报表定义类型从对应的业务表聚合数据
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
 * 拉取收入报表（从 invoices 表按日期汇总）
 * @param tenantId 租户 id
 */
async function fetchRevenueReport(tenantId: string): Promise<DetailRow[]> {
  const startDate = filters.value.periodStart
    ? new Date(filters.value.periodStart).toISOString()
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
  const endDate = filters.value.periodEnd
    ? new Date(`${filters.value.periodEnd}T23:59:59`).toISOString()
    : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59).toISOString()

  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('tenant_id', tenantId)
    .gte('created_at', startDate)
    .lte('created_at', endDate)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  // 按日期分组汇总
  const dailyMap = new Map<string, { date: string, invoice_count: number, total_amount: number, paid_amount: number }>()
  for (const inv of (data ?? [])) {
    const date = inv.created_at?.slice(0, 10) ?? '-'
    const existing = dailyMap.get(date)
    if (existing) {
      existing.invoice_count += 1
      existing.total_amount += Number(inv.total_amount ?? 0)
      existing.paid_amount += Number(inv.paid_amount ?? 0)
    }
    else {
      dailyMap.set(date, {
        date,
        invoice_count: 1,
        total_amount: Number(inv.total_amount ?? 0),
        paid_amount: Number(inv.paid_amount ?? 0),
      })
    }
  }

  return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 拉取库存报表（从 inventory_balances 汇总当前库存）
 * @param tenantId 租户 id
 */
async function fetchInventoryReport(tenantId: string): Promise<DetailRow[]> {
  const { data, error } = await supabase
    .from('inventory_balances')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('item_name', { ascending: true })

  if (error) {
    throw new Error(error.message)
  }

  return (data ?? []).map(item => ({
    item_name: item.item_name ?? '-',
    item_code: item.item_code ?? '-',
    unit: item.unit ?? '-',
    quantity: Number(item.quantity ?? 0),
    unit_cost: Number(item.unit_cost ?? 0),
    total_value: Number(item.quantity ?? 0) * Number(item.unit_cost ?? 0),
    last_updated: item.updated_at ?? item.created_at ?? '-',
  }))
}

/**
 * 拉取客户报表（从 customers 按注册月份汇总统计）
 * @param tenantId 租户 id
 */
async function fetchCustomerReport(tenantId: string): Promise<DetailRow[]> {
  const { data: customers, error } = await supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(error.message)
  }
  if (!customers || customers.length === 0) {
    return []
  }

  // 按注册月份分组统计
  const monthMap = new Map<string, { month: string, new_customers: number }>()
  for (const c of customers) {
    const month = c.created_at?.slice(0, 7) ?? '-'
    const existing = monthMap.get(month)
    if (existing) {
      existing.new_customers += 1
    }
    else {
      monthMap.set(month, { month, new_customers: 1 })
    }
  }

  // 同时查询宠物数
  const { data: pets } = await supabase
    .from('pets')
    .select('id, customer_id')
    .eq('tenant_id', tenantId)

  const petsPerCustomer = new Map<string, number>()
  for (const p of (pets ?? [])) {
    petsPerCustomer.set(p.customer_id, (petsPerCustomer.get(p.customer_id) ?? 0) + 1)
  }

  return Array.from(monthMap.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(row => ({
      ...row,
      total_customers_with_pets: customers.filter(c => c.created_at?.startsWith(row.month) && petsPerCustomer.has(c.id)).length,
    }))
}

/**
 * 拉取医疗报表（从 encounters 按日期汇总就诊统计）
 * @param tenantId 租户 id
 */
async function fetchMedicalReport(tenantId: string): Promise<DetailRow[]> {
  const startDate = filters.value.periodStart
    ? new Date(filters.value.periodStart).toISOString()
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
  const endDate = filters.value.periodEnd
    ? new Date(`${filters.value.periodEnd}T23:59:59`).toISOString()
    : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59).toISOString()

  const { data, error } = await supabase
    .from('encounters')
    .select('*')
    .eq('tenant_id', tenantId)
    .gte('created_at', startDate)
    .lte('created_at', endDate)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  // 按日期分组汇总
  const dailyMap = new Map<string, { date: string, encounter_count: number, status_breakdown: Record<string, number> }>()
  for (const enc of (data ?? [])) {
    const date = enc.created_at?.slice(0, 10) ?? '-'
    const status = enc.status ?? 'unknown'
    const existing = dailyMap.get(date)
    if (existing) {
      existing.encounter_count += 1
      existing.status_breakdown[status] = (existing.status_breakdown[status] ?? 0) + 1
    }
    else {
      dailyMap.set(date, {
        date,
        encounter_count: 1,
        status_breakdown: { [status]: 1 },
      })
    }
  }

  return Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(row => ({
      date: row.date,
      encounter_count: row.encounter_count,
      draft: row.status_breakdown.draft ?? 0,
      active: row.status_breakdown.active ?? 0,
      completed: row.status_breakdown.completed ?? 0,
    }))
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
