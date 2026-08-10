<script setup lang="ts">
import type { EncounterRecord, EncounterRevisionRecord, PrescriptionItemInput, PrescriptionRecord } from '@/types/clinical'
import type { MedicalRecordAmendmentRecord } from '@/types/compliance'
import type { PetRecord } from '@/types/customer'
import type { StatusVariant } from '@/utils/status'
import apiClinical from '@/api/modules/clinical'
import apiCompliance from '@/api/modules/compliance'
import apiDiagnostics from '@/api/modules/diagnostics'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'
import JourneyTimeline from '@/components/business/JourneyTimeline/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { ENCOUNTER_STATUS_LABELS, PRESCRIPTION_STATUS_LABELS } from '@/types/clinical'
import { AMENDMENT_STATUS_LABELS, ARCHIVE_STATUS_LABELS } from '@/types/compliance'

defineOptions({
  name: 'ClinicalEncounterDetail',
})

const route = useRoute()
const encounterId = computed(() => route.params.id as string)

const { auth } = useAppAuth()
const tenantStore = useAppTenantStore()

const loading = ref(false)
const encounter = ref<EncounterRecord | null>(null)
const pet = ref<PetRecord | null>(null)
const revisions = ref<EncounterRevisionRecord[]>([])
const prescriptions = ref<PrescriptionRecord[]>([])
const prescriptionItemsByRx = ref<Record<string, any[]>>({})
const amendments = ref<MedicalRecordAmendmentRecord[]>([])

/** 病历编辑表单 */
const form = reactive({
  chiefComplaint: '',
  historyPresent: '',
  examFindings: '',
  diagnosisText: '',
  treatmentPlan: '',
  followUpDate: '',
})

/**
 * S3.1-Fix B3(审计 23 节):病历详情为表单式编辑,接入页面级未保存离开保护
 * - 编辑态(form 与加载快照不一致)置 dirty,路由离开/刷新/关闭前弹确认
 * - 保存成功后同步快照并清除 dirty
 */
const encounterGuard = usePageUnsavedGuard('clinical-encounter-detail')
const formBaseline = reactive({
  chiefComplaint: '',
  historyPresent: '',
  examFindings: '',
  diagnosisText: '',
  treatmentPlan: '',
  followUpDate: '',
})
const encounterDirty = computed(() =>
  form.chiefComplaint !== formBaseline.chiefComplaint
  || form.historyPresent !== formBaseline.historyPresent
  || form.examFindings !== formBaseline.examFindings
  || form.diagnosisText !== formBaseline.diagnosisText
  || form.treatmentPlan !== formBaseline.treatmentPlan
  || form.followUpDate !== formBaseline.followUpDate,
)
watch(encounterDirty, d => encounterGuard.setDirty(d), { immediate: true })

/** 将当前表单值同步为未保存快照(加载/保存成功后调用) */
function syncFormBaseline() {
  formBaseline.chiefComplaint = form.chiefComplaint
  formBaseline.historyPresent = form.historyPresent
  formBaseline.examFindings = form.examFindings
  formBaseline.diagnosisText = form.diagnosisText
  formBaseline.treatmentPlan = form.treatmentPlan
  formBaseline.followUpDate = form.followUpDate
  encounterGuard.setDirty(false)
}

/** 签署弹窗(S30-R04:签署人强制为当前登录用户,无手选) */
const signVisible = ref(false)
const signDoctorName = ref('')

/** 修订弹窗 */
const reviseVisible = ref(false)
const reviseForm = reactive({
  reason: '',
  content: '',
})

/** 处方编辑 */
const prescriptionItems = ref<PrescriptionItemInput[]>([{ drugName: '', dosage: '', frequency: '', quantity: 1, unit: '' }])
const savingPrescription = ref(false)
const diagnosticVisible = ref(false)
const diagnosticSubmitting = ref(false)
const diagnosticForm = reactive({ type: 'lab' as 'lab' | 'imaging', catalogItemId: '', question: '' })

