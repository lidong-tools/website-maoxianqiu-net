import type { RouteRecordRaw } from 'vue-router'

/**
 * Stage-04 Agent-06 — 保险理赔 / 文档归档 路由
 *
 * 菜单结构:
 *   /operations/insurance   保险理赔中心(理赔包 → 材料清单 → 生成 PDF → 导出历史)
 *   /operations/archives    文档归档中心(PDF 归档 / 下载 / 签名生命周期)
 *
 * 权限:
 *   - insurance 权限码:insurance.view(菜单)/ insurance.generate(生成)
 *   - archives 权限码:documents.archive.view
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/operations/insurance',
    name: 'operationsInsurance',
    component: () => import('@/views/operations/insurance/index.vue'),
    meta: {
      title: '保险理赔',
      icon: 'i-ri:umbrella-line',
      auth: 'insurance.view',
    },
  },
  {
    path: '/operations/archives',
    name: 'operationsArchives',
    component: () => import('@/views/operations/archives/index.vue'),
    meta: {
      title: '文档归档',
      icon: 'i-ri:archive-line',
      auth: 'documents.archive.view',
    },
  },
]

export default routes
