import type { RouteRecordRaw } from 'vue-router'

/**
 * 客户门户管理路由(Agent-08)
 *
 * 菜单:
 *   /portal/admin  客户门户管理(身份 / 宠物访问授权 / Consent / 通知订阅 / Webhook 事件)
 *
 * 权限:portal.identity.view(主菜单);各 Tab 内的写操作由服务端按
 * portal.identity.manage / portal.pet.access.manage 独立校验,前端按钮不重复隐藏。
 *
 * 注:本模块注册入口在 src/router/routes.ts(共享冻结文件),由 Final Integrator 集成。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/portal/admin',
    name: 'portalAdmin',
    component: () => import('@/views/portal/index.vue'),
    meta: {
      title: '客户门户管理',
      icon: 'i-ri:customer-service-2-line',
      auth: 'portal.identity.view',
    },
  },
]

export default routes
