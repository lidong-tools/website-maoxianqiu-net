<script setup lang="ts">
import type { CustomerRecord, PetRecord } from '@/types/customer'
import apiClinical from '@/api/modules/clinical'
import apiStore from '@/api/modules/store'
import { supabase } from '@/lib/supabase'
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

const petMap = ref<Record<string, PetRecord>>({})
const customerMap = ref<Record<string, CustomerRecord>>({})
const doctorMap = ref<Record<string, string>>({})

let refreshTimer: ReturnType<typeof setInterval> | null = null

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

async function enrich(rows: WaitingRow[]) {
  const petIds = [...new Set(rows.map(r => r.pet_id).filter(Boolean))]
  const customerIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))]
  const doctorIds = [...new Set(rows.map(r => r.doctor_id).filter(Boolean) as string[])]
  if (petIds.length) {
    const { data } = await supabase.from('pets').select('*').in('id', petIds)
    data?.forEach((p) => { petMap.value[p.id] = p as PetRecord })
  }
  if (customerIds.length) {
    const { data } = await supabase.from('customers').select('*').in('id', customerIds)
    data?.forEach((c) => { customerMap.value[c.id] = c as CustomerRecord })
  }
  if (doctorIds.length) {
    const { data } = await supabase.from('employees').select('user_id, name').in('user_id', doctorIds)
    data?.forEach((e: any) => { doctorMap.value[e.user_id] = e.name })
  }
}

async function loadData() {
  loading.value = true
  try {
    const res: any = await apiClinical.listWaiting(currentStoreId.value || undefined)
    dataList.value = res.data.list ?? []
    await enrich(dataList.value)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载候诊队列失败')
  }
  finally {
    loading.value = false
  }
}

// P0-06:切店后跟随当前门店自动重载
useStoreScopedPage({
  load: () => {
    currentStoreId.value = tenantStore.currentStoreId
    return loadData()
  },
})

onMounted(async () => {
  await loadStoreOptions()
  if (tenantStore.currentStoreId) {
    currentStoreId.value = tenantStore.currentStoreId
  }
  await loadData()
  refreshTimer = setInterval(loadData, 30000)
})

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
})

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

function waitMinutes(scheduledStart: string): number {
  const diff = Date.now() - new Date(scheduledStart).getTime()
  return Math.max(0, Math.floor(diff / 60000))
}

const waitingCount = computed(() => dataList.value.length)
/** 超过 30 分钟候诊人数 */
const overdueCount = computed(() => dataList.value.filter(r => waitMinutes(r.scheduled_start) > 30).length)

/** 排序:超时优先 → 签到/预约时间 → 急诊 */
const sortedList = computed(() => {
  return [...dataList.value].sort((a, b) => {
    const aOverdue = waitMinutes(a.scheduled_start) > 30 ? 1 : 0
    const bOverdue = waitMinutes(b.scheduled_start) > 30 ? 1 : 0
    if (aOverdue !== bOverdue) {
      return bOverdue - aOverdue
    }
    return new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime()
  })
})

function displayRow(row: WaitingRow) {
  const pet = petMap.value[row.pet_id]
  const customer = customerMap.value[row.customer_id]
  return {
    petName: pet?.name ?? '未知宠物',
    customerName: customer?.name ?? '未知主人',
    phone: customer?.phone ?? '',
    doctorName: row.doctor_id ? (doctorMap.value[row.doctor_id] ?? '') : '',
    risks: pet?.risk_tags ?? [],
    species: pet?.species ?? '',
  }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告) -->
    <!--
    <EntityPageHeader compact title="候诊队列" description="实时队列 · 每 30 秒自动刷新">
      <template #actions>
        <FaSelect v-model="currentStoreId" :options="storeOptions" class="w-40" @change="loadData" />
        <FaButton size="sm" variant="outline" @click="loadData">
          <FaIcon name="i-lucide:refresh-cw" />
          刷新
        </FaButton>
      </template>
    </EntityPageHeader>
    -->

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <!-- 顶部统计 -->
      <div class="gap-4 grid grid-cols-3">
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ waitingCount }}
          </div>
          <div class="text-xs text-muted-foreground">
            候诊
          </div>
        </div>
        <div class="p-3 border border-red-200 rounded-lg bg-red-50">
          <div class="text-2xl text-red-600 font-semibold tabular-nums">
            {{ overdueCount }}
          </div>
          <div class="text-xs text-red-600/70">
            超过 30 分钟
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            -
          </div>
          <div class="text-xs text-muted-foreground">
            已叫号
          </div>
        </div>
      </div>

      <!-- 候诊列表卡片 -->
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <!-- 工具栏:左筛选,右功能按钮 -->
        <div class="px-4 pt-3 border-b">
          <div class="pb-3 flex flex-wrap gap-2 items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaSelect v-model="currentStoreId" :options="storeOptions" class="w-40" @change="loadData" />
              <span class="text-sm text-muted-foreground">候诊 {{ waitingCount }} · 超时 {{ overdueCount }}</span>
            </div>
            <FaButton size="sm" variant="outline" @click="loadData">
              <FaIcon name="i-lucide:refresh-cw" />
              刷新
            </FaButton>
          </div>
        </div>

        <!-- 候诊卡片流 -->
        <div v-loading="loading" class="flex-1 gap-3 grid auto-rows-max grid-cols-1 min-h-0 overflow-auto xl:grid-cols-2">
          <div
            v-for="row in sortedList"
            :key="row.id"
            class="p-3 border rounded-lg flex gap-3 items-center justify-between"
            :class="waitMinutes(row.scheduled_start) > 30 ? 'border-red-200 bg-red-50/50' : 'bg-card'"
          >
            <div class="min-w-0">
              <div class="flex gap-2 items-center">
                <span class="text-sm font-medium">{{ displayRow(row).petName }}</span>
                <span v-if="displayRow(row).species" class="text-xs text-muted-foreground">{{ displayRow(row).species }}</span>
                <span
                  class="text-xs font-medium"
                  :class="waitMinutes(row.scheduled_start) > 30 ? 'text-red-600' : 'text-amber-600'"
                >
                  {{ waitMinutes(row.scheduled_start) }} min
                </span>
              </div>
              <div class="text-xs text-muted-foreground mt-0.5 truncate">
                {{ displayRow(row).customerName }}<template v-if="displayRow(row).phone">
                  · {{ displayRow(row).phone }}
                </template>
                <template v-if="displayRow(row).doctorName">
                  · 医生 {{ displayRow(row).doctorName }}
                </template>
              </div>
              <div class="text-xs text-muted-foreground mt-0.5 truncate">
                {{ row.reason ?? '未填写原因' }} · {{ APPOINTMENT_SOURCE_LABELS[row.source as keyof typeof APPOINTMENT_SOURCE_LABELS] ?? row.source }}
              </div>
              <div v-if="displayRow(row).risks.length" class="mt-1 flex flex-wrap gap-1">
                <span v-for="r in displayRow(row).risks" :key="r" class="text-xs text-amber-700 font-medium px-1.5 py-0.5 rounded bg-amber-100 inline-flex gap-1 items-center">
                  <FaIcon name="i-lucide:triangle-alert" class="size-3" />
                  {{ r }}
                </span>
              </div>
            </div>
            <div class="shrink-0">
              <FaButton size="sm" @click="onStartVisit(row)">
                <FaIcon name="i-lucide:play" />
                开始就诊
              </FaButton>
            </div>
          </div>
          <EmptyState v-if="!loading && sortedList.length === 0" compact title="当前无候诊宠物" description="有新预约报到后自动显示" />
        </div>
      </div>
    </div>
  </div>
</template>
