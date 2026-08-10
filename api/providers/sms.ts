import type { MessageChannel, MessagingProvider, MessagingWebhookProvider, ProviderSendInput, ProviderSendResult, ProviderWebhookEvent } from './types.js'
import {

  ProviderError,

} from './types.js'

/**
 * 短信 Provider(Agent-08 多渠道扩展)
 *
 * 通用 HTTP JSON API 抽象(兼容阿里云/腾讯云等按"URL + API Key + 签名文本"
 * 调用的短信服务)。真实接入时由服务端环境变量配置:
 *   MESSAGING_SMS_API_URL   (必填,POST JSON 端点)
 *   MESSAGING_SMS_API_KEY   (必填,Bearer 密钥,仅服务端)
 *   MESSAGING_SMS_SIGN      (必填,短信签名,如"毛线球宠物医院")
 *
 * 未配置时 isConfigured()=false,send 抛 PROVIDER_NOT_CONFIGURED,
 * 绝不 mock 成功伪造投递记录(Agent-08 DEEP §14)。
 */
export class SmsMessagingProvider implements MessagingProvider, MessagingWebhookProvider {
  readonly name = 'sms'

  constructor(private readonly config: {
    apiUrl: string
    apiKey: string
    sign: string
  }) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiUrl && this.config.apiKey && this.config.sign)
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (input.channel !== 'sms') {
      throw new ProviderError('CHANNEL_MISMATCH', `sms Provider 不能发送 ${input.channel} 渠道消息`)
    }
    if (!this.isConfigured()) {
      throw new ProviderError('PROVIDER_NOT_CONFIGURED', '短信通道未配置(MESSAGING_SMS_API_URL/API_KEY/SIGN)')
    }
    const recipient = (input.recipient || '').trim()
    if (!/^[0-9+\-\s]{5,20}$/.test(recipient)) {
      throw new ProviderError('INVALID_RECIPIENT', `无效的手机号: ${input.recipient}`)
    }

    let res: Response
    try {
      res = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sign: this.config.sign,
          to: recipient,
          text: input.text,
        }),
        signal: AbortSignal.timeout(10_000),
      })
    }
    catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new ProviderError('PROVIDER_NETWORK', `短信服务请求失败: ${message}`)
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      throw new ProviderError(
        `HTTP_${res.status}`,
        `短信服务返回错误(HTTP ${res.status})`,
        { status: res.status, message: bodyText.slice(0, 500) },
      )
    }

    const messageId = res.headers.get('x-message-id') || undefined
    return {
      status: 'sent',
      providerMessageId: messageId,
      raw: { httpStatus: res.status },
    }
  }

  /**
   * Webhook 验签:共享密钥 HMAC(服务端配置 MESSAGING_WEBHOOK_SECRET 后,
   * 短信厂商回调需携带 X-Messaging-Webhook-Signature: sha256=<hex>)。
   * 未配置共享密钥一律拒收(宁可不收也不处理未验签事件,P0)。
   */
  async verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<boolean> {
    const secret = (process.env.MESSAGING_WEBHOOK_SECRET || '').trim()
    const signature = headers['x-messaging-webhook-signature'] ?? headers['X-Messaging-Webhook-Signature']
    if (!secret || !signature || !signature.startsWith('sha256=')) {
      return false
    }
    const { createHmac, timingSafeEqual } = await import('node:crypto')
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
    const given = signature.slice('sha256='.length)
    const a = Buffer.from(expected)
    const b = Buffer.from(given)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /**
   * 解析回调为标准 JSON 事件数组:
   * [{ providerEventId, deliveryId?, providerMessageId?, eventType: delivered|failed|bounced|unknown, ... }]
   */
  async parseWebhook(rawBody: string, _headers: Record<string, string | undefined>): Promise<ProviderWebhookEvent[]> {
    let body: unknown
    try {
      body = JSON.parse(rawBody)
    }
    catch {
      return []
    }
    const list = Array.isArray(body) ? body : [body]
    const events: ProviderWebhookEvent[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') { continue }
      const record = item as Record<string, unknown>
      const providerEventId = typeof record.providerEventId === 'string' ? record.providerEventId : null
      if (!providerEventId) { continue }
      const rawType = typeof record.eventType === 'string' ? record.eventType : 'unknown'
      const eventType = rawType === 'delivered' || rawType === 'failed' || rawType === 'bounced'
        ? rawType
        : 'unknown'
      events.push({
        provider: 'sms',
        providerEventId,
        deliveryId: typeof record.deliveryId === 'string' ? record.deliveryId : null,
        providerMessageId: typeof record.providerMessageId === 'string' ? record.providerMessageId : null,
        eventType,
        payload: record,
      })
    }
    return events
  }
}

/**
 * 微信 Provider 占位 Adapter(Agent-08)
 *
 * 微信(公众号/订阅号)模板消息需要小程序/公众号资质与 token 换取流程,
 * 本阶段未提供真实凭据通道:isConfigured()=false,发送一律返回 PROVIDER_NOT_CONFIGURED。
 * 接入真实微信服务号时在此实现模板消息发送,不改变既有 Email/SMS 路径。
 */
export class WechatMessagingProvider implements MessagingProvider {
  readonly name = 'wechat'

  isConfigured(): boolean {
    return false
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (input.channel !== 'wechat' && input.channel !== 'work_wechat') {
      throw new ProviderError('CHANNEL_MISMATCH', `wechat Provider 不能发送 ${input.channel} 渠道消息`)
    }
    throw new ProviderError('PROVIDER_NOT_CONFIGURED', '微信通道未接入,请配置公众号/企业微信凭据')
  }
}

export type { MessageChannel }
