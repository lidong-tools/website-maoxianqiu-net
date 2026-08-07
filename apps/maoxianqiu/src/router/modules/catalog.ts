import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

/**
 * Catalog 目录管理路由(MXQ-6006)
 * - /catalog:目录管理(类目树 + 项目列表 + 门店价格覆盖)
 * - meta.auth: catalog.view
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/catalog',
    component: Layout,
    name: 'catalog',
    meta: {
      title: '目录管理',
      icon: 'i-ic:round-category',
      auth: 'catalog.view',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/catalog/index.vue'),
        meta: {
          title: '目录管理',
          breadcrumb: false,
        },
      },
    ],
  },
]

export default routes