/** 医生开检查后，由数据库事务同步收费项和专业岗位任务。 */
async function onCreateDiagnosticOrder() {
  if (!encounter.value || !diagnosticForm.catalogItemId || !tenantStore.currentTenantId) {
    useFaToast().warning('请选择检查价目')
    return
  }
  diagnosticSubmitting.value = true
  try {
    const common = {
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId || undefined,
      encounterId: encounter.value.id,
      customerId: encounter.value.customer_id,
      petId: encounter.value.pet_id,
      catalogItemId: diagnosticForm.catalogItemId,
    }
    if (diagnosticForm.type === 'lab') {
      await apiDiagnostics.createLabOrder({ ...common, remark: diagnosticForm.question || undefined })
    }
    else {
      await apiDiagnostics.createImagingOrder({ ...common, imagingType: 'other', clinicalQuestion: diagnosticForm.question || undefined })
    }
    diagnosticVisible.value = false
    diagnosticForm.catalogItemId = ''
    diagnosticForm.question = ''
    useFaToast().success('检查申请已创建，并同步到收银台与执行岗位')
  }
  catch (error: any) {
    useFaToast().error(error?.message || '创建检查申请失败')
  }
  finally {
    diagnosticSubmitting.value = false
  }
}

/** 修订申请弹窗(归档后) */
const amendmentRequestVisible = ref(false)
const amendmentRequestForm = reactive({
  reason: '',
})

/** 拒绝修订弹窗 */
const rejectVisible = ref(false)
const rejectTarget = ref<MedicalRecordAmendmentRecord | null>(null)
const rejectReason = ref('')

/** 执行修订弹窗 */
const applyVisible = ref(false)
const applyTarget = ref<MedicalRecordAmendmentRecord | null>(null)
const applyForm = reactive({
  chiefComplaint: '',
  historyPresent: '',
  examFindings: '',
  diagnosisText: '',
  treatmentPlan: '',
})

/** 开具处方弹窗 */
const issueVisible = ref(false)
const issueTarget = ref<PrescriptionRecord | null>(null)
const issueForm = reactive({
  validUntil: '',
})

/** 延长有效期弹窗 */
const extendVisible = ref(false)
const extendTarget = ref<PrescriptionRecord | null>(null)
const extendForm = reactive({
  newValidUntil: '',
})

const isSigned = computed(() => encounter.value?.status === 'signed')
const isEditable = computed(() => encounter.value && !isSigned.value)
/** 是否已归档(归档后仅可走修订流程变更) */
const isArchived = computed(() => encounter.value?.archive_status === 'archived')
/** 归档超时:未归档且已超过归档截止时间 */
const isArchiveOverdue = computed(() => {
  const enc = encounter.value
  if (!enc || enc.archive_status === 'archived' || !enc.archive_due_at) {
    return false
  }
  return new Date(enc.archive_due_at).getTime() < Date.now()
})
/** 归档状态标签(超时展示"已超时") */
const archiveStatusLabel = computed(() => {
  const enc = encounter.value
  if (!enc?.archive_status) {
    return ''
  }
  return isArchiveOverdue.value ? '归档超时' : ARCHIVE_STATUS_LABELS[enc.archive_status]
})
/** 归档时间文案 */
const archivedAtText = computed(() => {
  const enc = encounter.value
  if (enc?.archive_status === 'archived' && enc.archived_at) {
    return `归档于 ${new Date(enc.archived_at).toLocaleString('zh-CN')}`
  }
  return ''
})
/** 处方是否已定稿(issued/dispensed),定稿后明细编辑只读 */
const prescriptionLocked = computed(() => prescriptions.value.some(rx => rx.status === 'issued' || rx.status === 'dispensed'))

const auditItems = computed(() =>
  revisions.value.map(rev => ({
    actor: rev.revised_by ? (rev.revised_by.slice(0, 8)) : '未知',
    at: new Date(rev.revised_at).toLocaleString('zh-CN'),
    action: `修订版本 #${rev.revision_no}`,
    after: rev.reason || undefined,
  })),
)

const summaryTags = computed<{ label: string, variant?: StatusVariant }[]>(() => {
  const tags: { label: string, variant?: StatusVariant }[] = [
    { label: ENCOUNTER_STATUS_LABELS[encounter.value?.status ?? 'in_progress'], variant: isSigned.value ? 'success' : 'info' },
  ]
  if (encounter.value?.archive_status) {
    tags.push({ label: archiveStatusLabel.value, variant: isArchiveOverdue.value ? 'danger' : 'neutral' })
  }
  return tags
})

/**
 * 加载病历详情(含修订历史 + 处方 + 归档后修订申请)
 */
