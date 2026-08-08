<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { CustomerRecord, PetRecord } from '@/types/customer'
import type { Admission, Cage, Room } from '@/types/inpatient'
import apiInpatient, { generateIdempotencyKey } from '@/api/modules/inpatient'
import CustomerPicker from '@/components/business/CustomerPicker/index.vue'
import BusinessEmployeePicker from '@/components/business/EmployeePicker/index.vue'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import PetPicker from '@/components/business/PetPicker/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { ADMISSION_STATUS_LABELS } from '@/types/inpatient'

defineOptions({
  name: 'InpatientAdmission',
})

interface AdmissionRow {
  id: string
  pet_id: string
  customer_id: string
  cage_id: string
  doctor_id: string | null
  admission_reason: string | null
  admitted_at: string
  status: Admission['status']
  discharged_at: string | null
  total_charge: number
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const submitting = ref(false)
const dataList = ref<AdmissionRow[]>([])
const rooms = ref<Room[]>([])
const cages = ref<Cage[]>([])

const search = ref({
  status: '',
})
const admitVisible = ref(false)
const petMap = ref<Record<string, PetRecord>>({})
const customerMap = ref<Record<string, CustomerRecord>>({})

async function enrich(rows: AdmissionRow[]) {
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

const tableColumns = computed<TableColumn<AdmissionRow>[]>(() => [
  {
    id: 'pet',
    header: '宠物',
    cell: (info: any) => {
      const row = info.row.original as AdmissionRow
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-xs font-medium' }, petMap.value[row.pet_id]?.name ?? row.pet_id.slice(0, 8)),
        h('div', { class: 'text-xs text-muted-foreground' }, customerMap.value[row.customer_id]?.name ?? '未知主人'),
      ])
    },
  },
  {
    accessorKey: 'admission_reason',
    header: '入院原因',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'admitted_at',
    header: '入院时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as Admission['status']
      return h(EntityStatusTag, { label: ADMISSION_STATUS_LABELS[v] ?? v, variant: v === 'admitted' ? 'info' : v === 'discharged' ? 'success' : 'warning', dot: true })
    },
  },
  {
    accessorKey: 'total_charge',
    header: '总费用',
    cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  {
    accessorKey: 'discharged_at',
    header: '出院时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 140,
    align: 'right',
    fixed: 'right',
  },
])

const admitForm = reactive({
  customerId: '',
  petId: '',
  cageId: '',
  doctorId: '',
  admissionReason: '',
})

async function loadRooms() {
  try {
    const res = await apiInpatient.listRooms(tenantStore.currentStoreId || undefined, true)
    rooms.value = res.data.list
    if (rooms.value.length > 0) {
      await loadCages()
    }
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '加载房间失败')
  }
}

async function loadCages() {
  try {
    const res = await apiInpatient.listCages(
      tenantStore.currentStoreId || undefined,
      undefined,
      'available',
    )
    cages.value = res.data.list
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '加载笼位失败')
  }
}

async function loadAdmissions() {
  loading.value = true
  try {
    const res = await apiInpatient.listAdmissions(
      tenantStore.currentStoreId || undefined,
      search.value.status || undefined,
    )
    dataList.value = res.data.list as AdmissionRow[]
    await enrich(dataList.value)
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '加载住院记录失败')
  }
  finally {
    loading.value = false
  }
}

