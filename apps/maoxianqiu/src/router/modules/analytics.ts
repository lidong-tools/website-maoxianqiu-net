import type { RouteRecordRaw } from 'vue-router'

/**
 * 经营报表与驾驶舱(S32-B)
 *
 * 菜单结构:
 *   /analytics/dashboard   经营驾驶舱
 *   /analytics/revenue     收入分析
 *   /analytics/customers   客户分析
 *   /analytics/clinical    医疗运营
 *   /analytics/inventory   库存分析
 *
 * 权限:
 *   - 门店报表(带 storeId):analytics.view.store
 *   - 全院报表(不带 storeId):analytics.view.tenant
 *   - CSV 导出:analytics.export(服务端另行校验)
 * 菜单统一用 analytics.view.store;全院模式在页面内按 analytics.view.tenant 显隐。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/analytics/dashboard',
    name: 'analyticsDashboard',
    component: () => import('@/views/analytics/dashboard/index.vue'),
    meta: {
      title: '经营驾驶舱',
      icon: 'i-carbon:dashboard',
      auth: 'analytics.view.store',
    },
  },
  {
    path: '/analytics/revenue',
    name: 'analyticsRevenue',
    component: () => import('@/views/analytics/revenue/index.vue'),
    meta: {
      title: '收入分析',
      icon: 'i-carbon:chart-line',
      auth: 'analytics.view.store',
    },
  },
  {
    path: '/analytics/customers',
    name: 'analyticsCustomers',
    component: () => import('@/views/analytics/customers/index.vue'),
    meta: {
      title: '客户分析',
      icon: 'i-carbon:user-multiple',
      auth: 'analytics.view.store',
    },
  },
  {
    path: '/analytics/clinical',
    name: 'analyticsClinical',
    component: () => import('@/views/analytics/clinical/index.vue'),
    meta: {
      title: '医疗运营',
      icon: 'i-carbon:stethoscope',
      auth: 'analytics.view.store',
    },
  },
  {
    path: '/analytics/inventory',
    name: 'analyticsInventory',
    component: () => import('@/views/analytics/inventory/index.vue'),
    meta: {
      title: '库存分析',
      icon: 'i-carbon:inventory-management',
      auth: 'analytics.view.store',
    },
  },
]

export default routes
