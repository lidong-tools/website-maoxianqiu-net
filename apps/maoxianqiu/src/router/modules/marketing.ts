import type { RouteRecordRaw } from 'vue-router'

/**
 * Marketing 营销增长路由(Stage-04 Agent-05):优惠券 / 套餐次卡 / 营销活动
 *
 * 菜单结构:
 *   /marketing/coupons    优惠券(marketing.view)
 *   /marketing/packages   套餐次卡(marketing.view)
 *   /marketing/campaigns  营销活动(marketing.view)
 *
 * 集成说明:本模块由 Agent-09 展开到 routes.ts 的新顶级菜单"营销增长" children,
 * 并在 MENU 注册点追加 permissions 声明。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/marketing/coupons',
    name: 'marketingCoupons',
    component: () => import('@/views/marketing/coupons/index.vue'),
    meta: {
      title: '优惠券',
      icon: 'i-ri:ticket-2-line',
      auth: 'marketing.view',
    },
  },
  {
    path: '/marketing/packages',
    name: 'marketingPackages',
    component: () => import('@/views/marketing/packages/index.vue'),
    meta: {
      title: '套餐次卡',
      icon: 'i-ri:coupon-3-line',
      auth: 'marketing.view',
    },
  },
  {
    path: '/marketing/campaigns',
    name: 'marketingCampaigns',
    component: () => import('@/views/marketing/campaigns/index.vue'),
    meta: {
      title: '营销活动',
      icon: 'i-ri:megaphone-line',
      auth: 'marketing.view',
    },
  },
]

export default routes
