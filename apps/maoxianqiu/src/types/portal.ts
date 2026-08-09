/**
 * 客户门户(Portal)类型(Agent-08)
 * 与 supabase/migrations/20260810000265~67 及 api/routes/portal.ts 返回结构对齐。
 * C 端身份与员工 IAM 完全分离。
 */

/** 身份验证渠道 */
export type PortalIdentityProvider = 'phone' | 'email' | 'wechat'

/** C 端身份状态 */
export type PortalIdentityStatus = 'active' | 'revoked'

/** C 端客户身份(customer_identities) */
export interface PortalIdentity {
  id: string
  tenant_id: string
  customer_id: string | null
  provider: PortalIdentityProvider
  subject: string
  status: PortalIdentityStatus
  verified_at: string | null
  revoked_at: string | null
  revoked_reason: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  customers?: { name: string, customer_no: string } | null
}

/** 宠物访问授权类型 */
export type PortalAccessType = 'owner' | 'family' | 'caregiver'

/** 宠物访问授权权限 */
export type PortalPetPermission = 'view' | 'appointment' | 'report'

/** 宠物访问授权(customer_pet_access) */
export interface PortalPetAccess {
  id: string
  tenant_id: string
  pet_id: string
  customer_id: string
  access_type: PortalAccessType
  permissions: PortalPetPermission[]
  status: PortalIdentityStatus
  granted_by: string | null
  expires_at: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
  pets?: { name: string, species: string } | null
  customers?: { name: string, customer_no: string } | null
}

/** 客户 Consent 类型 */
export type ConsentType = 'privacy' | 'marketing' | 'electronic_report' | 'notification'

/** 客户 Consent(customer_consents,版本化) */
export interface CustomerConsent {
  id: string
  tenant_id: string
  customer_id: string
  consent_type: ConsentType
  version: string
  accepted_at: string
  revoked_at: string | null
  source: 'portal' | 'staff' | 'paper'
  created_at: string
  customers?: { name: string, customer_no: string } | null
}

/** 通知渠道 */
export type PortalChannel = 'sms' | 'email' | 'wechat'

/** 通知场景 */
export type NotificationScene =
  | 'appointment'
  | 'vaccine'
  | 'deworming'
  | 'report_published'
  | 'followup'
  | 'marketing'
  | 'billing'

/** 通知订阅(notification_subscriptions,客户+渠道+场景) */
export interface NotificationSubscription {
  id: string
  tenant_id: string
  customer_id: string
  channel: PortalChannel
  scene: NotificationScene
  enabled: boolean
  destination: string | null
  created_at: string
  updated_at: string
  customers?: { name: string, customer_no: string } | null
}

/** Provider 回调事件状态 */
export type WebhookEventType = 'delivered' | 'failed' | 'bounced' | 'unknown'
export type WebhookEventStatus = 'received' | 'processed' | 'ignored'

/** Provider 回调事件(message_provider_events) */
export interface ProviderWebhookEventRow {
  id: string
  tenant_id: string | null
  provider: string
  provider_event_id: string
  delivery_id: string | null
  provider_message_id: string | null
  event_type: WebhookEventType
  payload_snapshot: Record<string, unknown>
  received_at: string
  processed_at: string | null
  status: WebhookEventStatus
  created_at: string
}

/** 消息通道配置状态摘要(不含 Secret) */
export interface ProviderChannelStatus {
  channel: 'sms' | 'email' | 'wechat' | 'work_wechat'
  provider: string
  configured: boolean
}

// ===== C 端会话(供 H5/小程序等 C 端页面消费,本 Admin 工程仅保留类型) =====

/** Portal 会话身份信息 */
export interface PortalSessionIdentity {
  identityId: string
  tenantId: string
  customerId: string | null
  customer: {
    id: string
    customer_no: string
    name: string
    phone: string | null
    email: string | null
    status: string
  } | null
  provider: PortalIdentityProvider
  subject: string
  status: PortalIdentityStatus
}

// ===== UI 标签映射 =====

export const PORTAL_PROVIDER_LABELS: Record<PortalIdentityProvider, string> = {
  phone: '手机号',
  email: '邮箱',
  wechat: '微信',
}

export const PORTAL_ACCESS_TYPE_LABELS: Record<PortalAccessType, string> = {
  owner: '主人',
  family: '家庭成员',
  caregiver: '看护人',
}

export const CONSENT_TYPE_LABELS: Record<ConsentType, string> = {
  privacy: '隐私政策',
  marketing: '营销信息',
  electronic_report: '电子报告',
  notification: '通知服务',
}

export const PORTAL_CHANNEL_LABELS: Record<PortalChannel, string> = {
  sms: '短信',
  email: '邮件',
  wechat: '微信',
}

export const NOTIFICATION_SCENE_LABELS: Record<NotificationScene, string> = {
  appointment: '预约',
  vaccine: '疫苗',
  deworming: '驱虫',
  report_published: '报告发布',
  followup: '随访',
  marketing: '营销',
  billing: '账单',
}

export const WEBHOOK_EVENT_TYPE_LABELS: Record<WebhookEventType, string> = {
  delivered: '已送达',
  failed: '失败',
  bounced: '退信',
  unknown: '未知',
}

export const WEBHOOK_EVENT_STATUS_LABELS: Record<WebhookEventStatus, string> = {
  received: '已接收',
  processed: '已处理',
  ignored: '已忽略',
}
