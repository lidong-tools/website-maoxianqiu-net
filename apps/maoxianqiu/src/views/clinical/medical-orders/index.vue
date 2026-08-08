<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { MedicalOrderStatus, MedicalOrderType } from '@/types/clinical'
import type { CustomerRecord, PetRecord } from '@/types/customer'
import apiClinical from '@/api/modules/clinical'
import apiStore from '@/api/modules/store'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import BusinessPetPicker from '@/components/business/PetPicker/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { MEDICAL_ORDER_STATUS_LABELS, MEDICAL_ORDER_TYPE_LABELS } from '@/types/clinical'

defineOptions({
  name: 'ClinicalMedicalOrders',
})

interface MedicalOrderRow {
  id: string
  order_no: string
  encounter_id: string | null
  admission_id: string | null
  pet_id: string
  customer_id: string | null
  order_type: MedicalOrderType
  item_name: string
  dosage: string | null
  frequency: string | null
  quantity: number
  unit: string | null
  instructions: string | null
  scheduled_at: string | null
  assignee_id: string | null
  status: MedicalOrderStatus
  created_at: string
  store_id: string | null
}

const tenantStore = useAppTenantStore()
const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const loading = ref(false)
const dataList = ref<MedicalOrderRow[]>([])
const statsList = ref<MedicalOrderRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  storeId: '',
  status: '',
  orderType: '',
})
const activeTab = ref('all')

const petMap = ref<Record<string, PetRecord>>({})
const customerMap = ref<Record<string, CustomerRecord>>({})

/** 开立医嘱弹窗 */
const createVisible = ref(false)
const createForm = reactive({
  petId: '',
  itemName: '',
  orderType: 'treatment' as MedicalOrderType,
  dosage: '',
  frequency: '',
  quantity: 1,
  unit: '',
  instructions: '',
  scheduledAt: '',
})
const creating = ref(false)

/** 取消医嘱弹窗 */
const cancelVisible = ref(false)
const cancelTarget = ref<MedicalOrderRow | null>(null)
const cancelReason = ref('')
const cancelling = ref(false)

const TABS = [
  { label: '全部', value: 'all' },
  { label: '执行中', value: 'active' },
  { label: '已完成', value: 'completed' },
  { label: '已取消', value: 'cancelled' },
  { label: '已过期', value: 'expired' },
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

async function enrich(rows: MedicalOrderRow[]) {
  const petIds = [...new Set(rows.map(r => r.pet_id).filter(Boolean))]
  const customerIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean) as string[])]
  if (petIds.length) {
    const { data } = await supabase.from('pets').select('*').in('id', petIds)
    data?.forEach((p) => { petMap.value[p.id] = p as PetRecord })
  }
  if (customerIds.length) {
    const { data } = await supabase.from('customers').select('*').in('id', customerIds)
    data?.forEach((c) => { customerMap.value[c.id] = c as CustomerRecord })
  }
}

