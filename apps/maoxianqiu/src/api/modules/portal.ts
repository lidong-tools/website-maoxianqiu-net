import type {
  CustomerConsent,
  NotificationSubscription,
  PortalChannel,
  PortalIdentity,
  PortalIdentityProvider,
  PortalPetAccess,
  PortalPetPermission,
  ProviderChannelStatus,
  ProviderWebhookEventRow,
} from '@/types/portal'
import api from '../index'

/**
 * 客户门户 Admin API 模块(Agent-08)
 *
 * 仅 Admin 管理端接口(员工 IAM + portal.* 权限码)。
 * C 端接口(/portal/auth、/portal/me 等)供 H5/小程序 C 端工程消费,不在本 Admin 工程暴露。
 */

export default {
  /**
   * 身份列表(按租户)
   */
  async listIdentities(params: { tenantId: string }) {
    return api.get<{ list: PortalIdentity[], total: number }>('portal/admin/identities', { params })
  },

  /**
   * 手动绑定已核实身份
   */
  createIdentity(data: {
    tenantId: string
    customerId: string
    provider: PortalIdentityProvider
    subject: string
  }) {
    return api.post<PortalIdentity>('portal/admin/identities', data)
  },

  /**
   * 停用身份
   */
  revokeIdentity(id: string, data: { tenantId: string, reason?: string }) {
    return api.post<PortalIdentity>(`portal/admin/identities/${id}/revoke`, data)
  },

  /**
   * 宠物访问授权列表
   */
  async listPetAccess(params: {
    tenantId: string
    customerId?: string
    petId?: string
  }) {
    return api.get<{ list: PortalPetAccess[], total: number }>('portal/admin/pet-access', { params })
  },

  /**
   * 授权/更新宠物访问(upsert 按 pet+customer)
   */
  upsertPetAccess(data: {
    tenantId: string
    petId: string
    customerId: string
    accessType: PortalPetAccess['access_type']
    permissions: PortalPetPermission[]
    expiresAt?: string
  }) {
    return api.post<PortalPetAccess>('portal/admin/pet-access', data)
  },

  /**
   * 撤销宠物访问授权
   */
  revokePetAccess(id: string, data: { tenantId: string }) {
    return api.post<PortalPetAccess>(`portal/admin/pet-access/${id}/revoke`, data)
  },

  /**
   * 客户 Consent 列表
   */
  async listConsents(params: {
    tenantId: string
    customerId?: string
    consentType?: string
  }) {
    return api.get<{ list: CustomerConsent[], total: number }>('portal/admin/consents', { params })
  },

  /**
   * 通知订阅列表
   */
  async listSubscriptions(params: {
    tenantId: string
    customerId?: string
  }) {
    return api.get<{ list: NotificationSubscription[], total: number }>('portal/admin/subscriptions', { params })
  },

  /**
   * 消息通道配置状态(不含 Secret)
   */
  async getProviderChannelStatus() {
    return api.get<ProviderChannelStatus[]>('portal/admin/provider-status')
  },

  /**
   * Provider 回调事件列表
   */
  async listWebhookEvents(params: {
    tenantId: string
    status?: string
    provider?: string
  }) {
    return api.get<{ list: ProviderWebhookEventRow[], total: number }>('portal/admin/webhook-events', { params })
  },

  /**
   * C 端会话信息(供管理端调试查看;无权限用户由服务端拒绝)
   * @deprecated C 端会话仅服务端签发,管理端不消费,保留类型兼容
   */
  _sessionSupport: false as const,
}

export type { PortalChannel }
