import api from '../index'

/**
 * CRM Growth 领域 API 模块(Stage-04 Agent-05)
 *
 * 设计原则:
 *   - Segment/Churn 计算与刷新走 Hono Command + service-role-only RPC(禁止前端算)
 *   - 定义 CRUD 走 Hono(服务端 requireScopedPermission + 审计)
 *   - 客户洞察聚合走 Hono(customer.view)
 */

/** 分层规则条件 */
export interface SegmentCondition {
  dim: 'recency_days' | 'visits_total' | 'visits_last_365' | 'spend_total'
    | 'spend_last_365' | 'pet_count' | 'member_tier_code' | 'member_points'
    | 'vaccination_due' | 'deworming_due' | 'no_show_count' | 'followup_overdue'
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  value: number | string | boolean
}

/** 分层定义 */
export interface SegmentDefinition {
  id: string
  tenant_id: string
  code: string
  name: string
  description: string | null
  rule_json: { logic: 'and' | 'or', conditions: SegmentCondition[] }
  priority: number
  active: boolean
  created_at: string
  updated_at: string
  member_count?: number
}

/** 流失风险记录 */
export interface ChurnRiskRecord {
  id: string
  customer_id: string
  risk_type: string
  score: number
  level: 'high' | 'medium' | 'low'
  explanation: Array<{ text: string, points: number }>
  calculated_at: string
  model_version: string
  customers?: { id: string, name: string, phone: string, store_id: string | null } | null
}

/** 客户洞察聚合 */
export interface CustomerInsights {
  customerId: string
  segments: Array<{
    segment_id: string
    code: string
    name: string
    score: number
    explanation: string[]
  }>
  churn: {
    customer_id: string
    risk_type: string
    score: number
    level: 'high' | 'medium' | 'low'
    explanation: Array<{ text: string, points: number }>
    calculated_at: string
    model_version: string
  } | null
  activeCoupons: any[]
  packages: any[]
  campaignHistory: any[]
}

export default {
  // ===== 客户分层 Segments =====

  /**
   * 分层定义列表(走 Hono,crm.segment.view)
   * @param tenantId 租户 id
   */
  async listSegments(params: { tenantId: string }) {
    return api.get<{ list: SegmentDefinition[] }>('crm-growth/segments', { params })
  },

  /**
   * 创建分层定义(走 Hono,crm.segment.manage)
   */
  createSegment(data: {
    tenantId: string
    code: string
    name: string
    description?: string
    ruleJson: { logic: 'and' | 'or', conditions: SegmentCondition[] }
    priority?: number
    active?: boolean
  }) {
    return api.post<SegmentDefinition>('crm-growth/segments', data)
  },

  /**
   * 更新分层定义(走 Hono,crm.segment.manage)
   */
  updateSegment(id: string, data: Partial<{
    code: string
    name: string
    description: string
    ruleJson: { logic: 'and' | 'or', conditions: SegmentCondition[] }
    priority: number
    active: boolean
  }>) {
    return api.patch<SegmentDefinition>(`crm-growth/segments/${id}`, data)
  },

  /**
   * 删除分层定义(走 Hono,crm.segment.manage)
   */
  deleteSegment(id: string) {
    return api.delete(`crm-growth/segments/${id}`)
  },

  /**
   * 批量重算分层物化成员(走 Hono RPC)
   * @param tenantId 租户 id
   */
  refreshSegments(data: { tenantId: string }) {
    return api.post<{ tenant_id: string, evaluated: number }>('crm-growth/segments/refresh', data)
  },

  /**
   * 分层成员列表(走 Hono,crm.segment.view)
   */
  async listSegmentCustomers(id: string, params: { tenantId: string, page?: number, pageSize?: number }) {
    return api.get<{ list: any[], total: number, page: number, pageSize: number }>(
      `crm-growth/segments/${id}/customers`,
      { params },
    )
  },

  // ===== 流失预警 Churn =====

  /**
   * 流失风险列表(走 Hono,crm.churn.view)
   */
  async listChurn(params: {
    tenantId: string
    level?: 'high' | 'medium' | 'low'
    page?: number
    pageSize?: number
  }) {
    return api.get<{ list: ChurnRiskRecord[], total: number, page: number, pageSize: number }>(
      'crm-growth/churn',
      { params },
    )
  },

  /**
   * 批量重算流失评分(走 Hono RPC)
   */
  refreshChurn(data: { tenantId: string }) {
    return api.post<{ tenant_id: string, evaluated: number }>('crm-growth/churn/refresh', data)
  },

  // ===== 客户洞察 =====

  /**
   * 客户洞察聚合(Segment/Churn/Coupons/Packages/Campaign History)
   * 走 Hono,customer.view
   * @param customerId 客户 id
   */
  async getCustomerInsights(customerId: string) {
    return api.get<CustomerInsights>(`crm-growth/customers/${customerId}/insights`)
  },
}
