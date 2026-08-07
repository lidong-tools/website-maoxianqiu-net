import type { RouteRecordRaw } from 'vue-router'

/**
 * Billing 领域路由(MXQ-8001~8007)
 * 子页面按操作权限控制按钮显隐
 *
 * 状态机:
 *   发票:  draft → confirmed → paid → refunded
 *          draft → cancelled
 *          confirmed → partially_paid → paid
 */
const routes: RouteRecordRaw[] = [
  {
    // 发票列表(收银台)
    path: '/billing/invoices',
    name: 'billingInvoices',
    component: () => import('@/views/billing/index.vue'),
    meta: {
      title: '发票列表',
      icon: 'i-ri:bill-line',
      auth: 'invoice.view',
    },
  },
  {
    // 收银工作台
    path: '/billing/cashier',
    name: 'billingCashier',
    component: () => import('@/views/billing/cashier/index.vue'),
    meta: {
      title: '快速收银',
      icon: 'i-ri:wallet-3-line',
      auth: 'invoice.create',
    },
  },
]

export default routes
