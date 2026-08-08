import { expect, test } from '@playwright/test'
import { loginViaUI, requireCredentials } from '../helpers/auth'

/**
 * 登录页渲染与登录流程 E2E 测试
 * - 登录页渲染:不依赖任何凭据,验证登录页各元素正常展示
 * - 登录流程:使用真实 Supabase 凭据(E2E_USERNAME / E2E_PASSWORD)完成登录,
 *   凭据未配置时自动跳过
 */
test.describe('登录页', () => {
  test('登录页渲染:展示欢迎语、账号密码表单与登录按钮', async ({ page }) => {
    // 访问登录页(hash 路由)
    await page.goto('/#/login', { waitUntil: 'domcontentloaded' })

    // 欢迎语与产品标题(maoxianqiu 登录组件已移除登录方式切换 tab)
    await expect(page.getByText('欢迎使用').first()).toBeVisible()
    await expect(page.getByText('毛线球').first()).toBeVisible()

    // 账号密码输入框(FaInput 包装层与内部 input 均带 placeholder,须用 role 精确匹配)
    await expect(page.getByRole('textbox', { name: '用户名' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '密码' })).toBeVisible()

    // 登录按钮
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible()
  })

  test('登录流程:使用 Supabase 凭据登录并进入工作台', async ({ page }) => {
    // 获取必需凭据:未经 E2E_OPTIONAL=true 时缺失将报错而非静默跳过
    const credentials = requireCredentials()
    test.skip(!credentials, '未配置 E2E_USERNAME / E2E_PASSWORD 且未设置 E2E_OPTIONAL=true')

    // 通过 UI 完成登录
    await loginViaUI(page, credentials!.account, credentials!.password)

    // 登录成功:URL 跳转到首页(hash 路由 #/),主导航侧边栏渲染
    await expect(page).toHaveURL(/\/#\/$/)
    await expect(page.locator('.main-sidebar-container')).toBeVisible()
  })
})
