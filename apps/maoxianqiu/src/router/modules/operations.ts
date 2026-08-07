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
 *
 * 权限:
 *   - imports 权限码:imports.manage
 *   - print 权限码:print.manage
 *   - reports 权限码:reports.view
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
]

export default routes
