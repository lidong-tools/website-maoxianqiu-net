import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

/**
 * Inpatient 住院管理领域路由(MXQ-11001~11009)
 *
 * 菜单结构:
 *   /inpatient/dashboard  房态看板(MXQ-11002)
 *   /inpatient/admission  入院登记(MXQ-11003)
 *   /inpatient/nursing    护理管理(MXQ-11004)
 *   /inpatient/handover   交接班(MXQ-11005)
 *
 * 权限:
 *   - 父级菜单须 inpatient.view
 *   - admission 须 inpatient.admit
 *   - nursing 须 nursing.view
 *   - handover 须 handover.manage
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/inpatient',
    component: Layout,
    name: 'inpatient',
    meta: {
      title: '住院管理',
      icon: 'i-ri:hotel-bed-line',
      auth: 'inpatient.view',
    },
    children: [
      {
        // 房态看板(MXQ-11002)
        path: 'dashboard',
        name: 'inpatientDashboard',
        component: () => import('@/views/inpatient/dashboard/index.vue'),
        meta: {
          title: '房态看板',
          auth: 'inpatient.view',
        },
      },
      {
        // 入院登记(MXQ-11003)
        path: 'admission',
        name: 'inpatientAdmission',
        component: () => import('@/views/inpatient/admission/index.vue'),
        meta: {
          title: '入院登记',
          auth: 'inpatient.admit',
        },
      },
      {
        // 护理管理(MXQ-11004)
        path: 'nursing',
        name: 'inpatientNursing',
        component: () => import('@/views/inpatient/nursing/index.vue'),
        meta: {
          title: '护理管理',
          auth: 'nursing.view',
        },
      },
      {
        // 交接班(MXQ-11005)
        path: 'handover',
        name: 'inpatientHandover',
        component: () => import('@/views/inpatient/handover/index.vue'),
        meta: {
          title: '交接班',
          auth: 'handover.manage',
        },
      },
    ],
  },
]

export default routes
