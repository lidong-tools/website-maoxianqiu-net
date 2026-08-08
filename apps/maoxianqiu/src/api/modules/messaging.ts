import type {
  MessageDeliveryAttempt,
  MessagingDelivery,
  MessagingDeliveryDetail,
  MessagingSendRequest,
  MessagingSendResult,
  MessagingTemplate,
  ProviderSummary,
  WhitelistVariable,
} from '@/types/messaging'
import api from '../index'

/**
 * Messaging 领域 API 模块(S32-D 消息通知真实 Provider)
 *
 * 全部走 Hono Command(service role):服务端负责白名单校验、渲染、真实 Provider 发送与尝试落库。
 * Provider Secret 只存在于服务端环境变量,前端任何接口都拿不到。
 */

export default {
  /**
   * 获取 Provider 配置摘要(不含 Secret)
   */
  async getProviderSummary() {
    return api.get<ProviderSummary>('messaging/provider')
  },

  /**
   * 获取模板变量白名单(供模板编辑器点击插入)
   */
  async getVariableWhitelist() {
    return api.get<WhitelistVariable[]>('messaging/variables')
  },

  /**
   * 模板列表
   */
  async listTemplates(params: {
    tenantId: string
    channel?: string
    onlyActive?: boolean
  }) {
    return api.get<{ list: MessagingTemplate[], total: number }>('messaging/templates', { params })
  },

  /**
   * 新建模板(服务端做白名单校验并自动提取变量)
   */
  createTemplate(data: {
    tenantId: string
    code: string
    name: string
    channel: MessagingTemplate['channel']
    subject?: string | null
    body: string
    isActive?: boolean
  }) {
    return api.post<MessagingTemplate>('messaging/templates', data)
  },

  /**
   * 更新模板(版本号服务端自动 +1)
   */
  updateTemplate(id: string, data: {
    tenantId: string
    name?: string
    channel?: MessagingTemplate['channel']
    subject?: string | null
    body?: string
    isActive?: boolean
  }) {
    return api.patch<MessagingTemplate>(`messaging/templates/${id}`, data)
  },

  /**
   * 发送消息(建投递 + 真实 Provider 发送)
   */
  send(data: MessagingSendRequest) {
    return api.post<MessagingSendResult>('messaging/send', data)
  },

  /**
   * 投递记录列表
   */
  async listDeliveries(params: {
    tenantId: string
    storeId?: string
    status?: string
    scene?: string
    channel?: string
    from?: number
    limit?: number
  }) {
    return api.get<{ list: MessagingDelivery[], total: number }>('messaging/deliveries', { params })
  },

  /**
   * 投递详情(含尝试历史)
   */
  async getDelivery(id: string) {
    return api.get<MessagingDeliveryDetail>(`messaging/deliveries/${id}`)
  },

  /**
   * 人工重试(最多 3 次)
   */
  retryDelivery(id: string) {
    return api.post<MessagingSendResult>(`messaging/deliveries/${id}/retry`, {})
  },
}

export type {
  MessageDeliveryAttempt,
  MessagingDelivery,
  MessagingDeliveryDetail,
  MessagingSendResult,
  MessagingTemplate,
}
