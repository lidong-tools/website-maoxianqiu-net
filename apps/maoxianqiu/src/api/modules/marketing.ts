import api from '../index'

/**
 * Marketing 领域 API 模块(Stage-04 Agent-05)
 *
 * 设计原则:
 *   - 券/套餐核销、发放、发布走 Hono Command + service-role-only RPC(锁 + 幂等)
 *   - 模板 CRUD 走 Hono(服务端 requireScopedPermission + 审计)
 *   - Campaign 只负责 Audience/Offer/Channel,消息发送走 Agent-08 Messaging Contract
 */

/** 优惠券模板 */
export interface Coupon {
  id: string
  tenant_id: string
  code: string
  name: string
  type: 'fixed' | 'percentage'
  value: number
  min_spend: number
  max_discount: number | null
  catalog_type: string | null
  catalog_item_id: string | null
  store_id: string | null
  valid_from: string | null
  valid_until: string | null
  quota: number
  used_count: number
  per_customer_limit: number
  stacking_policy: 'single' | 'stackable'
  is_active: boolean
  created_at: string
}

/** 优惠券发放记录 */
export interface CouponIssue {
  id: string
  tenant_id: string
  coupon_id: string
  customer_id: string
  code: string
  status: 'available' | 'redeemed' | 'expired' | 'cancelled'
  issued_at: string
  expires_at: string | null
  redeemed_at: string | null
  coupons?: Coupon | null
  customers?: { id: string, name: string, phone: string } | null
}

/** 套餐模板 */
export interface ServicePackage {
  id: string
  tenant_id: string
  code: string
  name: string
  description: string | null
  price: number
  validity_days: number | null
  store_id: string | null
  is_active: boolean
  items?: ServicePackageItem[]
}

/** 套餐明细项 */
export interface ServicePackageItem {
  id: string
  package_id: string
  catalog_item_id: string | null
  name: string
  quantity: number
  sort_order: number
}

/** 客户套餐 */
export interface CustomerPackage {
  id: string
  tenant_id: string
  customer_id: string
  package_id: string
  store_id: string | null
  total_quantity: number
  remaining_quantity: number
  valid_from: string
  expires_at: string | null
  status: 'active' | 'expired' | 'refunded' | 'cancelled'
  service_packages?: ServicePackage | null
  customers?: { id: string, name: string, phone: string } | null
}

/** 优惠券创建入参 */
export interface CouponInput {
  tenantId: string
  code: string
  name: string
  type: 'fixed' | 'percentage'
  value: number
  minSpend?: number
  maxDiscount?: number | null
  catalogType?: string | null
  catalogItemId?: string | null
  storeId?: string | null
  validFrom?: string | null
  validUntil?: string | null
  quota?: number
  perCustomerLimit?: number
  stackingPolicy?: 'single' | 'stackable'
  isActive?: boolean
}

/** 套餐创建入参 */
export interface PackageInput {
  tenantId: string
  code: string
  name: string
  description?: string | null
  price?: number
  validityDays?: number | null
  storeId?: string | null
  isActive?: boolean
  items: Array<{ catalogItemId?: string | null, name: string, quantity?: number }>
}

/** 活动创建入参 */
export interface CampaignInput {
  tenantId: string
  code: string
  name: string
  description?: string | null
  type: 'manual' | 'segment' | 'birthday' | 'churn' | 'referral'
  segmentId?: string | null
  storeId?: string | null
  offerType?: 'coupon' | 'package' | 'none' | null
  offerId?: string | null
  channel?: 'sms' | 'email' | 'wechat' | 'work_wechat'
  messageTemplateId?: string | null
  startsAt?: string | null
  endsAt?: string | null
  status?: 'draft' | 'scheduled' | 'published' | 'completed' | 'cancelled'
}

