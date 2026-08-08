import type { RouteRecordRaw } from 'vue-router'

// CRM 客户关系管理(MXQ-5001~5010)
const routes: RouteRecordRaw[] = [
  {
    // 回访任务(S3.1-AGENT-04)
    path: '/crm/followups',
    name: 'crmFollowups',
    component: () => import('@/views/crm/followups/index.vue'),
    meta: {
      title: '回访任务',
      icon: 'i-lucide:phone-call',
      auth: 'followup.view',
    },
  },
  {
    // 客户管理
    path: '/crm/customer',
    name: 'crmCustomer',
    component: () => import('@/views/crm/customer/index.vue'),
    meta: {
      title: '客户管理',
      icon: 'i-ic:round-people',
      auth: 'customer.view',
    },
  },
  {
    // 客户详情(含新建/编辑,不在菜单显示,从客户管理进入)
    path: '/crm/customer/:id',
    name: 'crmCustomerDetail',
    component: () => import('@/views/crm/customer/detail.vue'),
    meta: {
      title: '客户详情',
      breadcrumb: true,
      menu: false,
      activeMenu: '/crm/customer',
      auth: 'customer.view',
    },
  },
  {
    // 宠物详情(不在菜单显示,从客户详情进入)
    path: '/crm/pet/:id',
    name: 'crmPet',
    component: () => import('@/views/crm/pet/detail.vue'),
    meta: {
      title: '宠物详情',
      breadcrumb: true,
      menu: false,
      auth: 'pet.view',
    },
  },
]

export default routes
