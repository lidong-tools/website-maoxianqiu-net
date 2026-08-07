import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

/**
 * Operations 运营管理路由(MXQ-12001~12009)
 *
 * 菜单结构:
 *   /operations/imports   导入中心
 *   /operations/print     打印中心
 *   /operations/reports   报表中心
 *   /operations/message   消息管理
 *     /templates           消息模板管理
 *     /deliveries          消息投递记录
 *
 * 权限:
 *   - imports 权限码:imports.manage
 *   - print 权限码:print.manage
 *   - reports 权限码:reports.view
 *   - message 权限码:message.manage
 *   - 父级菜单 visibleByQuery 权限:operations.*
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/operations/imports',
    component: Layout,
    name: 'operationsImports',
    meta: {
      title: '导入中心',
      icon: 'i-ri:upload-2-line',
      auth: 'imports.manage',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/operations/imports/index.vue'),
        meta: {
          title: '导入中心',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    path: '/operations/print',
    component: Layout,
    name: 'operationsPrint',
    meta: {
      title: '打印中心',
      icon: 'i-ri:printer-line',
      auth: 'print.manage',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/operations/print/index.vue'),
        meta: {
          title: '打印中心',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    path: '/operations/reports',
    component: Layout,
    name: 'operationsReports',
    meta: {
      title: '报表中心',
      icon: 'i-ri:bar-chart-2-line',
      auth: 'reports.view',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/operations/reports/index.vue'),
        meta: {
          title: '报表中心',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    path: '/operations/message',
    component: Layout,
    name: 'operationsMessage',
    meta: {
      title: '消息管理',
      icon: 'i-ri:message-2-line',
      auth: 'message.manage',
    },
    children: [
      {
        path: 'templates',
        name: 'operationsMessageTemplates',
        component: () => import('@/views/operations/message/templates.vue'),
        meta: {
          title: '消息模板管理',
          breadcrumb: false,
        },
      },
      {
        path: 'deliveries',
        name: 'operationsMessageDeliveries',
        component: () => import('@/views/operations/message/deliveries.vue'),
        meta: {
          title: '消息投递记录',
          breadcrumb: false,
        },
      },
    ],
  },
]

export default routes