async function loadData() {
  loading.value = true
  try {
    const res: any = await apiClinical.getEncounter(encounterId.value)
    encounter.value = res.data.encounter
    revisions.value = res.data.revisions
    if (!encounter.value) {
      return
    }
    form.chiefComplaint = encounter.value.chief_complaint ?? ''
    form.historyPresent = encounter.value.history_present ?? ''
    form.examFindings = encounter.value.exam_findings ?? ''
    form.diagnosisText = encounter.value.diagnosis_text ?? ''
    form.treatmentPlan = encounter.value.treatment_plan ?? ''
    form.followUpDate = encounter.value.follow_up_date ?? ''
    // S3.1-Fix B3:加载完成后同步未保存快照,避免初次进入即误判 dirty
    syncFormBaseline()

    const petRes = await supabase.from('pets').select('*').eq('id', encounter.value.pet_id).maybeSingle()
    pet.value = (petRes.data ?? null) as PetRecord | null

    const rxRes: any = await apiClinical.listPrescriptions({ encounterId: encounterId.value })
    prescriptions.value = rxRes.data.list
    await loadPrescriptionItems(prescriptions.value.map(rx => rx.id))

    // 归档后加载修订申请列表(直连,RLS 兜底)
    if (encounter.value.archive_status === 'archived') {
      const amendRes: any = await apiCompliance.listAmendments('encounter', encounterId.value)
      amendments.value = amendRes.data.list
    }
    else {
      amendments.value = []
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载病历失败')
  }
  finally {
    loading.value = false
  }
}

/** 批量加载处方明细(单次 in 查询,按 prescription_id 分组) */
async function loadPrescriptionItems(ids: string[]) {
  if (!ids.length) {
    prescriptionItemsByRx.value = {}
    return
  }
  const { data, error } = await supabase.from('prescription_items').select('*').in('prescription_id', ids).order('sort_order')
  if (error) {
    return
  }
  const grouped: Record<string, any[]> = {}
  data?.forEach((it) => {
    ;(grouped[it.prescription_id] ??= []).push(it)
  })
  prescriptionItemsByRx.value = grouped
}

/**
 * 保存病历修改(仅 in_progress/completed 可改)
 */
async function onSave() {
  if (!encounter.value) {
    return
  }
  if (encounter.value.status === 'signed') {
    useFaToast().warning('已签署病历不可直接修改')
    return
  }
  try {
    const res: any = await apiClinical.updateEncounter(encounter.value.id, {
      chiefComplaint: form.chiefComplaint,
      historyPresent: form.historyPresent,
      examFindings: form.examFindings,
      diagnosisText: form.diagnosisText,
      treatmentPlan: form.treatmentPlan,
      followUpDate: form.followUpDate || undefined,
      expectedVersion: encounter.value.version,
    })
    encounter.value = res.data
    // S3.1-Fix B3:保存成功后同步快照并清除 dirty
    syncFormBaseline()
    useFaToast().success('病历已保存')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '保存失败')
  }
}

/**
 * 签署病历(S30-R04:走 Hono Command,签署人强制为当前登录用户)
 * 打开弹窗时展示当前登录账号;签署时后端以 user.id 作为 doctor_id,
 * 拒绝代签(doctorId !== user.id → 403)。
 */
async function onSign() {
  if (!encounter.value) {
    return
  }
  try {
    const res: any = await apiClinical.signEncounter(encounter.value.id)
    encounter.value = res.data
    signVisible.value = false
    useFaToast().success('病历已签署')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '签署失败')
  }
}

/** 打开签署弹窗:获取当前登录账号用于展示(签署本身不依赖前端传 id) */
async function openSign() {
  const { data: userData } = await supabase.auth.getUser()
  signDoctorName.value = userData.user?.email ?? ''
  signVisible.value = true
}

/**
 * 修订病历(RPC,创建修订版本)
 */
async function onRevise() {
  if (!encounter.value) {
    return
  }
  if (!reviseForm.reason) {
    useFaToast().warning('请填写修订原因')
    return
  }
  try {
    const content = {
      chiefComplaint: form.chiefComplaint,
      historyPresent: form.historyPresent,
      examFindings: form.examFindings,
      diagnosisText: form.diagnosisText,
      treatmentPlan: form.treatmentPlan,
    }
    await apiClinical.reviseEncounter(encounter.value.id, content, reviseForm.reason)
    reviseVisible.value = false
    reviseForm.reason = ''
    reviseForm.content = ''
    useFaToast().success('修订版本已创建')
    loadData()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '修订失败')
  }
}

