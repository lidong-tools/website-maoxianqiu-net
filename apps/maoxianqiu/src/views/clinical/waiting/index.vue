<script setup lang="ts">
import apiClinical from '@/api/modules/clinical'
import apiStore from '@/api/modules/store'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { APPOINTMENT_SOURCE_LABELS } from '@/types/clinical'

defineOptions({
  name: 'ClinicalWaiting',
})

interface WaitingRow {
  id: string
  customer_id: string
  pet_id: string
  doctor_id: string | null
  scheduled_start: string
  reason: string | null
  source: string
  store_id: string | null
}

const router = useRouter()
const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<WaitingRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const currentStoreId = ref('')

/** 自动刷新计时器 */
let refreshTimer: ReturnType<typeof setInterval> | null = null

/**
 * 加载门店选项
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
 * 加载候诊队列
 */
async function loadData() {
  loading.value = true
  try {
    const res: any = await apiClinical.listWaiting(currentStoreId.value || undefined)
    dataList.value = res.data.list ?? []
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载候诊队列失败')
  }
  finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadStoreOptions()
  if (tenantStore.currentStoreId) {
    currentStoreId.value = tenantStore.currentStoreId
  }
  await loadData()
  // 每 30 秒自动刷新候诊队列
  refreshTimer = setInterval(loadData, 30000)
})

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
})

/**
 * 开始就诊(checked_in→in_progress),并跳转工作台
 */
async function onStartVisit(row: WaitingRow) {
  try {
    await apiClinical.startAppointment(row.id)
    useFaToast().success('已开始就诊')
    router.push('/clinical/workbench')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '开始就诊失败')
  }
}

/**
 * 计算等待时长(分钟)
 */
function waitMinutes(scheduledStart: string): number {
  const diff = Date.now() - new Date(scheduledStart).getTime()
  return Math.max(0, Math.floor(diff / 60000))
}

/** 候诊数量 */
const waitingCount = computed(() => dataList.value.length)
</script>

<template>
  <div>
    <FaPageHeader title="候诊队列" class="mb-0">
      <template #description>
        当前已报到待就诊的宠物队列(每 30 秒自动刷新),共 {{ waitingCount }} 位候诊
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="门店" class="col-span-1">
              <FaSelect v-model="currentStoreId" :options="storeOptions" class="w-full" @change="loadData" />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton variant="outline" @click="loadData">
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
        :columns="[
          { accessorKey: 'scheduled_start', header: '预约时间', cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '-' },
          { accessorKey: 'customer_id', header: '客户 ID', cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-' },
          { accessorKey: 'pet_id', header: '宠物 ID', cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-' },
          { accessorKey: 'reason', header: '就诊原因', cell: (info: any) => info.getValue() ?? '-' },
          { accessorKey: 'source', header: '来源', cell: (info: any) => APPOINTMENT_SOURCE_LABELS[info.getValue() as keyof typeof APPOINTMENT_SOURCE_LABELS] ?? info.getValue() },
          { id: 'wait', header: '已等待', cell: (info: any) => `${waitMinutes(info.row.original.scheduled_start)} 分钟` },
          { id: 'operation', header: '操作', width: 140, align: 'center', fixed: 'right' },
        ]"
        :data="dataList"
      >
        <template #cell-operation="{ row }">
          <FaButton type="primary" size="sm" @click="onStartVisit(row.original)">
            <FaIcon name="i-ri:play-line" />
            开始就诊
          </FaButton>
        </template>
      </FaTable>
      <FaEmpty v-if="!loading && dataList.length === 0" description="当前无候诊宠物" />
    </FaPageMain>
  </div>
</template>
