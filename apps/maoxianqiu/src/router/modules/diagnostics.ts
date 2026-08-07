import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

/**
 * Diagnostics 疫苗与检验领域路由(MXQ-10001~10011)
 *
 * 菜单结构:
 *   /diagnostics/vaccination  疫苗接种管理(MXQ-10001~10005)
 *   /diagnostics/lab          检验管理(MXQ-10006~10009)
 *   /diagnostics/reminder     提醒管理(MXQ-10004)
 *
 * 权限:
 *   - 父级菜单须 vaccine.view
 *   - vaccination 须 vaccine.view / vaccine.manage
 *   - lab 须 lab.view / lab.request / lab.result.input / lab.result.review
 *   - reminder 须 diag_reminder.view
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/diagnostics',
    component: Layout,
    name: 'diagnostics',
    meta: {
      title: '疫苗与检验',
      icon: 'i-ri:test-tube-line',
      auth: 'vaccine.view',
    },
    children: [
      {
        // 疫苗接种管理(MXQ-10001~10005)
        path: 'vaccination',
        name: 'diagnosticsVaccination',
        component: () => import('@/views/diagnostics/vaccination/index.vue'),
        meta: {
          title: '疫苗接种',
          auth: 'vaccine.view',
        },
      },
      {
        // 检验管理(MXQ-10006~10009)
        path: 'lab',
        name: 'diagnosticsLab',
        component: () => import('@/views/diagnostics/lab/index.vue'),
        meta: {
          title: '检验管理',
          auth: 'lab.view',
        },
      },
      {
        // 提醒管理(MXQ-10004)
        path: 'reminder',
        name: 'diagnosticsReminder',
        component: () => import('@/views/diagnostics/reminder/index.vue'),
        meta: {
          title: '到期提醒',
          auth: 'diag_reminder.view',
        },
      },
    ],
  },
]

export default routes
