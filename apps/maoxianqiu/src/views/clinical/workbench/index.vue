<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- 工作台动作守卫与竞态校验使用单行提前返回 */
import type { EncounterFormState } from './composables/useEncounterDraft'
import type { EncounterRecord } from '@/types/clinical'
/**
 * ClinicalWorkbench — 医生工作台页面编排层
 * 统一消费 GET /workbenches/doctor 与 GET /clinical/encounters/:id/workspace,
 * 由 composables 驱动队列/工作区/病历草稿/方案草稿,组件只负责展示与交互。
 * 布局:≥1360 三栏(候诊+病历+诊疗方案);<1360 候诊/方案进入 FaDrawer,
 * 病历编辑区始终保留可编辑宽度。
 */
import type { DoctorQueueRow, EncounterWorkspace } from '@/types/patient-journey'
import apiClinical from '@/api/modules/clinical'
import apiMedicationSafety from '@/api/modules/medication-safety'
import apiJourney from '@/api/modules/patient-journey'
import ClinicalPlanPanel from './components/ClinicalPlanPanel.vue'
import ClinicalPlanSummary from './components/ClinicalPlanSummary.vue'
import DoctorQueuePanel from './components/DoctorQueuePanel.vue'
import EncounterConflictModal from './components/EncounterConflictModal.vue'
import EncounterEditor from './components/EncounterEditor.vue'
import PatientContextBar from './components/PatientContextBar.vue'
import RecentEncounterDrawer from './components/RecentEncounterDrawer.vue'
import { useClinicalPlanDraft } from './composables/useClinicalPlanDraft'
import { useDoctorQueue } from './composables/useDoctorQueue'
import { useEncounterDraft } from './composables/useEncounterDraft'
import { useEncounterWorkspace } from './composables/useEncounterWorkspace'

defineOptions({
  name: 'ClinicalWorkbench',
})

// ===== 组合式函数实例化 =====
// conflictVisible 须先于 useEncounterDraft 声明,其 onAutosaveConflict 回调在自动保存 409 时打开冲突弹窗
const conflictVisible = ref(false)
const queue = useDoctorQueue()
const workspace = useEncounterWorkspace()
const draft = useEncounterDraft({
  onAutosaveConflict: () => { conflictVisible.value = true },
})
const plan = useClinicalPlanDraft()

// 顶层解构:plain 对象内的 ref 在模板中不会自动解包,解构为顶层 ref 后由模板自动解包
const {
  doctorQueue,
  loadingQueue,
  queueCounts,
} = queue
const {
  workspace: workspaceData,
  loadingWorkspace,
  activeEncounter,
  activePet,
  encounterReadonly,
  billing,
  medicationSafety,
  recentEncounters,
} = workspace
const {
  form,
  saving,
  savedText,
  isDirty: encounterDirty,
} = draft
const {
  prescriptionDraft,
  prescriptionSubmitting,
  labDraft,
  imagingDraft,
  diagnosticSubmitting,
  medicalOrderDraft,
  medicalOrderSubmitting,
  planDirty,
  validPrescriptionItems,
} = plan

/** 全局未保存保护:病历 + 下单草稿整体判定 */
const workbenchGuard = usePageUnsavedGuard('clinical-workbench')

// ===== 响应式三栏(测量内容区实际宽度,扣除应用侧边栏后判断) =====
const contentRef = ref<HTMLElement | null>(null)
const contentWidth = ref(0)
const isWide = computed(() => contentWidth.value >= 1360)
let resizeObserver: ResizeObserver | null = null
/** 以内容区容器宽度(而非 window.innerWidth)作为三栏切换基准 */
function measureContentWidth() {
  if (contentRef.value) {
    contentWidth.value = contentRef.value.clientWidth
  }
}

// ===== 抽屉状态(窄屏) =====
const queueDrawerVisible = ref(false)
const planDrawerVisible = ref(false)
const historyDrawerVisible = ref(false)

