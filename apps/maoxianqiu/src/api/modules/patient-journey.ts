import type { ClinicalPlanCommitInput, ClinicalPlanCommitResult, EncounterWorkspace, JourneyEvent, WorkbenchData, WorkbenchRole } from '@/types/patient-journey'
import api from '../index'

function commandContext(role: WorkbenchRole) {
  return {
    actorRole: role,
    sourceWorkbench: `workbench.${role}`,
    idempotencyKey: crypto.randomUUID(),
  }
}

export default {
  /** 岗位工作台:支持状态/关键词/分页,状态数量为服务端全量聚合 */
  async getWorkbench(role: WorkbenchRole, input: { storeId: string, status?: string, keyword?: string, page?: number, pageSize?: number }) {
    const result = await api.get<WorkbenchData>(`/workbenches/${role}`, { params: input })
    return (result as any).data as WorkbenchData
  },
  async getTimeline(encounterId: string) {
    const result = await api.get<{ list: JourneyEvent[] }>(`/clinical/encounters/${encounterId}/timeline`)
    return (result as any).data.list as JourneyEvent[]
  },
  /** 患者完整工作区 DTO(医生工作台唯一患者数据源,浏览器不再跨表拼装) */
  async getWorkspace(encounterId: string) {
    const result = await api.get(`/clinical/encounters/${encounterId}/workspace`)
    return (result as any).data as EncounterWorkspace
  },
  /** 诊疗方案原子提交:单个 Command 事务化落库处方/检验/影像/医嘱/收费/任务/事件 */
  async commitClinicalPlan(encounterId: string, input: ClinicalPlanCommitInput) {
    // 幂等键契约:body 与 idempotency-key header 使用同一个可复用键,
    // 服务端以 header 优先,重复重试返回上次结果;调用方需在超时重试时复用同一键
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID()
    const result = await api.post(`/clinical/encounters/${encounterId}/plan/commit`, {
      ...input,
      idempotencyKey,
    }, {
      headers: { 'idempotency-key': idempotencyKey },
    })
    return (result as any).data as ClinicalPlanCommitResult
  },
  async getQueueDisplay(storeId: string) {
    const result = await api.get<{ list: WorkbenchData['list'] }>('/clinical/queue/display', { params: { storeId } })
    return (result as any).data.list as WorkbenchData['list']
  },
  /** 前台签到:创建/复用候诊队列记录(幂等,已存在时直接返回既有记录) */
  async checkInAppointment(input: { appointmentId: string, triageRequired?: boolean, serviceType?: string, actorRole: WorkbenchRole, sourceWorkbench?: string, idempotencyKey?: string }) {
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID()
    const result = await api.post('/clinical/queue/check-in', {
      ...input,
      idempotencyKey,
    }, {
      headers: { 'idempotency-key': idempotencyKey },
    })
    return result
  },
  async transitionQueue(queueId: string, role: WorkbenchRole, targetStatus: string, reason?: string) {
    return api.post(`/clinical/queue/${queueId}/transition`, { ...commandContext(role), targetStatus, reason })
  },
  async saveTriage(queueId: string, role: WorkbenchRole, input: Record<string, unknown>) {
    return api.post(`/clinical/queue/${queueId}/triage`, { ...commandContext(role), ...input })
  },
  async transitionTask(taskId: string, role: WorkbenchRole, action: string, input: Record<string, unknown> = {}) {
    return api.post(`/workflow-tasks/${taskId}/transition`, { ...commandContext(role), action, ...input })
  },
  async finishConsultation(encounterId: string, reason?: string) {
    return api.post(`/clinical/encounters/${encounterId}/finish-consultation`, { ...commandContext('doctor'), reason })
  },
  async voidChargeItem(chargeId: string, reason: string) {
    return api.post(`/billing/charge-items/${chargeId}/void`, { ...commandContext('cashier'), reason })
  },
  async createInvoiceFromCharges(encounterId: string, chargeItemIds: string[], input: { discountAmount: number, discountReason?: string, taxAmount: number }) {
    const result = await api.post(`/billing/encounters/${encounterId}/invoice-from-charges`, {
      ...commandContext('cashier'),
      chargeItemIds,
      ...input,
    })
    return (result as any).data
  },
  async savePreference(role: WorkbenchRole) {
    return api.post('/workbenches/preference', { activeRole: role })
  },
}
