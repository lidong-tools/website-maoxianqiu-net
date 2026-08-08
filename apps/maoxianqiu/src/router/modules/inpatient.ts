import type { RouteRecordRaw } from 'vue-router'

/**
 * Inpatient 住院管理领域路由(MXQ-11001~11009)
 *
 * 菜单结构:
 *   /inpatient/dashboard  房态看板(MXQ-11002)
 *   /inpatient/admission  入院登记(MXQ-11003)
 *   /inpatient/nursing    护理管理(MXQ-11004)
 *   /inpatient/handover   班次交接(MXQ-11005)
 *
 * 权限:
 *   - dashboard 须 inpatient.view
 *   - admission 须 inpatient.admit
 *   - nursing 须 nursing.view
 *   - handover 须 handover.manage
 */
const routes: RouteRecordRaw[] = [
  {
    // 房态看板(MXQ-11002)
    path: '/inpatient/dashboard',
    name: 'inpatientDashboard',
    component: () => import('@/views/inpatient/dashboard/index.vue'),
    meta: {
      title: '房态看板',
      icon: 'i-ri:hotel-bed-line',
      auth: 'inpatient.view',
    },
  },
  {
    // 入院登记(MXQ-11003)
    path: '/inpatient/admission',
    name: 'inpatientAdmission',
    component: () => import('@/views/inpatient/admission/index.vue'),
    meta: {
      title: '入院登记',
      icon: 'i-ri:login-box-line',
      auth: 'inpatient.admit',
    },
  },
  {
    // 护理管理(MXQ-11004)
    path: '/inpatient/nursing',
    name: 'inpatientNursing',
    component: () => import('@/views/inpatient/nursing/index.vue'),
    meta: {
      title: '护理管理',
      icon: 'i-ri:first-aid-kit-line',
      auth: 'nursing.view',
    },
  },
  {
    // 班次交接(MXQ-11005)
    path: '/inpatient/handover',
    name: 'inpatientHandover',
    component: () => import('@/views/inpatient/handover/index.vue'),
    meta: {
      title: '班次交接',
      icon: 'i-ri:exchange-line',
      auth: 'handover.manage',
    },
  },
  {
    // 病程记录(S3.1-C 住院闭环)
    path: '/inpatient/progress-notes',
    name: 'inpatientProgressNotes',
    component: () => import('@/views/inpatient/progress-notes/index.vue'),
    meta: {
      title: '病程记录',
      icon: 'i-ri:file-text-line',
      auth: 'progress.view',
    },
  },
  {
    // 出院结算(S3.1-C 结算闭环)
    path: '/inpatient/settlement',
    name: 'inpatientSettlement',
    component: () => import('@/views/inpatient/settlement/index.vue'),
    meta: {
      title: '出院结算',
      icon: 'i-ri:price-tag-3-line',
      auth: 'settlement.view',
    },
  },
  {
    // 寄养(S3.1 Agent-06)
    path: '/inpatient/boarding',
    name: 'inpatientBoarding',
    component: () => import('@/views/inpatient/boarding/index.vue'),
    meta: {
      title: '寄养管理',
      icon: 'i-ri:paw-print-line',
      auth: 'boarding.view',
    },
  },
]

export default routes
