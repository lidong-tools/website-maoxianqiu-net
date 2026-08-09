/**
 * 消息 Provider 抽象(S32-D)
 *
 * Provider 只负责"把一条消息发给一个接收人",不知道任何业务 Domain。
 * 业务(模板、变量白名单、投递记录、重试)由 api/services/messaging 编排。
 */

/** 统一投递状态(MXQ-12005 扩展):queued → sent/delivered / failed */
export type ProviderStatus = 'queued' | 'sent' | 'delivered' | 'failed'

/** 消息渠道 */
export type MessageChannel = 'sms' | 'email' | 'wechat' | 'work_wechat'

/** Provider 发送入参(已渲染完毕,与业务无关) */
export interface ProviderSendInput {
  channel: MessageChannel
  recipient: string
  subject?: string | null
  text: string
  /** 业务侧透传的跟踪上下文(写入 attempt.request_snapshot,便于排障) */
  meta?: Record<string, unknown>
}

/** Provider 发送结果 */
export interface ProviderSendResult {
  providerMessageId?: string
  status: ProviderStatus
  raw?: unknown
}

/** Provider 发送异常(含 Provider 原始错误码,写入 attempt.error_code/error_message) */
export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** 消息 Provider 接口:发送单条消息,返回状态 */
export interface MessagingProvider {
  readonly name: string
  /** 是否已正确配置凭据(未配置时应回退 Mock 或在生产环境拒绝) */
  isConfigured(): boolean
  send(input: ProviderSendInput): Promise<ProviderSendResult>
}

/**
 * Webhook 能力接口(Agent-08 DEEP §11)
 *
 * 实现方负责各自 Provider 的回调验签与解析:
 *   - verifyWebhook(rawBody, headers):验签失败返回 false
 *   - parseWebhook(rawBody, headers):解析出统一事件结构
 * 未实现验签的 Provider 必须返回 false(宁可不收也不处理未验签事件,P0)。
 */
export interface MessagingWebhookProvider {
  /**
   * 验签 Provider 回调(原始 body + 请求头)
   * 返回 false 时消息中心应拒绝处理并返回 401
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<boolean>
  /**
   * 解析 Provider 回调为统一事件(验签通过后调用)
   * 返回 null 表示该回调与本 Provider 无关(如 email 退信校验回调)
   */
  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<ProviderWebhookEvent[]>
}

/** 统一 Provider 回调事件(Agent-08 DEEP §12) */
export interface ProviderWebhookEvent {
  provider: string
  providerEventId: string
  deliveryId?: string | null
  providerMessageId?: string | null
  eventType: 'delivered' | 'failed' | 'bounced' | 'unknown'
  payload: Record<string, unknown>
}

/**
 * 消息状态查询接口(可选)
 * 某些 Provider 支持按消息 id 主动查询回执;未实现时 queryStatus 返回 null。
 */
export interface MessagingQueryableProvider {
  queryStatus(providerMessageId: string): Promise<ProviderSendResult | null>
}