/** 营销活动 */
export interface Campaign {
  id: string
  tenant_id: string
  code: string
  name: string
  description: string | null
  type: 'manual' | 'segment' | 'birthday' | 'churn' | 'referral'
  segment_id: string | null
  store_id: string | null
  offer_type: 'coupon' | 'package' | 'none' | null
  offer_id: string | null
  channel: 'sms' | 'email' | 'wechat' | 'work_wechat'
  message_template_id: string | null
  starts_at: string | null
  ends_at: string | null
  status: 'draft' | 'scheduled' | 'published' | 'completed' | 'cancelled'
  published_at: string | null
  latest_run?: {
    run_no: number
    status: string
    audience_count: number
    completed_at: string | null
  } | null
}

export default {
  // ===== 优惠券 Coupons =====

  /**
   * 优惠券模板列表(走 Hono,marketing.view)
   */
  async listCoupons(params: { tenantId: string, type?: 'fixed' | 'percentage', page?: number, pageSize?: number }) {
    return api.get<{ list: Coupon[], total: number, page: number, pageSize: number }>('marketing/coupons', { params })
  },

  /**
   * 创建优惠券(走 Hono,marketing.manage)
   */
  createCoupon(data: CouponInput) {
    return api.post<Coupon>('marketing/coupons', data)
  },

  /**
   * 更新优惠券(走 Hono,marketing.manage)
   */
  updateCoupon(id: string, data: Partial<CouponInput>) {
    return api.patch<Coupon>(`marketing/coupons/${id}`, data)
  },

  /**
   * 发放优惠券(走 Hono RPC,marketing.adjust_entitlement)
   */
  issueCoupon(id: string, data: { tenantId: string, customerIds: string[] }) {
    return api.post<{ issued: number, issues: Array<{ issue_id: string, code: string, customer_id: string }> }>(
      `marketing/coupons/${id}/issue`,
      data,
    )
  },

  /**
   * 发放记录列表(走 Hono,marketing.view)
   */
  async listCouponIssues(params: {
    tenantId: string
    couponId?: string
    status?: 'available' | 'redeemed' | 'expired' | 'cancelled'
    page?: number
    pageSize?: number
  }) {
    return api.get<{ list: CouponIssue[], total: number, page: number, pageSize: number }>(
      'marketing/coupon-issues',
      { params },
    )
  },

  /**
   * 作废优惠券(走 Hono RPC,marketing.adjust_entitlement)
   */
  cancelCouponIssue(id: string, data: { tenantId: string, reason?: string }) {
    return api.post(`marketing/coupon-issues/${id}/cancel`, data)
  },

  /**
   * 核销优惠券(走 Hono RPC:锁 + 幂等,marketing.adjust_entitlement)
   */
  redeemCouponIssue(id: string, data: {
    tenantId: string
    customerId: string
    storeId: string
    subtotal: number
    invoiceId?: string | null
    idempotencyKey?: string
  }) {
    return api.post<{ redemption_id: string, discount_amount: number, idempotent: boolean }>(
      `marketing/coupon-issues/${id}/redeem`,
      data,
    )
  },

  // ===== 套餐/次卡 Packages =====

  /**
   * 套餐模板列表(走 Hono,marketing.view)
   */
  async listPackages(params: { tenantId: string, isActive?: 'true' | 'false', page?: number, pageSize?: number }) {
    return api.get<{ list: ServicePackage[], total: number, page: number, pageSize: number }>('marketing/packages', { params })
  },

  /**
   * 创建套餐(含明细,走 Hono,marketing.manage)
   */
  createPackage(data: {
    tenantId: string
    code: string
    name: string
    description?: string | null
    price?: number
    validityDays?: number | null
    storeId?: string | null
    isActive?: boolean
    items: Array<{ catalogItemId?: string | null, name: string, quantity?: number }>
  }) {
    return api.post<ServicePackage>('marketing/packages', data)
  },

  /**
   * 更新套餐(走 Hono,marketing.manage;带 items 时整体重写明细)
   */
  updatePackage(id: string, data: Partial<PackageInput>) {
    return api.patch<ServicePackage>(`marketing/packages/${id}`, data)
  },

  /**
   * 客户购卡(走 Hono RPC:幂等开卡,marketing.adjust_entitlement)
   */
  purchasePackage(id: string, data: {
    tenantId: string
    customerId: string
    storeId: string
    invoiceId?: string | null
    idempotencyKey?: string
  }) {
    return api.post<{ customer_package_id: string, total_quantity: number, idempotent: boolean }>(
      `marketing/packages/${id}/purchase`,
      data,
    )
  },

  /**
   * 客户套餐列表(走 Hono,marketing.view)
   */
  async listCustomerPackages(params: {
    tenantId: string
    customerId?: string
    status?: 'active' | 'expired' | 'refunded' | 'cancelled'
    page?: number
    pageSize?: number
  }) {
    return api.get<{ list: CustomerPackage[], total: number, page: number, pageSize: number }>(
      'marketing/customer-packages',
      { params },
    )
  },

  /**
   * 套餐核销(走 Hono RPC:行锁防负 + 幂等,marketing.adjust_entitlement)
   */
  redeemCustomerPackage(id: string, data: {
    tenantId: string
    customerId: string
    storeId: string
    packageItemId: string
    invoiceId?: string | null
    idempotencyKey?: string
  }) {
    return api.post<{ redemption_id: string, remaining_quantity: number, idempotent: boolean }>(
      `marketing/customer-packages/${id}/redeem`,
      data,
    )
  },

  /**
   * 套餐退款(走 Hono RPC:幂等,marketing.adjust_entitlement)
   */
  refundCustomerPackage(id: string, data: { tenantId: string, reason?: string, idempotencyKey?: string }) {
    return api.post(`marketing/customer-packages/${id}/refund`, data)
  },

  /**
   * 核销冲正(恢复次数,走 Hono RPC)
   */
  reversePackageRedemption(id: string, data: { tenantId: string, reason?: string }) {
    return api.post(`marketing/package-redemptions/${id}/reverse`, data)
  },

  // ===== Campaign 营销活动 =====

  /**
   * 活动列表(走 Hono,marketing.view)
   */
  async listCampaigns(params: { tenantId: string, status?: string, page?: number, pageSize?: number }) {
    return api.get<{ list: Campaign[], total: number, page: number, pageSize: number }>('marketing/campaigns', { params })
  },

  /**
   * 创建活动(走 Hono,marketing.manage)
   */
  createCampaign(data: CampaignInput) {
    return api.post<Campaign>('marketing/campaigns', data)
  },

  /**
   * 更新活动(走 Hono,marketing.manage;已发布活动禁止修改)
   */
  updateCampaign(id: string, data: Partial<CampaignInput>) {
    return api.patch<Campaign>(`marketing/campaigns/${id}`, data)
  },

  /**
   * 删除活动(走 Hono,marketing.manage)
   */
  deleteCampaign(id: string) {
    return api.delete(`marketing/campaigns/${id}`)
  },

  /**
   * 发布活动(走 Hono RPC:Snapshot Audience + 建 Run,marketing.publish)
   */
  publishCampaign(id: string, data: { tenantId: string, customerIds?: string[] }) {
    return api.post<{ run_id: string, run_no: number, campaign_id: string, audience_count: number, rule_version: string }>(
      `marketing/campaigns/${id}/publish`,
      data,
    )
  },

  /**
   * 活动 Audience 预览(走 Hono,marketing.view)
   */
  async campaignAudiencePreview(id: string, params: { tenantId: string, page?: number, pageSize?: number }) {
    return api.get<{ list: any[], total: number, page: number, pageSize: number, campaign: any }>(
      `marketing/campaigns/${id}/audience-preview`,
      { params },
    )
  },

  /**
   * 活动运行记录(走 Hono,marketing.view)
   */
  async campaignRuns(id: string, params: { tenantId: string }) {
    return api.get<{ list: any[] }>(`marketing/campaigns/${id}/runs`, { params })
  },

  // ===== Referral 推荐 =====

  /**
   * 生成推荐码(走 Hono RPC)
   */
  generateReferralCode(data: { tenantId: string, customerId: string }) {
    return api.post<{ referral_code_id: string, code: string }>('marketing/referral-codes', data)
  },

  /**
   * 登记推荐关系(走 Hono RPC)
   */
  registerReferral(data: { tenantId: string, code: string, refereeCustomerId: string }) {
    return api.post<{ referral_code_id: string, code: string, status: string }>('marketing/referral-events', data)
  },
}
