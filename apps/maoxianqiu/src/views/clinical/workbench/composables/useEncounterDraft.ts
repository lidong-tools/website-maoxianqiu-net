/* eslint-disable style/max-statements-per-line -- 病历守卫与计时器清理使用单行提前返回 */
/**
 * 病历草稿组合式函数
 * 负责:病历表单状态、dirty 判定、乐观锁保存、409 冲突三种动作、键盘保存。
 * 覆盖"病历 + 下单草稿"整体未保存保护(下单草稿由 useClinicalPlanDraft 汇总到同一 guard)。
 */
import type { EncounterRecord, UpdateEncounterInput } from '@/types/clinical'
import apiClinical from '@/api/modules/clinical'

/** 病历编辑表单字段 */
export interface EncounterFormState {
  chiefComplaint: string
  historyPresent: string
  examFindings: string
  diagnosisText: string
  treatmentPlan: string
  followUpDate: string
}

export function emptyEncounterForm(): EncounterFormState {
  return {
    chiefComplaint: '',
    historyPresent: '',
    examFindings: '',
    diagnosisText: '',
    treatmentPlan: '',
    followUpDate: '',
  }
}

export function useEncounterDraft(options: { onAutosaveConflict?: () => void } = {}) {
  const form = reactive<EncounterFormState>(emptyEncounterForm())
  /** 表单基线:最近一次加载/保存时的服务器值,用于 dirty 判定 */
  const baselineEncounter = ref<EncounterRecord | null>(null)
  const saving = ref(false)
  const lastSavedAt = ref<Date | null>(null)
  /** 自动保存计时器(停止输入 2 秒后触发) */
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null
  /** 自动保存串行化:同一时刻仅一个保存请求在途 */
  let saveInFlight: Promise<EncounterRecord | null> | null = null
  /** 保存期间又发生输入,完成后补一次保存 */
  let autosavePending = false

  /** 表单与基线不一致即为 dirty(P0-25 数据丢失保护核心) */
  const isDirty = computed(() => {
    if (!baselineEncounter.value) { return false }
    const e = baselineEncounter.value
    return form.chiefComplaint !== (e.chief_complaint ?? '')
      || form.historyPresent !== (e.history_present ?? '')
      || form.examFindings !== (e.exam_findings ?? '')
      || form.diagnosisText !== (e.diagnosis_text ?? '')
      || form.treatmentPlan !== (e.treatment_plan ?? '')
      || form.followUpDate !== (e.follow_up_date ?? '')
  })

  /** 加载病历到表单,并重置基线 */
  function applyEncounter(encounter: EncounterRecord) {
    form.chiefComplaint = encounter.chief_complaint ?? ''
    form.historyPresent = encounter.history_present ?? ''
    form.examFindings = encounter.exam_findings ?? ''
    form.diagnosisText = encounter.diagnosis_text ?? ''
    form.treatmentPlan = encounter.treatment_plan ?? ''
    form.followUpDate = encounter.follow_up_date ?? ''
    baselineEncounter.value = encounter
    lastSavedAt.value = null
  }

  /** 保存草稿;返回 null 表示未执行/失败,否则返回最新病历 */
  async function saveDraft(): Promise<EncounterRecord | null> {
    if (!baselineEncounter.value) { return null }
    if (baselineEncounter.value.status === 'signed') {
      useFaToast().warning('已签署病历不可直接修改,请使用修订功能')
      return null
    }
    saving.value = true
    try {
      const input: UpdateEncounterInput = {
        chiefComplaint: form.chiefComplaint,
        historyPresent: form.historyPresent,
        examFindings: form.examFindings,
        diagnosisText: form.diagnosisText,
        treatmentPlan: form.treatmentPlan,
        followUpDate: form.followUpDate || undefined,
        expectedVersion: baselineEncounter.value.version,
      }
      const res = await apiClinical.updateEncounter(baselineEncounter.value.id, input)
      const saved = res.data
      baselineEncounter.value = saved
      lastSavedAt.value = new Date()
      return saved
    }
    catch (error: any) {
      // 乐观锁冲突由页面统一弹窗处理,这里只做标记
      if (error?.response?.status === 409) {
        throw error
      }
      useFaToast().error(error?.message || '保存失败')
      return null
    }
    finally {
      saving.value = false
    }
  }

  /** 自动保存串行化执行:避免并发保存覆盖版本;409 冲突通知页面统一弹窗 */
  async function runAutosave() {
    if (!isDirty.value || baselineEncounter.value?.status === 'signed') { return }
    if (saveInFlight) {
      autosavePending = true
      return
    }
    saveInFlight = saveDraft()
    try {
      await saveInFlight
    }
    catch (error: any) {
      // 乐观锁冲突交给页面统一弹窗处理(不再静默吞掉);其余自动保存失败不打扰用户
      if (error?.response?.status === 409) {
        options.onAutosaveConflict?.()
      }
    }
    finally {
      saveInFlight = null
    }
    // 保存期间又有输入 → 完成后补一次保存,保证最后状态落库
    if (autosavePending) {
      autosavePending = false
      await runAutosave()
    }
  }

  /** 停止输入 2 秒后自动保存(串行化,409 冲突由页面统一处理) */
  function scheduleAutosave() {
    if (autosaveTimer) { clearTimeout(autosaveTimer) }
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null
      runAutosave()
    }, 2000)
  }

  /** 保存状态文本 */
  const savedText = computed(() => {
    if (!lastSavedAt.value) { return '尚未保存' }
    return `已保存 ${lastSavedAt.value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
  })

  /** 清空草稿(切店/结束时调用) */
  function resetDraft() {
    Object.assign(form, emptyEncounterForm())
    baselineEncounter.value = null
    lastSavedAt.value = null
    if (autosaveTimer) { clearTimeout(autosaveTimer) }
    autosaveTimer = null
  }

  return {
    form,
    baselineEncounter,
    saving,
    lastSavedAt,
    isDirty,
    savedText,
    applyEncounter,
    saveDraft,
    scheduleAutosave,
    resetDraft,
  }
}
