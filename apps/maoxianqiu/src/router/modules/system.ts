import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

// 系统管理(真实功能);父级 Layout + 子路由加载真实 view,避免只加载 Layout 壳
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
    children: [
      {
        path: '',
        component: () => import('@/views/system/user/index.vue'),
        meta: {
          title: '用户管理',
          breadcrumb: false,
        },
      },
    ],
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
    children: [
      {
        path: '',
        component: () => import('@/views/system/role/index.vue'),
        meta: {
          title: '角色管理',
          breadcrumb: false,
        },
      },
    ],
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
    children: [
      {
        path: '',
        component: () => import('@/views/system/store/index.vue'),
        meta: {
          title: '店铺管理',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    path: '/system/veterinarian-registration',
    component: Layout,
    name: 'systemVeterinarianRegistration',
    meta: {
      title: '执业兽医备案',
      icon: 'i-ic:round-medical-services',
      auth: 'veterinarian_registration.read',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/system/veterinarian-registration/index.vue'),
        meta: {
          title: '执业兽医备案',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    // UI Foundation 业务组件演示页(Story,隐藏菜单,仅内部验证用)
    path: '/system/component-demo',
    component: Layout,
    name: 'systemComponentDemo',
    meta: {
      title: '业务组件演示',
      menu: false,
    },
    children: [
      {
        path: '',
        component: () => import('@/views/dev/component-demo.vue'),
        meta: {
          title: '业务组件演示',
          breadcrumb: false,
        },
      },
    ],
  },
]

export default routes
