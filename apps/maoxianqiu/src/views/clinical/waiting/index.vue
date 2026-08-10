<script setup lang="ts">
import type { CustomerRecord, PetRecord } from '@/types/customer'
import apiClinical from '@/api/modules/clinical'
import apiJourney from '@/api/modules/patient-journey'
import apiStore from '@/api/modules/store'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { useWorkbenchStore } from '@/store/modules/app/workbench'
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
const workbenchStore = useWorkbenchStore()
const loading = ref(false)
/** 当前正在执行「开始就诊」的候诊行 id,用于按钮 loading 与防重复点击 */
const startingId = ref<string | null>(null)
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

/**
 * 开始就诊:将候诊预约完整交接给医生工作台
 * 1. 幂等确保候诊队列记录存在(check-in 已存在则直接复用,不重复排队);
 * 2. 流转队列 → in_consultation,服务端在队列流转中自动创建就诊并同步预约状态;
 * 3. 携带 encounterId 跳转医生工作台,由工作台自动定位打开该患者。
 * 失败时降级为仅推进预约状态(兼容队列记录缺失/权限未同步的存量环境)。
 */
async function onStartVisit(row: WaitingRow) {
  if (startingId.value) { return }
  startingId.value = row.id
  try {
    const actorRole = workbenchStore.activeRole
    // 1. 幂等确保候诊队列记录存在(不存在则按无需分诊创建,状态直接为 waiting)
    const checkIn: any = await apiJourney.checkInAppointment({
      appointmentId: row.id,
      triageRequired: false,
      serviceType: 'outpatient',
      actorRole,
      sourceWorkbench: `workbench.${actorRole}`,
      idempotencyKey: crypto.randomUUID(),
    })
    const queueRow = checkIn.data as { id: string, status: string, encounter_id: string | null }
    // 2. 流转队列到诊疗中(服务端自动创建就诊、同步预约到 in_progress)
    let encounterId: string | null = queueRow.encounter_id
    if (queueRow.status !== 'in_consultation') {
      const trans: any = await apiJourney.transitionQueue(queueRow.id, actorRole, 'in_consultation')
      encounterId = trans.data?.encounter_id ?? null
    }
    useFaToast().success('已开始就诊')
    router.push(encounterId ? `/clinical/workbench?encounterId=${encounterId}` : '/clinical/workbench')
  }
  catch (e: any) {
    // 降级:仅推进预约状态后跳转(不携带 encounterId,工作台展示空态)
    try {
      await apiClinical.startAppointment(row.id)
      router.push('/clinical/workbench')
    }
    catch {
      useFaToast().error(e?.message || '开始就诊失败')
    }
  }
  finally {
    startingId.value = null
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

// ===== 本地分页(候诊排序在客户端完成,接口不参与分页) =====
const { pagination, onSizeChange, onCurrentChange } = usePagination()

/** 当前页展示的候诊行(按排序结果切片) */
const pagedList = computed(() => {
  const { page, size } = pagination.value
  const start = (page - 1) * size
  return sortedList.value.slice(start, start + size)
})

/** 候诊总数变化时同步总条数,并兜底钳制页码(防止刷新后页码越界出现空页) */
watch(
  () => sortedList.value.length,
  (len) => {
    pagination.value.total = len
    const maxPage = Math.max(1, Math.ceil(len / pagination.value.size))
    if (pagination.value.page > maxPage) {
      pagination.value.page = maxPage
    }
  },
  { immediate: true },
)

/** 每页条数变化后回到第一页 */
async function onPaginationSizeChange(size: number) {
  await onSizeChange(size)
  pagination.value.page = 1
}

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
  <!-- 绝对定位占满父容器,与回访任务等列表页保持内容区高度一致 -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
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

    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <!-- 顶部统计 -->
      <div class="shrink-0 gap-4 grid grid-cols-3">
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
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 工具栏:左筛选,右功能按钮 -->
        <div class="px-4 pt-3 border-b shrink-0">
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
        <div v-loading="loading" class="flex-1 gap-3 p-3 grid auto-rows-max grid-cols-1 min-h-0 overflow-auto xl:grid-cols-2">
          <div
            v-for="row in pagedList"
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
              <FaButton
                size="sm"
                :loading="startingId === row.id"
                :disabled="Boolean(startingId)"
                @click="onStartVisit(row)"
              >
                <FaIcon name="i-lucide:play" />
                开始就诊
              </FaButton>
            </div>
          </div>
          <!-- 空状态:横跨全部列并撑满可用高度,内容垂直水平居中(EmptyState 自身为 flex 居中布局) -->
          <EmptyState
            v-if="!loading && sortedList.length === 0"
            compact
            title="当前无候诊宠物"
            description="有新预约报到后自动显示"
            class="col-span-full min-h-[280px]"
          />
        </div>

        <!-- 底部分页工具栏(本地分页,候诊排序在客户端完成) -->
        <div class="px-3 py-2 border-t shrink-0">
          <FaPagination
            :page="pagination.page"
            :size="pagination.size"
            :total="pagination.total"
            @page-change="onCurrentChange"
            @size-change="onPaginationSizeChange"
          />
        </div>
      </div>
    </div>
  </div>
</template>