async function onAdmit() {
  if (!admitForm.customerId || !admitForm.petId || !admitForm.cageId) {
    useFaToast().warning('请选择客户、宠物并填写笼位')
    return
  }
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择工作门店')
    return
  }
  submitting.value = true
  try {
    const idempotencyKey = generateIdempotencyKey()
    await apiInpatient.admitPatient({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId,
      customerId: admitForm.customerId.trim(),
      petId: admitForm.petId.trim(),
      cageId: admitForm.cageId,
      doctorId: admitForm.doctorId.trim() || undefined,
      admissionReason: admitForm.admissionReason.trim() || undefined,
    }, idempotencyKey)
    useFaToast().success('入院成功')
    admitVisible.value = false
    admitForm.customerId = ''
    admitForm.petId = ''
    admitForm.cageId = ''
    admitForm.doctorId = ''
    admitForm.admissionReason = ''
    await Promise.all([loadCages(), loadAdmissions()])
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

function onDischarge(row: AdmissionRow) {
  if (row.status !== 'admitted') {
    useFaToast().warning('仅「在院」状态可出院')
    return
  }
  useFaModal().confirm({
    title: '办理出院',
    content: `确认将宠物 ${petMap.value[row.pet_id]?.name ?? row.pet_id.slice(0, 8)} 办理出院吗？出院后将释放笼位并汇总费用。`,
    onConfirm: async () => {
      try {
        const idempotencyKey = generateIdempotencyKey()
        await apiInpatient.dischargePatient({
          admissionId: row.id,
        }, idempotencyKey)
        useFaToast().success('已出院')
        await Promise.all([loadCages(), loadAdmissions()])
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

function onTransfer(row: AdmissionRow) {
  if (row.status !== 'admitted') {
    useFaToast().warning('仅「在院」状态可换房')
    return
  }
  const availableCages = cages.value.filter(c => c.id !== row.cage_id)
  if (availableCages.length === 0) {
    useFaToast().warning('当前没有可用笼位可换房')
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
      }, availableCages.map(c => h('option', { value: c.id }, `${c.name} (${c.code})`))),
    ]),
    onConfirm: async () => {
      if (!selectedCageId) {
        useFaToast().warning('请选择目标笼位')
        return Promise.reject(new Error('no cage selected'))
      }
      try {
        const idempotencyKey = generateIdempotencyKey()
        await apiInpatient.transferCage({
          admissionId: row.id,
          newCageId: selectedCageId,
        }, idempotencyKey)
        useFaToast().success('换房成功')
        await Promise.all([loadCages(), loadAdmissions()])
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  }).open()
}

function onOpenAdmit() {
  admitVisible.value = true
  loadCages()
}

// P1(审计 25):未保存内容保护 - 入院表单有内容时视为 dirty
const admitGuard = usePageUnsavedGuard('inpatient-admission')
watch(admitForm, () => {
  const f = admitForm
  admitGuard.setDirty(!!f.customerId || !!f.petId || !!f.cageId || !!f.doctorId || !!f.admissionReason)
}, { deep: true, immediate: true })

// P0-06:切店后按新门店重载房间/笼位/住院记录
useStoreScopedPage({
  load: async () => {
    await loadRooms()
    await loadAdmissions()
  },
})

onMounted(async () => {
  await loadRooms()
  await loadAdmissions()
})
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="入院登记" description="办理入院 · 锁定笼位 · 生成住院记录">
      <template #actions>
        <FaSelect
          v-model="search.status"
          :options="[
            { label: '全部状态', value: '' },
            { label: '在院', value: 'admitted' },
            { label: '已出院', value: 'discharged' },
          ]"
          class="w-36"
          @change="loadAdmissions()"
        />
        <FaButton size="sm" @click="onOpenAdmit">
          <FaIcon name="i-lucide:plus" />
          办理入院
        </FaButton>
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <div v-loading="loading" class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <div class="flex-1 min-h-0 overflow-auto">
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="tableColumns"
            :data="dataList"
          >
            <template #cell-operation="{ row }">
              <div class="flex gap-1 justify-end">
                <FaButton v-if="row.original.status === 'admitted'" variant="outline" size="sm" @click="onTransfer(row.original)">
                  换房
                </FaButton>
                <FaButton v-if="row.original.status === 'admitted'" variant="outline" size="sm" @click="onDischarge(row.original)">
                  出院
                </FaButton>
              </div>
            </template>
          </FaTable>
        </div>
      </div>
    </div>

    <!-- 办理入院抽屉 -->
    <FaDrawer v-model="admitVisible" title="办理入院" :width="620" :show-confirm-button="false">
      <div class="p-4 space-y-3">
        <div class="gap-3 grid grid-cols-1 md:grid-cols-2">
          <FaLabel label="客户">
            <CustomerPicker v-model="admitForm.customerId" placeholder="搜索选择客户" />
          </FaLabel>
          <FaLabel label="宠物">
            <PetPicker v-model="admitForm.petId" :customer-id="admitForm.customerId" placeholder="搜索选择宠物" />
          </FaLabel>
          <FaLabel label="主治医生(可选)">
            <BusinessEmployeePicker v-model="admitForm.doctorId" placeholder="搜索选择医生" />
          </FaLabel>
          <FaLabel label="入院原因">
            <FaInput v-model="admitForm.admissionReason" placeholder="如:骨折术后恢复" class="w-full" />
          </FaLabel>
        </div>

        <div>
          <div class="text-sm font-medium mb-2">
            选择笼位({{ cages.length }} 可用)
          </div>
          <div class="gap-2 grid grid-cols-2 max-h-56 overflow-auto sm:grid-cols-3">
            <button
              v-for="c in cages"
              :key="c.id"
              type="button"
              class="p-2 text-left border rounded-md transition"
              :class="admitForm.cageId === c.id ? 'border-primary bg-primary-50' : 'hover:bg-gray-50'"
              @click="admitForm.cageId = c.id"
            >
              <div class="text-xs font-medium">
                {{ c.name }}
              </div>
              <div class="text-[10px] text-muted-foreground">
                {{ c.code }} · ¥{{ c.daily_rate }}/日
              </div>
            </button>
            <EmptyState v-if="!cages.length" compact title="暂无可用笼位" />
          </div>
        </div>

        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="admitVisible = false">
            取消
          </FaButton>
          <FaButton :loading="submitting" @click="onAdmit">
            <FaIcon name="i-lucide:plus" />
            确认入院
          </FaButton>
        </div>
      </div>
    </FaDrawer>
  </div>
</template>
