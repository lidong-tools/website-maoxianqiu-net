<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { ImportErrorRow, ImportJob, ImportJobStatus, ImportJobType } from '@/types/imports'
import apiImports from '@/api/modules/imports'
import apiStore from '@/api/modules/store'
import ImportWizard from '@/components/imports/ImportWizard.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { IMPORT_JOB_STATUS_LABELS, IMPORT_TYPE_LABELS, IMPORT_TYPES_ENABLED } from '@/types/imports'

defineOptions({
  name: 'OperationsImports',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<ImportJob[]>([])
const total = ref(0)
const page = ref(0)
const PAGE_SIZE = 20

const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  storeId: '',
  type: '' as '' | ImportJobType,
})

type TabKey = 'all' | 'running' | 'history' | 'failed'
const tabs: Array<{ key: TabKey, label: string, status?: string }> = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '进行中', status: ['uploaded', 'mapped', 'validated', 'queued', 'pending', 'processing'].join(',') },
  // awaiting_domain_apply 为命令队列型导入(员工/期初)的成功终态,也归入历史
  { key: 'history', label: '历史', status: ['completed', 'failed', 'cancelled', 'awaiting_domain_apply'].join(',') },
  { key: 'failed', label: '失败任务', status: 'failed' },
]
const activeTab = ref<TabKey>('all')

const showWizard = ref(false)

// 详情抽屉
const detailVisible = ref(false)
const detailJob = ref<ImportJob | null>(null)
const detailErrorCount = ref(0)

// 错误抽屉
const errorsVisible = ref(false)
const errorList = ref<ImportErrorRow[]>([])
const errorTotal = ref(0)
const errorPage = ref(0)
const ERROR_PAGE_SIZE = 20

async function loadStoreOptions() {
  try {
    const res: any = await apiStore.list()
    const stores = res.data.list ?? []
    storeOptions.value = [
      { label: '全部门店', value: '' },
      ...stores.map((s: any) => ({ label: s.name, value: s.id })),
    ]
  }
  catch {
    storeOptions.value = [{ label: '全部门店', value: '' }]
  }
}

function getDataList() {
  if (!tenantStore.currentTenantId) {
    dataList.value = []
    total.value = 0
    return
  }
  loading.value = true
  const tab = tabs.find(t => t.key === activeTab.value)
  apiImports.list({
    tenantId: tenantStore.currentTenantId,
    storeId: search.value.storeId || undefined,
    type: search.value.type || undefined,
    status: tab?.status,
    from: page.value * PAGE_SIZE,
    limit: PAGE_SIZE,
  }).then((res) => {
    dataList.value = res.list
    total.value = res.total
  }).catch(() => {
    dataList.value = []
  }).finally(() => {
    loading.value = false
  })
}

function onTabChange(key: TabKey) {
  activeTab.value = key
  page.value = 0
  getDataList()
}

function onSearch() {
  page.value = 0
  getDataList()
}

function onReset() {
  search.value.storeId = tenantStore.currentStoreId || ''
  search.value.type = ''
  page.value = 0
  getDataList()
}

function goPage(p: number) {
  page.value = p
  getDataList()
}

function openWizard() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  showWizard.value = true
}

function onWizardClose() {
  showWizard.value = false
}

function onWizardCompleted() {
  getDataList()
}

async function viewDetail(row: ImportJob) {
  try {
    const res = await apiImports.detail(row.id)
    detailJob.value = res.job
    detailErrorCount.value = res.errorCount
    detailVisible.value = true
  }
  catch {
    // toast handled
  }
}

async function openErrors(row: ImportJob) {
  errorPage.value = 0
  errorsVisible.value = true
  const res = await apiImports.listErrors(row.id, { from: 0, limit: ERROR_PAGE_SIZE })
  errorList.value = res.list
  errorTotal.value = res.total
}

async function loadErrorPage(p: number) {
  if (!detailJob.value) {
    return
  }
  errorPage.value = p
  const res = await apiImports.listErrors(detailJob.value.id, { from: p * ERROR_PAGE_SIZE, limit: ERROR_PAGE_SIZE })
  errorList.value = res.list
}