// ===== 提交确认与冲突弹窗 =====
const summaryVisible = ref(false)
const submittingPlan = ref(false)

/** 整体 dirty:病历未保存或存在下单草稿 */
const overallDirty = computed(() => draft.isDirty.value || plan.planDirty.value)
watch(overallDirty, d => workbenchGuard.setDirty(d), { immediate: true })

/** 当前选中队列项高亮 id */
const activeQueueId = computed(() => selectedQueueId.value ?? (workspace.workspace.value?.queue?.id as string | undefined))

/**
 * 点击即选中的队列项 id(不等 workspace 接口返回,保证卡片高亮即时切换)。
 * 与 previewWorkspace 配合:先立即高亮并展示患者预览,再异步加载完整工作区。
 */
const selectedQueueId = ref<string | undefined>(undefined)
/** 基于队列行构造的患者信息预览(工作区加载完成前先展示) */
const previewWorkspace = ref<EncounterWorkspace | null>(null)
/** 预览竞态令牌:每次点击自增,仅最新一次点击可清空预览 */
let previewToken = 0

/** 点击患者后立即高亮卡片并基于队列行构造预览工作区(不等接口返回);返回竞态令牌 */
function setPreviewWorkspace(row: DoctorQueueRow): number {
  previewToken += 1
  selectedQueueId.value = row.id
  previewWorkspace.value = {
    encounter: {},
    queue: { id: row.id, status: row.status, queue_no: row.queue_no ?? row.queue_number ?? '' },
    triage: null,
    tasks: [],
    charges: [],
    timeline: [],
    prescriptions: [],
    labOrders: [],
    imagingOrders: [],
    medicalOrders: [],
    pet: (row.pet ?? null) as Record<string, any> | null,
    customer: (row.customer ?? null) as Record<string, any> | null,
    recentEncounters: [],
    billing: { pendingAmount: 0, noPriceCount: 0, pendingCount: 0, paidAmount: 0 },
    medicationSafety: { blockingChecks: [], warningChecks: [], hasBlocking: false },
    journeyStage: '',
    blockers: [],
    warnings: [],
    nextOwnerRole: null,
    allowedActions: [],
    workspaceVersion: 0,
  }
  return previewToken
}

// ===== 病历字段更新:同步草稿 + 触发自动保存 =====
function onFormUpdate(field: keyof EncounterFormState, value: string) {
  ;(draft.form as unknown as Record<string, string>)[field] = value
  draft.scheduleAutosave()
}

// ===== 队列交互 =====

/** 叫号:waiting → called */
async function onCallQueueRow(row: DoctorQueueRow) {
  await queue.callPatient(row)
}

/** 开始接诊:点击即选中并展示患者预览,再流转 called → in_consultation 并打开患者工作区(用刷新后的最新行,避免重复创建就诊) */
async function onStartQueueRow(row: DoctorQueueRow) {
  setPreviewWorkspace(row)
  const { ok, updated } = await queue.startConsultation(row)
  if (ok) {
    await openQueueRow(updated ?? row)
  }
}

/** 选择队列行:先过 dirty guard,再打开(或创建)患者工作区 */
async function onSelectQueueRow(row: DoctorQueueRow) {
  if (overallDirty.value) {
    const confirmed = await confirmDiscardDraft()
    if (!confirmed) { return }
  }
  // 已叫号状态点击:先立即选中并展示患者预览,再转入接诊(服务端自动创建就诊并回写队列),最后打开工作区
  if (row.status === 'called') {
    setPreviewWorkspace(row)
    const { ok, updated } = await queue.startConsultation(row)
    if (!ok) { return }
    await openQueueRow(updated ?? row)
    return
  }
  await openQueueRow(row)
}

/**
 * 打开患者工作区:点击即高亮并展示预览,再异步加载。
 * 优先复用已有关联 encounter,否则按预约创建;选中后只请求一次 workspace,命令成功后再后台刷新校准。
 */
