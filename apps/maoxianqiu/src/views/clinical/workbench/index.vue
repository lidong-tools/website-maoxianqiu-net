<script setup lang="ts">
import type { AppointmentRecord, EncounterRecord } from '@/types/clinical'
import type { CustomerRecord, PetRecord } from '@/types/customer'
import apiClinical from '@/api/modules/clinical'
import apiDiagnostics from '@/api/modules/diagnostics'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { ENCOUNTER_STATUS_LABELS } from '@/types/clinical'

defineOptions({
  name: 'ClinicalWorkbench',
})

const router = useRouter()
const tenantStore = useAppTenantStore()

const loadingAppointments = ref(false)
const todayAppointments = ref<AppointmentRecord[]>([])
const activeEncounter = ref<EncounterRecord | null>(null)
const activePet = ref<PetRecord | null>(null)
const recentEncounters = ref<EncounterRecord[]>([])
const prescriptions = ref<any[]>([])
const labOrders = ref<any[]>([])
const saving = ref(false)
const lastSavedAt = ref<Date | null>(null)

/** P0-25:全局未保存保护接入,切门店由 ToolbarStart confirmLeave 统一处理 */
const workbenchGuard = useUnsavedChangesGuard().register('clinical-workbench')
/** 表单基线:最近一次加载/保存时的服务器值,用于 dirty 判定 */
const baselineEncounter = ref<EncounterRecord | null>(null)
/** P0-26:409 冲突弹窗 */
const conflictVisible = ref(false)

const petMap = ref<Record<string, PetRecord>>({})
const customerMap = ref<Record<string, CustomerRecord>>({})

const encounterForm = reactive({
  chiefComplaint: '',
  historyPresent: '',
  examFindings: '',
  diagnosisText: '',
  treatmentPlan: '',
  followUpDate: '',
})

/** 表单与基线不一致即为 dirty(P0-25 数据丢失保护核心) */
const isDirty = computed(() => {
  if (!activeEncounter.value || !baselineEncounter.value) {
    return false
  }
  const f = encounterForm
  const e = baselineEncounter.value
  return f.chiefComplaint !== (e.chief_complaint ?? '')
    || f.historyPresent !== (e.history_present ?? '')
    || f.examFindings !== (e.exam_findings ?? '')
    || f.diagnosisText !== (e.diagnosis_text ?? '')
    || f.treatmentPlan !== (e.treatment_plan ?? '')
    || f.followUpDate !== (e.follow_up_date ?? '')
})

watch(isDirty, (d) => workbenchGuard.setDirty(d), { immediate: true })

const todayStart = computed(() => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
})
const todayEnd = computed(() => {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d.toISOString()
})

/** P0-04:候诊主队列只允许 checked_in/in_progress,取消/未到店/已完成不得进入 */
const queueRows = computed(() =>
  todayAppointments.value
    .filter(a => a.status === 'checked_in' || a.status === 'in_progress')
    .map((a) => {
      const pet = a.pet_id ? petMap.value[a.pet_id] : undefined
      const customer = a.customer_id ? customerMap.value[a.customer_id] : undefined
      return {
        ...a,
        petName: pet?.name ?? '未知宠物',
        customerName: customer?.name ?? '未知主人',
        phone: customer?.phone ?? '',
      }
    }),
)

/** 批量富化 pet/customer 名称,替代 raw UUID */
async function enrich(rows: Array<{ pet_id?: string | null, customer_id?: string | null }>) {
  const petIds = [...new Set(rows.map(r => r.pet_id).filter(Boolean))] as string[]
  const customerIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))] as string[]
  if (petIds.length) {
    const { data } = await supabase.from('pets').select('*').in('id', petIds)
    data?.forEach((p) => { petMap.value[p.id] = p as PetRecord })
  }
  if (customerIds.length) {
    const { data } = await supabase.from('customers').select('*').in('id', customerIds)
    data?.forEach((c) => { customerMap.value[c.id] = c as CustomerRecord })
  }
}

