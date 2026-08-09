/**
 * Messaging Provider 配置(Agent-08 多渠道扩展)
 *
 * 全部凭据只读自服务端环境变量,不下发前端:
 *   MESSAGING_PROVIDER  email | mock(主通道兼容旧变量)
 *   MESSAGING_API_KEY / MESSAGING_SENDER / MESSAGING_API_URL    Email(SendGrid)
 *   MESSAGING_SMS_API_URL / MESSAGING_SMS_API_KEY / MESSAGING_SMS_SIGN   SMS
 *   MESSAGING_WECHAT_APP_ID / MESSAGING_WECHAT_APP_SECRET        WeChat(预留)
 *   MESSAGING_WEBHOOK_SECRET             Webhook 共享密钥(SMS 等通用通道)
 *   MESSAGING_EMAIL_WEBHOOK_PUBLIC_KEY   SendGrid Event Webhook ed25519 公钥
 * 兼容旧变量:MESSAGE_PROVIDER / MESSAGE_SENDER
 */

export interface MessagingEnvConfig {
  provider: 'email' | 'mock'
  email: {
    apiUrl: string
    apiKey: string
    sender: string
  }
  sms: {
    apiUrl: string
    apiKey: string
    sign: string
  }
  wechat: {
    appId: string
    appSecret: string
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
  return {
    provider: wantsEmail ? 'email' : 'mock',
    email: { apiUrl, apiKey, sender },
    sms: {
      apiUrl: (process.env.MESSAGING_SMS_API_URL || '').trim(),
      apiKey: (process.env.MESSAGING_SMS_API_KEY || '').trim(),
      sign: (process.env.MESSAGING_SMS_SIGN || '').trim(),
    },
    wechat: {
      appId: (process.env.MESSAGING_WECHAT_APP_ID || '').trim(),
      appSecret: (process.env.MESSAGING_WECHAT_APP_SECRET || '').trim(),
    },
  }
}

/**
 * 当前是否处于"真实 Provider 已配置"状态(与 operations.ts 生产 Mock 拒绝逻辑对齐)。
 * 生产环境若未配置真实 Provider,发送入口应拒绝执行。
 */
export function isRealProviderConfigured(): boolean {
  const cfg = loadMessagingConfig()
  return cfg.provider === 'email' && Boolean(cfg.email.apiKey && cfg.email.sender)
}

/** 生产环境判定(与 messaging engine 一致) */
export function isProductionEnv(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
}