const tableColumns = computed<TableColumn<ImportJob>[]>(() => [
  {
    accessorKey: 'type',
    header: '类型',
    cell: info => IMPORT_TYPE_LABELS[info.getValue() as ImportJobType] ?? info.getValue(),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const v = info.getValue() as ImportJobStatus
      return IMPORT_JOB_STATUS_LABELS[v] ?? v
    },
  },
  {
    accessorKey: 'total_rows',
    header: '总行数',
    cell: info => info.getValue() ?? 0,
  },
  {
    accessorKey: 'valid_rows',
    header: '有效',
    cell: info => info.getValue() ?? 0,
  },
  {
    accessorKey: 'invalid_rows',
    header: '无效',
    cell: info => info.getValue() ?? 0,
  },
  {
    accessorKey: 'success_count',
    header: '成功',
    cell: info => info.getValue() ?? 0,
  },
  {
    accessorKey: 'failed_count',
    header: '失败',
    cell: info => info.getValue() ?? 0,
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: info => (info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-'),
  },
  {
    id: 'operation',
    header: '操作',
    width: 120,
    align: 'center',
    fixed: 'right',
  },
])

onMounted(async () => {
  await loadStoreOptions()
  if (tenantStore.currentStoreId) {
    search.value.storeId = tenantStore.currentStoreId
  }
  getDataList()
})

