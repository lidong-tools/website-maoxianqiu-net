<script setup lang="ts">
import type { EncounterRecord, EncounterRevisionRecord, PrescriptionItemInput, PrescriptionRecord } from '@/types/clinical'
import apiClinical from '@/api/modules/clinical'
import { ENCOUNTER_STATUS_COLORS, ENCOUNTER_STATUS_LABELS, PRESCRIPTION_STATUS_LABELS } from '@/types/clinical'

defineOptions({
  name: 'ClinicalEncounterDetail',
})

const route = useRoute()
const encounterId = computed(() => route.params.id as string)

const loading = ref(false)
const encounter = ref<EncounterRecord | null>(null)
const revisions = ref<EncounterRevisionRecord[]>([])
const prescriptions = ref<PrescriptionRecord[]>([])

/** 病历编辑表单 */
const form = reactive({
  chiefComplaint: '',
  historyPresent: '',
  examFindings: '',
  diagnosisText: '',
  treatmentPlan: '',
  followUpDate: '',
})

/** 签署弹窗 */
const signVisible = ref(false)
const signDoctorId = ref('')

/** 修订弹窗 */
const reviseVisible = ref(false)
const reviseForm = reactive({
  reason: '',
  content: '',
})

/** 处方编辑 */
const prescriptionItems = ref<PrescriptionItemInput[]>([{ drugName: '', dosage: '', frequency: '', quantity: 1, unit: '' }])
const savingPrescription = ref(false)

/**
 * 加载病历详情(含修订历史 + 处方)
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
 * 签署病历(RPC,需主治医生 id)
 */
async function onSign() {
  if (!encounter.value) {
    return
  }
  if (!signDoctorId.value) {
    useFaToast().warning('请输入医生 ID')
    return
  }
  try {
    const res: any = await apiClinical.signEncounter(encounter.value.id, signDoctorId.value)
    encounter.value = res.data
    signVisible.value = false
    useFaToast().success('病历已签署')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '签署失败')
  }
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

const isSigned = computed(() => encounter.value?.status === 'signed')
const isEditable = computed(() => encounter.value && !isSigned.value)

onMounted(loadData)
</script>

<template>
  <div v-loading="loading">
    <FaPageHeader title="病历详情" class="mb-0">
      <template #description>
        病历编辑 / 签署 / 修订 / 处方管理
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
            <FaButton v-if="isEditable" type="primary" size="sm" @click="signVisible = true">
              <FaIcon name="i-ri:pen-nib-line" />
              签署
            </FaButton>
            <FaButton v-if="isSigned" variant="outline" size="sm" @click="reviseVisible = true">
              <FaIcon name="i-ri:edit-2-line" />
              修订
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
            <FaButton v-if="!isSigned" variant="outline" size="sm" :loading="savingPrescription" @click="onSavePrescription">
              <FaIcon name="i-ri:save-line" />
              保存处方
            </FaButton>
          </div>
          <!-- 已有处方列表 -->
          <div v-if="prescriptions.length > 0" class="mb-3 space-y-2">
            <div v-for="rx in prescriptions" :key="rx.id" class="p-2 border rounded flex items-center justify-between">
              <span class="text-xs">处方 {{ rx.id.slice(0, 8) }} · {{ PRESCRIPTION_STATUS_LABELS[rx.status] }}</span>
              <FaButton v-if="rx.status === 'draft'" variant="outline" size="sm" @click="onDispense(rx)">
                发药
              </FaButton>
            </div>
          </div>
          <!-- 处方明细编辑(未签署时可用) -->
          <div v-if="!isSigned" class="space-y-2">
            <div v-for="(item, idx) in prescriptionItems" :key="idx" class="flex gap-2 items-center">
              <FaInput v-model="item.drugName" placeholder="药品名称" class="flex-1" />
              <FaInput v-model="item.dosage" placeholder="剂量" class="w-100px" />
              <FaInput v-model="item.frequency" placeholder="频次" class="w-100px" />
              <FaInput v-model.number="item.quantity" type="number" placeholder="数量" class="w-80px" />
              <FaInput v-model="item.unit" placeholder="单位" class="w-80px" />
              <FaButton variant="outline" size="icon-sm" @click="removePrescriptionItem(idx)">
                <FaIcon name="i-ri:delete-bin-line" />
              </FaButton>
            </div>
            <FaButton variant="outline" size="sm" @click="addPrescriptionItem">
              <FaIcon name="i-ri:add-line" />
              添加药品
            </FaButton>
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

    <!-- 签署弹窗 -->
    <FaModal v-model:visible="signVisible" title="签署病历" @confirm="onSign">
      <div class="space-y-3">
        <p class="text-sm text-gray-600">
          签署后病历将变为终态,不可直接修改,如需修改请使用修订功能。
        </p>
        <FaLabel label="医生 ID">
          <FaInput v-model="signDoctorId" placeholder="当前主治医生 ID" class="w-full" />
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
  </div>
</template>
