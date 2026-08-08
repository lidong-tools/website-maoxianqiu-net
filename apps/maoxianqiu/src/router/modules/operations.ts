import type { RouteRecordRaw } from 'vue-router'

/**
 * Operations 运营管理路由(MXQ-12001~12009)
 *
 * 菜单结构:
 *   /operations/imports   导入中心
 *   /operations/print     打印中心
 *   /operations/reports   报表中心
 *   /operations/message/templates  消息模板
 *   /operations/message/deliveries 投递记录
 *
 * 权限:
 *   - imports 权限码:imports.manage
 *   - print 权限码:print.manage
 *   - reports 权限码:reports.view
 *   - message 权限码:message.manage
 */
const routes: RouteRecordRaw[] = [
  {
    // CORE-05:审批中心(折扣 + 病历修订统一待办)
    path: '/operations/approvals',
    name: 'operationsApprovals',
    component: () => import('@/views/operations/approvals/index.vue'),
    meta: {
      title: '审批中心',
      icon: 'i-ri:file-shield-2-line',
      auth: 'approval.inbox.view',
    },
  },
  {
    path: '/operations/imports',
    name: 'operationsImports',
    component: () => import('@/views/operations/imports/index.vue'),
    meta: {
      title: '导入中心',
      icon: 'i-ri:upload-2-line',
      auth: 'imports.manage',
    },
  },
  {
    path: '/operations/print',
    name: 'operationsPrint',
    component: () => import('@/views/operations/print/index.vue'),
    meta: {
      title: '打印中心',
      icon: 'i-ri:printer-line',
      auth: 'print.manage',
    },
  },
  {
    path: '/operations/reports',
    name: 'operationsReports',
    component: () => import('@/views/operations/reports/index.vue'),
    meta: {
      title: '报表中心',
      icon: 'i-ri:bar-chart-2-line',
      auth: 'reports.view',
    },
  },
  {
    path: '/operations/message/templates',
    name: 'operationsMessageTemplates',
    component: () => import('@/views/operations/message/templates.vue'),
    meta: {
      title: '消息模板',
      icon: 'i-ri:file-copy-line',
      auth: 'message.manage',
    },
  },
  {
    path: '/operations/message/deliveries',
    name: 'operationsMessageDeliveries',
    component: () => import('@/views/operations/message/deliveries.vue'),
    meta: {
      title: '投递记录',
      icon: 'i-ri:mail-send-line',
      auth: 'message.manage',
    },
  },
]

export default routes
