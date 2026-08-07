import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

// CRM 客户关系管理(MXQ-5001~5010)
const routes: RouteRecordRaw[] = [
  {
    // 客户管理
    path: '/crm/customer',
    component: Layout,
    name: 'crmCustomer',
    meta: {
      title: '客户管理',
      icon: 'i-ic:round-people',
      auth: 'customer.view',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/crm/customer/index.vue'),
        meta: {
          title: '客户管理',
          breadcrumb: false,
        },
      },
      {
        // 客户详情(含新建/编辑)
        path: ':id',
        component: () => import('@/views/crm/customer/detail.vue'),
        meta: {
          title: '客户详情',
          breadcrumb: true,
          menu: false,
          activeMenu: '/crm/customer',
        },
      },
    ],
  },
  {
    // 宠物详情(不在菜单显示,从客户详情进入)
    path: '/crm/pet',
    component: Layout,
    name: 'crmPet',
    meta: {
      title: '宠物详情',
      menu: false,
    },
    children: [
      {
        path: ':id',
        component: () => import('@/views/crm/pet/detail.vue'),
        meta: {
          title: '宠物详情',
          breadcrumb: true,
          menu: false,
          auth: 'pet.view',
        },
      },
    ],
  },
]

export default routes