async function loadTodayAppointments() {
  loadingAppointments.value = true
  try {
    const res: any = await apiClinical.listAppointments({
      storeId: tenantStore.currentStoreId || undefined,
      dateFrom: todayStart.value,
      dateTo: todayEnd.value,
      pageSize: 100,
    })
    todayAppointments.value = res.data.list ?? []
    await enrich(todayAppointments.value)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载今日预约失败')
  }
  finally {
    loadingAppointments.value = false
  }
}

async function loadRecentEncounters() {
  // P0-05:选中患者后,最近就诊 = 当前 pet_id,禁止把全店历史混入
  if (!activeEncounter.value?.pet_id) {
    recentEncounters.value = []
    return
  }
  const res: any = await apiClinical.listEncounters({
    petId: activeEncounter.value.pet_id,
    storeId: tenantStore.currentStoreId || undefined,
    pageSize: 10,
  })
  recentEncounters.value = (res.data.list as EncounterRecord[]).filter(e => e.id !== activeEncounter.value?.id)
  await enrich(recentEncounters.value)
}

async function onSelectAppointment(row: AppointmentRecord) {
  // P0-25:切换患者前确认未保存内容
  if (isDirty.value) {
    const ok = await confirmSwitchPatient()
    if (!ok) {
      return
    }
  }
  if (row.status === 'checked_in') {
    try {
      await apiClinical.startAppointment(row.id)
      await loadTodayAppointments()
    }
    catch (e: any) {
      useFaToast().error(e?.message || '开始就诊失败')
      return
    }
  }
  await openOrCreateEncounter(row)
}

async function openOrCreateEncounter(row: AppointmentRecord) {
  try {
    const res: any = await apiClinical.listEncounters({
      doctorId: row.doctor_id ?? undefined,
      petId: row.pet_id,
      pageSize: 10,
    })
    const existing = (res.data.list as EncounterRecord[]).find(e => e.appointment_id === row.id)
    if (existing) {
      await applyEncounter(existing)
    }
    else {
      const createRes: any = await apiClinical.createEncounter({
        tenantId: row.tenant_id,
        storeId: row.store_id ?? undefined,
        appointmentId: row.id,
        customerId: row.customer_id,
        petId: row.pet_id,
        doctorId: row.doctor_id ?? undefined,
        chiefComplaint: row.reason ?? undefined,
      })
      await applyEncounter(createRes.data)
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message || '打开就诊失败')
  }
}

async function applyEncounter(encounter: EncounterRecord) {
  activeEncounter.value = encounter
  encounterForm.chiefComplaint = encounter.chief_complaint ?? ''
  encounterForm.historyPresent = encounter.history_present ?? ''
  encounterForm.examFindings = encounter.exam_findings ?? ''
  encounterForm.diagnosisText = encounter.diagnosis_text ?? ''
  encounterForm.treatmentPlan = encounter.treatment_plan ?? ''
  encounterForm.followUpDate = encounter.follow_up_date ?? ''
  baselineEncounter.value = encounter
  workbenchGuard.setDirty(false)
  await Promise.all([
    loadActivePet(encounter.pet_id),
    loadPrescriptions(encounter.id),
    // P0-05:本次就诊检验 = current encounter_id
    loadLabOrders(encounter.id),
  ])
  loadRecentEncounters()
}

async function loadActivePet(petId: string) {
  const { data } = await supabase.from('pets').select('*').eq('id', petId).single()
  activePet.value = (data ?? null) as PetRecord | null
}

async function loadPrescriptions(encounterId: string) {
  try {
    const res: any = await apiClinical.listPrescriptions({ encounterId })
    prescriptions.value = res.data.list ?? []
  }
  catch {
    prescriptions.value = []
  }
}

