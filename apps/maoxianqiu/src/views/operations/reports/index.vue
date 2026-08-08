<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { ReportCategory, ReportDataPayload } from '@/types/operations'
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
    useFaToast().error(err instanceof Error ? err.message : '加载快照详情失败')
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
 * P0-06 统一报表真源:调用 Hono GET /api/operations/report-data/:reportCode,
 * 服务端聚合业务表返回标准 DTO,前端只负责渲染 rows(不再浏览器跨表聚合)
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
    const res = await apiOperations.getReportData(row.code, {
      tenantId: tenantStore.currentTenantId,
      periodStart: filters.value.periodStart || undefined,
      periodEnd: filters.value.periodEnd || undefined,
    })
    const payload = res.data as ReportDataPayload
    reportDataList.value = (payload.rows ?? []) as DetailRow[]
    reportDataColumns.value = buildColumnsFromData(reportDataList.value)
  }
  catch (err: unknown) {
    useFaToast().error(err instanceof Error ? err.message : '生成报表数据失败')
    reportDataList.value = []
    reportDataColumns.value = []
  }
  finally {
    reportDataLoading.value = false
  }
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
  const headers = targetColumns.map((col: any) => col.accessorKey ?? col.id ?? '')

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
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleDateString('zh-CN') : '-',
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
    cell: info => (info.getValue() as string | undefined)?.slice(0, 8) ?? '-',
  },
  { accessorKey: 'period_start', header: '起始日期' },
  { accessorKey: 'period_end', header: '结束日期' },
  {
    accessorKey: 'created_at',
    header: '生成时间',
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
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
    <EntityPageHeader compact title="报表中心" description="收入/退款/库存/客户/医疗报表;快照走 Hono Command + generate_report_snapshot RPC,实时明细走统一报表真源(Hono 服务端聚合),前端只负责渲染" />
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
