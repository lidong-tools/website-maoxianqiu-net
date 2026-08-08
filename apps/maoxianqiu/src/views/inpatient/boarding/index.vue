<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { CustomerRecord, PetRecord } from '@/types/customer'
import type { BoardingCageStatusView, BoardingStay, BoardingStayStatus } from '@/types/inpatient-boarding'
import apiBoarding, { generateBoardingIdempotencyKey } from '@/api/modules/inpatient-boarding'
import CustomerPicker from '@/components/business/CustomerPicker/index.vue'
import PetPicker from '@/components/business/PetPicker/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { BOARDING_STATUS_LABELS } from '@/types/inpatient-boarding'

defineOptions({
  name: 'InpatientBoarding',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const activeTab = ref('cages')

const TABS = [
  { label: '房态', value: 'cages' },
  { label: '当前寄养', value: 'current' },
  { label: '预约入住', value: 'planned' },
  { label: '历史', value: 'history' },
]

const cageStatusList = ref<BoardingCageStatusView[]>([])
const currentStays = ref<BoardingStay[]>([])
const plannedStays = ref<BoardingStay[]>([])
const historyStays = ref<BoardingStay[]>([])
const petMap = ref<Record<string, PetRecord>>({})
const customerMap = ref<Record<string, CustomerRecord>>({})

const ACTIVE_STATUSES: BoardingStayStatus[] = ['checked_in', 'in_service', 'checkout_pending']

/** 可入住/可换的笼位(空闲,不区分房间类型,展示房间名) */
const availableCages = computed(() => cageStatusList.value.filter(c => c.cage_status === 'available'))

function petName(id: string): string {
  return petMap.value[id]?.name ?? id.slice(0, 8)
}
function customerName(id: string): string {
  return customerMap.value[id]?.name ?? '未知主人'
}

async function enrich(rows: BoardingStay[]) {
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

async function loadCageStatus() {
  try {
    cageStatusList.value = await apiBoarding.listBoardingCageStatus(tenantStore.currentStoreId || undefined)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载寄养房态失败')
  }
}

async function loadStays() {
  const storeId = tenantStore.currentStoreId || undefined
  const [current, planned, history] = await Promise.all([
    apiBoarding.listBoardingStays(storeId),
    apiBoarding.listBoardingStays(storeId, 'planned'),
    apiBoarding.listBoardingStays(storeId),
  ])
  const all = [...current.data.list, ...planned.data.list, ...history.data.list]
  currentStays.value = current.data.list.filter(s => ACTIVE_STATUSES.includes(s.status))
  plannedStays.value = planned.data.list.filter(s => s.status === 'planned')
  historyStays.value = history.data.list.filter(s => s.status === 'checked_out' || s.status === 'cancelled')
  await enrich(all)
}

async function load() {
  loading.value = true
  try {
    await Promise.all([loadCageStatus(), loadStays()])
  }
  finally {
    loading.value = false
  }
}

function onTabChange() {
  // 房态与寄养单共享笼位数据,无需重复请求;切店时统一重载
}

// ==================== 入住 / 预约抽屉 ====================

const formVisible = ref(false)
const formMode = ref<'checkin' | 'book'>('checkin')
const submitting = ref(false)
const form = reactive({
  customerId: '',
  petId: '',
  cageId: '',
  expectedCheckOutAt: '',
  dietNotes: '',
  walkingNotes: '',
  medicationNotes: '',
  vaccineVerified: false,
  riskAcknowledged: false,
  emergencyName: '',
  emergencyPhone: '',
  emergencyRelation: '',
})

function openForm(mode: 'checkin' | 'book') {
  formMode.value = mode
  Object.assign(form, {
    customerId: '',
    petId: '',
    cageId: '',
    expectedCheckOutAt: '',
    dietNotes: '',
    walkingNotes: '',
    medicationNotes: '',
    vaccineVerified: false,
    riskAcknowledged: false,
    emergencyName: '',
    emergencyPhone: '',
    emergencyRelation: '',
  })
  formVisible.value = true
}

async function onFormSubmit() {
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择工作门店')
    return
  }
  if (!form.customerId || !form.petId || !form.cageId) {
    useFaToast().warning('请选择客户、宠物与笼位')
    return
  }
  submitting.value = true
  try {
    const common = {
      expectedCheckOutAt: form.expectedCheckOutAt || undefined,
      dietNotes: form.dietNotes.trim() || undefined,
      walkingNotes: form.walkingNotes.trim() || undefined,
      medicationNotes: form.medicationNotes.trim() || undefined,
      vaccineVerified: form.vaccineVerified,
      riskAcknowledged: form.riskAcknowledged,
      emergencyContact: {
        name: form.emergencyName.trim() || undefined,
        phone: form.emergencyPhone.trim() || undefined,
        relation: form.emergencyRelation.trim() || undefined,
      },
    }
    if (formMode.value === 'book') {
      await apiBoarding.bookStay({
        tenantId: tenantStore.currentTenantId,
        storeId: tenantStore.currentStoreId,
        customerId: form.customerId,
        petId: form.petId,
        cageId: form.cageId,
        ...common,
      })
      useFaToast().success('预约成功')
    }
    else {
      await apiBoarding.checkInBoarding({
        tenantId: tenantStore.currentTenantId,
        storeId: tenantStore.currentStoreId,
        customerId: form.customerId,
        petId: form.petId,
        cageId: form.cageId,
        ...common,
      }, generateBoardingIdempotencyKey())
      useFaToast().success('入住成功')
    }
    formVisible.value = false
    await load()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

// ==================== 预约确认 / 取消 ====================

function onConfirmPlanned(stay: BoardingStay) {
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择工作门店')
    return
  }
  useFaModal().confirm({
    title: '确认入住',
    content: `确认将 ${petName(stay.pet_id)} 入住笼位吗？将锁定笼位并开始计费。`,
    onConfirm: async () => {
      try {
        await apiBoarding.checkInBoarding({
          tenantId: stay.tenant_id,
          storeId: stay.store_id,
          stayId: stay.id,
        }, generateBoardingIdempotencyKey())
        useFaToast().success('已入住')
        await load()
      }
      catch {
        // 已由拦截器提示
      }
    },
  })
}

function onCancelPlanned(stay: BoardingStay) {
  useFaModal().confirm({
    title: '取消预约',
    content: `确认取消 ${petName(stay.pet_id)} 的寄养预约吗？`,
    onConfirm: async () => {
      try {
        await apiBoarding.cancelBoarding(stay.id)
        useFaToast().success('已取消')
        await load()
      }
      catch {
        // 已由拦截器提示
      }
    },
  })
}

// ==================== 换笼位 ====================

function onChangeCage(stay: BoardingStay) {
  const candidates = availableCages.value.filter(c => c.cage_id !== stay.cage_id)
  if (candidates.length === 0) {
    useFaToast().warning('当前没有可用笼位可更换')
    return
  }
  let selectedCageId = ''
  useFaModal().create({
    title: '选择目标笼位',
    content: () => h('div', { class: 'py-2' }, [
      h('p', { class: 'text-sm mb-2' }, '请选择新的笼位:'),
      h('select', {
        class: 'w-full border rounded p-2',
        onChange: (e: Event) => {
          selectedCageId = (e.target as HTMLSelectElement).value
        },
      }, candidates.map(c => h('option', { value: c.cage_id }, `${c.cage_name} (${c.cage_code}) · ${c.room_name ?? ''}`))),
    ]),
    onConfirm: async () => {
      if (!selectedCageId) {
        useFaToast().warning('请选择目标笼位')
        return Promise.reject(new Error('no cage selected'))
      }
      try {
        await apiBoarding.changeCage(stay.id, { newCageId: selectedCageId }, generateBoardingIdempotencyKey())
        useFaToast().success('换笼位成功')
        await load()
      }
      catch {
        // 已由拦截器提示
      }
    },
  }).open()
}

// ==================== 离店 ====================

async function onCheckout(stay: BoardingStay) {
  let prepared: Awaited<ReturnType<typeof apiBoarding.prepareCheckout>>
  try {
    prepared = await apiBoarding.prepareCheckout(stay.id)
  }
  catch {
    return
  }
  useFaModal().confirm({
    title: '办理离店',
    content: `${petName(stay.pet_id)} 寄养 ${prepared.stayDays} 天,应收 ¥${prepared.totalCharge.toFixed(2)}。确认离店并释放笼位？`,
    onConfirm: async () => {
      try {
        await apiBoarding.checkoutBoarding(stay.id, generateBoardingIdempotencyKey())
        useFaToast().success('已离店')
        await load()
      }
      catch {
        // 已由拦截器提示
      }
    },
  })
}

// ==================== 详情抽屉 ====================

const detailVisible = ref(false)
const detailTab = ref('records')
const currentStay = ref<BoardingStay | null>(null)
const dailyRecords = ref<Awaited<ReturnType<typeof apiBoarding.listDailyRecords>>['data']['list']>([])
const serviceCharges = ref<Awaited<ReturnType<typeof apiBoarding.listServiceCharges>>['data']['list']>([])
const recordForm = reactive({ recordDate: '', feeding: '', walking: '', medication: '', condition: '', note: '' })
const chargeForm = reactive({ description: '', quantity: 1, unitPrice: 0, chargeDate: '' })

const DETAIL_TABS = [
  { label: '每日记录', value: 'records' },
  { label: '服务消费', value: 'charges' },
  { label: '入住要求', value: 'requirements' },
]

async function onOpenDetail(stay: BoardingStay) {
  currentStay.value = stay
  detailVisible.value = true
  detailTab.value = 'records'
  Object.assign(recordForm, { recordDate: new Date().toISOString().slice(0, 10), feeding: '', walking: '', medication: '', condition: '', note: '' })
  Object.assign(chargeForm, { description: '', quantity: 1, unitPrice: 0, chargeDate: new Date().toISOString().slice(0, 10) })
  await loadDetail()
}

async function loadDetail() {
  if (!currentStay.value) {
    return
  }
  const [records, charges] = await Promise.all([
    apiBoarding.listDailyRecords(currentStay.value.id),
    apiBoarding.listServiceCharges(currentStay.value.id),
  ])
  dailyRecords.value = records.data.list
  serviceCharges.value = charges.data.list
}

async function onRecordSubmit() {
  if (!currentStay.value) {
    return
  }
  try {
    await apiBoarding.recordDaily(currentStay.value.id, {
      recordDate: recordForm.recordDate || new Date().toISOString().slice(0, 10),
      feeding: recordForm.feeding.trim() || undefined,
      walking: recordForm.walking.trim() || undefined,
      medication: recordForm.medication.trim() || undefined,
      condition: recordForm.condition.trim() || undefined,
      note: recordForm.note.trim() || undefined,
    })
    useFaToast().success('照护记录已保存')
    await loadDetail()
  }
  catch {
    // 已由拦截器提示
  }
}

async function onChargeSubmit() {
  if (!currentStay.value) {
    return
  }
  try {
    await apiBoarding.addServiceCharge(currentStay.value.id, {
      description: chargeForm.description.trim() || undefined,
      quantity: chargeForm.quantity,
      unitPrice: chargeForm.unitPrice,
      chargeDate: chargeForm.chargeDate || new Date().toISOString().slice(0, 10),
    })
    useFaToast().success('服务费已添加')
    await loadDetail()
  }
  catch {
    // 已由拦截器提示
  }
}

// ==================== 表格列 ====================

const currentColumns = computed<TableColumn<BoardingStay>[]>(() => [
  {
    id: 'pet',
    header: '宠物',
    cell: (info: any) => {
      const row = info.row.original as BoardingStay
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-xs font-medium' }, petName(row.pet_id)),
        h('div', { class: 'text-xs text-muted-foreground' }, customerName(row.customer_id)),
      ])
    },
  },
  { accessorKey: 'boarding_no', header: '寄养单号' },
  {
    accessorKey: 'cage_id',
    header: '笼位',
    cell: (info: any) => {
      const cage = cageStatusList.value.find(c => c.cage_id === info.getValue())
      return cage ? `${cage.cage_name} (${cage.cage_code})` : String(info.getValue()).slice(0, 8)
    },
  },
  {
    accessorKey: 'check_in_at',
    header: '入住时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'expected_check_out_at',
    header: '预计离店',
    cell: (info: any) => info.getValue() ? new Date(info.getValue() as string).toLocaleDateString('zh-CN') : '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => h(EntityStatusTag, { label: BOARDING_STATUS_LABELS[info.getValue() as BoardingStayStatus] ?? info.getValue(), variant: statusVariant(info.getValue() as BoardingStayStatus), dot: true }),
  },
  {
    id: 'operation',
    header: '操作',
    width: 200,
    align: 'right',
    fixed: 'right',
  },
])

const plannedColumns = computed<TableColumn<BoardingStay>[]>(() => [
  {
    id: 'pet',
    header: '宠物',
    cell: (info: any) => {
      const row = info.row.original as BoardingStay
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-xs font-medium' }, petName(row.pet_id)),
        h('div', { class: 'text-xs text-muted-foreground' }, customerName(row.customer_id)),
      ])
    },
  },
  { accessorKey: 'boarding_no', header: '寄养单号' },
  {
    accessorKey: 'cage_id',
    header: '笼位',
    cell: (info: any) => {
      const cage = cageStatusList.value.find(c => c.cage_id === info.getValue())
      return cage ? `${cage.cage_name} (${cage.cage_code})` : String(info.getValue()).slice(0, 8)
    },
  },
  {
    accessorKey: 'check_in_at',
    header: '预计入住',
    cell: (info: any) => info.getValue() ? new Date(info.getValue() as string).toLocaleDateString('zh-CN') : '-',
  },
  {
    accessorKey: 'expected_check_out_at',
    header: '预计离店',
    cell: (info: any) => info.getValue() ? new Date(info.getValue() as string).toLocaleDateString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 180,
    align: 'right',
    fixed: 'right',
  },
])

