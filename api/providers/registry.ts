import { loadMessagingConfig } from '../services/messaging/config.js'
import { EmailMessagingProvider } from './email.js'
import { MockMessagingProvider } from './mock.js'
import type { MessagingProvider } from './types.js'

/**
 * Provider 注册表(S32-D)
 *
 * 按环境配置解析当前生效的 Provider:
 *   - MESSAGING_PROVIDER=email(且带凭据)→ 真实邮件 Provider
 *   - 其余 → Mock Provider(仅开发/演示,生产环境发送入口会拒绝)
 *
 * Provider 由服务端解析,Secret 只存在于服务端环境变量。
 */
let cachedProvider: MessagingProvider | null = null
let cachedKey = ''

export function getProvider(): MessagingProvider {
  const cfg = loadMessagingConfig()
  const key = `${cfg.provider}|${cfg.email.apiKey.length > 0}|${cfg.email.sender}`
  if (cachedProvider && cachedKey === key) {
    return cachedProvider
  }
  const provider: MessagingProvider = cfg.provider === 'email' && cfg.email.apiKey && cfg.email.sender
    ? new EmailMessagingProvider(cfg.email)
    : new MockMessagingProvider()
  cachedProvider = provider
  cachedKey = key
  return provider
}

/** 提供 Provider 摘要(不含任何 Secret),供前端展示当前模式 */
export function getProviderSummary(): {
  provider: string
  configured: boolean
  channel: string
} {
  const cfg = loadMessagingConfig()
  const provider = getProvider()
  const configured = provider.isConfigured() && cfg.provider === 'email'
  return {
    provider: provider.name,
    configured,
    channel: provider.name === 'email' ? 'email' : 'sms/email(演示)',
  }
}
