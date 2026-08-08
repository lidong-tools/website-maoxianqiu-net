import { expect, test } from '@playwright/test'
import { ensureLogin } from '../helpers/auth'

/**
 * 核心页面可达性冒烟测试
 * - 前置条件:需要已登录状态(依赖真实 Supabase 凭据 E2E_USERNAME / E2E_PASSWORD,
 *   未配置时整组跳过)
 * - 覆盖内容:主导航菜单渲染 + 客户宠物(CRM)/ 目录价目(Catalog)/ 收费收银(Billing)
 *   三个业务模块的页面可达性
 */
test.describe('核心页面冒烟测试', () => {
  // 每个用例前建立登录态;凭据缺失时跳过
  test.beforeEach(async ({ page }) => {
    const loggedIn = await ensureLogin(page)
    test.skip(!loggedIn, '未配置 E2E_USERNAME / E2E_PASSWORD,跳过冒烟测试')
  })

  test('主导航菜单渲染:业务模块入口齐全', async ({ page }) => {
    // 主导航侧边栏容器(菜单以 meta.shortTitle 简称渲染,见 MainSidebar/mainMenuTitle)
    const mainSidebar = page.locator('.main-sidebar-container')

    // 断言业务模块菜单项可见(与 src/router/routes.ts 的 asyncRoutes 对齐,精确匹配短标题)
    const moduleTitles = [
      '客户',
      '目录',
      '库存',
      '收费',
      '诊疗',
      '住院',
      '疫苗',
      '运营',
      '监管',
      '日结',
      '系统',
    ]
    for (const title of moduleTitles) {
      await expect(mainSidebar.getByText(title, { exact: true }).first()).toBeVisible()
    }
  })

  test('客户宠物(CRM):客户列表页可达', async ({ page }) => {
    // 直接导航到客户管理页(hash 路由)
    await page.goto('/#/crm/customer', { waitUntil: 'domcontentloaded' })

    // 断言路由与页面标题
    await expect(page).toHaveURL(/\/#\/crm\/customer/)
    await expect(page.getByText('客户管理').first()).toBeVisible()
  })

  test('目录价目(Catalog):目录管理页可达', async ({ page }) => {
    // 直接导航到目录管理页
    await page.goto('/#/catalog', { waitUntil: 'domcontentloaded' })

    // 断言路由与页面标题
    await expect(page).toHaveURL(/\/#\/catalog/)
    await expect(page.getByText('目录管理').first()).toBeVisible()
  })

  test('收费收银(Billing):发票列表页可达', async ({ page }) => {
    // 直接导航到发票列表页
    await page.goto('/#/billing/invoices', { waitUntil: 'domcontentloaded' })

    // 断言路由与页面标题
    await expect(page).toHaveURL(/\/#\/billing\/invoices/)
    await expect(page.getByText('发票列表').first()).toBeVisible()
  })

  test('收费收银(Billing):收银工作台可达', async ({ page }) => {
    // 直接导航到收银工作台
    await page.goto('/#/billing/cashier', { waitUntil: 'domcontentloaded' })

    // 断言路由与页面标题
    await expect(page).toHaveURL(/\/#\/billing\/cashier/)
    await expect(page.getByText('快速收银').first()).toBeVisible()
  })
})