async function openQueueRow(row: DoctorQueueRow) {
  const token = setPreviewWorkspace(row)
  if (row.encounter?.id) {
    await loadWorkspaceById(row.encounter.id, token)
    return
  }
  const petId = row.pet?.id
  const customerId = row.customer?.id
  if (!petId || !customerId) {
    useFaToast().warning('候诊记录缺少宠物/主人信息,请先由前台补全')
    return
  }
  try {
    const created: any = await apiClinical.createEncounter({
      tenantId: (row as any).tenant_id,
      storeId: (row as any).store_id ?? undefined,
      appointmentId: row.appointment?.id,
      customerId,
      petId,
      doctorId: (row as any).assigned_doctor_id ?? undefined,
      chiefComplaint: row.appointment?.reason ?? undefined,
    })
    await loadWorkspaceById(created.data.id, token)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '创建就诊失败')
  }
}

/**
 * 按 encounterId 加载工作区并把病历载入草稿。
 * 仅当本次加载仍是最新一次点击(token 匹配)时,才把患者预览切换为完整工作区,避免快速切换患者时预览被旧请求清空。
 */
async function loadWorkspaceById(encounterId: string, token: number) {
  const data = await workspace.loadWorkspace(encounterId)
  if (!data?.encounter) { return }
  if (token === previewToken) {
    previewWorkspace.value = null
  }
  draft.applyEncounter(data.encounter as EncounterRecord)
  plan.resetPlanDraft()
  summaryVisible.value = false
}

// ===== 病历保存 =====

/** 保存病历草稿;409 冲突打开标准化冲突弹窗 */
async function onSaveDraft() {
  if (!workspace.activeEncounter.value) { return }
  try {
    const saved = await draft.saveDraft()
    if (saved) {
      await workspace.refreshWorkspace()
    }
  }
  catch (e: any) {
    if (e?.response?.status === 409) {
      conflictVisible.value = true
      return
    }
    useFaToast().error(e?.message || '保存失败')
  }
}

/** 签署病历:先确保草稿已保存,再调用签署命令(签署后只读,修改须走修订功能) */
const signingEncounter = ref(false)
async function onSignEncounter() {
  const enc = workspace.activeEncounter.value
  if (!enc) { return }
  if (draft.isDirty.value) {
    const saved = await draft.saveDraft()
    if (!saved) { return }
    await workspace.refreshWorkspace()
  }
  signingEncounter.value = true
  try {
    await apiClinical.signEncounter(enc.id)
    useFaToast().success('病历已签署,不可再直接修改(修改须走修订功能)')
    await workspace.refreshWorkspace()
    await queue.loadQueue()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '签署病历失败')
  }
  finally {
    signingEncounter.value = false
  }
}

// ===== 四类下单提交 =====

async function onSubmitPrescription() {
  const enc = workspace.activeEncounter.value
  if (!enc) { return }
  const ok = await plan.submitPrescription(enc.id)
  if (ok) { await workspace.refreshWorkspace() }
}

async function onSubmitLab() {
  const enc = workspace.activeEncounter.value
  if (!enc) { return }
  const ok = await plan.submitLab(enc.id, enc.customer_id, enc.pet_id)
  if (ok) { await workspace.refreshWorkspace() }
}

async function onSubmitImaging() {
  const enc = workspace.activeEncounter.value
  if (!enc) { return }
  const ok = await plan.submitImaging(enc.id, enc.customer_id, enc.pet_id)
  if (ok) { await workspace.refreshWorkspace() }
}

async function onSubmitMedicalOrder() {
  const enc = workspace.activeEncounter.value
  if (!enc) { return }
  const ok = await plan.submitMedicalOrder(enc.id, enc.customer_id, enc.pet_id)
  if (ok) { await workspace.refreshWorkspace() }
}

