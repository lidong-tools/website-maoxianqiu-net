import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

/**
 * Billing 领域路由(MXQ-8001~8007)
 * 父级菜单须 invoice.view 权限;子页面按操作权限控制按钮显隐
 *
 * 状态机:
 *   发票:  draft → confirmed → paid → refunded
 *          draft → cancelled
 *          confirmed → partially_paid → paid
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/billing',
    component: Layout,
    name: 'billing',
    meta: {
      title: '收费收银',
      icon: 'i-ri:bank-card-line',
      auth: 'invoice.view',
    },
    children: [
      {
        // 发票列表(收银台)
        path: 'invoices',
        name: 'billingInvoices',
        component: () => import('@/views/billing/index.vue'),
        meta: {
          title: '发票列表',
          auth: 'invoice.view',
        },
      },
      {
        // 收银工作台
        path: 'cashier',
        name: 'billingCashier',
        component: () => import('@/views/billing/cashier/index.vue'),
        meta: {
          title: '收银工作台',
          auth: 'invoice.create',
        },
      },
    ],
  },
]

export default routes