const historyColumns = computed<TableColumn<BoardingStay>[]>(() => [
  {
    id: 'pet',
    header: '宠物',
    cell: (info: any) => {
      const row = info.row.original as BoardingStay
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-xs font-medium' }, petName(row.pet_id)),
        h('div', { class: 'text-xs text-muted-foreground' }, customerName(row.customer_id)),
      ])
    },
  },
  { accessorKey: 'boarding_no', header: '寄养单号' },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => h(EntityStatusTag, { label: BOARDING_STATUS_LABELS[info.getValue() as BoardingStayStatus] ?? info.getValue(), variant: statusVariant(info.getValue() as BoardingStayStatus), dot: true }),
  },
  {
    accessorKey: 'checked_out_at',
    header: '离店时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'total_charge',
    header: '总费用',
    cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  {
    id: 'operation',
    header: '操作',
    width: 90,
    align: 'right',
    fixed: 'right',
  },
])

function statusVariant(status: BoardingStayStatus): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'checked_out':
      return 'success'
    case 'checkout_pending':
      return 'warning'
    case 'cancelled':
      return 'warning'
    case 'checked_in':
    case 'in_service':
      return 'info'
    default:
      return 'neutral'
  }
}

// ==================== 房态分组 ====================

interface RoomGroup {
  room_id: string
  room_name: string
  cages: BoardingCageStatusView[]
  available_count: number
  occupied_count: number
  total_count: number
}

