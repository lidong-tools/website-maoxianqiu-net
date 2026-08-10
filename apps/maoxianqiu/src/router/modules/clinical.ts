import type { RouteRecordRaw } from 'vue-router'

// Clinical 诊疗核心(MXQ-7001~7011)
const routes: RouteRecordRaw[] = [
  {
    path: '/workbenches/:role',
    name: 'roleWorkbench',
    component: () => import('@/views/workbenches/index.vue'),
    meta: {
      title: '岗位工作台',
      icon: 'i-ri:dashboard-3-line',
      keepAlive: true,
    },
  },
  {
    path: '/clinical/waiting-display',
    name: 'clinicalWaitingDisplay',
    component: () => import('@/views/clinical/waiting-display/index.vue'),
    meta: {
      title: '候诊叫号大屏',
      menu: false,
      breadcrumb: false,
      activeMenu: '/clinical/waiting',
      auth: 'queue.call',
    },
  },
  {
    // 医生工作台(MXQ-7004)
    path: '/clinical/workbench',
    name: 'clinicalWorkbench',
    component: () => import('@/views/clinical/workbench/index.vue'),
    meta: {
      title: '医生工作',
      icon: 'i-ri:stethoscope-line',
      auth: 'encounter.work',
    },
  },
  {
    // 预约管理(MXQ-7001)
    path: '/clinical/appointment',
    name: 'clinicalAppointment',
    component: () => import('@/views/clinical/appointment/index.vue'),
    meta: {
      title: '预约管理',
      icon: 'i-ri:calendar-todo-line',
      auth: 'appointment.view',
    },
  },
  {
    // 候诊队列(MXQ-7002)
    path: '/clinical/waiting',
    name: 'clinicalWaiting',
    component: () => import('@/views/clinical/waiting/index.vue'),
    meta: {
      title: '候诊队列',
      icon: 'i-ri:hourglass-line',
      auth: 'appointment.view',
    },
  },
  {
    // 病历详情(MXQ-7003/7005,不在菜单显示,从工作台/列表进入)
    path: '/clinical/encounter/:id',
    name: 'clinicalEncounter',
    component: () => import('@/views/clinical/encounter/detail.vue'),
    meta: {
      title: '病历详情',
      breadcrumb: true,
      menu: false,
      activeMenu: '/clinical/workbench',
      auth: 'encounter.view',
    },
  },
  {
    // 护士任务(MXQ-7007)
    path: '/clinical/nurse-tasks',
    name: 'clinicalNurseTasks',
    component: () => import('@/views/clinical/nurse-tasks/index.vue'),
    meta: {
      title: '护士任务',
      icon: 'i-ri:task-line',
      auth: 'nurse_task.view',
    },
  },
  {
    // 医嘱管理(S3.1-C 医疗闭环,开立医嘱自动生成护士任务)
    path: '/clinical/medical-orders',
    name: 'clinicalMedicalOrders',
    component: () => import('@/views/clinical/medical-orders/index.vue'),
    meta: {
      title: '医嘱管理',
      icon: 'i-ri:file-list-3-line',
      auth: 'nurse_task.view',
    },
  },
]

export default routes
