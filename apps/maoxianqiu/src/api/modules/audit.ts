import api from '../index'
import operations from './operations'

/**
 * 审计与安全 API 模块(CORE-04)
 * - 审计日志走 Hono Query(service role 只读,权限 audit.view / audit.export)
 * - 安全事件复用 operations.listSecurityEvents
 */

export interface AuditLogItem {
  id: string
  tenant_id: string
  store_id: string | null
  user_id: string | null
  employee_name: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  metadata: Record<string, unknown>
  request_id: string | null
  created_at: string
  [key: string]: unknown
}

export interface AuditLogParams {
  tenantId?: string
  storeId?: string
  userId?: string
  action?: string
  entityType?: string
  entityId?: string
  requestId?: string
  startAt?: string
  endAt?: string
  from?: number
  limit?: number
}

export default {
  /**
   * 审计日志列表
   * GET /api/audit/audit-logs
   */
  async listAuditLogs(params: AuditLogParams) {
    const res = await api.get<{ list: AuditLogItem[], total: number }>('audit/audit-logs', { params })
    return (res as any).data
  },

  /**
   * 审计日志详情
   * GET /api/audit/audit-logs/:id
   */
  async getAuditLog(id: string, params?: { tenantId?: string }) {
    const res = await api.get<AuditLogItem>(`audit/audit-logs/${id}`, { params })
    return (res as any).data
  },

  /**
   * 安全事件列表(复用 operations 模块)
   */
  listSecurityEvents(params: { tenantId?: string, eventType?: string, severity?: string, from?: number, limit?: number }) {
    return operations.listSecurityEvents(params)
  },
}