async function loadLabOrders(encounterId: string) {
  try {
    const res: any = await apiDiagnostics.listLabOrders({ encounterId, pageSize: 20 })
    labOrders.value = res.data.list ?? []
  }
  catch {
    labOrders.value = []
  }
}

async function onSaveDraft() {
  if (!activeEncounter.value) { return }
  if (activeEncounter.value.status === 'signed') {
    useFaToast().warning('已签署病历不可直接修改,请使用修订功能')
    return
  }
  saving.value = true
  try {
    const res: any = await apiClinical.updateEncounter(activeEncounter.value.id, {
      chiefComplaint: encounterForm.chiefComplaint,
      historyPresent: encounterForm.historyPresent,
      examFindings: encounterForm.examFindings,
      diagnosisText: encounterForm.diagnosisText,
      treatmentPlan: encounterForm.treatmentPlan,
      followUpDate: encounterForm.followUpDate || undefined,
      expectedVersion: activeEncounter.value.version,
    })
    activeEncounter.value = res.data
    baselineEncounter.value = res.data
    workbenchGuard.setDirty(false)
    lastSavedAt.value = new Date()
    useFaToast().success('病历已保存')
  }
  catch (e: any) {
    // P0-26:乐观锁冲突走专门 UX,禁止只给普通 Error Toast / 覆盖服务器最新版本
    if (e?.response?.status === 409) {
      conflictVisible.value = true
      return
    }
    useFaToast().error(e?.message || '保存失败')
  }
  finally {
    saving.value = false
  }
}

async function fetchLatestEncounter(id: string): Promise<EncounterRecord> {
  const res: any = await apiClinical.getEncounter(id)
  return res.data.encounter as EncounterRecord
}

/** 409 弹窗动作1:查看最新版本(丢弃本地未保存内容) */
async function onConflictViewLatest() {
  if (!activeEncounter.value) { return }
  try {
    const latest = await fetchLatestEncounter(activeEncounter.value.id)
    conflictVisible.value = false
    await applyEncounter(latest)
    useFaToast().success('已载入服务器最新版本')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载最新版本失败')
  }
}

/** 409 弹窗动作2:复制我的未保存内容(载入最新,保留本地编辑,由用户确认后重新保存) */
async function onConflictKeepMine() {
  const mine = {
    chiefComplaint: encounterForm.chiefComplaint,
    historyPresent: encounterForm.historyPresent,
    examFindings: encounterForm.examFindings,
    diagnosisText: encounterForm.diagnosisText,
    treatmentPlan: encounterForm.treatmentPlan,
    followUpDate: encounterForm.followUpDate,
  }
  if (!activeEncounter.value) { return }
  try {
    const latest = await fetchLatestEncounter(activeEncounter.value.id)
    conflictVisible.value = false
    await applyEncounter(latest)
    encounterForm.chiefComplaint = mine.chiefComplaint
    encounterForm.historyPresent = mine.historyPresent
    encounterForm.examFindings = mine.examFindings
    encounterForm.diagnosisText = mine.diagnosisText
    encounterForm.treatmentPlan = mine.treatmentPlan
    encounterForm.followUpDate = mine.followUpDate
    workbenchGuard.setDirty(true)
    useFaToast().warning('已载入最新版本,你的未保存内容已保留,请核对后重新保存')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载最新版本失败')
  }
}

/** 409 弹窗动作3:稍后处理 */
function onConflictLater() {
  conflictVisible.value = false
}

/** P0-25:切换患者前确认 */
function confirmSwitchPatient(): Promise<boolean> {
  return new Promise((resolve) => {
    useFaModal().confirm({
      title: '未保存的病历',
      content: '当前病历有尚未保存的内容,切换患者将丢失这些修改。',
      confirmButtonText: '放弃并切换',
      cancelButtonText: '取消',
      onConfirm: () => { workbenchGuard.setDirty(false); resolve(true) },
      onCancel: () => resolve(false),
    })
  })
}

