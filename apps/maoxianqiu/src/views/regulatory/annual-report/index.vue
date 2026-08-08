<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  AnnualRegulatoryReportRecord,
  RegulatoryReportStatus,
} from '@/types/regulatory'
import apiRegulatory from '@/api/modules/regulatory'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { REGULATORY_REPORT_STATUS_LABELS } from '@/types/regulatory'

defineOptions({
  name: 'RegulatoryAnnualReport',
})

/** 列表展示行 */
interface DisplayRow {
  id: string
  storeName: string
  reportYear: number
  status: RegulatoryReportStatus
  generatedAt: string
  submittedAt: string
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<AnnualRegulatoryReportRecord[]>([])
// 复审审计(S3.1-Fix-Reaudit-v3 §6):computed 而非 ref+onMounted,切租户即时响应,不保留旧 Tenant 快照
const currentTenantId = computed(() => tenantStore.currentTenantId)
const searchStoreId = ref('')
const platformUiDeferred = computed(() => !tenantStore.currentTenantId)

/** 列表列配置 */
const tableColumns = computed<TableColumn<DisplayRow>[]>(() => [
  {
    accessorKey: 'storeName',
    header: '门店',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'reportYear',
    header: '报告年度',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: info => REGULATORY_REPORT_STATUS_LABELS[info.getValue() as RegulatoryReportStatus] ?? '-',
  },
  {
    accessorKey: 'generatedAt',
    header: '生成时间',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'submittedAt',
    header: '提交时间',
    cell: info => info.getValue() ?? '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 220,
    align: 'center',
    fixed: 'right',
  },
])

/** 行 → 展示结构 */
function toDisplayRow(row: AnnualRegulatoryReportRecord): DisplayRow {
  return {
    id: row.id,
    storeName: row.stores?.name ?? '-',
    reportYear: row.report_year,
    status: row.status,
    generatedAt: row.generated_at ?? '-',
    submittedAt: row.submitted_at ?? '-',
  }
}

/**
 * 加载年度报告列表(浏览器直连,RLS 兜底)
 */
async function getDataList() {
  if (!currentTenantId.value) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiRegulatory.listAnnualReports(
      currentTenantId.value,
      searchStoreId.value || undefined,
    )
    dataList.value = res.data.list ?? []
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载失败')
  }
  finally {
    loading.value = false
  }
}

/** 生成报告对话框 */
const genVisible = ref(false)
const submitting = ref(false)
const genForm = reactive({
  storeId: '',
  reportYear: new Date().getFullYear() as number,
})

/** 打开生成报告对话框 */
function openGenerate() {
  genForm.storeId = searchStoreId.value
  genForm.reportYear = new Date().getFullYear()
  genVisible.value = true
}

/**
 * 生成报告(走 Hono Command,权限 regulatory_report.generate)
 * 生成时保存 report_snapshot,查看/导出一律读快照,历史内容固定
 */
async function onSubmitGenerate() {
  if (!genForm.storeId) {
    useFaToast().warning('请选择门店')
    return
  }
  if (!genForm.reportYear) {
    useFaToast().warning('请填写报告年度')
    return
  }
  if (submitting.value) {
    return
  }
  submitting.value = true
  try {
    await apiRegulatory.generateReport({
      storeId: genForm.storeId,
      reportYear: genForm.reportYear,
    })
    genVisible.value = false
    useFaToast().success('报告已生成(快照已固化)')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '生成失败')
  }
  finally {
    submitting.value = false
  }
}

/**
 * 提交报告(走 Hono Command,权限 regulatory_report.submit)
 */
async function onSubmitReport(row: DisplayRow) {
  try {
    await apiRegulatory.submitReport(row.id)
    useFaToast().success('报告已提交')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '提交失败')
  }
}

/** 报告快照预览 */
const previewVisible = ref(false)
const previewRow = ref<AnnualRegulatoryReportRecord | null>(null)

/** 打开快照预览(读取固化快照,不实时重算) */
function openPreview(row: DisplayRow) {
  const src = dataList.value.find(r => r.id === row.id)
  if (!src) {
    return
  }
  previewRow.value = src
  previewVisible.value = true
}

/** 快照统计口径展示行 */
interface SnapshotStatRow {
  key: string
  label: string
  value: string
}

/** 从固化快照提取统计行(unavailable 字段明确展示) */
function snapshotStats(): SnapshotStatRow[] {
  const snap = previewRow.value?.report_snapshot as Record<string, unknown> | null | undefined
  if (!snap) {
    return []
  }
  const stats = (snap.stats ?? {}) as Record<string, unknown>
  const unavailable = ((snap.unavailable_fields as string[]) ?? [])
  const rows: SnapshotStatRow[] = [
    { key: 'encounter_count', label: '诊疗数量', value: fmt(stats.encounter_count, 'encounter_count', unavailable) },
    { key: 'doctor_count', label: '医生数量', value: fmt(stats.doctor_count, 'doctor_count', unavailable) },
    { key: 'registered_veterinarian_count', label: '执业兽医数量', value: fmt(stats.registered_veterinarian_count, 'registered_veterinarian_count', unavailable) },
    { key: 'prescription_count', label: '处方数量', value: fmt(stats.prescription_count, 'prescription_count', unavailable) },
    { key: 'epidemic_event_count', label: '疫情事件数量', value: fmt(stats.epidemic_event_count, 'epidemic_event_count', unavailable) },
    { key: 'species_distribution', label: '动物类别分布', value: fmtSpecies(stats.species_distribution, 'species_distribution', unavailable) },
    { key: 'medical_waste_summary', label: '医疗废弃物概要', value: fmtWaste(stats.medical_waste_summary, 'medical_waste_summary', unavailable) },
  ]
  return rows
}

