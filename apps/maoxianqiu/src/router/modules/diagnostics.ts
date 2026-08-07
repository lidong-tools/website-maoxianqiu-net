import type { RouteRecordRaw } from 'vue-router'

/**
 * Diagnostics 疫苗与检验领域路由(MXQ-10001~10011)
 *
 * 菜单结构:
 *   /diagnostics/vaccination  疫苗接种管理(MXQ-10001~10005)
 *   /diagnostics/lab          检验管理(MXQ-10006~10009)
 *   /diagnostics/reminder     到期提醒(MXQ-10004)
 *
 * 权限:
 *   - vaccination 须 vaccine.view / vaccine.manage
 *   - lab 须 lab.view / lab.request / lab.result.input / lab.result.review
 *   - reminder 须 diag_reminder.view
 */
const routes: RouteRecordRaw[] = [
  {
    // 疫苗接种管理(MXQ-10001~10005)
    path: '/diagnostics/vaccination',
    name: 'diagnosticsVaccination',
    component: () => import('@/views/diagnostics/vaccination/index.vue'),
    meta: {
      title: '疫苗接种',
      icon: 'i-ri:syringe-line',
      auth: 'vaccine.view',
    },
  },
  {
    // 检验管理(MXQ-10006~10009)
    path: '/diagnostics/lab',
    name: 'diagnosticsLab',
    component: () => import('@/views/diagnostics/lab/index.vue'),
    meta: {
      title: '检验管理',
      icon: 'i-ri:test-tube-line',
      auth: 'lab.view',
    },
  },
  {
    // 到期提醒(MXQ-10004)
    path: '/diagnostics/reminder',
    name: 'diagnosticsReminder',
    component: () => import('@/views/diagnostics/reminder/index.vue'),
    meta: {
      title: '到期提醒',
      icon: 'i-ri:alarm-line',
      auth: 'diag_reminder.view',
    },
  },
  {
    // 标本流转(S3.1-C 标本闭环)
    path: '/diagnostics/lab-samples',
    name: 'diagnosticsLabSamples',
    component: () => import('@/views/diagnostics/lab-samples/index.vue'),
    meta: {
      title: '标本流转',
      icon: 'i-ri:exchange-funds-line',
      auth: 'lab.view',
    },
  },
  {
    // 危急值管理(S3.1-C 危急值闭环)
    path: '/diagnostics/critical-values',
    name: 'diagnosticsCriticalValues',
    component: () => import('@/views/diagnostics/critical-values/index.vue'),
    meta: {
      title: '危急告警',
      icon: 'i-ri:error-warning-line',
      auth: 'lab.view',
    },
  },
]

export default routes
