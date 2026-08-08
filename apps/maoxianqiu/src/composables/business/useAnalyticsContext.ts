import dayjs from 'dayjs'
import type { AnalyticsQuery } from '@/api/modules/analytics'

/**
 * S32-B 经营报表 页面共享上下文
 *
 * 遵循 S32-B 规格 §10(Authorization vs Context):
 *   - 默认 = 当前门店(currentStoreId);
 *   - 仅当用户拥有 analytics.view.tenant 且主动打开"全院"开关才汇总全部门店;
 *   - 切店时自动关闭全院,避免混入旧门店范围。
 *
 * 时间(§11):startAt/endAt 为业务日期 YYYY-MM-DD,服务端在 Tenant Timezone 内解释。
 */

export interface AnalyticsContext {
  tenantId: string
  currentStoreId: string
  canViewTenant: boolean
  allStores: boolean
  startAt: string
  endAt: string
  /** 实际传给 API 的查询参数(全院时 storeId 为空) */
  params: AnalyticsQuery
  ready: boolean
}

export function useAnalyticsContext() {
  const appTenantStore = useAppTenantStore()

  const tenantId = computed(() => appTenantStore.currentTenantId)
  const currentStoreId = computed(() => appTenantStore.currentStoreId)
  const canViewTenant = computed(() =>
    appTenantStore.effectivePermissions.includes('analytics.view.tenant'),
  )

  const allStores = ref(false)
  const startAt = ref(dayjs().startOf('month').format('YYYY-MM-DD'))
  const endAt = ref(dayjs().format('YYYY-MM-DD'))

  const storeId = computed(() => (allStores.value ? undefined : currentStoreId.value || undefined))

  const params = computed<AnalyticsQuery>(() => ({
    tenantId: tenantId.value,
    storeId: storeId.value,
    startAt: startAt.value,
    endAt: endAt.value,
  }))

  // 切店自动关闭全院
  watch(currentStoreId, () => {
    allStores.value = false
  })

  return {
    tenantId,
    currentStoreId,
    canViewTenant,
    allStores,
    startAt,
    endAt,
    storeId,
    params,
    ready: appTenantStore.isReady,
  }
}

export type AnalyticsContextReturn = ReturnType<typeof useAnalyticsContext>