/** 数值格式化:null 或 unavailable → '无法可靠计算' */
function fmt(v: unknown, key: string, unavailable: string[]): string {
  if (v == null || unavailable.includes(key)) {
    return '无法可靠计算(unavailable)'
  }
  return String(v)
}

/** 动物类别分布格式化 */
function fmtSpecies(v: unknown, key: string, unavailable: string[]): string {
  if (v == null || unavailable.includes(key)) {
    return '无法可靠计算(unavailable)'
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>)
    return entries.length === 0 ? '无' : entries.map(([k, n]) => `${k}: ${n}`).join('; ')
  }
  return JSON.stringify(v)
}

/** 医疗废弃物概要格式化 */
function fmtWaste(v: unknown, key: string, unavailable: string[]): string {
  if (v == null || unavailable.includes(key)) {
    return '无法可靠计算(unavailable)'
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `记录数: ${o.record_count ?? 0}; 总量: ${o.total_quantity ?? 0}; 已交接: ${o.handed_over_count ?? 0}`
  }
  return JSON.stringify(v)
}

/** 导出快照 JSON(读取固化快照) */
function onExport(row: DisplayRow) {
  const src = dataList.value.find(r => r.id === row.id)
  if (!src) {
    return
  }
  const blob = new Blob([JSON.stringify(src.report_snapshot ?? {}, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `annual-report-${src.store_id.slice(0, 8)}-${src.report_year}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

// 复审审计 §6:切租户时重置门店筛选并重载,避免残留旧租户数据
watch(currentTenantId, () => {
  searchStoreId.value = ''
  getDataList()
})

onMounted(() => {
  // 审计 S3.1 P0-03:统一使用全局 Tenant Store 上下文,不再自行从 memberships 推导当前租户
  getDataList()
})
</script>

<template>
  <div>
    <EntityPageHeader compact title="年度动物诊疗活动报告" description="依据《动物诊疗机构管理办法》第三十条,生成/预览/导出/提交年度诊疗活动报告(快照式,生成后历史内容固定)" />
    <FaPageMain>
      <div
        v-if="platformUiDeferred"
        class="text-sm text-amber-700 mb-3 px-4 py-3 border border-amber-200 rounded-md bg-amber-50"
      >
        当前账号无租户成员关系,无法确定租户上下文。
      </div>
      <div class="mb-3 flex flex-wrap gap-2 items-center">
        <BusinessStorePicker v-model="searchStoreId" placeholder="选择门店(可选)" class="w-56" />
        <FaButton variant="outline" @click="getDataList">
          查询
        </FaButton>
      </div>
      <FaTable
        v-loading="loading"
        table-root-class="rounded-lg overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="tableColumns"
        :data="dataList.map(toDisplayRow)"
      >
        <template #toolbar>
          <PermissionButton permission="regulatory_report.generate" @click="openGenerate">
            生成报告
          </PermissionButton>
        </template>
        <template #cell-operation="{ row }">
          <FaButton size="sm" variant="outline" class="mr-1" @click="openPreview(row.original)">
            预览
          </FaButton>
          <FaButton size="sm" variant="outline" class="mr-1" @click="onExport(row.original)">
            导出
          </FaButton>
          <PermissionButton
            v-if="row.original.status === 'generated'"
            permission="regulatory_report.submit"
            size="sm"
            variant="outline"
            @click="onSubmitReport(row.original)"
          >
            提交
          </PermissionButton>
        </template>
      </FaTable>
    </FaPageMain>

    <FaDrawer v-model="genVisible" title="生成年度报告" :width="520">
      <div class="space-y-3">
        <FaLabel label="门店">
          <BusinessStorePicker v-model="genForm.storeId" class="w-full" />
        </FaLabel>
        <FaLabel label="报告年度">
          <FaInput
            v-model="genForm.reportYear"
            type="number"
            :min="2000"
            :max="2100"
            class="w-full"
          />
        </FaLabel>
        <div class="text-xs text-muted-foreground">
          生成时将基于当前数据固化快照;查看/导出一律读取快照,历史内容不会随后续业务数据漂移。
        </div>
      </div>
      <template #footer>
        <div class="flex gap-2 justify-end">
          <FaButton variant="outline" @click="genVisible = false">
            取消
          </FaButton>
          <FaButton type="primary" :loading="submitting" @click="onSubmitGenerate">
            生成
          </FaButton>
        </div>
      </template>
    </FaDrawer>

    <FaDrawer v-model="previewVisible" title="报告快照预览" :width="640">
      <div v-if="previewRow" class="text-sm space-y-3">
        <div class="flex items-center justify-between">
          <div>
            {{ previewRow.stores?.name ?? '-' }} / {{ previewRow.report_year }} 年度
          </div>
          <FaTag>
            {{ REGULATORY_REPORT_STATUS_LABELS[previewRow.status] ?? previewRow.status }}
          </FaTag>
        </div>
        <FaDescriptions
          :items="[
            { label: '生成时间', value: previewRow.generated_at ?? '-' },
            { label: '提交时间', value: previewRow.submitted_at ?? '-' },
          ]"
        />
        <FaDivider />
        <div class="font-medium">
          统计数据(快照)
        </div>
        <FaTable
          row-key="key"
          stripe
          border
          :columns="[
            { accessorKey: 'label', header: '口径' },
            { accessorKey: 'value', header: '数值' },
          ]"
          :data="snapshotStats()"
        />
      </div>
      <template #footer>
        <div class="flex gap-2 justify-end">
          <FaButton variant="outline" @click="previewVisible = false">
            关闭
          </FaButton>
        </div>
      </template>
    </FaDrawer>
  </div>
</template>
