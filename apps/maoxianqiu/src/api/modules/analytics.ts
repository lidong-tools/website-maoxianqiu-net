import api from '../index'
import type {
  AnalyticsGroupBy,
  ClinicalReport,
  CustomerReport,
  DashboardReport,
  InventoryReport,
  RevenueDimension,
  RevenueReport,
} from '@/types/analytics'

/**
 * S32-B 经营报表与驾驶舱 领域 API 模块
 *
 * 分层策略:
 *   - 全部为只读聚合查询,走 Hono /api/analytics/*(服务端 requireScopedPermission 收敛数据范围);
 *   - 统一 Query:tenantId / storeId / startAt / endAt / groupBy / dimension;
 *   - 时间语义:startAt/endAt 为业务日期(YYYY-MM-DD),在 Tenant Timezone 内解释;
 *   - storeId 为空 = 全院(需 analytics.view.tenant);带 storeId = 门店(需 analytics.view.store);
 *   - CSV 导出:服务端生成 text/csv + 审计,前端用 fetch 下载(绕过 axios JSON 拦截器)。
 */

export interface AnalyticsQuery {
  tenantId: string
  storeId?: string
  startAt?: string
  endAt?: string
}

export interface RevenueQuery extends AnalyticsQuery {
  groupBy?: AnalyticsGroupBy
  dimension?: RevenueDimension
}

export default {
  /** 驾驶舱 */
  async dashboard(params: AnalyticsQuery) {
    const res = await api.get('analytics/dashboard', { params })
    return res as unknown as { data: DashboardReport }
  },

  /** 收入分析 */
  async revenue(params: RevenueQuery) {
    const res = await api.get('analytics/revenue', { params })
    return res as unknown as { data: RevenueReport }
  },

  /** 客户分析 */
  async customers(params: AnalyticsQuery) {
    const res = await api.get('analytics/customers', { params })
    return res as unknown as { data: CustomerReport }
  },

  /** 医疗运营 */
  async clinical(params: AnalyticsQuery) {
    const res = await api.get('analytics/clinical', { params })
    return res as unknown as { data: ClinicalReport }
  },

  /** 库存分析 */
  async inventory(params: AnalyticsQuery) {
    const res = await api.get('analytics/inventory', { params })
    return res as unknown as { data: InventoryReport }
  },

  /**
   * 导出 CSV(权限 + 审计由服务端保证)
   * 直接 fetch 下载,避免 axios responseType 拦截器干扰。
   */
  async exportCsv(params: RevenueQuery & { report: string }) {
    const accountStore = useAppAccountStore()
    const tenantStore = useAppTenantStore()
    const qs = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') {
        qs.set(k, String(v))
      }
    })
    const base = api.defaults.baseURL ?? ''
    const url = `${base.replace(/\/$/, '')}/analytics/export?${qs.toString()}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accountStore.token}`,
        Token: accountStore.token,
        'X-Tenant-Id': tenantStore.currentTenantId,
        'X-Store-Id': tenantStore.currentStoreId,
      },
    })
    if (!res.ok) {
      throw new Error('导出失败,请检查权限后重试')
    }
    const blob = await res.blob()
    const disposition = res.headers.get('Content-Disposition') ?? ''
    const match = /filename="?([^";]+)"?/.exec(disposition)
    const filename = match?.[1] ?? `analytics-export-${Date.now()}.csv`
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    a.click()
    URL.revokeObjectURL(objectUrl)
  },
}
