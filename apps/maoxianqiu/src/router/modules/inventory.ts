import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

/**
 * Inventory 领域路由(MXQ-9001~9008)
 * 父级菜单须 inventory.view 权限;子页面按操作权限控制按钮显隐
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/inventory',
    component: Layout,
    name: 'inventory',
    meta: {
      title: '库存管理',
      icon: 'i-ri:archive-line',
      auth: 'inventory.view',
    },
    children: [
      {
        path: 'dashboard',
        name: 'inventoryDashboard',
        component: () => import('@/views/inventory/dashboard.vue'),
        meta: {
          title: '库存概览',
        },
      },
      {
        path: 'receipt',
        name: 'inventoryReceipt',
        component: () => import('@/views/inventory/receipt/index.vue'),
        meta: {
          title: '入库',
          auth: 'inventory.receive',
        },
      },
      {
        path: 'count',
        name: 'inventoryCount',
        component: () => import('@/views/inventory/count/index.vue'),
        meta: {
          title: '盘点',
          auth: 'inventory.count',
        },
      },
      {
        path: 'transfer',
        name: 'inventoryTransfer',
        component: () => import('@/views/inventory/transfer/index.vue'),
        meta: {
          title: '调拨',
          auth: 'inventory.transfer',
        },
      },
    ],
  },
]

export default routes
