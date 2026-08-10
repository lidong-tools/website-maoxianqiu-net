import type { JourneyEvent, WorkbenchData, WorkbenchRole } from '@/types/patient-journey'
import api from '../index'

function commandContext(role: WorkbenchRole) {
  return {
    actorRole: role,
    sourceWorkbench: `workbench.${role}`,
    idempotencyKey: crypto.randomUUID(),
  }
}

export default {
  async getWorkbench(role: WorkbenchRole, storeId: string) {
    const result = await api.get<WorkbenchData>(`/workbenches/${role}`, { params: { storeId } })
    return (result as any).data as WorkbenchData
  },
  async getTimeline(encounterId: string) {
    const result = await api.get<{ list: JourneyEvent[] }>(`/clinical/encounters/${encounterId}/timeline`)
    return (result as any).data.list as JourneyEvent[]
  },
  async getWorkspace(encounterId: string) {
    const result = await api.get(`/clinical/encounters/${encounterId}/workspace`)
    return (result as any).data as Record<string, any>
  },
  async getQueueDisplay(storeId: string) {
    const result = await api.get<{ list: WorkbenchData['list'] }>('/clinical/queue/display', { params: { storeId } })
    return (result as any).data.list as WorkbenchData['list']
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
