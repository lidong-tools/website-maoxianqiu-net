<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { AppointmentStatus } from '@/types/clinical'
import type { CustomerRecord, PetRecord } from '@/types/customer'
import apiClinical from '@/api/modules/clinical'
import apiStore from '@/api/modules/store'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import { supabase } from '@/lib/supabase'
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
const petMap = ref<Record<string, PetRecord>>({})
const customerMap = ref<Record<string, CustomerRecord>>({})

async function enrich(rows: AppointmentRow[]) {
  const petIds = [...new Set(rows.map(r => r.pet_id).filter(Boolean))]
  const customerIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))]
  if (petIds.length) {
    const { data } = await supabase.from('pets').select('*').in('id', petIds)
    data?.forEach((p) => { petMap.value[p.id] = p as PetRecord })
  }
  if (customerIds.length) {
    const { data } = await supabase.from('customers').select('*').in('id', customerIds)
    data?.forEach((c) => { customerMap.value[c.id] = c as CustomerRecord })
  }
}

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
  }).then(async (res: any) => {
    loading.value = false
    dataList.value = res.data.list ?? []
    pagination.value.total = res.data.total
    await enrich(dataList.value)
  }).catch(() => {
    loading.value = false
  })
}

/** 状态对应的下一步动作 */
function nextActionFor(row: AppointmentRow) {
  if (row.status === 'pending') {
    return { label: '确认', target: 'confirmed' as AppointmentStatus }
  }
  if (row.status === 'confirmed') {
    return { label: '报到', target: 'checked_in' as AppointmentStatus }
  }
  if (row.status === 'checked_in') {
    return { label: '进入候诊', target: 'in_progress' as AppointmentStatus }
  }
  if (row.status === 'in_progress') {
    return { label: '完成', target: 'completed' as AppointmentStatus }
  }
  return null
}

function statusVariant(s: AppointmentStatus): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  if (s === 'completed') { return 'success' }
  if (s === 'cancelled' || s === 'no_show') { return 'danger' }
  if (s === 'in_progress') { return 'info' }
  if (s === 'checked_in') { return 'warning' }
  return 'neutral'
}

function moreFor(row: AppointmentRow) {
  if (['completed', 'cancelled', 'no_show'].includes(row.status)) {
    return []
  }
  return [
    { label: '取消', icon: 'i-lucide:ban', onClick: () => onTransition(row, 'cancelled', '取消') },
    { label: '标记爽约', icon: 'i-lucide:user-x', onClick: () => onTransition(row, 'no_show', '标记爽约') },
  ]
}

// P0-06:切店后重置分页与门店筛选并重载
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
    id: 'patient',
    header: '宠物/主人',
    cell: (info: any) => {
      const row = info.row.original as AppointmentRow
      const pet = petMap.value[row.pet_id]
      const customer = customerMap.value[row.customer_id]
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-xs font-medium' }, pet?.name ?? '未知宠物'),
        h('div', { class: 'text-xs text-muted-foreground' }, customer ? `${customer.name}${customer.phone ? ` · ${customer.phone}` : ''}` : '未知主人'),
      ])
    },
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
      const v = info.getValue() as AppointmentStatus
      return h(EntityStatusTag, { label: APPOINTMENT_STATUS_LABELS[v] ?? v, variant: statusVariant(v), dot: true })
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 180,
    align: 'right',
    fixed: 'right',
  },
])
</script>

<template>
  <div>
    <EntityPageHeader compact title="预约管理" description="管理宠物医院预约,支持状态机推进(确认→候诊→就诊→完成)" />
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
          <TablePrimaryAction
            v-if="nextActionFor(row.original)"
            :primary-label="nextActionFor(row.original)!.label"
            :more="moreFor(row.original)"
            @primary="onTransition(row.original, nextActionFor(row.original)!.target, nextActionFor(row.original)!.label)"
          />
        </template>
      </FaTable>
      <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />
    </FaPageMain>
  </div>
</template>
