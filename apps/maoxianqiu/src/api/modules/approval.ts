import api from '../index'
import apiBilling from './billing'
import apiCompliance from './compliance'

/**
 * Approval Inbox 聚合 API 模块(CORE-05)
 * 列表走 Hono 聚合查询(approval.inbox.view);决定动作复用各业务域 Command。
 */

export type ApprovalItemType = 'invoice_discount' | 'medical_record_amendment'

export interface ApprovalInboxItem {
  type: ApprovalItemType
  id: string
  title: string
  storeId: string | null
  tenantId: string
  requestedBy: string | null
  requestedByName: string | null
  reason: string | null
  status: string
  risk: 'high' | 'medium' | 'low'
  amount: number | null
  createdAt: string
  entityId: string
  entityType: string
  summary: string
  detail: Record<string, unknown>
}

function unwrap<T>(res: any): { list: T[], total: number } {
  return (res as any)?.data ?? { list: [], total: 0 }
}

export default {
  /** 待我审批 */
  async listApprovalInbox(params?: { tenantId?: string }) {
    const res = await api.get<{ list: ApprovalInboxItem[], total: number }>('approvals/inbox', { params })
    return unwrap<ApprovalInboxItem>(res)
  },

  /** 我发起的 */
  async listMyApprovals(params?: { tenantId?: string }) {
    const res = await api.get<{ list: ApprovalInboxItem[], total: number }>('approvals/mine', { params })
    return unwrap<ApprovalInboxItem>(res)
  },

  /** 已处理 */
  async listProcessedApprovals(params?: { tenantId?: string }) {
    const res = await api.get<{ list: ApprovalInboxItem[], total: number }>('approvals/processed', { params })
    return unwrap<ApprovalInboxItem>(res)
  },

  /**
   * 折扣审批决定(复用 billing Command)
   */
  decideDiscount(approvalId: string, status: 'approved' | 'rejected', reason?: string) {
    return apiBilling.approveDiscount({ approvalId, status, reason })
  },

  /**
   * 病历修订审批决定(复用 compliance Command)
   */
  decideAmendment(id: string, decision: 'approved' | 'rejected', reason?: string) {
    return apiCompliance.reviewAmendment(id, { decision, reason })
  },
}