const groupedByRoom = computed<RoomGroup[]>(() => {
  const map = new Map<string, RoomGroup>()
  for (const cage of cageStatusList.value) {
    const key = cage.room_id
    if (!map.has(key)) {
      map.set(key, {
        room_id: cage.room_id,
        room_name: cage.room_name ?? '未分配房间',
        cages: [],
        available_count: 0,
        occupied_count: 0,
        total_count: 0,
      })
    }
    const group = map.get(key)!
    group.cages.push(cage)
    group.total_count += 1
    if (cage.cage_status === 'available') {
      group.available_count += 1
    }
    else if (cage.cage_status === 'occupied') {
      group.occupied_count += 1
    }
  }
  return Array.from(map.values())
})

const summary = computed(() => {
  const total = cageStatusList.value.length
  const available = cageStatusList.value.filter(c => c.cage_status === 'available').length
  const occupied = cageStatusList.value.filter(c => c.cage_status === 'occupied').length
  const maintenance = cageStatusList.value.filter(c => c.cage_status === 'maintenance').length
  const cleaning = cageStatusList.value.filter(c => c.cage_status === 'cleaning').length
  return { total, available, occupied, maintenance, cleaning }
})

// P0-06:切店后重载
useStoreScopedPage({
  load: async () => {
    await load()
  },
})