/** 用药安全阻断豁免:调用 overrideCheck 命令(原因必填),成功后刷新工作区 */
async function onOverrideMedicationCheck(payload: { checkId: string, reason: string }) {
  try {
    await apiMedicationSafety.overrideCheck(payload.checkId, { reason: payload.reason })
    useFaToast().success('豁免已记录并写入审计')
    await workspace.refreshWorkspace()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '豁免失败')
  }
}

// ===== 历史病历复制 =====

/** 将历史病历的诊断/方案复制到当前草稿(仅复制,提示未保存) */
function onCopyHistoryToDraft(e: Record<string, any>) {
  if (!e.diagnosis_text && !e.treatment_plan) {
    useFaToast().warning('该历史病历没有可复制的诊断或方案')
    return
  }
  if (e.diagnosis_text) {
    draft.form.diagnosisText = draft.form.diagnosisText
      ? `${draft.form.diagnosisText}；${e.diagnosis_text}`
      : e.diagnosis_text
  }
  if (e.treatment_plan) {
    draft.form.treatmentPlan = draft.form.treatmentPlan
      ? `${draft.form.treatmentPlan}；${e.treatment_plan}`
      : e.treatment_plan
  }
  draft.scheduleAutosave()
  historyDrawerVisible.value = false
  useFaToast().info('已复制到当前草稿,尚未保存')
}

// ===== 提交诊疗方案 =====

/** 本次提交将随 plan/commit 一并原子落库的草稿摘要(确认摘要展示) */
const pendingDraftsSummary = computed(() => {
  const items: Array<{ type: string, label: string }> = []
  const rxCount = validPrescriptionItems.value.length
  if (rxCount) { items.push({ type: '处方', label: `${rxCount} 行药品` }) }
  if (labDraft.catalogItemId) { items.push({ type: '检验', label: '1 项' }) }
  if (imagingDraft.catalogItemId) { items.push({ type: '影像', label: '1 项' }) }
  if (medicalOrderDraft.itemName) { items.push({ type: '医嘱', label: medicalOrderDraft.itemName }) }
  return items
})

/** 点击"提交诊疗方案":先确保病历已保存,再打开确认摘要(剩余下单草稿随提交原子落库) */
async function onRequestCommitPlan() {
  const enc = workspace.activeEncounter.value
  if (!enc) { return }
  if (workspace.encounterReadonly.value) {
    useFaToast().warning('当前就诊已关闭/签署,不可提交诊疗方案')
    return
  }
  if (draft.isDirty.value) {
    const saved = await draft.saveDraft()
    if (!saved) { return }
    await workspace.refreshWorkspace()
  }
  if (workspace.medicationSafety.value?.hasBlocking) {
    useFaToast().error('存在未处理的用药安全阻断,请先处理豁免')
    planDrawerVisible.value = true
    return
  }
  summaryVisible.value = true
}

/**
 * 确认提交:病历 + 剩余下单草稿通过 plan/commit 单一 Command 原子落库,
 * 服务端单事务完成处方/检验/影像/医嘱/收费/任务/事件并推进 plan_ready。
 */
