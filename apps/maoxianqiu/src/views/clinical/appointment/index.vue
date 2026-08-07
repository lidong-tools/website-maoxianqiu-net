<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { AppointmentStatus } from '@/types/clinical'
import apiClinical from '@/api/modules/clinical'
import apiStore from '@/api/modules/store'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { APPOINTMENT_SOURCE_LABELS, APPOINTMENT_STATUS_LABELS } from '@/types/clinical'

defineOptions({
  name: 'ClinicalAppointment',
})

interface AppointmentRow {
  id: string
  customer_id: string
  pet_id: string
  doctor_id: string | null
  scheduled_start: string
  scheduled_end: string
  reason: string | null
  status: AppointmentStatus
  source: string
  store_id: string | null
}

const router = useRouter()
const tenantStore = useAppTenantStore()
const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const loading = ref(false)
const dataList = ref<AppointmentRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  storeId: '',
  status: '',
  dateFrom: '',
  dateTo: '',
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
 * 获取预约列表
 */
function getDataList() {
  loading.value = true
  apiClinical.listAppointments({
    storeId: search.value.storeId || undefined,
    status: (search.value.status as AppointmentStatus) || undefined,
    dateFrom: search.value.dateFrom || undefined,
    dateTo: search.value.dateTo || undefined,
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
  search.value.status = ''
  search.value.dateFrom = ''
  search.value.dateTo = ''
  currentChange()
}

/**
 * 推进预约状态(确认/报到/开始/完成)
 */
async function onTransition(row: AppointmentRow, target: AppointmentStatus, label: string) {
  try {
    await apiClinical.transitionAppointment(row.id, target)
    useFaToast().success(`${label}成功`)
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || `${label}失败`)
  }
}

/**
 * 跳转就诊工作台
 */
function onWorkbench() {
  router.push('/clinical/workbench')
}

const tableColumns = computed<TableColumn<AppointmentRow>[]>(() => [
  {
    accessorKey: 'scheduled_start',
    header: '预约时间',
    cell: (info: any) => {
      const v = info.getValue()
      return v ? new Date(v).toLocaleString('zh-CN') : '-'
    },
  },
  {
    accessorKey: 'customer_id',
    header: '客户 ID',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-',
  },
  {
    accessorKey: 'pet_id',
    header: '宠物 ID',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-',
  },
  {
    accessorKey: 'reason',
    header: '就诊原因',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'source',
    header: '来源',
    cell: (info: any) => APPOINTMENT_SOURCE_LABELS[info.getValue() as keyof typeof APPOINTMENT_SOURCE_LABELS] ?? info.getValue(),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue()
      const label = APPOINTMENT_STATUS_LABELS[v as keyof typeof APPOINTMENT_STATUS_LABELS] ?? v
      return h('span', { class: 'px-2 py-0.5 rounded text-xs bg-default-100' }, label)
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 220,
    align: 'center',
    fixed: 'right',
  },
])
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="预约管理" class="mb-0">
      <template #description>
        管理宠物医院预约,支持状态机推进(确认→候诊→就诊→完成)
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="门店" class="col-span-1">
              <FaSelect v-model="search.storeId" :options="storeOptions" class="w-full" @change="currentChange()" />
            </FaLabel>
            <FaLabel label="状态" class="col-span-1">
              <FaSelect
                v-model="search.status"
                :options="[
                  { label: '全部', value: '' },
                  { label: '待确认', value: 'pending' },
                  { label: '已确认', value: 'confirmed' },
                  { label: '已候诊', value: 'checked_in' },
                  { label: '就诊中', value: 'in_progress' },
                  { label: '已完成', value: 'completed' },
                  { label: '已取消', value: 'cancelled' },
                  { label: '爽约', value: 'no_show' },
                ]"
                class="w-full"
                @change="currentChange()"
              />
            </FaLabel>
            <FaLabel label="开始日期" class="col-span-1">
              <FaInput v-model="search.dateFrom" type="date" class="w-full" @change="currentChange()" />
            </FaLabel>
            <FaLabel label="结束日期" class="col-span-1">
              <FaInput v-model="search.dateTo" type="date" class="w-full" @change="currentChange()" />
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
          <FaButton @click="onWorkbench">
            <FaIcon name="i-ri:stethoscope-line" />
            前往工作台
          </FaButton>
        </template>
        <template #cell-operation="{ row }">
          <div class="flex-center flex-wrap gap-1">
            <FaButton v-if="row.original.status === 'pending'" variant="outline" size="sm" @click="onTransition(row.original, 'confirmed', '确认')">
              确认
            </FaButton>
            <FaButton v-if="row.original.status === 'confirmed'" variant="outline" size="sm" @click="onTransition(row.original, 'checked_in', '报到')">
              报到
            </FaButton>
            <FaButton v-if="row.original.status === 'checked_in'" variant="outline" size="sm" @click="onTransition(row.original, 'in_progress', '开始就诊')">
              就诊
            </FaButton>
            <FaButton v-if="row.original.status === 'in_progress'" variant="outline" size="sm" @click="onTransition(row.original, 'completed', '完成')">
              完成
            </FaButton>
            <FaButton
              v-if="!['completed', 'cancelled', 'no_show'].includes(row.original.status)"
              variant="outline"
              size="sm"
              @click="onTransition(row.original, 'cancelled', '取消')"
            >
              取消
            </FaButton>
            <FaButton
              v-if="!['completed', 'cancelled', 'no_show'].includes(row.original.status)"
              variant="outline"
              size="sm"
              @click="onTransition(row.original, 'no_show', '标记爽约')"
            >
              爽约
            </FaButton>
          </div>
        </template>
      </FaTable>
      <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />
    </FaPageMain>
  </div>
</template>
