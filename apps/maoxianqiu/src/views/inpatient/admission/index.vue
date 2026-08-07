<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { Admission, Cage, Room } from '@/types/inpatient'
import apiInpatient, { generateIdempotencyKey } from '@/api/modules/inpatient'
import CustomerPicker from '@/components/business/CustomerPicker/index.vue'
import BusinessEmployeePicker from '@/components/business/EmployeePicker/index.vue'
import PetPicker from '@/components/business/PetPicker/index.vue'
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

const tableColumns = computed<TableColumn<AdmissionRow>[]>(() => [
  {
    accessorKey: 'pet_id',
    header: '宠物 ID',
    cell: info => (info.getValue() as string | undefined)?.slice(0, 8),
  },
  {
    accessorKey: 'customer_id',
    header: '客户 ID',
    cell: info => (info.getValue() as string | undefined)?.slice(0, 8),
  },
  {
    accessorKey: 'admission_reason',
    header: '入院原因',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'admitted_at',
    header: '入院时间',
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const v = info.getValue() as Admission['status']
      const label = ADMISSION_STATUS_LABELS[v] ?? v
      const colorMap: Record<string, string> = {
        admitted: 'info',
        discharged: 'default',
        transferred: 'warning',
      }
      return h('span', {
        class: `inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-${colorMap[v] ?? 'default'}-100 text-${colorMap[v] ?? 'default'}-700`,
      }, label)
    },
  },
  {
    accessorKey: 'total_charge',
    header: '总费用',
    cell: info => `¥${(info.getValue() as number | undefined)?.toFixed(2) ?? '0.00'}`,
  },
  {
    accessorKey: 'discharged_at',
    header: '出院时间',
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 180,
    align: 'center',
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

/** 加载房间列表(用于初始化笼位下拉) */
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

/** 加载笼位列表(仅可用) */
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

/** 加载住院记录列表 */
async function loadAdmissions() {
  loading.value = true
  try {
    const res = await apiInpatient.listAdmissions(
      tenantStore.currentStoreId || undefined,
      search.value.status || undefined,
    )
    dataList.value = res.data.list as AdmissionRow[]
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '加载住院记录失败')
  }
  finally {
    loading.value = false
  }
}

/** 提交入院(MXQ-11003,走 Hono Command + admit_patient RPC) */
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
    // 重置表单
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

/** 办理出院(MXQ-11008,走 Hono Command + discharge_patient RPC) */
function onDischarge(row: AdmissionRow) {
  if (row.status !== 'admitted') {
    useFaToast().warning('仅「在院」状态可出院')
    return
  }
  useFaModal().confirm({
    title: '办理出院',
    content: `确认将宠物 ${row.pet_id.slice(0, 8)} 办理出院吗？出院后将释放笼位并汇总费用。`,
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

/** 换房(MXQ-11006,走 Hono Command + transfer_cage RPC) */
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

onMounted(async () => {
  await loadRooms()
  await loadAdmissions()
})
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="入院登记" class="mb-0">
      <template #description>
        办理宠物入院:选择笼位 → 锁定房位 → 生成住院记录;支持出院、换房操作
      </template>
    </FaPageHeader>
    <FaPageMain>
      <!-- 入院表单 -->
      <div class="mb-4 p-4 border rounded-lg bg-muted/30">
        <div class="mb-3 flex gap-2 items-center">
          <FaIcon name="i-ri:hospital-line" class="text-lg" />
          <span class="font-bold">办理入院</span>
          <span class="text-xs text-muted-foreground">
            (走 Hono Command + admit_patient RPC,事务化锁笼位防并发冲突)
          </span>
        </div>
        <div class="gap-3 grid grid-cols-1 md:grid-cols-3">
          <FaLabel label="客户">
            <CustomerPicker v-model="admitForm.customerId" placeholder="搜索选择客户" />
          </FaLabel>
          <FaLabel label="宠物">
            <PetPicker v-model="admitForm.petId" :customer-id="admitForm.customerId" placeholder="搜索选择宠物" />
          </FaLabel>
          <FaLabel label="主治医生(可选)">
            <BusinessEmployeePicker v-model="admitForm.doctorId" placeholder="搜索选择医生" />
          </FaLabel>
          <FaLabel label="选择笼位">
            <FaSelect v-model="admitForm.cageId" placeholder="请选择可用笼位" class="w-full" :options="cages.map(c => ({ label: `${c.name} (${c.code}) - ¥${c.daily_rate}/日`, value: c.id }))" />
          </FaLabel>
          <FaLabel label="入院原因">
            <FaInput
              v-model="admitForm.admissionReason"
              placeholder="如:骨折术后恢复"
              class="w-full"
            />
          </FaLabel>
          <div class="flex items-end">
            <FaButton type="primary" :loading="submitting" @click="onAdmit">
              <FaIcon name="i-ri:add-line" />
              办理入院
            </FaButton>
          </div>
        </div>
      </div>

      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="状态" class="col-span-1">
              <FaSelect
                v-model="search.status"
                :options="[
                  { label: '全部', value: '' },
                  { label: '在院', value: 'admitted' },
                  { label: '已出院', value: 'discharged' },
                ]"
                class="w-full"
                @change="loadAdmissions()"
              />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton type="primary" @click="loadAdmissions">
                <FaIcon name="i-ri:refresh-line" />
                刷新
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
        <template #cell-operation="{ row }">
          <div class="flex-center gap-2">
            <FaButton
              v-if="row.original.status === 'admitted'"
              variant="outline"
              size="sm"
              @click="onTransfer(row.original)"
            >
              <FaIcon name="i-ri:swap-line" />
              换房
            </FaButton>
            <FaButton
              v-if="row.original.status === 'admitted'"
              variant="destructive"
              size="sm"
              @click="onDischarge(row.original)"
            >
              <FaIcon name="i-ri:logout-box-line" />
              出院
            </FaButton>
          </div>
        </template>
      </FaTable>
    </FaPageMain>
  </div>
</template>