function getDataList() {
  loading.value = true
  const status = activeTab.value === 'all' ? undefined : (activeTab.value as MedicalOrderStatus)
  apiClinical.listMedicalOrders({
    storeId: search.value.storeId || undefined,
    status,
    orderType: (search.value.orderType as MedicalOrderType) || undefined,
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

async function loadStats() {
  try {
    const res: any = await apiClinical.listMedicalOrders({
      storeId: search.value.storeId || undefined,
      page: 1,
      pageSize: 500,
    })
    statsList.value = res.data.list ?? []
    await enrich(statsList.value)
  }
  catch {
    statsList.value = []
  }
}

const activeCount = computed(() => statsList.value.filter(r => r.status === 'active').length)
const completedCount = computed(() => statsList.value.filter(r => r.status === 'completed').length)
const cancelledCount = computed(() => statsList.value.filter(r => r.status === 'cancelled').length)

// P0-06:切店后重置分页与门店筛选并重载列表/统计
useStoreScopedPage({
  load: () => {
    getDataList()
    loadStats()
  },
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
  loadStats()
})

function onTabChange(val: string) {
  activeTab.value = val
  onCurrentChange(1).then(() => getDataList())
}

function sizeChange(size: number) {
  onSizeChange(size).then(() => getDataList())
}

function currentChange(page = 1) {
  onCurrentChange(page).then(() => getDataList())
}

function searchReset() {
  search.value.orderType = ''
  currentChange()
}

async function onCreate() {
  if (!createForm.petId || !createForm.itemName) {
    useFaToast().warning('请选择宠物并填写医嘱项目')
    return
  }
  creating.value = true
  try {
    const res: any = await apiClinical.createMedicalOrder({
      tenantId: tenantStore.currentTenantId || '',
      storeId: search.value.storeId || undefined,
      petId: createForm.petId,
      orderType: createForm.orderType,
      itemName: createForm.itemName,
      dosage: createForm.dosage || undefined,
      frequency: createForm.frequency || undefined,
      quantity: createForm.quantity,
      unit: createForm.unit || undefined,
      instructions: createForm.instructions || undefined,
      scheduledAt: createForm.scheduledAt || undefined,
    })
    useFaToast().success(`医嘱已开立(${res.data?.orderNo ?? ''}),已自动生成护士任务`)
    createVisible.value = false
    createForm.petId = ''
    createForm.itemName = ''
    createForm.orderType = 'treatment'
    createForm.dosage = ''
    createForm.frequency = ''
    createForm.quantity = 1
    createForm.unit = ''
    createForm.instructions = ''
    createForm.scheduledAt = ''
    getDataList()
    loadStats()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '开立失败')
  }
  finally {
    creating.value = false
  }
}

function openCancel(row: MedicalOrderRow) {
  cancelTarget.value = row
  cancelReason.value = ''
  cancelVisible.value = true
}

async function onCancel() {
  if (!cancelTarget.value) {
    return
  }
  cancelling.value = true
  try {
    await apiClinical.cancelMedicalOrder(cancelTarget.value.id, cancelReason.value.trim() || undefined)
    useFaToast().success('医嘱已取消')
    cancelVisible.value = false
    getDataList()
    loadStats()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
  finally {
    cancelling.value = false
  }
}

function displayRow(row: MedicalOrderRow) {
  const pet = petMap.value[row.pet_id]
  const customer = row.customer_id ? customerMap.value[row.customer_id] : undefined
  return {
    petName: pet?.name ?? '未知宠物',
    customerName: customer?.name ?? '',
  }
}

const tableColumns = computed<TableColumn<MedicalOrderRow>[]>(() => [
  { accessorKey: 'order_no', header: '医嘱单号' },
  {
    id: 'patient',
    header: '宠物/主人',
    cell: (info: any) => {
      const d = displayRow(info.row.original)
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'font-medium text-xs' }, d.petName),
        h('div', { class: 'text-xs text-muted-foreground' }, d.customerName || '-'),
      ])
    },
  },
  { accessorKey: 'item_name', header: '医嘱项目' },
  {
    accessorKey: 'order_type',
    header: '类型',
    cell: (info: any) => MEDICAL_ORDER_TYPE_LABELS[info.getValue() as keyof typeof MEDICAL_ORDER_TYPE_LABELS] ?? info.getValue(),
  },
  {
    accessorKey: 'dosage',
    header: '剂量',
    cell: (info: any) => {
      const row = info.row.original as MedicalOrderRow
      return row.dosage ? `${row.dosage}${row.unit ? ` ${row.unit}` : ''}` : '-'
    },
  },
  { accessorKey: 'frequency', header: '频次', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'scheduled_at',
    header: '计划执行',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '立即执行',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as MedicalOrderStatus
      return h(EntityStatusTag, { label: MEDICAL_ORDER_STATUS_LABELS[v] ?? v, variant: v === 'completed' ? 'success' : v === 'cancelled' || v === 'expired' ? 'neutral' : 'info', dot: true })
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 120,
    align: 'right',
    fixed: 'right',
  },
])
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="医嘱管理" description="医生开立医嘱自动生成护士任务 · 状态闭环">
      <template #actions>
        <FaButton size="sm" @click="createVisible = true">
          <FaIcon name="i-lucide:plus" />
          开立医嘱
        </FaButton>
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <!-- 状态统计 -->
      <div class="gap-4 grid grid-cols-3">
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ activeCount }}
          </div>
          <div class="text-xs text-muted-foreground">
            执行中
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ completedCount }}
          </div>
          <div class="text-xs text-muted-foreground">
            已完成
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ cancelledCount }}
          </div>
          <div class="text-xs text-muted-foreground">
            已取消
          </div>
        </div>
      </div>

      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <!-- 状态 Tabs + 筛选 -->
        <div class="px-4 py-2 border-b flex flex-wrap gap-2 items-center">
          <div class="flex gap-1 items-center">
            <FaButton
              v-for="tab in TABS"
              :key="tab.value"
              size="sm"
              :variant="activeTab === tab.value ? 'default' : 'ghost'"
              @click="onTabChange(tab.value)"
            >
              {{ tab.label }}
            </FaButton>
          </div>
          <div class="ml-auto flex gap-2 items-center">
            <FaSelect v-model="search.storeId" :options="storeOptions" class="w-36" @change="currentChange()" />
            <FaSelect
              v-model="search.orderType"
              :options="[
                { label: '全部类型', value: '' },
                { label: '注射', value: 'injection' },
                { label: '输液', value: 'infusion' },
                { label: '治疗', value: 'treatment' },
                { label: '处置', value: 'disposal' },
                { label: '护理', value: 'nursing' },
                { label: '用药', value: 'medication' },
                { label: '其他', value: 'other' },
              ]"
              class="w-32"
              @change="currentChange()"
            />
            <FaButton size="sm" variant="outline" @click="searchReset">
              重置
            </FaButton>
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
                v-if="row.original.status === 'active'"
                primary-label="取消"
                primary-icon="i-lucide:ban"
                :more="[]"
                @primary="openCancel(row.original)"
              />
            </template>
          </FaTable>
        </div>
        <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2 px-4 pb-3" @page-change="currentChange" @size-change="sizeChange" />
      </div>
    </div>

    <!-- 开立医嘱弹窗 -->
    <FaModal v-model:visible="createVisible" title="开立医嘱" :loading="creating" @confirm="onCreate">
      <div class="space-y-3">
        <FaLabel label="宠物" required>
          <BusinessPetPicker v-model="createForm.petId" placeholder="搜索选择宠物" />
        </FaLabel>
        <FaLabel label="医嘱项目" required>
          <FaInput v-model="createForm.itemName" placeholder="如:静脉输液 / 皮下注射 / 换药" class="w-full" />
        </FaLabel>
        <div class="gap-x-4 gap-y-3 grid grid-cols-2">
          <FaLabel label="类型">
            <FaSelect
              v-model="createForm.orderType"
              :options="[
                { label: '注射', value: 'injection' },
                { label: '输液', value: 'infusion' },
                { label: '治疗', value: 'treatment' },
                { label: '处置', value: 'disposal' },
                { label: '护理', value: 'nursing' },
                { label: '用药', value: 'medication' },
                { label: '其他', value: 'other' },
              ]"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="频次">
            <FaInput v-model="createForm.frequency" placeholder="如 qd / bid / tid" class="w-full" />
          </FaLabel>
          <FaLabel label="剂量">
            <FaInput v-model="createForm.dosage" placeholder="如 2ml" class="w-full" />
          </FaLabel>
          <FaLabel label="数量/单位">
            <div class="flex gap-2">
              <FaInputNumber v-model="createForm.quantity" :min="0" class="flex-1" />
              <FaInput v-model="createForm.unit" placeholder="单位" class="w-24" />
            </div>
          </FaLabel>
        </div>
        <FaLabel label="执行说明">
          <FaInput v-model="createForm.instructions" type="textarea" :rows="2" placeholder="医嘱执行说明(可选)" class="w-full" />
        </FaLabel>
        <FaLabel label="计划执行时间">
          <FaInput v-model="createForm.scheduledAt" type="datetime-local" class="w-full" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 取消医嘱弹窗 -->
    <FaModal v-model:visible="cancelVisible" title="取消医嘱" :loading="cancelling" @confirm="onCancel">
      <div class="space-y-3">
        <FaAlert type="warning" :closable="false">
          医嘱"{{ cancelTarget?.item_name }}"将被取消,未执行的护士任务同步取消,已执行任务永久保留
        </FaAlert>
        <FaLabel label="取消原因">
          <FaInput v-model="cancelReason" placeholder="可选" class="w-full" />
        </FaLabel>
      </div>
    </FaModal>
  </div>
</template>