// P0-06:切店后重置分页与门店筛选并重载(避免旧门店导入任务残留)
useStoreScopedPage({
  load: getDataList,
  reset: () => {
    search.value.storeId = tenantStore.currentStoreId || ''
    page.value = 0
  },
})
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告 #8) -->
    <!--
    <EntityPageHeader compact title="导入中心" description="客户/宠物/商品/员工/库存期初批量导入；上传 → 映射 → 校验 → 执行" />
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <!-- 新建导入向导 -->
      <template v-if="showWizard">
        <div class="flex-1 min-h-0 overflow-auto">
          <ImportWizard
            :tenant-id="tenantStore.currentTenantId"
            :store-id="tenantStore.currentStoreId"
            :store-options="storeOptions"
            @close="onWizardClose"
            @completed="onWizardCompleted"
          />
          <div class="mt-4 flex justify-end">
            <FaButton variant="outline" @click="onWizardClose">
              返回列表
            </FaButton>
          </div>
        </div>
      </template>

      <!-- 任务列表 -->
      <template v-else>
        <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
          <div class="px-4 pt-3 border-b shrink-0">
            <!-- 自绘 tabs 按钮组移到筛选区最顶部 -->
            <div class="mb-2 flex gap-1 items-center">
              <FaButton
                v-for="t in tabs"
                :key="t.key"
                :variant="activeTab === t.key ? 'default' : 'ghost'"
                size="sm"
                @click="onTabChange(t.key)"
              >
                {{ t.label }}
              </FaButton>
            </div>
            <div class="pb-3 flex flex-wrap gap-3 items-center">
              <FaLabel label="门店" class="w-44">
                <FaSelect v-model="search.storeId" :options="storeOptions" class="w-full" @change="onSearch" />
              </FaLabel>
              <FaLabel label="类型" class="w-44">
                <FaSelect
                  v-model="search.type"
                  :options="[
                    { label: '全部', value: '' },
                    ...IMPORT_TYPES_ENABLED.map(t => ({ label: IMPORT_TYPE_LABELS[t], value: t })),
                  ]"
                  class="w-full"
                  @change="onSearch"
                />
              </FaLabel>
              <FaButton type="primary" @click="openWizard">
                <FaIcon name="i-ri:upload-2-line" />
                新建导入
              </FaButton>
              <div class="ml-auto flex gap-2 items-center">
                <FaButton variant="outline" @click="onReset">
                  重置
                </FaButton>
                <FaButton type="primary" @click="onSearch">
                  <FaIcon name="i-ri:search-line" />
                  筛选
                </FaButton>
              </div>
            </div>
          </div>

          <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
            <FaTable
              class="h-full min-h-0"
              table-root-class="overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="tableColumns"
              :data="dataList"
            >
              <template #cell-operation="{ row }">
                <div class="flex-center gap-2">
                  <FaButton variant="outline" size="icon-sm" title="详情" @click="viewDetail(row.original)">
                    <FaIcon name="i-ri:eye-line" />
                  </FaButton>
                  <FaButton
                    variant="outline"
                    size="icon-sm"
                    title="错误明细"
                    :disabled="(row.original.failed_count || 0) === 0 && row.original.status !== 'failed'"
                    @click="openErrors(row.original)"
                  >
                    <FaIcon name="i-ri:error-warning-line" />
                  </FaButton>
                </div>
              </template>
              <template #empty>
                <div class="text-gray-400 py-12 text-center">
                  暂无导入任务
                </div>
              </template>
            </FaTable>
          </div>
          <!-- 自绘分页改为标准 FaPagination(原 page 为 0 基,此处转 1 基) -->
          <FaPagination
            :page="page + 1"
            :size="PAGE_SIZE"
            :total="total"
            :sizes="[PAGE_SIZE]"
            class="mt-2 px-4 pb-3 shrink-0"
            @page-change="p => goPage(p - 1)"
          />
        </div>
      </template>
    </div>

    <!-- 任务详情抽屉 -->
    <FaDrawer v-model="detailVisible" title="任务详情" :width="480">
      <div v-if="detailJob" class="text-sm space-y-3">
        <div class="gap-y-2 grid grid-cols-2">
          <span class="text-gray-400">类型</span>
          <span>{{ IMPORT_TYPE_LABELS[detailJob.type] }}</span>
          <span class="text-gray-400">状态</span>
          <span>{{ IMPORT_JOB_STATUS_LABELS[detailJob.status] }}</span>
          <span class="text-gray-400">总行数</span>
          <span>{{ detailJob.total_rows }}</span>
          <span class="text-gray-400">有效 / 无效</span>
          <span>{{ detailJob.valid_rows }} / {{ detailJob.invalid_rows }}</span>
          <span class="text-gray-400">成功 / 失败</span>
          <span>{{ detailJob.success_count }} / {{ detailJob.failed_count }}</span>
          <span class="text-gray-400">错误明细</span>
          <span>{{ detailErrorCount }} 条</span>
          <span class="text-gray-400">创建时间</span>
          <span>{{ new Date(detailJob.created_at).toLocaleString('zh-CN') }}</span>
        </div>
        <div v-if="detailJob.mapping" class="p-3 rounded-lg bg-gray-50">
          <div class="font-medium mb-2">
            字段映射
          </div>
          <div v-for="(header, key) in detailJob.mapping" :key="key" class="py-0.5 flex justify-between">
            <span class="text-gray-500">{{ key }}</span>
            <span class="text-gray-400">← {{ header }}</span>
          </div>
        </div>
      </div>
    </FaDrawer>

    <!-- 错误明细抽屉 -->
    <FaDrawer v-model="errorsVisible" title="错误明细" :width="640">
      <div class="space-y-2">
        <div class="text-sm text-gray-500">
          共 {{ errorTotal }} 条
        </div>
        <div
          v-for="e in errorList"
          :key="e.id"
          class="text-sm p-2 border rounded-lg"
        >
          <div class="flex gap-2 items-center">
            <FaTag variant="destructive">
              第 {{ e.row_number }} 行
            </FaTag>
            <span class="text-red-600 font-medium">{{ e.message }}</span>
          </div>
          <div v-if="e.raw_data" class="text-xs text-gray-400 mt-1 truncate">
            {{ JSON.stringify(e.raw_data) }}
          </div>
        </div>
        <div v-if="errorList.length === 0" class="text-gray-400 py-8 text-center">
          暂无错误
        </div>
        <div v-if="errorTotal > errorList.length" class="pt-2 flex justify-center">
          <FaButton variant="outline" size="sm" @click="loadErrorPage(errorPage + 1)">
            加载更多
          </FaButton>
        </div>
      </div>
    </FaDrawer>
  </div>
</template>
