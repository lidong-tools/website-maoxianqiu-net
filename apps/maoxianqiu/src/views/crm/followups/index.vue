<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { FollowupTaskRecord } from '@/types/customer'
import apiCustomer from '@/api/modules/customer'
import apiStore from '@/api/modules/store'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import FollowupCreateDrawer from '@/components/followups/FollowupCreateDrawer/index.vue'
import FollowupDetailDrawer from '@/components/followups/FollowupDetailDrawer/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  FOLLOWUP_SOURCE_LABELS,
  FOLLOWUP_STATUS_LABELS,
  FOLLOWUP_TASK_TYPE_LABELS,
} from '@/types/customer'

defineOptions({
  name: 'CrmFollowups',
})

type FollowupBucket = 'overdue' | 'today' | 'upcoming' | 'finished' | 'all'

const tenantStore = useAppTenantStore()
const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const loading = ref(false)
const dataList = ref<FollowupTaskRecord[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  keyword: '',
  storeId: '',
})
const activeBucket = ref<FollowupBucket>('overdue')

const detailVisible = ref(false)
const detailTaskId = ref('')
const createVisible = ref(false)

const BUCKETS: Array<{ label: string, value: FollowupBucket }> = [
  { label: '逾期', value: 'overdue' },
  { label: '今天', value: 'today' },
  { label: '未来', value: 'upcoming' },
  { label: '已完成', value: 'finished' },
  { label: '全部', value: 'all' },
]

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
  loading.value = true
  apiCustomer.listFollowups({
    bucket: activeBucket.value,
    keyword: search.value.keyword || undefined,
    storeId: search.value.storeId || undefined,
    ...getParams(),
  }).then((res: any) => {
    loading.value = false
    dataList.value = res.data.list ?? []
    pagination.value.total = res.data.total
  }).catch(() => {
    loading.value = false
  })
}

useStoreScopedPage({
  load: getDataList,
  reset: () => {
    search.value.storeId = tenantStore.currentStoreId
    onCurrentChange(1)
  },
})

onMounted(async () => {
  await loadStoreOptions()
  if (tenantStore.currentStoreId) {
    search.value.storeId = tenantStore.currentStoreId
  }
  getDataList()
})

function onBucketChange() {
  onCurrentChange(1).then(() => getDataList())
}

function sizeChange(size: number) {
  onSizeChange(size).then(() => getDataList())
}

function currentChange(page = 1) {
  onCurrentChange(page).then(() => getDataList())
}

function searchReset() {
  search.value.keyword = ''
  currentChange()
}

function onView(row: FollowupTaskRecord) {
  detailTaskId.value = row.id
  detailVisible.value = true
}

function onChanged() {
  getDataList()
}

function onCreated() {
  getDataList()
}

function fmtDateTime(iso?: string | null): string {
  if (!iso) {
    return '-'
  }
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const tableColumns = computed<TableColumn<FollowupTaskRecord>[]>(() => [
  {
    id: 'time',
    header: '计划时间',
    width: 120,
    cell: (info: any) => {
      const row = info.row.original as FollowupTaskRecord
      const overdue = (row.status === 'pending' || row.status === 'in_progress')
        && new Date(row.scheduled_at).getTime() < Date.now()
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: overdue ? 'text-sm text-red-600 font-medium' : 'text-sm' }, fmtDateTime(row.scheduled_at)),
      ])
    },
  },
  {
    id: 'identity',
    header: '客户 / 宠物',
    cell: (info: any) => {
      const row = info.row.original as FollowupTaskRecord
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'font-medium text-sm' }, row.customer_name ?? '-'),
        h('div', { class: 'text-xs text-muted-foreground' }, [
          `${row.pet_name ?? '无宠物'}${row.customer_no ? ` · ${row.customer_no}` : ''}`,
        ]),
      ])
    },
  },
  {
    id: 'source',
    header: '来源',
    width: 90,
    cell: (info: any) => {
      const v = (info.row.original as FollowupTaskRecord).source_type
      return FOLLOWUP_SOURCE_LABELS[v] ?? v
    },
  },
  {
    id: 'taskType',
    header: '任务类型',
    width: 110,
    cell: (info: any) => {
      const v = (info.row.original as FollowupTaskRecord).task_type
      return FOLLOWUP_TASK_TYPE_LABELS[v] ?? v
    },
  },
  {
    accessorKey: 'assignee_name',
    header: '负责人',
    width: 100,
    cell: (info: any) => info.getValue() || '-',
  },
  {
    id: 'status',
    header: '状态',
    width: 100,
    cell: (info: any) => {
      const v = (info.row.original as FollowupTaskRecord).status
      return h(EntityStatusTag, {
        label: FOLLOWUP_STATUS_LABELS[v] ?? v,
        variant: v === 'completed' ? 'success' : v === 'cancelled' ? 'neutral' : v === 'in_progress' ? 'info' : 'warning',
        dot: true,
      })
    },
  },
  {
    id: 'next',
    header: '下一步',
    width: 130,
    cell: (info: any) => {
      const v = (info.row.original as FollowupTaskRecord).next_followup_at
      return v ? fmtDateTime(v) : '-'
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 110,
    align: 'left',
    fixed: 'right',
  },
])
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告 #8) -->
    <!--
    <EntityPageHeader compact title="回访任务" description="客户回访 · 逾期跟踪 · 结果登记">
      <template #actions>
        <FaButton size="sm" @click="createVisible = true">
          <FaIcon name="i-lucide:plus" />
          新建回访
        </FaButton>
      </template>
    </EntityPageHeader>
    -->

    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <div class="px-4 pt-3 border-b shrink-0">
          <FaTabs v-model="activeBucket" :list="BUCKETS" class="mb-2" @update:model-value="onBucketChange" />
          <div class="flex flex-wrap gap-3 items-center pb-3">
            <FaInput
              v-model="search.keyword"
              placeholder="客户姓名 / 手机号"
              class="w-64"
              clearable
              @keydown.enter="currentChange()"
              @clear="currentChange()"
            />
            <FaSelect v-model="search.storeId" :options="storeOptions" class="w-40" @change="currentChange()" />
            <FaButton size="sm" @click="createVisible = true">
              <FaIcon name="i-lucide:plus" />
              新建回访
            </FaButton>
            <div class="ml-auto flex gap-2 items-center">
              <FaButton size="sm" variant="outline" @click="searchReset">
                重置
              </FaButton>
              <FaButton size="sm" @click="currentChange()">
                <FaIcon name="i-lucide:search" />
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
              <TablePrimaryAction
                primary-label="查看"
                primary-icon="i-lucide:eye"
                @primary="onView(row.original)"
              />
            </template>
            <template #empty>
              <FaEmptyState description="暂无回访任务" />
            </template>
          </FaTable>
        </div>
        <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2 px-4 pb-3 shrink-0" @page-change="currentChange" @size-change="sizeChange" />
      </div>
    </div>

    <FollowupDetailDrawer
      v-model="detailVisible"
      :task-id="detailTaskId"
      @changed="onChanged"
    />
    <FollowupCreateDrawer
      v-model="createVisible"
      :tenant-id="tenantStore.currentTenantId"
      :store-id="search.storeId || undefined"
      @created="onCreated"
    />
  </div>
</template>
