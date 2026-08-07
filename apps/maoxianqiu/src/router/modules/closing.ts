import type { RouteRecordRaw } from 'vue-router'

// 日结对账(S31-并发任务B:Daily Closing + Reconciliation)
const routes: RouteRecordRaw[] = [
  {
    // 每日日结(关账/快照/调整)
    path: '/closing',
    name: 'dailyClosing',
    component: () => import('@/views/billing/closing/index.vue'),
    meta: {
      title: '每日日结',
      icon: 'i-carbon:financial',
      auth: 'daily_closing.read',
    },
  },
  {
    // 渠道对账(录入实际金额/差异确认)
    path: '/reconciliation',
    name: 'channelReconciliation',
    component: () => import('@/views/billing/reconciliation/index.vue'),
    meta: {
      title: '渠道对账',
      icon: 'i-carbon:data-check',
      auth: 'reconciliation.read',
    },
  },
]

export default routes