/**
 * 病历归档(S3.1-1,走 Hono Command,权限 medical_record.archive)
 */
async function onArchive() {
  if (!encounter.value) {
    return
  }
  try {
    await apiCompliance.archiveRecord({
      recordType: 'encounter',
      recordId: encounter.value.id,
    })
    useFaToast().success('病历已归档')
    loadData()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '归档失败')
  }
}

/** 归档确认弹窗 */
function onArchiveConfirm() {
  useFaModal().confirm({
    title: '归档确认',
    content: '确认归档该病历?归档后病历进入合规留存期,仅可通过修订流程变更内容。',
    onConfirm: onArchive,
  })
}

/**
 * 提交修订申请(归档后,权限 medical_record.amend.request)
 */
async function onSubmitAmendmentRequest() {
  if (!encounter.value) {
    return
  }
  if (!amendmentRequestForm.reason.trim()) {
    useFaToast().warning('请填写修订原因')
    return
  }
  try {
    await apiCompliance.requestAmendment({
      recordType: 'encounter',
      recordId: encounter.value.id,
      reason: amendmentRequestForm.reason.trim(),
    })
    amendmentRequestVisible.value = false
    amendmentRequestForm.reason = ''
    useFaToast().success('修订申请已提交')
    loadData()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '提交失败')
  }
}

/**
 * 批准修订申请(权限 medical_record.amend.approve)
 */
function onApproveAmendment(row: MedicalRecordAmendmentRecord) {
  useFaModal().confirm({
    title: '批准修订',
    content: '确认批准该修订申请?批准后申请人可执行修订。',
    onConfirm: async () => {
      try {
        await apiCompliance.reviewAmendment(row.id, {
          decision: 'approved',
        })
        useFaToast().success('已批准')
        loadData()
      }
      catch (e: any) {
        useFaToast().error(e?.message || '操作失败')
      }
    },
  })
}

/** 打开拒绝弹窗 */
function openRejectAmendment(row: MedicalRecordAmendmentRecord) {
  rejectTarget.value = row
  rejectReason.value = ''
  rejectVisible.value = true
}

/**
 * 提交拒绝修订(权限 medical_record.amend.approve)
 */
async function onSubmitReject() {
  if (!rejectTarget.value) {
    return
  }
  if (!rejectReason.value.trim()) {
    useFaToast().warning('请填写拒绝原因')
    return
  }
  try {
    await apiCompliance.reviewAmendment(rejectTarget.value.id, {
      decision: 'rejected',
      reason: rejectReason.value.trim(),
    })
    rejectVisible.value = false
    useFaToast().success('已拒绝')
    loadData()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
}

/** 打开执行修订弹窗,预填当前病历字段 */
function openApplyAmendment(row: MedicalRecordAmendmentRecord) {
  applyTarget.value = row
  applyForm.chiefComplaint = encounter.value?.chief_complaint ?? ''
  applyForm.historyPresent = encounter.value?.history_present ?? ''
  applyForm.examFindings = encounter.value?.exam_findings ?? ''
  applyForm.diagnosisText = encounter.value?.diagnosis_text ?? ''
  applyForm.treatmentPlan = encounter.value?.treatment_plan ?? ''
  applyVisible.value = true
}

/**
 * 执行修订(应用 approved 申请,权限 medical_record.amend.request)
 * payload 使用 encounter 表 snake_case 字段
 */
async function onSubmitApply() {
  if (!applyTarget.value) {
    return
  }
  try {
    await apiCompliance.applyAmendment(applyTarget.value.id, {
      payload: {
        chief_complaint: applyForm.chiefComplaint,
        history_present: applyForm.historyPresent,
        exam_findings: applyForm.examFindings,
        diagnosis_text: applyForm.diagnosisText,
        treatment_plan: applyForm.treatmentPlan,
      },
    })
    applyVisible.value = false
    useFaToast().success('修订已应用')
    loadData()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '执行修订失败')
  }
}

/**
 * 添加处方明细行
 */
function addPrescriptionItem() {
  prescriptionItems.value.push({ drugName: '', dosage: '', frequency: '', quantity: 1, unit: '' })
}

/**
 * 删除处方明细行
 */
function removePrescriptionItem(idx: number) {
  prescriptionItems.value.splice(idx, 1)
}

/**
 * 保存处方(RPC,事务化创建/更新处方 + 明细)
 */
