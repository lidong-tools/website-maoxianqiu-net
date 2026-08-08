<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { ImportErrorRow, ImportJob, ImportJobStatus, ImportJobType } from '@/types/imports'
import { IMPORT_JOB_STATUS_LABELS, IMPORT_TYPE_LABELS, IMPORT_TYPES } from '@/types/imports'
import apiImports from '@/api/modules/imports'
import apiStore from '@/api/modules/store'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import ImportWizard from '@/components/imports/ImportWizard.vue'

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
  { key: 'history', label: '历史', status: ['completed', 'failed', 'cancelled'].join(',') },
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
  <div>
    <EntityPageHeader compact title="导入中心" description="客户/宠物/商品/员工/库存期初批量导入；上传 → 映射 → 校验 → 执行" />

    <FaPageMain>
      <!-- 新建导入向导 -->
      <div v-if="showWizard">
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

      <!-- 任务列表 -->
      <template v-else>
        <div class="mb-3 flex items-center gap-1">
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

        <FaSearchBar :show-toggle="false">
          <template #default>
            <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
              <FaLabel label="门店" class="col-span-1">
                <FaSelect v-model="search.storeId" :options="storeOptions" class="w-full" @change="onSearch" />
              </FaLabel>
              <FaLabel label="类型" class="col-span-1">
                <FaSelect
                  v-model="search.type"
                  :options="[
                    { label: '全部', value: '' },
                    ...IMPORT_TYPES.map(t => ({ label: IMPORT_TYPE_LABELS[t], value: t })),
                  ]"
                  class="w-full"
                  @change="onSearch"
                />
              </FaLabel>
              <div class="flex gap-2 col-end--1 justify-end">
                <FaButton variant="outline" @click="onReset">
                  重置
                </FaButton>
                <FaButton type="primary" @click="onSearch">
                  <FaIcon name="i-ri:search-line" />
                  筛选
                </FaButton>
              </div>
            </div>
          </template>
        </FaSearchBar>

        <div class="mx--4 my-3 border-t border-t-dashed" />

        <FaTable
          v-loading="loading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="tableColumns"
          :data="dataList"
        >
          <template #toolbar>
            <FaButton type="primary" @click="openWizard">
              <FaIcon name="i-ri:upload-2-line" />
              新建导入
            </FaButton>
          </template>
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
            <div class="py-12 text-center text-gray-400">
              暂无导入任务
            </div>
          </template>
        </FaTable>

        <div class="mt-3 flex items-center justify-between">
          <span class="text-sm text-gray-400">共 {{ total }} 条</span>
          <div class="flex items-center gap-2">
            <FaButton variant="outline" size="sm" :disabled="page === 0" @click="goPage(page - 1)">
              上一页
            </FaButton>
            <span class="text-sm">第 {{ page + 1 }} 页</span>
            <FaButton
              variant="outline"
              size="sm"
              :disabled="(page + 1) * PAGE_SIZE >= total"
              @click="goPage(page + 1)"
            >
              下一页
            </FaButton>
          </div>
        </div>
      </template>
    </FaPageMain>

    <!-- 任务详情抽屉 -->
    <FaDrawer v-model="detailVisible" title="任务详情" :width="480">
      <div v-if="detailJob" class="space-y-3 text-sm">
        <div class="grid grid-cols-2 gap-y-2">
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
        <div v-if="detailJob.mapping" class="rounded-lg bg-gray-50 p-3">
          <div class="mb-2 font-medium">字段映射</div>
          <div v-for="(header, key) in detailJob.mapping" :key="key" class="flex justify-between py-0.5">
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
          class="rounded-lg border p-2 text-sm"
        >
          <div class="flex items-center gap-2">
            <FaTag variant="destructive">
              第 {{ e.row_number }} 行
            </FaTag>
            <span class="font-medium text-red-600">{{ e.message }}</span>
          </div>
          <div v-if="e.raw_data" class="mt-1 truncate text-xs text-gray-400">
            {{ JSON.stringify(e.raw_data) }}
          </div>
        </div>
        <div v-if="errorList.length === 0" class="py-8 text-center text-gray-400">
          暂无错误
        </div>
        <div v-if="errorTotal > errorList.length" class="flex justify-center pt-2">
          <FaButton variant="outline" size="sm" @click="loadErrorPage(errorPage + 1)">
            加载更多
          </FaButton>
        </div>
      </div>
    </FaDrawer>
  </div>
</template>
