import { expect, test } from '@playwright/test'
import { ensureLogin } from '../helpers/auth'
import { ensureChromium } from '../helpers/browser'

// 浏览器内核缺失时,除非 E2E_OPTIONAL=true,否则失败(保证核心测试必须执行)
test.skip(!ensureChromium(), 'Chromium 浏览器未安装且未设置 E2E_OPTIONAL=true')

/**
 * 核心业务流程 E2E 测试
 * - 前置条件:真实 Supabase 凭据(E2E_USERNAME / E2E_PASSWORD),未配置时整组跳过
 * - 覆盖内容:登录后工作台关键元素 / CRM 客户列表数据行渲染 /
 *   Billing 发票列表冒烟 / 创建客户到列表回显的完整闭环
 */
test.describe('核心业务流程', () => {
  // 每个用例前建立登录态;凭据缺失时跳过
  test.beforeEach(async ({ page }) => {
    const loggedIn = await ensureLogin(page)
    test.skip(!loggedIn, '未配置 E2E_USERNAME / E2E_PASSWORD,跳过核心业务流程测试')
  })

  test('登录成功后工作台展示关键元素', async ({ page }) => {
    // ensureLogin 已保证登录成功并停留在首页(hash 路由 /#/)
    await expect(page).toHaveURL(/\/#\/$/)

    // 工作台页面标题
    await expect(page.getByText('工作台').first()).toBeVisible()
    // 欢迎语
    await expect(page.getByText('欢迎使用毛线球')).toBeVisible()
    // 工作台指标卡片分组
    await expect(page.getByText('今日经营指标')).toBeVisible()
    await expect(page.getByText('快捷操作')).toBeVisible()
  })

  test('CRM 客户列表页表格渲染出数据行', async ({ page }) => {
    // 直接导航到客户管理列表页(hash 路由)
    await page.goto('/#/crm/customer', { waitUntil: 'domcontentloaded' })

    // 断言路由与页面标题
    await expect(page).toHaveURL(/\/#\/crm\/customer/)
    await expect(page.getByText('客户管理').first()).toBeVisible()

    // 表格表头渲染(客户编号/姓名列)
    await expect(page.getByText('客户编号').first()).toBeVisible()
    await expect(page.getByText('姓名').first()).toBeVisible()

    // 等待数据加载完成并渲染出数据行(测试租户含 seed 初始化数据)
    const firstRow = page.locator('table tbody tr').first()
    await expect(firstRow).toBeVisible()
  })

  test('Billing 发票列表页冒烟', async ({ page }) => {
    // 直接导航到发票列表页(hash 路由)
    await page.goto('/#/billing/invoices', { waitUntil: 'domcontentloaded' })

    // 断言路由与页面标题
    await expect(page).toHaveURL(/\/#\/billing\/invoices/)
    await expect(page.getByText('发票列表').first()).toBeVisible()

    // 发票表格表头渲染(发票号/应收列)
    await expect(page.getByText('发票号').first()).toBeVisible()
    await expect(page.getByText('应收').first()).toBeVisible()

    // 表格容器渲染完成(数据可为空,空态不阻塞冒烟)
    await expect(page.locator('table')).toBeVisible()
  })

  test('端到端:创建客户后列表出现该客户', async ({ page }) => {
    // 使用时间戳生成唯一客户名,避免与历史数据冲突
    const customerName = `E2E客户-${Date.now()}`

    // 进入新增客户页(hash 路由 /crm/customer/new 复用详情页新建模式)
    await page.goto('/#/crm/customer/new', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('新增客户').first()).toBeVisible()

    // 填写必填字段「客户姓名」并提交
    await page.getByPlaceholder('请输入姓名').fill(customerName)
    await page.getByRole('button', { name: '保存' }).click()

    // 保存成功跳转客户详情页,详情展示新客户姓名
    await page.waitForURL(/\/#\/crm\/customer\/[^/]+$/, { timeout: 30_000 })
    await expect(page.getByText(customerName).first()).toBeVisible()

    // 返回客户列表,按姓名关键词搜索
    await page.goto('/#/crm/customer', { waitUntil: 'domcontentloaded' })
    const keywordInput = page.getByPlaceholder('姓名/手机号/编号')
    await keywordInput.fill(customerName)
    // 输入框回车触发列表查询
    await keywordInput.press('Enter')

    // 列表渲染出刚创建的客户
    await expect(page.locator('table tbody').getByText(customerName).first()).toBeVisible()
  })
})
