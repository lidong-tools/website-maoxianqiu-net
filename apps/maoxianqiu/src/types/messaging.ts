/**
 * Messaging 领域类型(S32-D 消息通知真实 Provider)
 * 与 supabase/migrations/20260810000112_messaging_provider.sql 对齐
 */

/** 消息渠道 */
export type MessagingChannel = 'sms' | 'email' | 'wechat' | 'work_wechat'

/** 投递状态:queued → sent/delivered / failed */
export type MessagingStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'retry'

/** 消息模板(message_templates) */
export interface MessagingTemplate {
  id: string
  tenant_id: string
  code: string
  name: string
  channel: MessagingChannel
  subject: string | null
  body: string
  /** 模板实际使用的白名单变量(key 集合) */
  variables: Record<string, unknown>
  is_active: boolean
  version: number
  created_at: string
  updated_at: string
}

/** 投递记录(message_deliveries,S32-D 扩展 scene/snapshot) */
export interface MessagingDelivery {
  id: string
  tenant_id: string
  store_id: string | null
  scene: string | null
  reminder_id: string | null
  template_id: string | null
  channel: MessagingChannel
  recipient: string
  content_snapshot: string
  subject_snapshot: string | null
  variables_snapshot: Record<string, string> | null
  provider_message_id: string | null
  status: MessagingStatus
  error: string | null
  attempts: number
  sent_at: string | null
  created_at: string
}

/** 发送尝试(message_delivery_attempts) */
export interface MessageDeliveryAttempt {
  id: string
  delivery_id: string
  provider: string
  attempt_no: number
  request_snapshot: Record<string, unknown>
  response_snapshot: Record<string, unknown> | null
  status: MessagingStatus
  error_code: string | null
  error_message: string | null
  created_at: string
}

/** Provider 摘要(不含任何 Secret) */
export interface ProviderSummary {
  provider: string
  configured: boolean
  channel: string
}

/** 模板变量白名单项 */
export interface WhitelistVariable {
  key: string
  label: string
}

/** 发送请求入参 */
export interface MessagingSendRequest {
  tenantId: string
  storeId?: string | null
  scene?: string
  templateId?: string
  templateCode?: string
  channel?: MessagingChannel
  recipient: string
  variables?: Record<string, unknown>
}

/** 发送/重试返回 */
export interface MessagingSendResult {
  delivery: MessagingDelivery
  attempt: MessageDeliveryAttempt | null
  result: {
    status: MessagingStatus
    providerMessageId?: string
    raw?: unknown
  }
}

/** 投递详情 */
export interface MessagingDeliveryDetail {
  delivery: MessagingDelivery
  attempts: MessageDeliveryAttempt[]
}

// ===== UI 标签映射 =====

export const MESSAGING_CHANNEL_LABELS: Record<MessagingChannel, string> = {
  sms: '短信',
  email: '邮件',
  wechat: '微信',
  work_wechat: '企业微信',
}

export const MESSAGING_STATUS_LABELS: Record<MessagingStatus, string> = {
  queued: '排队中',
  sent: '已发送',
  delivered: '已送达',
  failed: '发送失败',
  retry: '重试中',
}

export const MESSAGING_SCENE_LABELS: Record<string, string> = {
  appointment_reminder: '预约提醒',
  vaccine_reminder: '疫苗提醒',
  revisit_reminder: '回访提醒',
  lab_report: '检验报告通知',
}
