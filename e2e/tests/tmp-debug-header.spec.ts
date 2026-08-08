/**
 * 临时调试(最终需删除):工作台页头 DOM 精确 dump
 * 运行:node ../node_modules/@playwright/test/cli.js test tmp-debug-header.spec.ts --reporter=line
 */
import { expect, test } from '@playwright/test'

const ACCOUNT = 'support@maoxianqiu.app'
const PASSWORD = 'Support@20001223'

test('debug workbench header', async ({ page }) => {
  const logs: string[] = []
  page.on('console', msg => logs.push(`[console:${msg.type()}] ${msg.text().slice(0, 300)}`))
  page.on('pageerror', err => logs.push(`[pageerror] ${err.message.slice(0, 500)}`))

  await page.goto('/#/login', { waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: '用户名' }).waitFor({ state: 'visible' })
  await page.getByRole('textbox', { name: '用户名' }).fill(ACCOUNT)
  await page.getByRole('textbox', { name: '密码' }).fill(PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(/\/#\/$/, { timeout: 30_000 })
  await expect(page.getByText('今日预约').first()).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1500)

  // 工作台 dump
  const info = await page.evaluate(() => {
    const apptEl = Array.from(document.querySelectorAll('*')).find(el => el.children.length === 0 && el.textContent?.trim() === '今日预约')
    let workbenchRootHTML = '(none)'
    if (apptEl) {
      const root = apptEl.parentElement?.parentElement?.parentElement?.parentElement?.parentElement
      if (root) workbenchRootHTML = root.innerHTML.slice(0, 1200)
    }
    return {
      customElements: Array.from(document.querySelectorAll('entity-page-header, fa-page-header, entity-summary-header')).map(el => el.tagName),
      hasPageHeaderText: Array.from(document.querySelectorAll('*')).some(el => el.textContent?.includes('毛线球宠物医院管理系统')),
      workbenchRootHTML,
    }
  })
  console.log('workbench:', JSON.stringify(info, null, 1))

  // 客户列表页 dump(对比:同为 EntityPageHeader compact)
  await page.goto('/#/crm/customer', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const cust = await page.evaluate(() => {
    const mb4 = document.querySelector('.mb-4')
    return {
      hasMb4: !!mb4,
      mb4HTML: mb4?.outerHTML?.slice(0, 800) ?? '(none)',
      customElements: Array.from(document.querySelectorAll('entity-page-header, fa-page-header')).map(el => el.tagName),
    }
  })
  console.log('customer page:', JSON.stringify(cust, null, 1))
  console.log('console logs:', logs.join('\n'))
})
