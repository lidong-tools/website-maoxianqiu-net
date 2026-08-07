<script setup lang="ts">
import type { AppointmentRecord, EncounterRecord } from '@/types/clinical'
import apiClinical from '@/api/modules/clinical'
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
const encounterForm = reactive({
  chiefComplaint: '',
  historyPresent: '',
  examFindings: '',
  diagnosisText: '',
  treatmentPlan: '',
  followUpDate: '',
})
const saving = ref(false)

/** 今日日期范围 */
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

/**
 * 加载今日预约(当前门店)
 */
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
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载今日预约失败')
  }
  finally {
    loadingAppointments.value = false
  }
}

/**
 * 选择预约,开始就诊
 */
async function onSelectAppointment(row: AppointmentRecord) {
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

/**
 * 打开或创建就诊记录
 */
async function openOrCreateEncounter(row: AppointmentRecord) {
  try {
    // 查找该预约是否已有就诊记录
    const res: any = await apiClinical.listEncounters({
      doctorId: row.doctor_id ?? undefined,
      petId: row.pet_id,
      pageSize: 10,
    })
    const existing = (res.data.list as EncounterRecord[]).find(e => e.appointment_id === row.id)
    if (existing) {
      activeEncounter.value = existing
      encounterForm.chiefComplaint = existing.chief_complaint ?? ''
      encounterForm.historyPresent = existing.history_present ?? ''
      encounterForm.examFindings = existing.exam_findings ?? ''
      encounterForm.diagnosisText = existing.diagnosis_text ?? ''
      encounterForm.treatmentPlan = existing.treatment_plan ?? ''
      encounterForm.followUpDate = existing.follow_up_date ?? ''
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
      activeEncounter.value = createRes.data
      encounterForm.chiefComplaint = row.reason ?? ''
      encounterForm.historyPresent = ''
      encounterForm.examFindings = ''
      encounterForm.diagnosisText = ''
      encounterForm.treatmentPlan = ''
      encounterForm.followUpDate = ''
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message || '打开就诊失败')
  }
}

/**
 * 保存病历草稿
 */
async function onSaveDraft() {
  if (!activeEncounter.value) {
    return
  }
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
    })
    activeEncounter.value = res.data
    useFaToast().success('病历已保存')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '保存失败')
  }
  finally {
    saving.value = false
  }
}

/**
 * 跳转病历详情页(签署/修订)
 */
function onOpenDetail() {
  if (activeEncounter.value) {
    router.push(`/clinical/encounter/${activeEncounter.value.id}`)
  }
}

/**
 * 完成就诊
 */
async function onComplete() {
  if (!activeEncounter.value) {
    return
  }
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

onMounted(loadTodayAppointments)
</script>

<template>
  <div>
    <FaPageHeader title="医生工作台" class="mb-0">
      <template #description>
        左侧今日预约/候诊列表,右侧就诊编辑区(集成病历编辑、签署、处方)
      </template>
    </FaPageHeader>
    <FaPageMain>
      <div class="flex gap-4 h-full">
        <!-- 左侧:今日预约列表 -->
        <div class="min-w-300px w-2/5">
          <div class="text-sm font-medium mb-2">
            今日预约({{ todayAppointments.length }})
          </div>
          <div v-loading="loadingAppointments" class="max-h-600px overflow-auto space-y-2">
            <div
              v-for="item in todayAppointments"
              :key="item.id"
              class="p-3 border rounded cursor-pointer transition hover:bg-gray-50"
              :class="{ 'border-primary bg-primary-50': activeEncounter?.appointment_id === item.id }"
              @click="onSelectAppointment(item)"
            >
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium">
                  {{ new Date(item.scheduled_start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
                </span>
                <span class="text-xs px-2 py-0.5 rounded bg-gray-100">{{ item.status }}</span>
              </div>
              <div class="text-xs text-gray-500 mt-1">
                宠物 {{ item.pet_id.slice(0, 8) }} · {{ item.reason ?? '未填写原因' }}
              </div>
            </div>
            <FaEmpty v-if="!loadingAppointments && todayAppointments.length === 0" description="今日无预约" />
          </div>
        </div>

        <!-- 右侧:就诊编辑区 -->
        <div class="flex-1">
          <div v-if="activeEncounter" class="space-y-3">
            <div class="flex items-center justify-between">
              <div class="text-sm font-medium">
                就诊病历 · 状态:{{ ENCOUNTER_STATUS_LABELS[activeEncounter.status] }}
              </div>
              <div class="flex gap-2">
                <FaButton variant="outline" size="sm" :disabled="activeEncounter.status === 'signed'" :loading="saving" @click="onSaveDraft">
                  <FaIcon name="i-ri:save-line" />
                  保存草稿
                </FaButton>
                <FaButton variant="outline" size="sm" :disabled="activeEncounter.status === 'signed'" @click="onComplete">
                  <FaIcon name="i-ri:check-line" />
                  完成就诊
                </FaButton>
                <FaButton type="primary" size="sm" @click="onOpenDetail">
                  <FaIcon name="i-ri:file-text-line" />
                  病历详情
                </FaButton>
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
          <FaEmpty v-else description="请从左侧选择预约开始就诊" />
        </div>
      </div>
    </FaPageMain>
  </div>
</template>
