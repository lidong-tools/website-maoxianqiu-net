/* eslint-disable style/max-statements-per-line -- 工作区守卫使用单行提前返回 */
/**
 * 患者工作区组合式函数
 * 唯一数据源为 GET /clinical/encounters/:id/workspace。
 * 负责:加载患者上下文(宠物/主人/分诊/病历/医疗单据/收费/用药安全)并派生展示视图。
 */
import type { EncounterWorkspace } from '@/types/patient-journey'
import apiJourney from '@/api/modules/patient-journey'

export function useEncounterWorkspace() {
  const workspace = ref<EncounterWorkspace | null>(null)
  const loadingWorkspace = ref(false)
  /** 防竞态:仅最新一次加载结果可写回 */
  let runId = 0

  /** 加载患者完整工作区(每次选中患者调用一次) */
  async function loadWorkspace(encounterId: string) {
    const currentRun = ++runId
    loadingWorkspace.value = true
    try {
      const data = await apiJourney.getWorkspace(encounterId)
      if (currentRun === runId) {
        workspace.value = data
      }
      return data
    }
    catch (error: any) {
      if (currentRun === runId) {
        useFaToast().error(error?.message || '加载患者工作区失败')
      }
      return null
    }
    finally {
      if (currentRun === runId) {
        loadingWorkspace.value = false
      }
    }
  }

  /** 命令成功后局部更新:重新拉取工作区校准(失败不阻断页面) */
  async function refreshWorkspace() {
    if (!workspace.value?.encounter?.id) { return }
    const currentRun = ++runId
    try {
      const data = await apiJourney.getWorkspace(workspace.value.encounter.id)
      if (currentRun === runId) {
        workspace.value = data
      }
    }
    catch {
      // 校准失败保持本地视图,交由用户手动刷新
    }
    finally {
      if (currentRun === runId) {
        loadingWorkspace.value = false
      }
    }
  }

  /** 清空工作区(切店/切患者时调用) */
  function resetWorkspace() {
    runId += 1
    workspace.value = null
    loadingWorkspace.value = false
  }

  // ===== 派生视图(供页面与组件直接消费) =====

  const activeEncounter = computed(() => workspace.value?.encounter ?? null)
  const activePet = computed(() => workspace.value?.pet ?? null)
  const activeCustomer = computed(() => workspace.value?.customer ?? null)
  const prescriptions = computed(() => workspace.value?.prescriptions ?? [])
  const labOrders = computed(() => workspace.value?.labOrders ?? [])
  const imagingOrders = computed(() => workspace.value?.imagingOrders ?? [])
  const medicalOrders = computed(() => workspace.value?.medicalOrders ?? [])
  const recentEncounters = computed(() => workspace.value?.recentEncounters ?? [])
  const blockers = computed(() => workspace.value?.blockers ?? [])
  const billing = computed(() => workspace.value?.billing)
  const medicationSafety = computed(() => workspace.value?.medicationSafety)
  const journeyStage = computed(() => workspace.value?.journeyStage ?? '')
  const allowedActions = computed(() => workspace.value?.allowedActions ?? [])

  /** 病历是否只读:已签署/关闭/取消/转诊 */
  const encounterReadonly = computed(() => {
    const status = activeEncounter.value?.clinical_status ?? activeEncounter.value?.status
    return ['signed', 'closed', 'cancelled', 'transferred'].includes(status)
  })

  return {
    workspace,
    loadingWorkspace,
    loadWorkspace,
    refreshWorkspace,
    resetWorkspace,
    activeEncounter,
    activePet,
    activeCustomer,
    prescriptions,
    labOrders,
    imagingOrders,
    medicalOrders,
    recentEncounters,
    blockers,
    billing,
    medicationSafety,
    journeyStage,
    allowedActions,
    encounterReadonly,
  }
}
