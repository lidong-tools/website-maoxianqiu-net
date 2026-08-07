import type { RouteRecordRaw } from 'vue-router'

// 监管运营(S3.1-PARALLEL-01)
// 菜单可见性以各只读权限码控制(auth),写操作按钮由 PermissionButton 按权限码控制
const routes: RouteRecordRaw[] = [
  {
    path: '/regulatory/license',
    name: 'regulatoryLicense',
    component: () => import('@/views/regulatory/license/index.vue'),
    meta: {
      title: '诊疗许可',
      icon: 'i-ic:round-verified-user',
      auth: 'license.read',
    },
  },
  {
    path: '/regulatory/annual-report',
    name: 'regulatoryAnnualReport',
    component: () => import('@/views/regulatory/annual-report/index.vue'),
    meta: {
      title: '年度报告',
      icon: 'i-ic:round-assignment',
      auth: 'regulatory_report.read',
    },
  },
  {
    path: '/regulatory/epidemic',
    name: 'regulatoryEpidemic',
    component: () => import('@/views/regulatory/epidemic/index.vue'),
    meta: {
      title: '疫情台账',
      icon: 'i-ic:round-warning',
      auth: 'epidemic.read',
    },
  },
  {
    path: '/regulatory/medical-waste',
    name: 'regulatoryMedicalWaste',
    component: () => import('@/views/regulatory/medical-waste/index.vue'),
    meta: {
      title: '医疗废物',
      icon: 'i-ic:round-recycling',
      auth: 'waste.read',
    },
  },
]

export default routes
