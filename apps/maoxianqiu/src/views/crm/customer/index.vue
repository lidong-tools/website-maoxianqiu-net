<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiCustomer from '@/api/modules/customer'
import apiStore from '@/api/modules/store'
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

/**
 * 加载门店选项(用于筛选)
 */
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

/**
 * 获取客户列表
 */
function getDataList() {
  loading.value = true
  apiCustomer.list({
    keyword: search.value.keyword || undefined,
    storeId: search.value.storeId || undefined,
    status: (search.value.status as any) || undefined,
    ...getParams(),
  }).then((res: any) => {
    loading.value = false
    dataList.value = res.data.list ?? []
    pagination.value.total = res.data.total
  }).catch(() => {
    loading.value = false
  })
}

onMounted(async () => {
  await loadStoreOptions()
  // 默认使用当前门店上下文
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

/**
 * 跳转客户详情
 */
function onView(row: CustomerRow) {
  router.push(`/crm/customer/${row.id}`)
}

/**
 * 跳转客户编辑(复用详情页)
 */
function onEdit(row: CustomerRow) {
  router.push(`/crm/customer/${row.id}?mode=edit`)
}

/**
 * 导入客户(MXQ-5010,UI占位)
 * 实际导入流程:上传文件 → 创建导入任务 → 轮询进度
 */
function onImport() {
  useFaModal().confirm({
    title: '导入客户',
    content: '导入功能开发中,将通过文件上传创建导入任务并追踪进度。',
    onConfirm: () => {
      useFaToast().info('导入功能开发中')
    },
  })
}

const tableColumns = computed<TableColumn<CustomerRow>[]>(() => [
  { accessorKey: 'customer_no', header: '客户编号' },
  { accessorKey: 'name', header: '姓名' },
  {
    accessorKey: 'phone',
    header: '手机号',
    cell: (info: any) => info.getValue() ?? '-',
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
      const v = info.getValue()
      const label = CUSTOMER_STATUS_LABELS[v as keyof typeof CUSTOMER_STATUS_LABELS] ?? v
      const colorMap: Record<string, string> = {
        active: 'success',
        archived: 'default',
        merged: 'warning',
      }
      return h('span', {
        class: `inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-${colorMap[v] ?? 'default'}-100 text-${colorMap[v] ?? 'default'}-700`,
      }, label)
    },
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: (info: any) => {
      const v = info.getValue()
      return v ? new Date(v).toLocaleDateString('zh-CN') : '-'
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 120,
    align: 'center',
    fixed: 'right',
  },
])
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="客户管理" class="mb-0">
      <template #description>
        管理宠物医院客户档案,支持搜索、分页、状态筛选
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="门店" class="col-span-1">
              <FaSelect v-model="search.storeId" :options="storeOptions" class="w-full" @change="currentChange()" />
            </FaLabel>
            <FaLabel label="关键词" class="col-span-1">
              <FaInput
                v-model="search.keyword"
                placeholder="姓名/手机号/编号"
                clearable
                class="w-full"
                @keydown.enter="currentChange()"
                @clear="currentChange()"
              />
            </FaLabel>
            <FaLabel label="状态" class="col-span-1">
              <FaSelect
                v-model="search.status"
                :options="[
                  { label: '全部', value: '' },
                  { label: '活跃', value: 'active' },
                  { label: '已归档', value: 'archived' },
                  { label: '已合并', value: 'merged' },
                ]"
                class="w-full"
                @change="currentChange()"
              />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton variant="outline" @click="searchReset()">
                重置
              </FaButton>
              <FaButton type="primary" @click="currentChange()">
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
          <FaButton @click="router.push('/crm/customer/new')">
            <FaIcon name="i-ri:add-line" />
            新增客户
          </FaButton>
          <FaButton variant="outline" @click="onImport">
            <FaIcon name="i-ri:upload-line" />
            导入客户
          </FaButton>
        </template>
        <template #cell-operation="{ row }">
          <div class="flex-center gap-2">
            <FaButton variant="outline" size="icon-sm" @click="onView(row.original)">
              <FaIcon name="i-ri:eye-line" />
            </FaButton>
            <FaButton variant="outline" size="icon-sm" @click="onEdit(row.original)">
              <FaIcon name="i-ri:edit-line" />
            </FaButton>
          </div>
        </template>
      </FaTable>
      <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />
    </FaPageMain>
  </div>
</template>
