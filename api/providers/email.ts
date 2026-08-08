import { ProviderError, type MessagingProvider, type ProviderSendInput, type ProviderSendResult } from './types'

/**
 * 真实邮件 Provider(S32-D)
 *
 * 使用 SendGrid 兼容的 HTTP API(Authorization: Bearer <API_KEY>),
 * 通过 Node 原生 fetch 发送,无需额外依赖。API Key / 发件人只存在于服务端环境变量,
 * 绝不下发前端,也不写入任何模板/投递明文字段。
 *
 * 兼容配置(从 api/services/messaging/config 读取):
 *   MESSAGING_API_URL  (可选,默认 https://api.sendgrid.com/v3/mail/send)
 *   MESSAGING_API_KEY  (必填,SendGrid API Key)
 *   MESSAGING_SENDER   (必填,发件人邮箱)
 *
 * 状态约定:HTTP 202 Accepted → sent;SendGrid 无投递回执时不再伪装 delivered。
 * 失败时抛 ProviderError(携带 Provider 返回的错误码/信息,供 attempt 落库)。
 */
export class EmailMessagingProvider implements MessagingProvider {
  readonly name = 'email'

  constructor(private readonly config: {
    apiUrl: string
    apiKey: string
    sender: string
  }) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.sender)
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (input.channel !== 'email') {
      throw new ProviderError('CHANNEL_MISMATCH', `email Provider 不能发送 ${input.channel} 渠道消息`)
    }
    const recipient = (input.recipient || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      throw new ProviderError('INVALID_RECIPIENT', `无效的收件邮箱: ${input.recipient}`)
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
          personalizations: [{ to: [{ email: recipient }] }],
          from: { email: this.config.sender },
          subject: input.subject || '',
          content: [
            { type: 'text/plain', value: input.text },
            { type: 'text/html', value: this.escapeHtml(input.text).replace(/\n/g, '<br/>') },
          ],
        }),
        // 不要无限等待 Provider;10s 超时
        signal: AbortSignal.timeout(10_000),
      })
    }
    catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new ProviderError('PROVIDER_NETWORK', `邮件服务请求失败: ${message}`)
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      // 不要将完整响应明文落库,仅截取错误信息
      throw new ProviderError(
        `HTTP_${res.status}`,
        `邮件服务返回错误(HTTP ${res.status})`,
        { status: res.status, message: bodyText.slice(0, 500) },
      )
    }

    const messageId = res.headers.get('x-message-id') || res.headers.get('X-Message-Id') || undefined
    return {
      status: 'sent',
      providerMessageId: messageId,
      raw: { httpStatus: res.status },
    }
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }
}
