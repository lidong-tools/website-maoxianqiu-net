<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { ReportCategory } from '@/types/operations'
import apiOperations from '@/api/modules/operations'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { REPORT_CATEGORY_LABELS } from '@/types/operations'

defineOptions({
  name: 'OperationsReports',
})

/** 显示提示信息 */
function showToastInfo(msg: string) {
  useFaToast().info(msg)
}

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

const defColumns = computed<TableColumn<ReportDefRow>[]>(() => [
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'name', header: '名称' },
  {
    accessorKey: 'category',
    header: '分类',
    cell: (info: any) => REPORT_CATEGORY_LABELS[info.getValue() as ReportCategory] ?? info.getValue(),
  },
  {
    accessorKey: 'is_active',
    header: '启用',
    cell: (info: any) => (info.getValue() ? '是' : '否'),
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleDateString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 120,
    align: 'center',
    fixed: 'right',
  },
])

const snapshotColumns = computed<TableColumn<SnapshotRow>[]>(() => [
  {
    accessorKey: 'report_id',
    header: '报表 id',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-',
  },
  { accessorKey: 'period_start', header: '起始日期' },
  { accessorKey: 'period_end', header: '结束日期' },
  {
    accessorKey: 'created_at',
    header: '生成时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
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
            <template #cell-operation>
              <div class="flex-center gap-2">
                <FaButton variant="outline" size="icon-sm" @click="showToastInfo('快照详情查看即将上线')">
                  <FaIcon name="i-ri:eye-line" />
                </FaButton>
              </div>
            </template>
          </FaTable>
        </template>
      </FaTabs>
    </FaPageMain>
  </div>
</template>
