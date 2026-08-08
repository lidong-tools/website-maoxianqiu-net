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
  /** P0-18:按 Tab 分页查询,附带三个 Tab 计数 facets */
  async listApprovals(params: { tab: 'inbox' | 'mine' | 'processed', page?: number, pageSize?: number, tenantId?: string }) {
    const res = await api.get<{
      list: ApprovalInboxItem[]
      total: number
      pagination: { page: number, pageSize: number, total: number }
      facets: { inbox: number, mine: number, processed: number }
    }>('approvals', { params: { tab: params.tab, page: params.page ?? 1, pageSize: params.pageSize ?? 20, tenantId: params.tenantId } })
    return ((res as any)?.data) ?? { list: [], total: 0, pagination: { page: 1, pageSize: 20, total: 0 }, facets: { inbox: 0, mine: 0, processed: 0 } }
  },

  /** P0-18:独立计数 */
  async getApprovalCounts(params: { tenantId?: string }) {
    const res = await api.get<{ inbox: number, mine: number, processed: number }>('approvals/counts', { params })
    return ((res as any)?.data) ?? { inbox: 0, mine: 0, processed: 0 }
  },

  /** 待我审批(兼容旧调用,无分页) */
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