onMounted(load)
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="寄养管理" description="寄养与住院共享笼位 · 每日照护 · 额外服务 · 离店结算">
      <template #actions>
        <FaButton size="sm" variant="outline" @click="load">
          <FaIcon name="i-lucide:refresh-cw" />
          刷新
        </FaButton>
        <FaButton size="sm" variant="outline" @click="openForm('book')">
          <FaIcon name="i-lucide:calendar-plus" />
          预约入住
        </FaButton>
        <FaButton size="sm" @click="openForm('checkin')">
          <FaIcon name="i-lucide:plus" />
          办理入住
        </FaButton>
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <FaTabs v-model="activeTab" :list="TABS" class="mb-1" @change="onTabChange" />

      <!-- 房态 -->
      <div v-if="activeTab === 'cages'" v-loading="loading" class="flex-1 min-h-0 space-y-3 overflow-auto">
        <div class="gap-3 grid grid-cols-2 md:grid-cols-5">
          <div class="p-3 text-center border rounded-lg">
            <div class="text-2xl font-bold">
              {{ summary.total }}
            </div>
            <div class="text-xs text-muted-foreground">
              笼位总数
            </div>
          </div>
          <div class="text-success p-3 text-center border rounded-lg">
            <div class="text-2xl font-bold">
              {{ summary.available }}
            </div>
            <div class="text-xs">
              空闲
            </div>
          </div>
          <div class="text-destructive p-3 text-center border rounded-lg">
            <div class="text-2xl font-bold">
              {{ summary.occupied }}
            </div>
            <div class="text-xs">
              占用
            </div>
          </div>
          <div class="text-warning p-3 text-center border rounded-lg">
            <div class="text-2xl font-bold">
              {{ summary.maintenance }}
            </div>
            <div class="text-xs">
              维护中
            </div>
          </div>
          <div class="text-info p-3 text-center border rounded-lg">
            <div class="text-2xl font-bold">
              {{ summary.cleaning }}
            </div>
            <div class="text-xs">
              清洁中
            </div>
          </div>
        </div>

        <div class="space-y-4">
          <div v-for="room in groupedByRoom" :key="room.room_id" class="p-4 border rounded-lg">
            <div class="mb-3 flex items-center justify-between">
              <div class="flex gap-2 items-center">
                <FaIcon name="i-ri:door-line" class="text-lg" />
                <span class="text-base font-bold">{{ room.room_name }}</span>
                <span v-if="room.cages[0]?.room_type" class="text-xs text-muted-foreground">
                  {{ room.cages[0].room_type === 'boarding' ? '寄养房' : room.cages[0].room_type }}
                </span>
              </div>
              <div class="text-xs flex gap-2">
                <FaTag variant="default" size="sm">
                  空闲 {{ room.available_count }}
                </FaTag>
                <FaTag variant="destructive" size="sm">
                  占用 {{ room.occupied_count }}
                </FaTag>
                <FaTag variant="outline" size="sm">
                  总数 {{ room.total_count }}
                </FaTag>
              </div>
            </div>
            <div class="gap-2 grid grid-cols-2 lg:grid-cols-6 md:grid-cols-4">
              <div
                v-for="cage in room.cages"
                :key="cage.cage_id"
                class="p-2 border rounded cursor-pointer transition hover:shadow"
                :class="{
                  'border-success bg-success-50': cage.cage_status === 'available',
                  'border-destructive bg-destructive-50': cage.cage_status === 'occupied',
                  'border-warning bg-warning-50': cage.cage_status === 'maintenance',
                  'border-info bg-info-50': cage.cage_status === 'cleaning',
                }"
              >
                <div class="text-sm font-bold truncate">
                  {{ cage.cage_name }}
                </div>
                <div class="text-xs text-muted-foreground">
                  {{ cage.cage_code }} · ¥{{ cage.daily_rate }}/日
                </div>
                <div class="mt-1 text-xs">
                  <FaTag :variant="cage.cage_status === 'available' ? 'default' : cage.cage_status === 'occupied' ? 'destructive' : 'outline'" size="sm">
                    {{ cage.cage_status === 'available' ? '空闲' : cage.cage_status === 'occupied' ? '占用' : cage.cage_status === 'maintenance' ? '维护' : '清洁' }}
                  </FaTag>
                </div>
                <div v-if="cage.cage_status === 'occupied' && cage.boarding_no" class="text-[10px] text-muted-foreground mt-1 truncate">
                  寄养 {{ cage.boarding_no }}
                </div>
                <div v-else-if="cage.cage_status === 'occupied' && cage.current_admission_id" class="text-[10px] text-muted-foreground mt-1">
                  住院占用
                </div>
              </div>
            </div>
          </div>
          <div v-if="!loading && cageStatusList.length === 0" class="text-muted-foreground py-8 text-center">
            当前门店暂无笼位数据
          </div>
        </div>
      </div>

      <!-- 当前寄养 -->
      <div v-else-if="activeTab === 'current'" v-loading="loading" class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <div class="flex-1 min-h-0 overflow-auto">
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="currentColumns"
            :data="currentStays"
          >
            <template #cell-operation="{ row }">
              <div class="flex gap-1 justify-end">
                <FaButton variant="outline" size="sm" @click="onOpenDetail(row.original)">
                  详情
                </FaButton>
                <FaButton variant="outline" size="sm" @click="onChangeCage(row.original)">
                  换笼位
                </FaButton>
                <FaButton variant="outline" size="sm" @click="onCheckout(row.original)">
                  离店
                </FaButton>
              </div>
            </template>
          </FaTable>
        </div>
        <div v-if="!loading && currentStays.length === 0" class="text-muted-foreground py-8 text-center">
          当前无在养宠物
        </div>
      </div>

      <!-- 预约入住 -->
      <div v-else-if="activeTab === 'planned'" v-loading="loading" class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <div class="flex-1 min-h-0 overflow-auto">
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="plannedColumns"
            :data="plannedStays"
          >
            <template #cell-operation="{ row }">
              <div class="flex gap-1 justify-end">
                <FaButton variant="outline" size="sm" @click="onOpenDetail(row.original)">
                  详情
                </FaButton>
                <FaButton variant="outline" size="sm" @click="onCancelPlanned(row.original)">
                  取消
                </FaButton>
                <FaButton size="sm" @click="onConfirmPlanned(row.original)">
                  确认入住
                </FaButton>
              </div>
            </template>
          </FaTable>
        </div>
        <div v-if="!loading && plannedStays.length === 0" class="text-muted-foreground py-8 text-center">
          暂无预约
        </div>
      </div>

      <!-- 历史 -->
      <div v-else v-loading="loading" class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <div class="flex-1 min-h-0 overflow-auto">
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="historyColumns"
            :data="historyStays"
          >
            <template #cell-operation="{ row }">
              <div class="flex gap-1 justify-end">
                <FaButton variant="outline" size="sm" @click="onOpenDetail(row.original)">
                  详情
                </FaButton>
              </div>
            </template>
          </FaTable>
        </div>
        <div v-if="!loading && historyStays.length === 0" class="text-muted-foreground py-8 text-center">
          暂无历史记录
        </div>
      </div>
    </div>

    <!-- 入住 / 预约抽屉 -->
    <FaDrawer v-model="formVisible" :title="formMode === 'book' ? '预约寄养' : '办理入住'" :width="640" :show-confirm-button="false">
      <div class="p-4 space-y-4">
        <div class="gap-3 grid grid-cols-1 md:grid-cols-2">
          <FaLabel label="客户">
            <CustomerPicker v-model="form.customerId" placeholder="搜索选择客户" />
          </FaLabel>
          <FaLabel label="宠物">
            <PetPicker v-model="form.petId" :customer-id="form.customerId" placeholder="搜索选择宠物" />
          </FaLabel>
          <FaLabel label="预计离店日期">
            <FaInput v-model="form.expectedCheckOutAt" type="date" class="w-full" />
          </FaLabel>
        </div>

        <div>
          <div class="text-sm font-medium mb-2">
            选择笼位({{ availableCages.length }} 可用)
          </div>
          <div class="gap-2 grid grid-cols-2 max-h-56 overflow-auto sm:grid-cols-3">
            <button
              v-for="c in availableCages"
              :key="c.cage_id"
              type="button"
              class="p-2 text-left border rounded-md transition"
              :class="form.cageId === c.cage_id ? 'border-primary bg-primary-50' : 'hover:bg-gray-50'"
              @click="form.cageId = c.cage_id"
            >
              <div class="text-xs font-medium">
                {{ c.cage_name }}
              </div>
              <div class="text-[10px] text-muted-foreground">
                {{ c.cage_code }} · {{ c.room_name ?? '' }} · ¥{{ c.daily_rate }}/日
              </div>
            </button>
            <EmptyState v-if="!availableCages.length" compact title="暂无可用笼位" />
          </div>
        </div>

        <div>
          <div class="text-sm font-medium mb-2">
            入住要求
          </div>
          <div class="space-y-2">
            <FaInput v-model="form.dietNotes" placeholder="饮食要求(如:肠胃敏感粮,每日3次)" />
            <FaInput v-model="form.walkingNotes" placeholder="遛宠要求(如:早晚各一次,戴牵引绳)" />
            <FaInput v-model="form.medicationNotes" placeholder="用药要求(如:每日早晚各喂一次)" />
          </div>
        </div>

        <div class="gap-3 grid grid-cols-1 md:grid-cols-3">
          <FaInput v-model="form.emergencyName" placeholder="紧急联系人" />
          <FaInput v-model="form.emergencyPhone" placeholder="联系电话" />
          <FaInput v-model="form.emergencyRelation" placeholder="与宠物关系" />
        </div>

        <div class="space-y-2 text-sm">
          <label class="flex gap-2 items-center cursor-pointer">
            <input v-model="form.vaccineVerified" type="checkbox" class="accent-primary">
            <span>已核验疫苗齐全</span>
          </label>
          <label class="flex gap-2 items-center cursor-pointer">
            <input v-model="form.riskAcknowledged" type="checkbox" class="accent-primary">
            <span>已确认寄养风险并授权</span>
          </label>
        </div>

        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="formVisible = false">
            取消
          </FaButton>
          <FaButton :loading="submitting" @click="onFormSubmit">
            <FaIcon name="i-lucide:check" />
            {{ formMode === 'book' ? '确认预约' : '确认入住' }}
          </FaButton>
        </div>
      </div>
    </FaDrawer>

    <!-- 详情抽屉 -->
    <FaDrawer v-model="detailVisible" :title="currentStay ? `${petName(currentStay.pet_id)} · ${currentStay.boarding_no}` : '寄养详情'" :width="680" :show-confirm-button="false">
      <div v-if="currentStay" class="flex flex-col h-full">
        <div class="border-b p-4">
          <div class="flex gap-2 items-center">
            <EntityStatusTag :label="BOARDING_STATUS_LABELS[currentStay.status] ?? currentStay.status" :variant="statusVariant(currentStay.status)" dot />
            <span v-if="currentStay.total_charge > 0" class="text-sm font-medium">
              总费用 ¥{{ currentStay.total_charge.toFixed(2) }}
            </span>
          </div>
          <div class="text-xs text-muted-foreground mt-1">
            主人: {{ customerName(currentStay.customer_id) }}
            <template v-if="currentStay.emergency_contact">
              <template v-if="(currentStay.emergency_contact as any).phone">
                · 紧急联系 {{ (currentStay.emergency_contact as any).name ?? '' }} {{ (currentStay.emergency_contact as any).phone }}
              </template>
            </template>
          </div>
        </div>

        <FaTabs v-model="detailTab" :list="DETAIL_TABS" class="px-4 pt-3" />

        <div class="flex-1 min-h-0 overflow-auto p-4 space-y-4">
          <!-- 每日记录 -->
          <div v-if="detailTab === 'records'" class="space-y-3">
            <div class="border rounded-lg p-3 space-y-2">
              <div class="gap-2 grid grid-cols-2 md:grid-cols-3">
                <FaInput v-model="recordForm.recordDate" type="date" />
                <FaInput v-model="recordForm.feeding" placeholder="饮食" />
                <FaInput v-model="recordForm.walking" placeholder="遛宠" />
                <FaInput v-model="recordForm.medication" placeholder="用药" />
                <FaInput v-model="recordForm.condition" placeholder="状态" />
                <FaInput v-model="recordForm.note" placeholder="备注" />
              </div>
              <div class="flex justify-end">
                <FaButton size="sm" @click="onRecordSubmit">
                  <FaIcon name="i-lucide:save" />
                  保存今日记录
                </FaButton>
              </div>
            </div>
            <div v-for="r in dailyRecords" :key="r.id" class="border rounded-lg p-3">
              <div class="text-xs font-medium text-muted-foreground mb-1">
                {{ r.record_date }}
              </div>
              <div class="gap-2 grid grid-cols-1 md:grid-cols-2 text-sm">
                <div v-if="r.feeding">
                  饮食: {{ r.feeding }}
                </div>
                <div v-if="r.walking">
                  遛宠: {{ r.walking }}
                </div>
                <div v-if="r.medication">
                  用药: {{ r.medication }}
                </div>
                <div v-if="r.condition">
                  状态: {{ r.condition }}
                </div>
                <div v-if="r.note" class="text-muted-foreground">
                  备注: {{ r.note }}
                </div>
              </div>
            </div>
            <div v-if="!dailyRecords.length" class="text-muted-foreground py-6 text-center">
              暂无每日记录
            </div>
          </div>

          <!-- 服务消费 -->
          <div v-else-if="detailTab === 'charges'" class="space-y-3">
            <div class="border rounded-lg p-3 space-y-2">
              <div class="gap-2 grid grid-cols-2 md:grid-cols-4">
                <FaInput v-model="chargeForm.description" placeholder="服务描述(如:洗澡美容)" />
                <FaInput v-model.number="chargeForm.quantity" type="number" min="1" />
                <FaInput v-model.number="chargeForm.unitPrice" type="number" min="0" />
                <FaInput v-model="chargeForm.chargeDate" type="date" />
              </div>
              <div class="flex gap-2 justify-end items-center">
                <span class="text-sm">
                  金额 ¥{{ (chargeForm.quantity * chargeForm.unitPrice).toFixed(2) }}
                </span>
                <FaButton size="sm" @click="onChargeSubmit">
                  <FaIcon name="i-lucide:plus" />
                  添加服务费
                </FaButton>
              </div>
            </div>
            <div class="border rounded-lg divide-y">
              <div v-for="s in serviceCharges" :key="s.id" class="flex items-center justify-between p-3 text-sm">
                <div>
                  <div class="font-medium">
                    {{ s.description ?? s.catalog_item_id?.slice(0, 8) }}
                  </div>
                  <div class="text-xs text-muted-foreground">
                    {{ s.charge_date }} · 数量 {{ s.quantity }} · ¥{{ s.unit_price }}
                  </div>
                </div>
                <div class="font-bold">
                  ¥{{ s.amount.toFixed(2) }}
                </div>
              </div>
              <div v-if="!serviceCharges.length" class="text-muted-foreground p-4 text-center">
                暂无额外服务
              </div>
            </div>
          </div>

          <!-- 入住要求 -->
          <div v-else class="space-y-2 text-sm">
            <div class="border rounded-lg p-3">
              <div class="text-xs font-medium text-muted-foreground mb-1">
                饮食要求
              </div>
              {{ currentStay.diet_notes || '无' }}
            </div>
            <div class="border rounded-lg p-3">
              <div class="text-xs font-medium text-muted-foreground mb-1">
                遛宠要求
              </div>
              {{ currentStay.walking_notes || '无' }}
            </div>
            <div class="border rounded-lg p-3">
              <div class="text-xs font-medium text-muted-foreground mb-1">
                用药要求
              </div>
              {{ currentStay.medication_notes || '无' }}
            </div>
            <div class="border rounded-lg p-3 flex gap-2">
              <FaTag :variant="currentStay.vaccine_verified ? 'default' : 'outline'" size="sm">
                疫苗{{ currentStay.vaccine_verified ? '已核验' : '未核验' }}
              </FaTag>
              <FaTag :variant="currentStay.risk_acknowledged ? 'default' : 'outline'" size="sm">
                风险{{ currentStay.risk_acknowledged ? '已确认' : '未确认' }}
              </FaTag>
            </div>
          </div>
        </div>
      </div>
    </FaDrawer>
  </div>
</template>
