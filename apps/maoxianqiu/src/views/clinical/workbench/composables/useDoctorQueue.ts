/* eslint-disable style/max-statements-per-line -- 队列守卫使用单行提前返回 */
/**
 * 医生岗位候诊队列组合式函数
 * 唯一数据源为 GET /workbenches/doctor,浏览器不再跨表拼装。
 * 负责:队列加载、叫号、开始接诊、等待时长与计数。
 */
import type { DoctorQueueRow } from '@/types/patient-journey'
import apiJourney from '@/api/modules/patient-journey'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { QUEUE_STATUS_LABELS, QUEUE_STATUS_VARIANTS } from '@/types/patient-journey'

export { QUEUE_STATUS_LABELS, QUEUE_STATUS_VARIANTS }

export function useDoctorQueue() {
  const tenantStore = useAppTenantStore()
  const doctorQueue = ref<DoctorQueueRow[]>([])
  const loadingQueue = ref(false)

  /** 各状态计数(服务端 counts 已按状态分组,这里补充前端快捷 key) */
  const queueCounts = computed(() => ({
    waiting: doctorQueue.value.filter(item => item.status === 'waiting').length,
    called: doctorQueue.value.filter(item => item.status === 'called').length,
    consulting: doctorQueue.value.filter(item => item.status === 'in_consultation').length,
  }))

  /** 加载医生岗位候诊队列 */
  async function loadQueue() {
    if (!tenantStore.currentStoreId) {
      doctorQueue.value = []
      return
    }
    loadingQueue.value = true
    try {
      const data = await apiJourney.getWorkbench('doctor', { storeId: tenantStore.currentStoreId })
      doctorQueue.value = data.list as DoctorQueueRow[]
    }
    catch {
      doctorQueue.value = []
    }
    finally {
      loadingQueue.value = false
    }
  }

  /** 叫号:waiting → called,候诊大屏同步播报 */
  async function callPatient(row: DoctorQueueRow) {
    if (!row.id) {
      useFaToast().warning('该预约还没有候诊队列记录,请先由前台完成签到')
      return false
    }
    try {
      await apiJourney.transitionQueue(row.id, 'doctor', 'called')
      useFaToast().success('已叫号,候诊大屏将同步播报')
      await loadQueue()
      return true
    }
    catch (error: any) {
      useFaToast().error(error?.message || '叫号失败')
      return false
    }
  }

  /**
   * 开始接诊:called → in_consultation。
   * 服务端 RPC 会在此步骤自动创建就诊并回写队列 encounter_id,
   * 因此返回刷新后的最新队列行,调用方应使用返回值打开工作区,避免重复创建就诊。
   */
  async function startConsultation(row: DoctorQueueRow): Promise<{ ok: boolean, updated?: DoctorQueueRow }> {
    if (!row.id) { return { ok: false } }
    if (row.status === 'called') {
      try {
        await apiJourney.transitionQueue(row.id, 'doctor', 'in_consultation')
        await loadQueue()
        // 用刷新后的队列行(含自动创建的 encounter)替代点击时的旧行
        const updated = doctorQueue.value.find(item => item.id === row.id) ?? row
        return { ok: true, updated }
      }
      catch (error: any) {
        useFaToast().error(error?.message || '接诊状态更新失败')
        return { ok: false }
      }
    }
    return { ok: true, updated: row }
  }

  /** 将候诊起始时间转为医生可快速识别的等待时长 */
  function waitingText(value?: string | null) {
    if (!value) { return '等待时长未知' }
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000))
    return minutes < 60 ? `已等待 ${minutes} 分钟` : `已等待 ${Math.floor(minutes / 60)}小时${minutes % 60}分`
  }

  /** 清空队列状态(切店时调用) */
  function reset() {
    doctorQueue.value = []
  }

  return {
    doctorQueue,
    loadingQueue,
    queueCounts,
    loadQueue,
    callPatient,
    startConsultation,
    waitingText,
    reset,
  }
}
