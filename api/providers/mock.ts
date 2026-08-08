import type { MessagingProvider, ProviderSendInput, ProviderSendResult } from './types'

/**
 * Mock Provider(S32-D)
 *
 * 仅用于本地开发/演示:不真正投递,直接返回 sent。
 * 生产环境未配置真实 Provider 时,发送入口会拒绝执行(不允许以 Mock 冒充正式发送)。
 */
export class MockMessagingProvider implements MessagingProvider {
  readonly name = 'mock'

  isConfigured(): boolean {
    return true
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    // 记录用于开发调试
    console.info(`[messaging][mock] ${input.channel} -> ${input.recipient}: ${(input.subject ? `${input.subject} | ` : '')}${input.text.slice(0, 80)}`)
    return {
      status: 'sent',
      providerMessageId: `mock-${Date.now()}`,
      raw: { mock: true },
    }
  }
}
