/**
 * Messaging Provider 配置(S32-D)
 *
 * S3.1 正在修复 Settings;本模块先从 Server Environment 读取,
 * 最终由 S3.2 Integrator 后续接入 System Settings。
 *
 * 环境变量:
 *   MESSAGING_PROVIDER  email | mock | real(real 为兼容旧变量,有 email 凭据时按 email 解析)
 *   MESSAGING_API_KEY   Email Provider API Key(仅服务端)
 *   MESSAGING_SENDER    Email 发件人(仅服务端)
 *   MESSAGING_API_URL   (可选)Email API 地址,默认 SendGrid v3
 *   兼容旧变量:MESSAGE_PROVIDER / MESSAGE_SENDER(见 isRealMessageProviderConfigured 的 MESSAGE_PROVIDER=real)
 */

export interface MessagingEnvConfig {
  provider: 'email' | 'mock'
  email: {
    apiUrl: string
    apiKey: string
    sender: string
  }
}

const DEFAULT_SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send'

/** 读取并规范化 Provider 环境配置(每次调用读取,便于测试与热更) */
export function loadMessagingConfig(): MessagingEnvConfig {
  const rawProvider = (process.env.MESSAGING_PROVIDER || process.env.MESSAGE_PROVIDER || 'mock').trim().toLowerCase()
  const apiKey = (process.env.MESSAGING_API_KEY || '').trim()
  const sender = (process.env.MESSAGING_SENDER || process.env.MESSAGE_SENDER || '').trim()
  const apiUrl = (process.env.MESSAGING_API_URL || DEFAULT_SENDGRID_URL).trim()

  // real 是旧变量语义(MESSAGE_PROVIDER=real):有 email 凭据则按 email,否则视为未配置回退 mock
  const wantsEmail = rawProvider === 'email' || (rawProvider === 'real' && Boolean(apiKey && sender))
  if (wantsEmail) {
    return { provider: 'email', email: { apiUrl, apiKey, sender } }
  }
  return { provider: 'mock', email: { apiUrl, apiKey, sender } }
}

/**
 * 当前是否处于"真实 Provider 已配置"状态(与 operations.ts 生产 Mock 拒绝逻辑对齐)。
 * 生产环境若未配置真实 Provider,发送入口应拒绝执行。
 */
export function isRealProviderConfigured(): boolean {
  const cfg = loadMessagingConfig()
  return cfg.provider === 'email' && Boolean(cfg.email.apiKey && cfg.email.sender)
}
