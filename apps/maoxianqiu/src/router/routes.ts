import type { RouteRecordMainRaw } from '@fantastic-admin/types'
import type { RouteRecordRaw } from 'vue-router'
import pinia from '@/store'
// 注意:example 路由模块(modules/*.example.ts)与 views/*_example 源码保留作为组件参考,
// 但不再注册进生产动态路由。禁止删除参考源码。
import AnalyticsModule from './modules/analytics'
import BillingModule from './modules/billing'
import CatalogModule from './modules/catalog'
import ClinicalModule from './modules/clinical'
import ClosingModule from './modules/closing'
import CrmModule from './modules/crm'
import DiagnosticsModule from './modules/diagnostics'
import InpatientModule from './modules/inpatient'
import InventoryModule from './modules/inventory'
import OperationsModule from './modules/operations'
import RegulatoryModule from './modules/regulatory'
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
    // 找回密码回调页:邮件链接回跳后在此设置新密码
    path: '/auth/reset-password',
    name: 'authResetPassword',
    component: () => import('@/views/auth/reset-password.vue'),
    meta: {
      title: '重置密码',
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
      title: '客户宠物',
      shortTitle: '客户',
      icon: 'i-carbon:user-multiple',
    },
    children: [
      ...CrmModule,
    ],
  },
  {
    meta: {
      title: '目录价目',
      shortTitle: '目录',
      icon: 'i-carbon:catalog',
    },
    children: [
      ...CatalogModule,
    ],
  },
  {
    meta: {
      title: '库存管理',
      shortTitle: '库存',
      icon: 'i-carbon:inventory-management',
    },
    children: [
      ...InventoryModule,
    ],
  },
  {
    meta: {
      title: '收费收银',
      shortTitle: '收费',
      icon: 'i-carbon:finance',
    },
    children: [
      ...BillingModule,
    ],
  },
  {
    meta: {
      title: '诊疗核心',
      shortTitle: '诊疗',
      icon: 'i-carbon:stethoscope',
    },
    children: [
      ...ClinicalModule,
    ],
  },
  {
    meta: {
      title: '住院管理',
      shortTitle: '住院',
      icon: 'i-carbon:hotel',
    },
    children: [
      ...InpatientModule,
    ],
  },
  {
    meta: {
      title: '疫苗检验',
      shortTitle: '疫苗',
      icon: 'i-carbon:data-vis-3',
    },
    children: [
      ...DiagnosticsModule,
    ],
  },
  {
    meta: {
      title: '运营管理',
      shortTitle: '运营',
      icon: 'i-carbon:operations-record',
    },
    children: [
      ...OperationsModule,
    ],
  },
  {
    meta: {
      title: '经营分析',
      shortTitle: '分析',
      icon: 'i-carbon:chart-multitype',
    },
    children: [
      ...AnalyticsModule,
    ],
  },
  {
    meta: {
      title: '监管运营',
      shortTitle: '监管',
      icon: 'i-carbon:rule',
    },
    children: [
      ...RegulatoryModule,
    ],
  },
  {
    meta: {
      title: '日结对账',
      shortTitle: '日结',
      icon: 'i-carbon:receipt',
    },
    children: [
      ...ClosingModule,
    ],
  },
  {
    meta: {
      title: '系统管理',
      shortTitle: '系统',
      icon: 'i-carbon:settings',
    },
    children: [
      ...SystemModule,
    ],
  },
]

export {
  asyncRoutes,
  constantRoutes,
  systemRoutes,
}
