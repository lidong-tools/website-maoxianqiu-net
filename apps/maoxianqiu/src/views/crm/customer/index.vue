<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiCustomer from '@/api/modules/customer'
import apiStore from '@/api/modules/store'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { CUSTOMER_STATUS_LABELS, MEMBER_LEVEL_LABELS } from '@/types/customer'

defineOptions({
  name: 'CrmCustomer',
})

interface CustomerRow {
  id: string
  customer_no: string
  name: string
  phone: string | null
  email: string | null
  member_level: string
  status: string
  store_id: string | null
  created_at: string
}

const router = useRouter()
const tenantStore = useAppTenantStore()
const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const loading = ref(false)
const dataList = ref<CustomerRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  keyword: '',
  storeId: '',
  status: '',
})
const petCountMap = ref<Record<string, number>>({})

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

async function enrichPetCounts(rows: CustomerRow[]) {
  const ids = rows.map(r => r.id)
  if (!ids.length) {
    return
  }
  const { data, error } = await supabase
    .from('pets')
    .select('customer_id')
    .in('customer_id', ids)
    .neq('status', 'archived')
  if (error) {
    return
  }
  const counts: Record<string, number> = {}
  data?.forEach((p: any) => {
    counts[p.customer_id] = (counts[p.customer_id] ?? 0) + 1
  })
  petCountMap.value = counts
}

function getDataList() {
  loading.value = true
  apiCustomer.list({
    keyword: search.value.keyword || undefined,
    storeId: search.value.storeId || undefined,
    status: (search.value.status as any) || undefined,
    ...getParams(),
  }).then(async (res: any) => {
    loading.value = false
    dataList.value = res.data.list ?? []
    pagination.value.total = res.data.total
    await enrichPetCounts(dataList.value)
  }).catch(() => {
    loading.value = false
  })
}

onMounted(async () => {
  await loadStoreOptions()
  if (tenantStore.currentStoreId) {
    search.value.storeId = tenantStore.currentStoreId
  }
  getDataList()
})

function sizeChange(size: number) {
  onSizeChange(size).then(() => getDataList())
}

function currentChange(page = 1) {
  onCurrentChange(page).then(() => getDataList())
}

function searchReset() {
  search.value.keyword = ''
  search.value.status = ''
  currentChange()
}

function onView(row: CustomerRow) {
  router.push(`/crm/customer/${row.id}`)
}

function onEdit(row: CustomerRow) {
  router.push(`/crm/customer/${row.id}?mode=edit`)
}

function onImport() {
  useFaModal().confirm({
    title: '导入客户',
    content: '导入功能开发中,将通过文件上传创建导入任务并追踪进度。',
    onConfirm: () => {
      useFaToast().info('导入功能开发中')
    },
  })
}

function moreFor(row: CustomerRow) {
  return [
    { label: '编辑', icon: 'i-lucide:pencil', onClick: () => onEdit(row) },
  ]
}

const tableColumns = computed<TableColumn<CustomerRow>[]>(() => [
  {
    id: 'identity',
    header: '客户',
    cell: (info: any) => {
      const row = info.row.original as CustomerRow
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'font-medium text-sm' }, row.name),
        h('div', { class: 'text-xs text-muted-foreground' }, `${row.customer_no}${row.phone ? ` · ${row.phone}` : ''}`),
      ])
    },
  },
  {
    id: 'petCount',
    header: '宠物',
    cell: (info: any) => `${petCountMap.value[(info.row.original as CustomerRow).id] ?? 0} 只`,
  },
  {
    accessorKey: 'member_level',
    header: '会员等级',
    cell: (info: any) => MEMBER_LEVEL_LABELS[info.getValue() as keyof typeof MEMBER_LEVEL_LABELS] ?? info.getValue(),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as string
      return h(EntityStatusTag, { label: CUSTOMER_STATUS_LABELS[v as keyof typeof CUSTOMER_STATUS_LABELS] ?? v, variant: v === 'active' ? 'success' : v === 'merged' ? 'warning' : 'neutral', dot: true })
    },
  },
  {
    accessorKey: 'created_at',
    header: '建档时间',
    cell: (info: any) => {
      const v = info.getValue()
      return v ? new Date(v).toLocaleDateString('zh-CN') : '-'
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 150,
    align: 'right',
    fixed: 'right',
  },
])
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="客户管理" description="客户档案 · 宠物数量 · 会员等级">
      <template #actions>
        <FaButton size="sm" variant="outline" @click="onImport">
          <FaIcon name="i-lucide:upload" />
          导入
        </FaButton>
        <FaButton size="sm" @click="router.push('/crm/customer/new')">
          <FaIcon name="i-lucide:plus" />
          新建客户
        </FaButton>
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <div class="px-4 py-3 border-b">
          <div class="flex flex-wrap gap-3 items-center">
            <FaInput
              v-model="search.keyword"
              placeholder="姓名 / 手机号 / 编号"
              class="w-64"
              clearable
              @keydown.enter="currentChange()"
              @clear="currentChange()"
            />
            <FaSelect v-model="search.storeId" :options="storeOptions" class="w-40" @change="currentChange()" />
            <FaSelect
              v-model="search.status"
              :options="[
                { label: '全部状态', value: '' },
                { label: '活跃', value: 'active' },
                { label: '已归档', value: 'archived' },
                { label: '已合并', value: 'merged' },
              ]"
              class="w-36"
              @change="currentChange()"
            />
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

        <div v-loading="loading" class="flex-1 min-h-0 overflow-auto">
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
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
                :more="moreFor(row.original)"
                @primary="onView(row.original)"
              />
            </template>
          </FaTable>
        </div>
        <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2 px-4 pb-3" @page-change="currentChange" @size-change="sizeChange" />
      </div>
    </div>
  </div>
</template>