/** P0-25:路由离开保护 */
onBeforeRouteLeave(async () => {
  if (!isDirty.value) { return true }
  return new Promise((resolve) => {
    useFaModal().confirm({
      title: '未保存的病历',
      content: '当前病历有尚未保存的内容,确定要离开吗?',
      confirmButtonText: '放弃并离开',
      cancelButtonText: '取消',
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
})

/** P0-25:刷新/关闭页面保护 */
function handleBeforeUnload(e: BeforeUnloadEvent) {
  if (isDirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

/** 医生工作台内快捷发起影像申请(S3.1-影像工作流入口) */
function onRequestImaging() {
  if (!activeEncounter.value) { return }
  router.push({
    path: '/diagnostics/imaging',
    query: {
      encounterId: activeEncounter.value.id,
      petId: activeEncounter.value.pet_id,
      customerId: activeEncounter.value.customer_id,
    },
  })
}

function onOpenDetail() {
  if (activeEncounter.value) {
    router.push(`/clinical/encounter/${activeEncounter.value.id}`)
  }
}

async function onComplete() {
  if (!activeEncounter.value) { return }
  useFaModal().confirm({
    title: '完成就诊',
    content: '确认完成本次就诊?完成后可进行病历签署。',
    onConfirm: async () => {
      try {
        await apiClinical.completeEncounter(activeEncounter.value!.id)
        useFaToast().success('就诊已完成')
        onOpenDetail()
      }
      catch (e: any) {
        useFaToast().error(e?.message || '完成就诊失败')
      }
    },
  })
}

const savedText = computed(() => {
  if (!lastSavedAt.value) { return '尚未保存' }
  return `已保存 ${lastSavedAt.value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
})

// P0-06:切店后清空当前患者上下文并按新门店重载候诊队列(切店前 ToolbarStart 已做 dirty 确认)
useStoreScopedPage({
  load: loadTodayAppointments,
  reset: () => {
    activeEncounter.value = null
    activePet.value = null
    recentEncounters.value = []
    prescriptions.value = []
    labOrders.value = []
    encounterForm.chiefComplaint = ''
    encounterForm.historyPresent = ''
    encounterForm.examFindings = ''
    encounterForm.diagnosisText = ''
    encounterForm.treatmentPlan = ''
    encounterForm.followUpDate = ''
    baselineEncounter.value = null
    conflictVisible.value = false
    workbenchGuard.setDirty(false)
    lastSavedAt.value = null
  },
})

onMounted(() => {
  loadTodayAppointments()
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  workbenchGuard.setDirty(false)
})
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="医生工作台" description="今日候诊 · 病历编辑 · 医疗操作一站式完成">
      <template #actions>
        <FaButton v-if="activeEncounter" size="sm" variant="outline" @click="onOpenDetail">
          <FaIcon name="i-lucide:file-text" />
          病历详情
        </FaButton>
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <PetSafetyBanner
        v-if="activePet"
        :risk-tags="activePet.risk_tags"
        :temperament="activePet.temperament"
        :medical-notes="activePet.medical_notes"
      />

      <div class="flex flex-1 gap-4 min-h-0">
        <!-- 左:候诊/历史 -->
        <div class="border rounded-lg bg-card flex shrink-0 flex-col w-[280px]">
          <div class="text-sm font-medium px-3 py-2 border-b">
            今日候诊({{ queueRows.length }})
          </div>
          <div v-loading="loadingAppointments" class="p-2 flex-1 min-h-0 overflow-auto">
            <button
              v-for="item in queueRows"
              :key="item.id"
              type="button"
              class="mb-2 p-2.5 text-left border rounded-md w-full transition hover:bg-gray-50"
              :class="{ 'border-primary bg-primary-50': activeEncounter?.appointment_id === item.id }"
              @click="onSelectAppointment(item)"
            >
              <div class="flex gap-2 items-center justify-between">
                <span class="text-sm font-medium">{{ item.petName }}</span>
                <span class="text-xs text-muted-foreground">{{ new Date(item.scheduled_start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</span>
              </div>
              <div class="text-xs text-muted-foreground mt-0.5 truncate">
                {{ item.customerName }}<template v-if="item.phone">
                  · {{ item.phone }}
                </template>
              </div>
              <div class="mt-1 flex gap-2 items-center justify-between">
                <span class="text-xs text-muted-foreground truncate">{{ item.reason ?? '未填写原因' }}</span>
                <EntityStatusTag :label="item.status" variant="neutral" :dot="false" />
              </div>
            </button>
            <EmptyState v-if="!loadingAppointments && queueRows.length === 0" compact title="今日无预约" />
          </div>

          <div class="text-sm font-medium px-3 py-2 border-t">
            最近就诊({{ recentEncounters.length }})
          </div>
          <div class="p-2 flex-1 min-h-0 overflow-auto">
            <div
              v-for="e in recentEncounters"
              :key="e.id"
              class="mb-2 p-2.5 border rounded-md"
              @click="router.push(`/clinical/encounter/${e.id}`)"
            >
              <div class="flex gap-2 items-center justify-between">
                <span class="text-sm font-medium truncate">{{ petMap[e.pet_id]?.name ?? '未知宠物' }}</span>
                <EntityStatusTag :label="ENCOUNTER_STATUS_LABELS[e.status]" variant="info" :dot="false" />
              </div>
              <div class="text-xs text-muted-foreground mt-0.5 truncate">
                {{ e.chief_complaint ?? '无主诉' }}
              </div>
            </div>
          </div>
        </div>

        <!-- 中:病历编辑 -->
        <div class="p-4 border rounded-lg bg-card flex-1 min-w-0 overflow-auto">
          <div v-if="activeEncounter" class="space-y-3">
            <div class="flex items-center justify-between">
              <div class="text-sm text-muted-foreground font-medium">
                就诊病历
                <EntityStatusTag :label="ENCOUNTER_STATUS_LABELS[activeEncounter.status]" variant="info" class="ml-2" />
              </div>
            </div>
            <FaLabel label="主诉">
              <FaInput v-model="encounterForm.chiefComplaint" :disabled="activeEncounter.status === 'signed'" placeholder="宠物主诉" class="w-full" />
            </FaLabel>
            <FaLabel label="现病史">
              <FaInput v-model="encounterForm.historyPresent" :disabled="activeEncounter.status === 'signed'" type="textarea" :rows="3" placeholder="病史描述" class="w-full" />
            </FaLabel>
            <FaLabel label="检查发现">
              <FaInput v-model="encounterForm.examFindings" :disabled="activeEncounter.status === 'signed'" type="textarea" :rows="3" placeholder="体检发现" class="w-full" />
            </FaLabel>
            <FaLabel label="诊断">
              <FaInput v-model="encounterForm.diagnosisText" :disabled="activeEncounter.status === 'signed'" placeholder="诊断结论" class="w-full" />
            </FaLabel>
            <FaLabel label="治疗方案">
              <FaInput v-model="encounterForm.treatmentPlan" :disabled="activeEncounter.status === 'signed'" type="textarea" :rows="3" placeholder="治疗方案" class="w-full" />
            </FaLabel>
            <FaLabel label="复诊日期">
              <FaInput v-model="encounterForm.followUpDate" :disabled="activeEncounter.status === 'signed'" type="date" class="w-full" />
            </FaLabel>
          </div>
          <EmptyState v-else description="请从左侧选择预约开始就诊" />
        </div>

        <!-- 右:医疗操作 -->
        <div class="border rounded-lg bg-card flex shrink-0 flex-col w-[360px]">
          <div class="text-sm font-medium px-3 py-2 border-b">
            医疗操作
          </div>
          <div v-if="activeEncounter" class="p-3 flex-1 min-h-0 overflow-auto">
            <div class="mb-4">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm font-medium">处方({{ prescriptions.length }})</span>
                <FaButton size="sm" variant="ghost" @click="router.push(`/clinical/encounter/${activeEncounter!.id}`)">
                  管理
                </FaButton>
              </div>
              <div class="space-y-1.5">
                <div v-for="rx in prescriptions" :key="rx.id" class="text-xs p-2 border rounded-md">
                  <div class="font-medium">
                    {{ rx.name ?? '未命名处方' }}
                  </div>
                  <div class="text-muted-foreground mt-0.5">
                    {{ rx.status }}
                  </div>
                </div>
                <EmptyState v-if="!prescriptions.length" compact title="暂无处方" />
              </div>
            </div>
            <div class="mb-4">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm font-medium">检验({{ labOrders.length }})</span>
                <FaButton size="sm" variant="ghost" @click="router.push('/diagnostics/lab')">
                  查看
                </FaButton>
              </div>
              <div class="space-y-1.5">
                <div v-for="lo in labOrders" :key="lo.id" class="text-xs p-2 border rounded-md">
                  <div class="font-medium">
                    {{ lo.order_no }}
                  </div>
                  <div class="text-muted-foreground mt-0.5">
                    {{ lo.status }}
                  </div>
                </div>
                <EmptyState v-if="!labOrders.length" compact title="暂无检验" />
              </div>
            </div>
            <div class="mb-4">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm font-medium">影像</span>
              </div>
              <FaButton size="sm" variant="outline" class="w-full justify-start" @click="onRequestImaging">
                <FaIcon name="i-lucide:scan-line" />
                申请影像
              </FaButton>
            </div>
          </div>
          <EmptyState v-else compact title="选择就诊后显示处方/检验" />
        </div>
      </div>
    </div>

    <WorkflowFixedBar>
      <template #left>
        <span class="text-sm text-muted-foreground">{{ savedText }}</span>
        <span v-if="activeEncounter" class="text-sm">
          宠物: <span class="font-medium">{{ activePet?.name ?? '未知' }}</span>
        </span>
      </template>
      <template #right>
        <FaButton size="sm" variant="outline" :disabled="!activeEncounter || activeEncounter.status === 'signed'" :loading="saving" @click="onSaveDraft">
          <FaIcon name="i-lucide:save" />
          保存草稿
        </FaButton>
        <FaButton size="sm" variant="outline" :disabled="!activeEncounter || activeEncounter.status === 'signed'" @click="onComplete">
          <FaIcon name="i-lucide:check" />
          完成就诊
        </FaButton>
      </template>
    </WorkflowFixedBar>

    <!-- P0-26:乐观锁冲突弹窗(查看最新/复制未保存/稍后处理) -->
    <div v-if="conflictVisible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="onConflictLater">
      <div class="w-[420px] max-w-full rounded-lg border bg-card p-5 shadow-xl">
        <div class="flex items-center gap-2">
          <FaIcon name="i-lucide:triangle-alert" class="text-amber-600" />
          <span class="text-base font-semibold">病历已被其他人更新</span>
        </div>
        <p class="mt-2 text-sm text-muted-foreground">
          该病历在其他窗口已被修改,直接保存将覆盖对方内容。请选择处理方式:
        </p>
        <div class="mt-4 space-y-2">
          <FaButton class="w-full justify-start" variant="outline" @click="onConflictViewLatest">
            <FaIcon name="i-lucide:refresh-cw" />
            查看最新版本
          </FaButton>
          <FaButton class="w-full justify-start" variant="outline" @click="onConflictKeepMine">
            <FaIcon name="i-lucide:clipboard-copy" />
            复制我的未保存内容
          </FaButton>
          <FaButton class="w-full justify-start" @click="onConflictLater">
            稍后处理
          </FaButton>
        </div>
      </div>
    </div>
  </div>
</template>
