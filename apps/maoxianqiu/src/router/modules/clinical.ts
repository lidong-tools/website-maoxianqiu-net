import type { RouteRecordRaw } from 'vue-router'

function Layout() {
  return import('@/layouts/index.vue')
}

// Clinical 诊疗核心(MXQ-7001~7011)
const routes: RouteRecordRaw[] = [
  {
    // 医生工作台(MXQ-7004)
    path: '/clinical/workbench',
    component: Layout,
    name: 'clinicalWorkbench',
    meta: {
      title: '医生工作台',
      icon: 'i-ri:stethoscope-line',
      auth: 'encounter.work',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/clinical/workbench/index.vue'),
        meta: {
          title: '医生工作台',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    // 预约管理(MXQ-7001)
    path: '/clinical/appointment',
    component: Layout,
    name: 'clinicalAppointment',
    meta: {
      title: '预约管理',
      icon: 'i-ri:calendar-todo-line',
      auth: 'appointment.view',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/clinical/appointment/index.vue'),
        meta: {
          title: '预约管理',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    // 候诊队列(MXQ-7002)
    path: '/clinical/waiting',
    component: Layout,
    name: 'clinicalWaiting',
    meta: {
      title: '候诊队列',
      icon: 'i-ri:hourglass-line',
      auth: 'appointment.view',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/clinical/waiting/index.vue'),
        meta: {
          title: '候诊队列',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    // 病历详情(MXQ-7003/7005,不在菜单显示,从工作台/列表进入)
    path: '/clinical/encounter',
    component: Layout,
    name: 'clinicalEncounter',
    meta: {
      title: '病历详情',
      menu: false,
    },
    children: [
      {
        path: ':id',
        component: () => import('@/views/clinical/encounter/detail.vue'),
        meta: {
          title: '病历详情',
          breadcrumb: true,
          menu: false,
          activeMenu: '/clinical/workbench',
          auth: 'encounter.view',
        },
      },
    ],
  },
  {
    // 护士任务(MXQ-7007)
    path: '/clinical/nurse-tasks',
    component: Layout,
    name: 'clinicalNurseTasks',
    meta: {
      title: '护士任务',
      icon: 'i-ri:task-line',
      auth: 'nurse_task.view',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/clinical/nurse-tasks/index.vue'),
        meta: {
          title: '护士任务',
          breadcrumb: false,
        },
      },
    ],
  },
  {
    // 医嘱管理(S3.1-C 医疗闭环,开立医嘱自动生成护士任务)
    path: '/clinical/medical-orders',
    component: Layout,
    name: 'clinicalMedicalOrders',
    meta: {
      title: '医嘱管理',
      icon: 'i-ri:file-list-3-line',
      auth: 'nurse_task.view',
    },
    children: [
      {
        path: '',
        component: () => import('@/views/clinical/medical-orders/index.vue'),
        meta: {
          title: '医嘱管理',
          breadcrumb: false,
        },
      },
    ],
  },
]

export default routes
