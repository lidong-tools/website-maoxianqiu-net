import type { RouteRecordRaw } from 'vue-router'

// Medication Safety 用药安全(Stage-04 Agent-04)
// 注:本模块文件由 Agent-04 创建,需由 Agent-09 集成到 router/routes.ts(INTEGRATION_REQUESTS)
const routes: RouteRecordRaw[] = [
  {
    // 用药安全规则/药品档案/相互作用管理
    path: '/clinical/medication-safety',
    name: 'medicationSafety',
    component: () => import('@/views/clinical/medication-safety/index.vue'),
    meta: {
      title: '用药安全',
      icon: 'i-ri:shield-check-line',
      auth: 'medication_safety.view',
    },
  },
]

export default routes