async function onConfirmPlan() {
  const enc = workspace.activeEncounter.value
  const base = draft.baselineEncounter.value
  if (!enc || !base) { return }
  // 收集当前未提交的下单草稿:处方有效行 + 检验/影像/医嘱单条草稿
  const prescriptions = validPrescriptionItems.value.map(item => ({
    catalogItemId: item.catalogItemId || undefined,
    drugName: item.drugName,
    dosage: item.dosage || undefined,
    frequency: item.frequency || undefined,
    quantity: Number(item.quantity),
    unit: item.unit || undefined,
    instructions: item.instructions || undefined,
  }))
  const labs = labDraft.catalogItemId
    ? [{ catalogItemId: labDraft.catalogItemId, remark: labDraft.remark || undefined }]
    : []
  const imaging = imagingDraft.catalogItemId
    ? [{
        catalogItemId: imagingDraft.catalogItemId,
        imagingType: imagingDraft.imagingType,
        clinicalQuestion: imagingDraft.clinicalQuestion || undefined,
      }]
    : []
  const medicalOrders = medicalOrderDraft.itemName
    ? [{
        orderType: medicalOrderDraft.orderType,
        itemName: medicalOrderDraft.itemName,
        dosage: medicalOrderDraft.dosage || undefined,
        frequency: medicalOrderDraft.frequency || undefined,
        quantity: Number(medicalOrderDraft.quantity),
        unit: medicalOrderDraft.unit || undefined,
        instructions: medicalOrderDraft.instructions || undefined,
      }]
    : []
  submittingPlan.value = true
  summaryVisible.value = false
  try {
    await apiJourney.commitClinicalPlan(enc.id, {
      expectedVersion: base.version,
      encounterUpdates: {
        chiefComplaint: draft.form.chiefComplaint,
        historyPresent: draft.form.historyPresent,
        examFindings: draft.form.examFindings,
        diagnosisText: draft.form.diagnosisText,
        treatmentPlan: draft.form.treatmentPlan,
        followUpDate: draft.form.followUpDate || undefined,
      },
      prescriptions,
      labs,
      imaging,
      medicalOrders,
      finishConsultation: true,
    })
    plan.resetPlanDraft()
    useFaToast().success('诊疗方案已提交,下游岗位待办已保留')
    await queue.loadQueue()
    await workspace.refreshWorkspace()
  }
  catch (e: any) {
    if (e?.response?.status === 409) {
      conflictVisible.value = true
      return
    }
    useFaToast().error(e?.message || '提交诊疗方案失败')
  }
  finally {
    submittingPlan.value = false
  }
}

// ===== 409 冲突三种动作 =====

/** 查看最新版本(丢弃本地未保存内容) */
async function onConflictViewLatest() {
  const enc = workspace.activeEncounter.value
  if (!enc) { return }
  conflictVisible.value = false
  await loadWorkspaceById(enc.id)
  useFaToast().success('已载入服务器最新版本')
}

/** 复制我的未保存内容(载入最新,保留本地编辑,由用户确认后重新保存) */
async function onConflictKeepMine() {
  const enc = workspace.activeEncounter.value
  if (!enc) { return }
  const mine = {
    chiefComplaint: draft.form.chiefComplaint,
    historyPresent: draft.form.historyPresent,
    examFindings: draft.form.examFindings,
    diagnosisText: draft.form.diagnosisText,
    treatmentPlan: draft.form.treatmentPlan,
    followUpDate: draft.form.followUpDate,
  }
  conflictVisible.value = false
  await loadWorkspaceById(enc.id)
  draft.form.chiefComplaint = mine.chiefComplaint
  draft.form.historyPresent = mine.historyPresent
  draft.form.examFindings = mine.examFindings
  draft.form.diagnosisText = mine.diagnosisText
  draft.form.treatmentPlan = mine.treatmentPlan
  draft.form.followUpDate = mine.followUpDate
  workbenchGuard.setDirty(true)
  useFaToast().warning('已载入最新版本,你的未保存内容已保留,请核对后重新保存')
}

/** 稍后处理 */
function onConflictLater() {
  conflictVisible.value = false
}

// ===== 未保存保护 =====

/** 切换患者/离开前确认丢弃草稿 */
function confirmDiscardDraft(): Promise<boolean> {
  return new Promise((resolve) => {
    useFaModal().confirm({
      title: '未保存的内容',
      content: '当前病历或下单草稿有尚未保存的内容,继续操作将丢失这些修改。',
      confirmButtonText: '放弃并继续',
      cancelButtonText: '取消',
      onConfirm: () => { workbenchGuard.setDirty(false); resolve(true) },
      onCancel: () => resolve(false),
    })
  })
}