async function onSavePrescription() {
  if (!encounter.value) {
    return
  }
  if (prescriptionLocked.value) {
    useFaToast().warning('处方已开具,明细不可修改')
    return
  }
  const validItems = prescriptionItems.value.filter(i => i.drugName && i.catalogItemId)
  if (validItems.length === 0) {
    useFaToast().warning('请至少选择一项目录药品并填写药品名称，以便同步准确价格到收银台')
    return
  }
  savingPrescription.value = true
  try {
    await apiClinical.savePrescription({
      encounterId: encounter.value.id,
      items: validItems,
    })
    useFaToast().success('处方已保存')
    loadData()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '保存处方失败')
  }
  finally {
    savingPrescription.value = false
  }
}

/** 打开开具处方弹窗 */
function openIssue(rx: PrescriptionRecord) {
  issueTarget.value = rx
  issueForm.validUntil = ''
  issueVisible.value = true
}

/**
 * 开具处方(走 Hono Command,权限 prescription.issue;开方人由服务端推导 R03)
 */
async function onSubmitIssue() {
  if (!issueTarget.value) {
    return
  }
  try {
    await apiCompliance.issuePrescription(issueTarget.value.id, {
      validUntil: issueForm.validUntil || undefined,
    })
    issueVisible.value = false
    useFaToast().success('处方已开具')
    loadData()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '开具失败')
  }
}

/** 打开延长有效期弹窗 */
function openExtend(rx: PrescriptionRecord) {
  extendTarget.value = rx
  extendForm.newValidUntil = rx.valid_until ?? ''
  extendVisible.value = true
}

/**
 * 延长处方有效期(走 Hono Command,权限 prescription.extend_validity)
 */
async function onSubmitExtend() {
  if (!extendTarget.value) {
    return
  }
  if (!extendForm.newValidUntil) {
    useFaToast().warning('请选择新的有效期')
    return
  }
  try {
    await apiCompliance.extendPrescriptionValidity(extendTarget.value.id, {
      newValidUntil: extendForm.newValidUntil,
    })
    extendVisible.value = false
    useFaToast().success('有效期已延长')
    loadData()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '延长失败')
  }
}

onMounted(loadData)
</script>

