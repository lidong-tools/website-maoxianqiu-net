<script setup lang="ts">
import type { EncounterRecord, EncounterRevisionRecord, PrescriptionItemInput, PrescriptionRecord } from '@/types/clinical'
import type { MedicalRecordAmendmentRecord } from '@/types/compliance'
import apiClinical from '@/api/modules/clinical'
import apiCompliance, { getCurrentEmployeeId } from '@/api/modules/compliance'
import { supabase } from '@/lib/supabase'
import { ENCOUNTER_STATUS_COLORS, ENCOUNTER_STATUS_LABELS, PRESCRIPTION_STATUS_LABELS } from '@/types/clinical'
import { AMENDMENT_STATUS_LABELS, ARCHIVE_STATUS_LABELS } from '@/types/compliance'

defineOptions({
  name: 'ClinicalEncounterDetail',
})

const route = useRoute()
const encounterId = computed(() => route.params.id as string)

const { auth } = useAppAuth()

const loading = ref(false)
const encounter = ref<EncounterRecord | null>(null)
const revisions = ref<EncounterRevisionRecord[]>([])
const prescriptions = ref<PrescriptionRecord[]>([])
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
  prescriberEmployeeId: '',
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
  return isArchiveOverdue.value ? '已超时' : ARCHIVE_STATUS_LABELS[enc.archive_status]
})
/** 归档状态标签样式(超时红色) */
const archiveStatusClass = computed(() => {
  if (!encounter.value?.archive_status) {
    return ''
  }
  return isArchiveOverdue.value ? 'bg-red-100 text-red-600' : 'bg-gray-100'
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

    const rxRes: any = await apiClinical.listPrescriptions({ encounterId: encounterId.value })
    prescriptions.value = rxRes.data.list

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
    })
    encounter.value = res.data
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
    const operatorEmployeeId = await getCurrentEmployeeId()
    await apiCompliance.archiveRecord({
      recordType: 'encounter',
      recordId: encounter.value.id,
      operatorEmployeeId,
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
    const requestedByEmployeeId = await getCurrentEmployeeId()
    await apiCompliance.requestAmendment({
      recordType: 'encounter',
      recordId: encounter.value.id,
      reason: amendmentRequestForm.reason.trim(),
      requestedByEmployeeId,
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
        const reviewerEmployeeId = await getCurrentEmployeeId()
        await apiCompliance.reviewAmendment(row.id, {
          decision: 'approved',
          reviewerEmployeeId,
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
    const reviewerEmployeeId = await getCurrentEmployeeId()
    await apiCompliance.reviewAmendment(rejectTarget.value.id, {
      decision: 'rejected',
      reason: rejectReason.value.trim(),
      reviewerEmployeeId,
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
    const appliedByEmployeeId = await getCurrentEmployeeId()
    await apiCompliance.applyAmendment(applyTarget.value.id, {
      payload: {
        chief_complaint: applyForm.chiefComplaint,
        history_present: applyForm.historyPresent,
        exam_findings: applyForm.examFindings,
        diagnosis_text: applyForm.diagnosisText,
        treatment_plan: applyForm.treatmentPlan,
      },
      appliedByEmployeeId,
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
  const validItems = prescriptionItems.value.filter(i => i.drugName)
  if (validItems.length === 0) {
    useFaToast().warning('请至少添加一条药品明细')
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

/**
 * 发药(RPC)
 */
async function onDispense(rx: PrescriptionRecord) {
  useFaModal().confirm({
    title: '发药确认',
    content: `确认发放处方药品?`,
    onConfirm: async () => {
      try {
        await apiClinical.dispensePrescription(rx.id)
        useFaToast().success('发药成功')
        loadData()
      }
      catch (e: any) {
        useFaToast().error(e?.message || '发药失败')
      }
    },
  })
}

/** 打开开具处方弹窗 */
function openIssue(rx: PrescriptionRecord) {
  issueTarget.value = rx
  issueForm.prescriberEmployeeId = ''
  issueForm.validUntil = ''
  issueVisible.value = true
}

/**
 * 开具处方(走 Hono Command,权限 prescription.issue)
 */
async function onSubmitIssue() {
  if (!issueTarget.value) {
    return
  }
  if (!issueForm.prescriberEmployeeId) {
    useFaToast().warning('请选择开方人')
    return
  }
  try {
    await apiCompliance.issuePrescription(issueTarget.value.id, {
      prescriberEmployeeId: issueForm.prescriberEmployeeId,
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
    const operatorEmployeeId = await getCurrentEmployeeId()
    await apiCompliance.extendPrescriptionValidity(extendTarget.value.id, {
      newValidUntil: extendForm.newValidUntil,
      operatorEmployeeId,
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
  <div v-loading="loading">
    <FaPageHeader title="病历详情" class="mb-0">
      <template #description>
        病历编辑 / 签署 / 归档 / 修订 / 处方管理
      </template>
    </FaPageHeader>
    <FaPageMain>
      <div v-if="encounter" class="space-y-4">
        <!-- 状态与操作栏 -->
        <div class="p-3 rounded bg-gray-50 flex items-center justify-between">
          <div class="flex gap-3 items-center">
            <span class="text-sm">状态:</span>
            <span class="text-xs px-2 py-0.5 rounded" :class="`bg-${ENCOUNTER_STATUS_COLORS[encounter.status]}-100`">
              {{ ENCOUNTER_STATUS_LABELS[encounter.status] }}
            </span>
            <span v-if="encounter.archive_status" class="text-xs px-2 py-0.5 rounded" :class="archiveStatusClass">
              {{ archiveStatusLabel }}
            </span>
            <span v-if="archivedAtText" class="text-xs text-gray-500">
              {{ archivedAtText }}
            </span>
            <span class="text-xs text-gray-500">宠物 {{ encounter.pet_id.slice(0, 8) }}</span>
            <span v-if="encounter.signed_at" class="text-xs text-gray-500">
              签署于 {{ new Date(encounter.signed_at).toLocaleString('zh-CN') }}
            </span>
          </div>
          <div class="flex gap-2">
            <FaButton variant="outline" size="sm" :disabled="!isEditable" @click="onSave">
              <FaIcon name="i-ri:save-line" />
              保存
            </FaButton>
            <FaButton v-if="isEditable" type="primary" size="sm" @click="openSign">
              <FaIcon name="i-ri:pen-nib-line" />
              签署
            </FaButton>
            <FaButton v-if="isSigned" variant="outline" size="sm" @click="reviseVisible = true">
              <FaIcon name="i-ri:edit-2-line" />
              修订
            </FaButton>
            <FaButton
              v-if="encounter.archive_status === 'signed' && auth('medical_record.archive')"
              variant="outline"
              size="sm"
              @click="onArchiveConfirm"
            >
              <FaIcon name="i-ri:archive-line" />
              归档
            </FaButton>
          </div>
        </div>

        <!-- 病历编辑表单 -->
        <div class="gap-3 grid grid-cols-1">
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
        <div class="pt-4 border-t">
          <div class="mb-2 flex items-center justify-between">
            <span class="text-sm font-medium">处方</span>
            <FaButton v-if="!isSigned" variant="outline" size="sm" :disabled="prescriptionLocked" :loading="savingPrescription" @click="onSavePrescription">
              <FaIcon name="i-ri:save-line" />
              保存处方
            </FaButton>
          </div>
          <!-- 已有处方列表 -->
          <div v-if="prescriptions.length > 0" class="mb-3 space-y-2">
            <div v-for="rx in prescriptions" :key="rx.id" class="p-2 border rounded flex items-center justify-between">
              <div class="flex gap-2 items-center">
                <span class="text-xs">处方 {{ rx.id.slice(0, 8) }} · {{ PRESCRIPTION_STATUS_LABELS[rx.status] }}</span>
                <span v-if="rx.issued_at" class="text-xs text-gray-500">
                  开具于 {{ new Date(rx.issued_at).toLocaleString('zh-CN') }}
                </span>
                <span v-if="rx.valid_until" class="text-xs text-gray-500">
                  有效期至 {{ new Date(rx.valid_until).toLocaleString('zh-CN') }}
                </span>
              </div>
              <div class="flex gap-1">
                <FaButton v-if="rx.status === 'draft' && auth('prescription.issue')" variant="outline" size="sm" @click="openIssue(rx)">
                  开具处方
                </FaButton>
                <FaButton v-if="rx.status === 'draft'" variant="outline" size="sm" @click="onDispense(rx)">
                  发药
                </FaButton>
                <FaButton v-if="rx.status === 'issued' && auth('prescription.extend_validity')" variant="outline" size="sm" @click="openExtend(rx)">
                  延长有效期
                </FaButton>
              </div>
            </div>
          </div>
          <!-- 处方明细编辑(未签署时可用;开具/发药后只读) -->
          <div v-if="!isSigned" class="space-y-2">
            <div v-for="(item, idx) in prescriptionItems" :key="idx" class="flex gap-2 items-center">
              <FaInput v-model="item.drugName" :disabled="prescriptionLocked" placeholder="药品名称" class="flex-1" />
              <FaInput v-model="item.dosage" :disabled="prescriptionLocked" placeholder="剂量" class="w-100px" />
              <FaInput v-model="item.frequency" :disabled="prescriptionLocked" placeholder="频次" class="w-100px" />
              <FaInput v-model.number="item.quantity" :disabled="prescriptionLocked" type="number" placeholder="数量" class="w-80px" />
              <FaInput v-model="item.unit" :disabled="prescriptionLocked" placeholder="单位" class="w-80px" />
              <FaButton v-if="!prescriptionLocked" variant="outline" size="icon-sm" @click="removePrescriptionItem(idx)">
                <FaIcon name="i-ri:delete-bin-line" />
              </FaButton>
            </div>
            <FaButton v-if="!prescriptionLocked" variant="outline" size="sm" @click="addPrescriptionItem">
              <FaIcon name="i-ri:add-line" />
              添加药品
            </FaButton>
          </div>
        </div>

        <!-- 修订管理(仅归档后,S3.1-1) -->
        <div v-if="isArchived" class="pt-4 border-t">
          <div class="mb-2 flex items-center justify-between">
            <span class="text-sm font-medium">修订管理({{ amendments.length }})</span>
            <FaButton v-if="auth('medical_record.amend.request')" variant="outline" size="sm" @click="amendmentRequestVisible = true">
              <FaIcon name="i-ri:edit-2-line" />
              修订申请
            </FaButton>
          </div>
          <div v-if="amendments.length === 0" class="text-xs text-gray-400">
            暂无修订申请
          </div>
          <div v-else class="space-y-2">
            <div v-for="row in amendments" :key="row.id" class="p-2 border rounded">
              <div class="flex gap-2 items-center justify-between">
                <div class="text-xs flex gap-2 items-center">
                  <span>{{ AMENDMENT_STATUS_LABELS[row.status] }}</span>
                  <span class="text-gray-500">{{ new Date(row.requested_at).toLocaleString('zh-CN') }}</span>
                </div>
                <div class="flex gap-1">
                  <FaButton v-if="row.status === 'pending' && auth('medical_record.amend.approve')" variant="outline" size="sm" @click="onApproveAmendment(row)">
                    批准
                  </FaButton>
                  <FaButton v-if="row.status === 'pending' && auth('medical_record.amend.approve')" variant="outline" size="sm" @click="openRejectAmendment(row)">
                    拒绝
                  </FaButton>
                  <FaButton v-if="row.status === 'approved' && auth('medical_record.amend.request')" variant="outline" size="sm" @click="openApplyAmendment(row)">
                    执行修订
                  </FaButton>
                </div>
              </div>
              <div class="text-xs text-gray-600 mt-1">
                原因:{{ row.reason }}
              </div>
              <div v-if="row.status === 'rejected' && row.rejected_reason" class="text-xs text-red-600 mt-1">
                拒绝原因:{{ row.rejected_reason }}
              </div>
              <div v-if="row.status === 'applied' && row.applied_at" class="text-xs text-gray-500 mt-1">
                已应用:{{ new Date(row.applied_at).toLocaleString('zh-CN') }}
              </div>
            </div>
          </div>
        </div>

        <!-- 修订历史 -->
        <div v-if="revisions.length > 0" class="pt-4 border-t">
          <div class="text-sm font-medium mb-2">
            修订历史({{ revisions.length }})
          </div>
          <div class="space-y-2">
            <div v-for="rev in revisions" :key="rev.id" class="text-xs p-2 border rounded">
              <div class="flex justify-between">
                <span>版本 #{{ rev.revision_no }}</span>
                <span class="text-gray-500">{{ new Date(rev.revised_at).toLocaleString('zh-CN') }}</span>
              </div>
              <div class="text-gray-600 mt-1">
                原因:{{ rev.reason }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </FaPageMain>

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
    <FaModal v-model:visible="issueVisible" title="开具处方" @confirm="onSubmitIssue">
      <div class="space-y-3">
        <p class="text-sm text-gray-600">
          开具后处方进入已开具状态,明细将锁定不可编辑。
        </p>
        <FaLabel label="开方人">
          <EmployeePicker v-model="issueForm.prescriberEmployeeId" class="w-full" />
        </FaLabel>
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
