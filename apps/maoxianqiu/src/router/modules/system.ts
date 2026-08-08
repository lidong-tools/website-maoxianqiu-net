import type { RouteRecordRaw } from 'vue-router'

// 系统管理(真实功能)
const routes: RouteRecordRaw[] = [
  {
    path: '/system/user',
    name: 'systemUser',
    component: () => import('@/views/system/user/index.vue'),
    meta: {
      title: '用户管理',
      icon: 'i-ic:round-group',
      auth: 'system:user:manage',
    },
  },
  {
    path: '/system/role',
    name: 'systemRole',
    component: () => import('@/views/system/role/index.vue'),
    meta: {
      title: '角色管理',
      icon: 'i-ic:round-settings',
      auth: 'system:role:manage',
    },
  },
  {
    path: '/system/store',
    name: 'systemStore',
    component: () => import('@/views/system/store/index.vue'),
    meta: {
      title: '店铺管理',
      icon: 'i-ic:round-store',
      auth: 'system:store:manage',
    },
  },
  {
    path: '/system/veterinarian-registration',
    name: 'systemVeterinarianRegistration',
    component: () => import('@/views/system/veterinarian-registration/index.vue'),
    meta: {
      title: '兽医备案',
      icon: 'i-ic:round-medical-services',
      auth: 'veterinarian_registration.read',
    },
  },
  {
    // S3.1-A:租户初始化(新建医院一键可营业)
    path: '/system/tenant-init',
    name: 'systemTenantInit',
    component: () => import('@/views/system/tenant-init/index.vue'),
    meta: {
      title: '新建医院',
      icon: 'i-ic:round-rocket-launch',
      auth: 'tenant.initialize',
    },
  },
  {
    // CORE-04:审计与安全(审计日志 + 安全事件)
    path: '/system/audit',
    name: 'systemAudit',
    component: () => import('@/views/system/audit/index.vue'),
    meta: {
      title: '审计与安全',
      icon: 'i-ic:round-manage-search',
      auth: 'audit.view',
    },
  },
  {
    // CORE-06:系统设置(医院信息/门店营业/业务规则/支付/打印/字典)
    path: '/system/settings',
    name: 'systemSettings',
    component: () => import('@/views/system/settings/index.vue'),
    meta: {
      title: '系统设置',
      icon: 'i-ic:round-tune',
      auth: ['settings.tenant.read', 'settings.store.read'],
    },
  },
  {
    // UI Foundation 业务组件演示页(Story,隐藏菜单,仅内部验证用)
    path: '/system/component-demo',
    name: 'systemComponentDemo',
    component: () => import('@/views/dev/component-demo.vue'),
    meta: {
      title: '业务组件演示',
      menu: false,
    },
  },
]

export default routes