/** 路由离开保护 */
onBeforeRouteLeave(async () => {
  if (!overallDirty.value) { return true }
  return new Promise((resolve) => {
    useFaModal().confirm({
      title: '未保存的内容',
      content: '当前病历或下单草稿有尚未保存的内容,确定要离开吗?',
      confirmButtonText: '放弃并离开',
      cancelButtonText: '取消',
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
})

/** 刷新/关闭页面保护 */
function handleBeforeUnload(e: BeforeUnloadEvent) {
  if (overallDirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

// ===== 切店保护 =====
useStoreScopedPage({
  load: () => queue.loadQueue(),
  reset: () => {
    workspace.resetWorkspace()
    draft.resetDraft()
    plan.resetPlanDraft()
    queue.reset()
    conflictVisible.value = false
    summaryVisible.value = false
    historyDrawerVisible.value = false
    // 清理选中高亮与患者预览,避免切店后残留旧门店患者
    selectedQueueId.value = undefined
    previewWorkspace.value = null
    workbenchGuard.setDirty(false)
  },
})

// ===== 生命周期 =====
onMounted(() => {
  queue.loadQueue()
  // 以内容区容器宽度驱动三栏布局切换(替代 window.innerWidth)
  measureContentWidth()
  resizeObserver = new ResizeObserver(measureContentWidth)
  if (contentRef.value) {
    resizeObserver.observe(contentRef.value)
  }
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('beforeunload', handleBeforeUnload)
  workbenchGuard.setDirty(false)
})
</script>

<template>
  <div ref="contentRef" class="flex flex-col h-full min-h-0">
    <!-- 顶部患者安全条(点击患者即展示预览,工作区加载完成后切换为完整数据) -->
    <PatientContextBar
      v-if="previewWorkspace || workspaceData"
      :workspace="previewWorkspace ?? workspaceData"
      class="m-3 mb-0 shrink-0"
    />

    <!-- ===== 宽屏三栏(内容区 ≥1360) ===== -->
    <template v-if="isWide">
      <div class="p-3 flex flex-1 gap-3 min-h-0">
        <!-- 左:候诊队列 -->
        <aside class="border rounded-lg bg-card flex shrink-0 flex-col min-h-0 w-60">
          <div class="px-3 py-2 border-b flex shrink-0 items-center justify-between">
            <span class="text-sm font-medium">
              候诊({{ queueCounts.waiting + queueCounts.called + queueCounts.consulting }})
            </span>
            <FaButton size="sm" variant="ghost" @click="historyDrawerVisible = true">
              <FaIcon name="i-lucide:history" />
              历史病历
            </FaButton>
          </div>
          <DoctorQueuePanel
            :rows="doctorQueue"
            :loading="loadingQueue"
            :active-queue-id="activeQueueId"
            @select="onSelectQueueRow"
            @call="onCallQueueRow"
            @start="onStartQueueRow"
          />
        </aside>

        <!-- 中:病历编辑 -->
        <main class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-auto">
          <div
            v-if="loadingWorkspace"
            class="text-muted-foreground flex flex-1 flex-col gap-2 items-center justify-center"
          >
            <FaIcon name="i-mdi:loading" class="size-6 animate-spin" />
            <span class="text-sm">正在加载患者工作区…</span>
          </div>
          <EncounterEditor
            v-else-if="activeEncounter"
            :form="form"
            :readonly="encounterReadonly"
            :saving="saving"
            @update="onFormUpdate"
            @save="onSaveDraft"
          />
          <EmptyState
            v-else
            description="从左侧候诊队列选择患者开始接诊"
            class="flex-1"
          />
        </main>

        <!-- 右:诊疗方案 -->
        <aside class="border rounded-lg bg-card flex shrink-0 flex-col min-h-0 w-80">
          <div
            v-if="loadingWorkspace"
            class="text-muted-foreground flex flex-1 items-center justify-center"
          >
            <FaIcon name="i-mdi:loading" class="size-6 animate-spin" />
          </div>
          <ClinicalPlanPanel
            v-else-if="workspaceData"
            :workspace="workspaceData"
            :readonly="encounterReadonly"
            :prescription-items="prescriptionDraft"
            :prescription-submitting="prescriptionSubmitting"
            :lab-draft="labDraft"
            :imaging-draft="imagingDraft"
            :diagnostic-submitting="diagnosticSubmitting"
            :medical-order-draft="medicalOrderDraft"
            :medical-order-submitting="medicalOrderSubmitting"
            @add-prescription="plan.addPrescriptionItem()"
            @remove-prescription="plan.removePrescriptionItem($event)"
            @update-prescription="(idx, field, val) => plan.updatePrescriptionItem(idx, field, val)"
            @submit-prescription="onSubmitPrescription"
            @update-lab="(field, val) => plan.updateLabDraft(field, val)"
            @submit-lab="onSubmitLab"
            @update-imaging="(field, val) => plan.updateImagingDraft(field, val)"
            @submit-imaging="onSubmitImaging"
            @update-medical-order="(field, val) => plan.updateMedicalOrderDraft(field, val)"
            @submit-medical-order="onSubmitMedicalOrder"
          />
          <EmptyState v-else compact title="选择就诊后显示处方/检验/影像/医嘱" />
        </aside>
      </div>
    </template>

    <!-- ===== 窄屏:病历独占 + 抽屉 ===== -->
    <template v-else>
      <div class="p-3 flex flex-1 min-h-0">
        <main class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-auto">
          <div
            v-if="loadingWorkspace"
            class="text-muted-foreground flex flex-1 flex-col gap-2 items-center justify-center"
          >
            <FaIcon name="i-mdi:loading" class="size-6 animate-spin" />
            <span class="text-sm">正在加载患者工作区…</span>
          </div>
          <EncounterEditor
            v-else-if="activeEncounter"
            :form="form"
            :readonly="encounterReadonly"
            :saving="saving"
            @update="onFormUpdate"
            @save="onSaveDraft"
          />
          <EmptyState
            v-else
            description="从候诊队列选择患者开始接诊(左下角打开队列)"
            class="flex-1"
          />
        </main>
      </div>

      <FaDrawer v-model="queueDrawerVisible" title="候诊队列" width="320" :footer="false">
        <div class="flex flex-col h-full min-h-0">
          <DoctorQueuePanel
            :rows="doctorQueue"
            :loading="loadingQueue"
            :active-queue-id="activeQueueId"
            @select="queueDrawerVisible = false; onSelectQueueRow($event)"
            @call="onCallQueueRow"
            @start="onStartQueueRow"
          />
        </div>
      </FaDrawer>

      <FaDrawer v-model="planDrawerVisible" title="诊疗方案" width="360" :footer="false">
        <div class="flex flex-col h-full min-h-0">
          <div
            v-if="loadingWorkspace"
            class="text-muted-foreground flex flex-1 items-center justify-center"
          >
            <FaIcon name="i-mdi:loading" class="size-6 animate-spin" />
          </div>
          <ClinicalPlanPanel
            v-else-if="workspaceData"
            :workspace="workspaceData"
            :readonly="encounterReadonly"
            :prescription-items="prescriptionDraft"
            :prescription-submitting="prescriptionSubmitting"
            :lab-draft="labDraft"
            :imaging-draft="imagingDraft"
            :diagnostic-submitting="diagnosticSubmitting"
            :medical-order-draft="medicalOrderDraft"
            :medical-order-submitting="medicalOrderSubmitting"
            @add-prescription="plan.addPrescriptionItem()"
            @remove-prescription="plan.removePrescriptionItem($event)"
            @update-prescription="(idx, field, val) => plan.updatePrescriptionItem(idx, field, val)"
            @submit-prescription="onSubmitPrescription"
            @update-lab="(field, val) => plan.updateLabDraft(field, val)"
            @submit-lab="onSubmitLab"
            @update-imaging="(field, val) => plan.updateImagingDraft(field, val)"
            @submit-imaging="onSubmitImaging"
            @update-medical-order="(field, val) => plan.updateMedicalOrderDraft(field, val)"
            @submit-medical-order="onSubmitMedicalOrder"
            @override-check="onOverrideMedicationCheck"
          />
          <EmptyState v-else compact title="选择就诊后显示处方/检验/影像/医嘱" />
        </div>
      </FaDrawer>
    </template>

    <!-- ===== 历史病历抽屉 ===== -->
    <RecentEncounterDrawer
      v-model:visible="historyDrawerVisible"
      :encounters="recentEncounters"
      :pet-name="activePet?.name"
      @copy-to-draft="onCopyHistoryToDraft"
    />

    <!-- ===== 409 冲突弹窗 ===== -->
    <EncounterConflictModal
      v-model:visible="conflictVisible"
      @view-latest="onConflictViewLatest"
      @keep-mine="onConflictKeepMine"
      @later="onConflictLater"
    />

    <!-- ===== 提交确认摘要 ===== -->
    <FaModal
      v-model="summaryVisible"
      title="提交诊疗方案"
      confirm-button-text="确认提交"
      cancel-button-text="取消"
      :confirm-button-loading="submittingPlan"
      :close-on-click-overlay="false"
      @confirm="onConfirmPlan"
    >
      <ClinicalPlanSummary
        v-if="workspaceData"
        :workspace="workspaceData"
        :plan-dirty="planDirty"
        :encounter-dirty="encounterDirty"
        :pending-drafts="pendingDraftsSummary"
      />
    </FaModal>

    <!-- ===== 底部动作栏 ===== -->
    <WorkflowFixedBar>
      <template #left>
        <span class="text-sm text-muted-foreground">{{ savedText }}</span>
        <span v-if="activeEncounter" class="text-sm text-muted-foreground">
          {{ activePet?.name ?? '未知宠物' }}
          <template v-if="billing?.pendingCount">
            · 待付款 <span class="font-medium">¥{{ billing.pendingAmount.toFixed(2) }}</span>
          </template>
          <span v-if="planDirty" class="text-amber-600">
            · 草稿 {{ validPrescriptionItems.length + (labDraft.catalogItemId ? 1 : 0) + (imagingDraft.catalogItemId ? 1 : 0) + (medicalOrderDraft.itemName ? 1 : 0) }}
          </span>
          <span v-if="medicationSafety?.hasBlocking" class="text-red-600">
            · 阻断 {{ medicationSafety.blockingChecks.length }}
          </span>
        </span>
      </template>
      <template #right>
        <template v-if="!isWide">
          <FaButton size="sm" variant="outline" @click="queueDrawerVisible = true">
            <FaIcon name="i-lucide:list" />
            候诊
          </FaButton>
          <FaButton size="sm" variant="outline" @click="planDrawerVisible = true">
            <FaIcon name="i-lucide:clipboard-list" />
            方案
            <span v-if="planDirty" class="text-[10px] text-white ml-1 rounded-full bg-amber-500 inline-flex size-4 items-center justify-center">!</span>
          </FaButton>
        </template>
        <FaButton
          size="sm"
          variant="outline"
          :disabled="!activeEncounter || encounterReadonly"
          :loading="saving"
          @click="onSaveDraft"
        >
          <FaIcon name="i-lucide:save" />
          保存草稿
        </FaButton>
        <FaButton
          size="sm"
          variant="outline"
          :disabled="!activeEncounter || encounterReadonly"
          :loading="signingEncounter"
          @click="onSignEncounter"
        >
          <FaIcon name="i-lucide:pen-line" />
          签署病历
        </FaButton>
        <FaButton
          size="sm"
          :disabled="!activeEncounter || encounterReadonly"
          :loading="submittingPlan"
          @click="onRequestCommitPlan"
        >
          <FaIcon name="i-lucide:check-check" />
          提交诊疗方案
        </FaButton>
      </template>
    </WorkflowFixedBar>
  </div>
</template>
