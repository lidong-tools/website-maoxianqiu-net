import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

const routes: RouteRecordRaw[] = [
  {
    path: '/system/user',
    component: Layout,
    name: 'systemUser',
    meta: {
      title: '用户管理',
      icon: 'i-ic:round-group',
      auth: 'system:user:manage',
    },
  },
  {
    path: '/system/role',
    component: Layout,
    name: 'systemRole',
    meta: {
      title: '角色管理',
      icon: 'i-ic:round-settings',
      auth: 'system:role:manage',
    },
  },
  {
    path: '/system/store',
    component: Layout,
    name: 'systemStore',
    meta: {
      title: '店铺管理',
      icon: 'i-ic:round-store',
      auth: 'system:store:manage',
    },
  },
]

export default routes
