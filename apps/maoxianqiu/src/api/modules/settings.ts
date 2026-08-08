import api from '../index'

/**
 * 系统设置 API 模块(CORE-06)
 * - 通用配置(system_settings):走 Hono Command,支持门店覆盖 → 租户默认 → 系统默认继承
 * - 医院信息 / 门店营业:走 Hono Command
 * - 支付 / 打印 / 字典:P0-12 起统一走 Hono Command + 审计,浏览器不再直连写
 */

export interface EffectiveSettingItem {
  namespace: string
  key: string
  label: string
  type: 'percent' | 'number' | 'days' | 'bool'
  value: unknown
  source: 'store' | 'tenant' | 'system'
}

export default {
  /**
   * 生效配置合并(门店覆盖 → 租户默认 → 系统默认)
   */
  async getEffectiveSettings(tenantId: string, storeId?: string, namespace = 'business') {
    const res = await api.get<{ items: EffectiveSettingItem[] }>('settings/effective', {
      params: { tenantId, storeId: storeId || undefined, namespace },
    })
    return (res as any).data
  },

  /**
   * 原始配置记录列表
   */
  async listSettings(tenantId: string, opts?: { storeId?: string, namespace?: string }) {
    const res = await api.get<{ list: any[], total: number }>('settings', {
      params: { tenantId, ...(opts?.storeId ? { storeId: opts.storeId } : {}), ...(opts?.namespace ? { namespace: opts.namespace } : {}) },
    })
    return (res as any).data
  },

  /**
   * 写入配置(storeId 有值=门店覆盖,否则租户默认)
   */
  async saveSetting(params: { tenantId: string, storeId?: string, namespace: string, key: string, value: unknown }) {
    const res = await api.put(`settings/${params.namespace}/${params.key}`, {
      tenantId: params.tenantId,
      storeId: params.storeId,
      value: params.value,
    })
    return (res as any).data
  },

  /**
   * 删除门店覆盖,恢复继承租户默认
   */
  async removeOverride(tenantId: string, storeId: string, namespace: string, key: string) {
    const res = await api.delete(`settings/${namespace}/${key}/override`, {
      params: { tenantId, storeId },
    })
    return (res as any).data
  },

  /**
   * 医院信息(tenants 查询)
   */
  async getTenant(id: string) {
    const res = await api.get<Record<string, unknown>>(`tenants/${id}`)
    return (res as any).data
  },

  /**
   * 医院信息(tenants 更新)
   */
  updateTenant(id: string, patch: { name?: string, shortName?: string, timezone?: string, currency?: string, locale?: string }) {
    return api.patch(`tenants/${id}`, patch)
  },

  /**
   * 门店营业设置(timezone/business_hours)
   */
  updateStoreSettings(id: string, patch: { timezone?: string, businessHours?: Record<string, unknown> }) {
    return api.patch(`stores/${id}/settings`, patch)
  },

  // ===== 支付(P0-12:走 Hono Command + 审计) =====
  async listPaymentContexts(tenantId: string, storeId: string) {
    const res = await api.get<{ list: any[] }>('settings/payment-contexts', { params: { tenantId, storeId } })
    return ((res as any).data?.list) ?? []
  },

  async savePaymentContext(row: { id?: string, tenant_id: string, store_id: string, method: string, label: string, is_default?: boolean, is_active?: boolean }) {
    const res = await api.put('settings/payment-contexts', {
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      method: row.method,
      label: row.label,
      isDefault: row.is_default ?? false,
      isActive: row.is_active ?? true,
    })
    return (res as any).data
  },

  async deletePaymentContext(id: string, tenantId: string, storeId: string) {
    const res = await api.delete(`settings/payment-contexts/${id}`, { params: { tenantId, storeId } })
    return (res as any).data
  },

  // ===== 打印(P0-12:走 Hono Command + 审计) =====
  async listPrintSettings(tenantId: string, storeId: string) {
    const res = await api.get<{ list: any[] }>('settings/print-settings', { params: { tenantId, storeId } })
    return ((res as any).data?.list) ?? []
  },

  async savePrintSetting(row: { id?: string, tenant_id: string, store_id: string, paper_size: string, label: string, is_default?: boolean, is_active?: boolean }) {
    const res = await api.put('settings/print-settings', {
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      paperSize: row.paper_size,
      label: row.label,
      isDefault: row.is_default ?? false,
      isActive: row.is_active ?? true,
    })
    return (res as any).data
  },

  async deletePrintSetting(id: string, tenantId: string, storeId: string) {
    const res = await api.delete(`settings/print-settings/${id}`, { params: { tenantId, storeId } })
    return (res as any).data
  },

  // ===== 字典(P0-12:走 Hono Command + 审计) =====
  async listDictionary(tenantId: string, category: string) {
    const res = await api.get<{ list: any[] }>('settings/dictionaries', { params: { tenantId, category } })
    return ((res as any).data?.list) ?? []
  },

  async saveDictionaryItem(row: { id?: string, tenant_id: string, category: string, code: string, label: string, sort_order?: number, is_active?: boolean }) {
    const res = await api.put('settings/dictionaries', {
      id: row.id,
      tenantId: row.tenant_id,
      category: row.category,
      code: row.code,
      label: row.label,
      sortOrder: row.sort_order ?? 0,
      isActive: row.is_active ?? true,
    })
    return (res as any).data
  },

  async deleteDictionaryItem(id: string, tenantId: string) {
    const res = await api.delete(`settings/dictionaries/${id}`, { params: { tenantId } })
    return (res as any).data
  },
}
