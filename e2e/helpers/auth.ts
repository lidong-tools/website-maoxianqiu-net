import type { Page } from '@playwright/test'
import process from 'node:process'

// 是否在 E2E_OPTIONAL 模式下(显式设置才允许跳过,默认必须失败)
function isOptional(): boolean {
  return process.env.E2E_OPTIONAL === 'true'
}

/**
 * 从环境变量读取真实 Supabase 登录凭据。
 * @returns 凭据对象;未配置时返回 undefined
 */
export function getCredentials(): { account: string, password: string } | undefined {
  const account = process.env.E2E_USERNAME
  const password = process.env.E2E_PASSWORD
  if (account && password) {
    return { account, password }
  }
  return undefined
}

/**
 * 获取必需的 Supabase 登录凭据。未设置 E2E_OPTIONAL=true 时凭据缺失将抛出错误,
 * 仅 E2E_OPTIONAL=true 时返回 undefined 允许调用方 skip。
 * @returns 凭据对象;E2E_OPTIONAL 模式下无凭据时返回 undefined
 */
export function requireCredentials(): { account: string, password: string } | undefined {
  const creds = getCredentials()
  if (creds) {
    return creds
  }
  if (isOptional()) {
    return undefined
  }
  throw new Error(
    '缺少 E2E_USERNAME / E2E_PASSWORD 环境变量,核心 E2E 测试必须执行。'
    + '请设置环境变量或设置 E2E_OPTIONAL=true 显式跳过需登录的测试。',
  )
}

/**
 * 通过 UI 完成 Supabase 账号密码登录。
 * 应用采用 hash 路由,登录成功后跳转到首页 `/#/`,随后出现主导航侧边栏。
 * @param page Playwright 页面实例
 * @param account 登录账号(邮箱)
 * @param password 登录密码
 */
export async function loginViaUI(page: Page, account: string, password: string): Promise<void> {
  // 访问登录页(hash 路由)
  await page.goto('/#/login', { waitUntil: 'domcontentloaded' })

  // 等待登录表单渲染完成(FaInput 包装层与内部 input 均带 placeholder,须用 role 精确匹配)
  const accountInput = page.getByRole('textbox', { name: '用户名' })
  const passwordInput = page.getByRole('textbox', { name: '密码' })
  await accountInput.waitFor({ state: 'visible' })

  // 填写账号密码并提交
  await accountInput.fill(account)
  await passwordInput.fill(password)
  await page.getByRole('button', { name: '登录' }).click()

  // 等待路由跳转到首页(hash 路由下为 `/#/`)
  await page.waitForURL(/\/#\/$/, { timeout: 30_000 })

  // 等待主导航侧边栏渲染,确保动态路由与菜单已生成
  await page.locator('.main-sidebar-container').waitFor({ state: 'visible', timeout: 15_000 })
}

/**
 * 统一的登录入口。默认模式下凭据缺失将抛出错误;
 * 仅 E2E_OPTIONAL=true 且无凭据时返回 false 供调用方 skip。
 * @param page Playwright 页面实例
 * @returns 是否成功建立登录态(true 表示已登录)
 */
export async function ensureLogin(page: Page): Promise<boolean> {
  const credentials = requireCredentials()
  if (!credentials) {
    return false
  }
  await loginViaUI(page, credentials.account, credentials.password)
  return true
}
