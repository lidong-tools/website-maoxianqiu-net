import type { RouteRecordMainRaw } from '@fantastic-admin/types'
import type { RouteRecordRaw } from 'vue-router'
import pinia from '@/store'
// 注意:example 路由模块(modules/*.example.ts)与 views/*_example 源码保留作为组件参考,
// 但不再注册进生产动态路由。禁止删除参考源码。
import BillingModule from './modules/billing'
import CatalogModule from './modules/catalog'
import ClinicalModule from './modules/clinical'
import CrmModule from './modules/crm'
import DiagnosticsModule from './modules/diagnostics'
import InpatientModule from './modules/inpatient'
import InventoryModule from './modules/inventory'
import OperationsModule from './modules/operations'
import SystemModule from './modules/system'

// 固定路由（默认路由）
const constantRoutes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/login.vue'),
    meta: {
      title: '登录',
    },
  },
  {
    path: '/:all(.*)*',
    name: 'notFound',
    component: () => import('@/views/[...all].vue'),
    meta: {
      title: '找不到页面',
    },
  },
]

// 系统路由
const systemRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('@/layouts/index.vue'),
    meta: {
      breadcrumb: false,
    },
    children: [
      {
        path: '',
        component: () => import('@/views/index.vue'),
        meta: {
          title: useAppSettingsStore(pinia).settings.app.home.title,
          icon: 'i-ant-design:home-twotone',
          breadcrumb: false,
        },
      },
      {
        path: 'reload',
        name: 'reload',
        component: () => import('@/views/reload.vue'),
        meta: {
          title: '重新加载中...',
          breadcrumb: false,
        },
      },
    ],
  },
]

// 动态路由（异步路由、导航菜单路由）
// 仅注册真实生产模块;example 演示模块已在 MXQ-1001 移出生产菜单
const asyncRoutes: RouteRecordMainRaw[] = [
  {
    meta: {
      title: '系统管理',
      icon: 'i-carbon:settings',
    },
    children: [
      ...SystemModule,
    ],
  },
  {
    meta: {
      title: '客户宠物',
      icon: 'i-carbon:user-multiple',
    },
    children: [
      ...CrmModule,
    ],
  },
  {
    meta: {
      title: '目录价目',
      icon: 'i-carbon:catalog',
    },
    children: [
      ...CatalogModule,
    ],
  },
  {
    meta: {
      title: '库存管理',
      icon: 'i-carbon:inventory-management',
    },
    children: [
      ...InventoryModule,
    ],
  },
  {
    meta: {
      title: '收费收银',
      icon: 'i-carbon:finance',
    },
    children: [
      ...BillingModule,
    ],
  },
  {
    meta: {
      title: '诊疗核心',
      icon: 'i-carbon:stethoscope',
    },
    children: [
      ...ClinicalModule,
    ],
  },
  {
    meta: {
      title: '住院管理',
      icon: 'i-carbon:hotel',
    },
    children: [
      ...InpatientModule,
    ],
  },
  {
    meta: {
      title: '疫苗检验',
      icon: 'i-carbon:data-vis-3',
    },
    children: [
      ...DiagnosticsModule,
    ],
  },
  {
    meta: {
      title: '运营管理',
      icon: 'i-carbon:operations-record',
    },
    children: [
      ...OperationsModule,
    ],
  },
]

export {
  asyncRoutes,
  constantRoutes,
  systemRoutes,
}
