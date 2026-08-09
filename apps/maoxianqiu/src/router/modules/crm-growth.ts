import type { RouteRecordRaw } from 'vue-router'

/**
 * CRM 增长路由(Stage-04 Agent-05):客户分层 + 流失预警
 *
 * 菜单结构:
 *   /crm/segments  客户分层(crm.segment.view)
 *   /crm/churn     流失预警(crm.churn.view)
 *
 * 集成说明:本模块由 Agent-09 展开到 routes.ts 的"客户宠物"顶级菜单 children。
 * 注意:路由权限使用 crm.segment.view / crm.churn.view,菜单 auth 与页面接口一致。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/crm/segments',
    name: 'crmSegments',
    component: () => import('@/views/crm/segments/index.vue'),
    meta: {
      title: '客户分层',
      icon: 'i-ri:user-heart-line',
      auth: 'crm.segment.view',
    },
  },
  {
    path: '/crm/churn',
    name: 'crmChurn',
    component: () => import('@/views/crm/churn/index.vue'),
    meta: {
      title: '流失预警',
      icon: 'i-ri:alert-line',
      auth: 'crm.churn.view',
    },
  },
]

export default routes