<template>
  <div v-loading="loading" class="flex flex-col h-full">
    <EntitySummaryHeader
      avatar="i-lucide:clipboard-plus"
      :subtitle="pet ? `${pet.name} · ${pet.species ?? ''} ${pet.breed ?? ''}` : '未知宠物'"
      :tags="summaryTags"
    >
      <template #title>
        <span>病历详情</span>
      </template>
      <template #actions>
        <FaButton v-if="isEditable" size="sm" @click="openSign">
          <FaIcon name="i-lucide:pen-line" />
          签署
        </FaButton>
        <FaButton v-if="encounter?.archive_status === 'signed' && auth('medical_record.archive')" size="sm" variant="outline" @click="onArchiveConfirm">
          <FaIcon name="i-lucide:archive" />
          归档
        </FaButton>
      </template>
    </EntitySummaryHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <PetSafetyBanner
        v-if="pet"
        :risk-tags="pet.risk_tags"
        :temperament="pet.temperament"
        :medical-notes="pet.medical_notes"
      />

      <div class="flex-1 gap-4 grid min-h-0 lg:grid-cols-3">
        <!-- 主区:病历编辑 + 处方 -->
        <div class="border rounded-lg bg-card flex flex-col min-w-0 overflow-auto lg:col-span-2">
          <div class="px-4 py-2.5 border-b flex items-center justify-between">
            <span class="text-sm font-medium">病历内容</span>
            <span v-if="encounter?.signed_at" class="text-xs text-muted-foreground">
              签署于 {{ new Date(encounter.signed_at).toLocaleString('zh-CN') }}
            </span>
          </div>
          <div class="p-4 space-y-3">
            <FaLabel label="主诉">
              <FaInput v-model="form.chiefComplaint" :disabled="isSigned" class="w-full" />
            </FaLabel>
            <FaLabel label="现病史">
              <FaInput v-model="form.historyPresent" :disabled="isSigned" type="textarea" :rows="3" class="w-full" />
            </FaLabel>
            <FaLabel label="检查发现">
              <FaInput v-model="form.examFindings" :disabled="isSigned" type="textarea" :rows="3" class="w-full" />
            </FaLabel>
            <FaLabel label="诊断">
              <FaInput v-model="form.diagnosisText" :disabled="isSigned" class="w-full" />
            </FaLabel>
            <FaLabel label="治疗方案">
              <FaInput v-model="form.treatmentPlan" :disabled="isSigned" type="textarea" :rows="3" class="w-full" />
            </FaLabel>
            <FaLabel label="复诊日期">
              <FaInput v-model="form.followUpDate" :disabled="isSigned" type="date" class="w-full" />
            </FaLabel>
          </div>

          <!-- 处方区域 -->
          <div class="px-4 py-3 border-t">
            <div class="mb-2 flex items-center justify-between">
              <span class="text-sm font-medium">处方({{ prescriptions.length }})</span>
              <div class="flex gap-2">
                <FaButton v-if="!isSigned" variant="outline" size="sm" @click="diagnosticVisible = true">
                  <FaIcon name="i-lucide:scan-line" />开检查
                </FaButton>
                <FaButton v-if="!isSigned" variant="outline" size="sm" :disabled="prescriptionLocked" :loading="savingPrescription" @click="onSavePrescription">
                  <FaIcon name="i-lucide:save" />保存处方
                </FaButton>
              </div>
            </div>
            <div v-if="prescriptions.length > 0" class="mb-3 space-y-2">
              <div v-for="rx in prescriptions" :key="rx.id" class="p-2.5 border rounded-md">
                <div class="flex flex-wrap gap-2 items-center justify-between">
                  <div class="flex flex-wrap gap-2 items-center">
                    <EntityStatusTag :label="PRESCRIPTION_STATUS_LABELS[rx.status]" :variant="rx.status === 'dispensed' ? 'success' : rx.status === 'issued' ? 'info' : 'neutral'" :dot="false" />
                    <span v-if="rx.issued_at" class="text-xs text-muted-foreground">
                      开具于 {{ new Date(rx.issued_at).toLocaleString('zh-CN') }}
                    </span>
                    <span v-if="rx.valid_until" class="text-xs text-muted-foreground">
                      有效期至 {{ new Date(rx.valid_until).toLocaleString('zh-CN') }}
                    </span>
                  </div>
                  <div class="flex gap-1">
                    <FaButton v-if="rx.status === 'draft' && auth('prescription.issue')" variant="outline" size="sm" @click="openIssue(rx)">
                      开具
                    </FaButton>
                    <span v-if="rx.status === 'issued'" class="text-xs text-muted-foreground">已同步收银台，付款后由药房发药</span>
                    <FaButton v-if="rx.status === 'issued' && auth('prescription.extend_validity')" variant="outline" size="sm" @click="openExtend(rx)">
                      延长
                    </FaButton>
                  </div>
                </div>
                <div v-if="prescriptionItemsByRx[rx.id]?.length" class="mt-2 overflow-x-auto">
                  <FaTable
                    :data="prescriptionItemsByRx[rx.id]"
                    :columns="[
                      { accessorKey: 'drug_name', header: '药品', cell: (c: any) => c.getValue() },
                      { accessorKey: 'dosage', header: '剂量', cell: (c: any) => c.getValue() },
                      { accessorKey: 'frequency', header: '频次', cell: (c: any) => c.getValue() },
                      { accessorKey: 'quantity', header: '数量', cell: (c: any) => c.getValue() },
                      { accessorKey: 'unit', header: '单位', cell: (c: any) => c.getValue() },
                      { accessorKey: 'usage_instruction', header: '用法', cell: (c: any) => c.getValue() ?? '-' },
                    ]"
                  />
                </div>
              </div>
            </div>
            <div v-if="!isSigned" class="space-y-2">
              <div v-for="(item, idx) in prescriptionItems" :key="idx" class="flex flex-wrap gap-2 items-center">
                <BusinessCatalogItemPicker v-model="item.catalogItemId" billing-type="drug" :disabled="prescriptionLocked" class="w-52" />
                <FaInput v-model="item.drugName" :disabled="prescriptionLocked" placeholder="药品名称" class="w-40" />
                <FaInput v-model="item.dosage" :disabled="prescriptionLocked" placeholder="剂量" class="w-24" />
                <FaInput v-model="item.frequency" :disabled="prescriptionLocked" placeholder="频次" class="w-24" />
                <FaInput v-model.number="item.quantity" :disabled="prescriptionLocked" type="number" placeholder="数量" class="w-20" />
                <FaInput v-model="item.unit" :disabled="prescriptionLocked" placeholder="单位" class="w-20" />
                <FaButton v-if="!prescriptionLocked" variant="outline" size="icon-sm" @click="removePrescriptionItem(idx)">
                  <FaIcon name="i-lucide:trash-2" />
                </FaButton>
              </div>
              <FaButton v-if="!prescriptionLocked" variant="outline" size="sm" @click="addPrescriptionItem">
                <FaIcon name="i-lucide:plus" />
                添加药品
              </FaButton>
            </div>
          </div>
        </div>

        <!-- 右栏:修订历史 + 修订管理 -->
        <div class="flex flex-col gap-4 min-w-0 overflow-auto">
          <div class="border rounded-lg bg-card">
            <div class="text-sm font-medium px-4 py-2.5 border-b">
              患者旅程与操作留痕
            </div>
            <div class="p-4">
              <JourneyTimeline :encounter-id="encounterId" />
            </div>
          </div>
          <div class="border rounded-lg bg-card">
            <div class="text-sm font-medium px-4 py-2.5 border-b">
              修订历史({{ revisions.length }})
            </div>
            <div class="p-4">
              <AuditTimeline :items="auditItems" />
            </div>
          </div>

          <div v-if="isArchived" class="border rounded-lg bg-card">
            <div class="px-4 py-2.5 border-b flex items-center justify-between">
              <span class="text-sm font-medium">修订管理({{ amendments.length }})</span>
              <FaButton v-if="auth('medical_record.amend.request')" variant="outline" size="sm" @click="amendmentRequestVisible = true">
                修订申请
              </FaButton>
            </div>
            <div class="p-3 space-y-2">
              <div v-for="row in amendments" :key="row.id" class="text-xs p-2.5 border rounded-md">
                <div class="flex gap-2 items-center justify-between">
                  <EntityStatusTag :label="AMENDMENT_STATUS_LABELS[row.status]" :variant="row.status === 'approved' ? 'success' : row.status === 'rejected' ? 'danger' : 'info'" :dot="false" />
                  <div class="flex gap-1">
                    <FaButton v-if="row.status === 'pending' && auth('medical_record.amend.approve')" variant="outline" size="sm" @click="onApproveAmendment(row)">
                      批准
                    </FaButton>
                    <FaButton v-if="row.status === 'pending' && auth('medical_record.amend.approve')" variant="outline" size="sm" @click="openRejectAmendment(row)">
                      拒绝
                    </FaButton>
                    <FaButton v-if="row.status === 'approved' && auth('medical_record.amend.request')" variant="outline" size="sm" @click="openApplyAmendment(row)">
                      执行
                    </FaButton>
                  </div>
                </div>
                <div class="text-muted-foreground mt-1.5">
                  <div>原因:{{ row.reason }}</div>
                  <div class="text-muted-foreground/80">
                    {{ new Date(row.requested_at).toLocaleString('zh-CN') }}
                  </div>
                  <div v-if="row.status === 'rejected' && row.rejected_reason" class="text-red-600">
                    拒绝原因:{{ row.rejected_reason }}
                  </div>
                  <div v-if="row.status === 'applied' && row.applied_at" class="text-muted-foreground">
                    已应用:{{ new Date(row.applied_at).toLocaleString('zh-CN') }}
                  </div>
                </div>
              </div>
              <EmptyState v-if="!amendments.length" compact title="暂无修订申请" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <WorkflowFixedBar>
      <template #left>
        <span v-if="encounter" class="text-sm text-muted-foreground">
          宠物: <span class="font-medium">{{ pet?.name ?? '未知' }}</span>
          <template v-if="archivedAtText"> · {{ archivedAtText }}</template>
        </span>
      </template>
      <template #right>
        <FaButton size="sm" variant="outline" :disabled="!isEditable" @click="onSave">
          <FaIcon name="i-lucide:save" />
          保存
        </FaButton>
        <FaButton v-if="isSigned" size="sm" variant="outline" @click="reviseVisible = true">
          <FaIcon name="i-lucide:rotate-ccw" />
          修订
        </FaButton>
      </template>
    </WorkflowFixedBar>

    <!-- 签署弹窗(S30-R04:签署人固定为当前登录用户,无手选) -->
    <FaModal v-model:visible="signVisible" title="签署病历" @confirm="onSign">
      <div class="space-y-3">
        <p class="text-sm text-gray-600">
          签署后病历将变为终态,不可直接修改,如需修改请使用修订功能。
        </p>
        <FaLabel label="签署人">
          <FaInput :model-value="signDoctorName" placeholder="当前登录账号" readonly class="w-full" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 修订弹窗 -->
    <FaModal v-model:visible="reviseVisible" title="修订病历" @confirm="onRevise">
      <div class="space-y-3">
        <p class="text-sm text-gray-600">
          修订将创建新版本,原文保留。请先修改上方表单内容,再填写修订原因。
        </p>
        <FaLabel label="修订原因">
          <FaInput v-model="reviseForm.reason" placeholder="修订原因" class="w-full" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 修订申请弹窗(归档后) -->
    <FaModal v-model:visible="amendmentRequestVisible" title="修订申请" @confirm="onSubmitAmendmentRequest">
      <div class="space-y-3">
        <p class="text-sm text-gray-600">
          提交后将进入审批流程,审批通过后方可执行修订。
        </p>
        <FaLabel label="修订原因">
          <FaInput v-model="amendmentRequestForm.reason" placeholder="请填写修订原因" class="w-full" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 拒绝修订弹窗 -->
    <FaModal v-model:visible="rejectVisible" title="拒绝修订" @confirm="onSubmitReject">
      <div class="space-y-3">
        <FaLabel label="拒绝原因">
          <FaInput v-model="rejectReason" placeholder="请填写拒绝原因" class="w-full" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 执行修订弹窗 -->
    <FaModal v-model:visible="applyVisible" title="执行修订" @confirm="onSubmitApply">
      <div class="space-y-3">
        <p class="text-sm text-gray-600">
          修订将覆盖当前病历内容,请确认字段内容。
        </p>
        <FaLabel label="主诉">
          <FaInput v-model="applyForm.chiefComplaint" class="w-full" />
        </FaLabel>
        <FaLabel label="现病史">
          <FaInput v-model="applyForm.historyPresent" type="textarea" :rows="2" class="w-full" />
        </FaLabel>
        <FaLabel label="检查发现">
          <FaInput v-model="applyForm.examFindings" type="textarea" :rows="2" class="w-full" />
        </FaLabel>
        <FaLabel label="诊断">
          <FaInput v-model="applyForm.diagnosisText" class="w-full" />
        </FaLabel>
        <FaLabel label="治疗方案">
          <FaInput v-model="applyForm.treatmentPlan" type="textarea" :rows="2" class="w-full" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 开具处方弹窗 -->
    <FaModal v-model:visible="diagnosticVisible" title="开具检查申请" :loading="diagnosticSubmitting" @confirm="onCreateDiagnosticOrder">
      <div class="space-y-3">
        <FaLabel label="检查类型">
          <FaSelect v-model="diagnosticForm.type" :options="[{ label: '检验', value: 'lab' }, { label: '影像', value: 'imaging' }]" />
        </FaLabel>
        <FaLabel label="检查价目（必选）">
          <BusinessCatalogItemPicker v-model="diagnosticForm.catalogItemId" billing-type="exam" />
        </FaLabel>
        <FaLabel label="临床问题 / 备注">
          <FaTextarea v-model="diagnosticForm.question" placeholder="请说明检查目的、重点关注和必要病史" />
        </FaLabel>
        <div class="text-sm text-blue-800 p-3 rounded-md bg-blue-50">
          提交后将同时生成客户待付款条目和检验/影像岗位任务，默认付款后执行。
        </div>
      </div>
    </FaModal>

    <!-- 开具处方弹窗 -->
    <FaModal v-model:visible="issueVisible" title="开具处方" @confirm="onSubmitIssue">
      <div class="space-y-3">
        <p class="text-sm text-gray-600">
          开具后处方进入已开具状态,明细将锁定不可编辑。开方人默认为当前登录账号。
        </p>
        <FaLabel label="有效期至">
          <FaInput v-model="issueForm.validUntil" type="datetime-local" class="w-full" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 延长有效期弹窗 -->
    <FaModal v-model:visible="extendVisible" title="延长处方有效期" @confirm="onSubmitExtend">
      <div class="space-y-3">
        <FaLabel label="新的有效期">
          <FaInput v-model="extendForm.newValidUntil" type="datetime-local" class="w-full" />
        </FaLabel>
      </div>
    </FaModal>
  </div>
</template>
