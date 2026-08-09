import type { RouteRecordRaw } from 'vue-router'

/**
 * Operations 运营管理路由(MXQ-12001~12009 + S3.2)
 *
 * 菜单结构:
 *   /operations/imports      导入中心 V2(S32-A)
 *   /operations/documents    业务文档中心 V2(S32-C)
 *   /operations/print        打印中心(旧)
 *   /operations/reports      报表中心(旧)
 *   /operations/messaging    消息中心(S32-D,替代旧 message/templates+deliveries)
 *
 * 权限:
 *   - imports 权限码:imports.view/create/execute/cancel(菜单用 imports.manage 兼容)
 *   - documents 权限码:documents.view
 *   - print 权限码:print.manage
 *   - reports 权限码:reports.view
 *   - messaging 权限码:message.manage(细粒度 messaging.* 拆分 deferred)
 */
const routes: RouteRecordRaw[] = [
  {
    // CORE-05:审批中心(折扣 + 病历修订统一待办)
    path: '/operations/approvals',
    name: 'operationsApprovals',
    component: () => import('@/views/operations/approvals/index.vue'),
    meta: {
      title: '审批中心',
      icon: 'i-ri:file-shield-2-line',
      auth: 'approval.inbox.view',
    },
  },
  {
    // S3.1 会员中心(等级/客户会员/积分流水/折扣规则)
    path: '/operations/memberships',
    name: 'operationsMemberships',
    component: () => import('@/views/operations/memberships/index.vue'),
    meta: {
      title: '会员中心',
      icon: 'i-ri:medal-line',
      auth: 'membership.view',
    },
  },
  {
    path: '/operations/imports',
    name: 'operationsImports',
    component: () => import('@/views/operations/imports/index.vue'),
    meta: {
      title: '导入中心',
      icon: 'i-ri:upload-2-line',
      auth: 'imports.manage',
    },
  },
  {
    path: '/operations/documents',
    name: 'operationsDocuments',
    component: () => import('@/views/operations/documents/index.vue'),
    meta: {
      title: '业务文档中心',
      icon: 'i-ri:file-list-line',
      auth: 'documents.view',
    },
  },
  {
    path: '/operations/print',
    name: 'operationsPrint',
    component: () => import('@/views/operations/print/index.vue'),
    meta: {
      title: '打印中心',
      icon: 'i-ri:printer-line',
      auth: 'print.manage',
    },
  },
  {
    path: '/operations/reports',
    name: 'operationsReports',
    component: () => import('@/views/operations/reports/index.vue'),
    meta: {
      title: '报表中心',
      icon: 'i-ri:bar-chart-2-line',
      auth: 'reports.view',
    },
  },
  {
    path: '/operations/messaging',
    name: 'operationsMessaging',
    component: () => import('@/views/operations/messaging/index.vue'),
    meta: {
      title: '消息中心',
      icon: 'i-ri:mail-send-line',
      auth: 'message.manage',
    },
  },
  {
    // Agent-03 Stage-04:储值账户(余额/充值/流水/调整/冻结)
    path: '/operations/wallet',
    name: 'operationsWallet',
    component: () => import('@/views/operations/wallet/index.vue'),
    meta: {
      title: '储值账户',
      icon: 'i-ri:wallet-3-line',
      auth: 'wallet.view',
    },
  },
]

export default routes
