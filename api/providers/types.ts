/**
 * 消息 Provider 抽象(S32-D)
 *
 * Provider 只负责"把一条消息发给一个接收人",不知道任何业务 Domain。
 * 业务(模板、变量白名单、投递记录、重试)由 api/services/messaging 编排。
 */

/** 统一投递状态(MXQ-12005 扩展):queued → sent/delivered / failed */
export type ProviderStatus = 'queued' | 'sent' | 'delivered' | 'failed'

/** Provider 发送入参(已渲染完毕,与业务无关) */
export interface ProviderSendInput {
  channel: 'sms' | 'email' | 'wechat' | 'work_wechat'
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
