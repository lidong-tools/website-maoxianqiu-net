import type { MessageChannel, MessagingProvider, ProviderSendInput, ProviderSendResult } from './types.js'
import { isProductionEnv, loadMessagingConfig } from '../services/messaging/config.js'
import { EmailMessagingProvider } from './email.js'
import { MockMessagingProvider } from './mock.js'
import { SmsMessagingProvider, WechatMessagingProvider } from './sms.js'
import {

  ProviderError,

} from './types.js'

/**
 * Provider 注册表(S32-D / Agent-08 多渠道扩展)
 *
 * 按环境配置 + 渠道解析当前生效的 Provider:
 *   - email   → MESSAGING_API_KEY + MESSAGING_SENDER 配置后使用真实邮件 Provider
 *   - sms     → MESSAGING_SMS_API_URL/API_KEY/SIGN 配置后使用短信 Provider
 *   - wechat  → MESSAGING_WECHAT_APP_ID/APP_SECRET 配置后使用微信占位 Provider(当前恒未配置)
 *   - 其余     → 未配置的渠道在开发环境回退 Mock(便于本地联调),
 *                生产环境返回"未配置即拒绝"的占位 Provider(send 抛 PROVIDER_NOT_CONFIGURED,
 *                绝不 mock 成功伪造投递记录)。
 *
 * Provider 由服务端解析,Secret 只存在于服务端环境变量。
 */
let cachedProvider: MessagingProvider | null = null
let cachedKey = ''

/** 兼容旧语义:主通道(email/mock),供既有 Messaging 引擎调用 */
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

/** 提供主通道 Provider 摘要(不含任何 Secret),供前端展示当前模式(向后兼容) */
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

/**
 * 解析某渠道已配置的真实 Provider;未配置返回 null。
 * 不构造未配置 Provider 的原因:Email.send 未配置时会发出注定失败的请求,
 * 由本函数在入口处拦截,保证"未配置 → 开发回退 Mock / 生产直接拒绝"语义统一。
 */
function resolveChannelProvider(cfg: ReturnType<typeof loadMessagingConfig>, channel: MessageChannel): MessagingProvider | null {
  if (channel === 'email') {
    return cfg.email.apiKey && cfg.email.sender
      ? new EmailMessagingProvider(cfg.email)
      : null
  }
  if (channel === 'sms') {
    return cfg.sms.apiUrl && cfg.sms.apiKey && cfg.sms.sign
      ? new SmsMessagingProvider(cfg.sms)
      : null
  }
  if (channel === 'wechat' || channel === 'work_wechat') {
    return cfg.wechat.appId && cfg.wechat.appSecret
      ? new WechatMessagingProvider()
      : null
  }
  return null
}

/**
 * 生产环境"未配置即拒绝"的占位 Provider:
 * send 一律抛 PROVIDER_NOT_CONFIGURED,绝不以 Mock 冒充正式投递。
 */
class UnconfiguredMessagingProvider implements MessagingProvider {
  readonly name = 'unconfigured'

  constructor(private readonly channel: MessageChannel) {}

  isConfigured(): boolean {
    return false
  }

  async send(_input: ProviderSendInput): Promise<ProviderSendResult> {
    throw new ProviderError(
      'PROVIDER_NOT_CONFIGURED',
      `${this.channel} 通道未配置,生产环境禁止发送`,
    )
  }
}

/**
 * 按渠道获取 Provider(Agent-08 C 端 OTP 发送等场景):
 *   - 已配置 → 真实 Provider
 *   - 未配置 → 开发环境回退 Mock;生产环境返回拒绝发送的占位 Provider
 */
export function getProviderForChannel(channel: MessageChannel): MessagingProvider {
  const cfg = loadMessagingConfig()
  const real = resolveChannelProvider(cfg, channel)
  if (real) {
    return real
  }
  if (!isProductionEnv()) {
    return new MockMessagingProvider()
  }
  return new UnconfiguredMessagingProvider(channel)
}

/** 通道配置状态摘要(不含任何 Secret),供 Portal Admin 展示当前多通道模式 */
export function getProviderChannelStatus(): Array<{
  channel: MessageChannel
  provider: string
  configured: boolean
}> {
  const cfg = loadMessagingConfig()
  const channels: MessageChannel[] = ['email', 'sms', 'wechat', 'work_wechat']
  return channels.map((channel) => {
    const provider = resolveChannelProvider(cfg, channel)
    return {
      channel,
      provider: provider ? provider.name : 'unconfigured',
      configured: Boolean(provider),
    }
  })
}
