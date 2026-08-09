import type { RouteRecordRaw } from 'vue-router'

/**
 * Inventory 领域路由(MXQ-9001~9008)
 * 子页面按操作权限控制按钮显隐
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/inventory/dashboard',
    name: 'inventoryDashboard',
    component: () => import('@/views/inventory/dashboard.vue'),
    meta: {
      title: '库存概览',
      icon: 'i-ri:dashboard-line',
      auth: 'inventory.view',
    },
  },
  {
    path: '/inventory/receipt',
    name: 'inventoryReceipt',
    component: () => import('@/views/inventory/receipt/index.vue'),
    meta: {
      title: '入库管理',
      icon: 'i-ri:inbox-archive-line',
      auth: 'inventory.receive',
    },
  },
  {
    path: '/inventory/count',
    name: 'inventoryCount',
    component: () => import('@/views/inventory/count/index.vue'),
    meta: {
      title: '盘点管理',
      icon: 'i-ri:list-check-2',
      auth: 'inventory.count',
    },
  },
  {
    path: '/inventory/transfer',
    name: 'inventoryTransfer',
    component: () => import('@/views/inventory/transfer/index.vue'),
    meta: {
      title: '调拨管理',
      icon: 'i-ri:shuffle-line',
      auth: 'inventory.transfer',
    },
  },
  {
    path: '/inventory/suppliers',
    name: 'inventorySuppliers',
    component: () => import('@/views/inventory/suppliers/index.vue'),
    meta: {
      title: '供应商管理',
      icon: 'i-ri:building-2-line',
      auth: 'supplier.view',
    },
  },
  {
    path: '/inventory/purchasing',
    name: 'inventoryPurchasing',
    component: () => import('@/views/inventory/purchasing/index.vue'),
    meta: {
      title: '采购管理',
      icon: 'i-ri:shopping-bag-3-line',
      auth: 'purchase.view',
    },
  },
  {
    path: '/inventory/purchase-requests',
    name: 'inventoryPurchaseRequests',
    component: () => import('@/views/inventory/purchase-requests/index.vue'),
    meta: {
      title: '采购申请',
      icon: 'i-ri:file-list-3-line',
      auth: 'purchase_request.view',
    },
  },
  {
    path: '/inventory/purchase-returns',
    name: 'inventoryPurchaseReturns',
    component: () => import('@/views/inventory/purchase-returns/index.vue'),
    meta: {
      title: '采购退货',
      icon: 'i-ri:file-upload-line',
      auth: 'purchase_return.view',
    },
  },
]

export default routes
