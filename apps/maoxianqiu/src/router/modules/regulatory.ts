import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

// 监管运营(S3.1-PARALLEL-01);父级 Layout + 子路由加载真实 view
// 菜单可见性以各只读权限码控制(auth),写操作按钮由 PermissionButton 按权限码控制
const routes: RouteRecordRaw[] = [
  {
    path: '/regulatory/license',
    component: Layout,
    name: 'regulatoryLicense',
    meta: {
      title: '动物诊疗许可证',
      icon: 'i-ic:round-verified-user',
      auth: 'license.read',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/regulatory/license/index.vue'),
        meta: {
          title: '动物诊疗许可证',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    path: '/regulatory/annual-report',
    component: Layout,
    name: 'regulatoryAnnualReport',
    meta: {
      title: '年度诊疗活动报告',
      icon: 'i-ic:round-assignment',
      auth: 'regulatory_report.read',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/regulatory/annual-report/index.vue'),
        meta: {
          title: '年度诊疗活动报告',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    path: '/regulatory/epidemic',
    component: Layout,
    name: 'regulatoryEpidemic',
    meta: {
      title: '疫情事件台账',
      icon: 'i-ic:round-warning',
      auth: 'epidemic.read',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/regulatory/epidemic/index.vue'),
        meta: {
          title: '疫情事件台账',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    path: '/regulatory/medical-waste',
    component: Layout,
    name: 'regulatoryMedicalWaste',
    meta: {
      title: '医疗废弃物台账',
      icon: 'i-ic:round-recycling',
      auth: 'waste.read',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/regulatory/medical-waste/index.vue'),
        meta: {
          title: '医疗废弃物台账',
          breadcrumb: false,
        },
      },
    ],
  },
]

export default routes
