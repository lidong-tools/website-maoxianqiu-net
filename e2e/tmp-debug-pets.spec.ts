/**
 * 临时调试脚本:复现 closed-loop-a 客户详情页宠物不可见问题
 * 步骤:UI 登录 → 打开客户详情页 → 打印 supabase 会话/请求/宠物 DOM/控制台错误
 * 运行:node ../node_modules/@playwright/test/cli.js test tmp-debug-pets.spec.ts
 */
import { test } from '@playwright/test'

const URL = 'https://bxhvtbhwuktrpxxygikj.supabase.co'
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4aHZ0Ymh3dWt0cnB4eHlnaWtqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMTY4MTQsImV4cCI6MjEwMTU5MjgxNH0.SPtTty6sWV7tXQvac_RvPqQ0pb1OwlrlX5eY9A5eppc'
const ACCOUNT = 'support@maoxianqiu.app'
const PASSWORD = 'Support@20001223'
// 上一次运行失败的客户 id(宠物已存在)
const CUSTOMER_ID = '35b044ce-3f08-4bda-8e54-270187e39fe0'
const PET_NAME = 'E2E闭环A宠物-1786182451388'

test('debug pets visibility', async ({ page }) => {
  // 收集控制台与网络日志
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('pets') || msg.text().includes('customers')) {
      console.log('[console]', msg.type(), msg.text())
    }
  })
  page.on('response', (res) => {
    if (res.url().includes('/rest/v1/')) {
      console.log('[net]', res.status(), res.url().split('/rest/v1/')[1])
    }
  })

  // 1. 打开登录页
  await page.goto('/#/login', { waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: '用户名' }).waitFor({ state: 'visible' })
  await page.getByRole('textbox', { name: '用户名' }).fill(ACCOUNT)
  await page.getByRole('textbox', { name: '密码' }).fill(PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(/\/#\/$/, { timeout: 30_000 })
  console.log('=== 登录成功,URL =', page.url())

  // 2. 打印 localStorage 全部内容(检查 supabase 会话)
  const ls = await page.evaluate(() => {
    const out: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      const v = localStorage.getItem(k) ?? ''
      out[k] = v.length > 120 ? `${v.slice(0, 120)}...(${v.length})` : v
    }
    return out
  })
  console.log('localStorage keys:', JSON.stringify(ls, null, 1))

  // 3. 用页面内的 supabase 会话 token 直查 pets/customers
  const q = await page.evaluate(async ({ URL, KEY, CUSTOMER_ID }) => {
    // 从 localStorage 提取 access_token
    const raw = Object.keys(localStorage).find(k => k.includes('auth-token'))
    let token = ''
    if (raw) {
      try {
        const parsed = JSON.parse(localStorage.getItem(raw)!)
        token = parsed.access_token ?? ''
      }
      catch {}
    }
    if (!token) {
      // 尝试 supabase 标准 key
      const v = localStorage.getItem('sb-bxhvtbhwuktrpxxygikj-auth-token')
      if (v) {
        try {
          token = JSON.parse(v).access_token ?? ''
        }
        catch {}
      }
    }
    const hdrs = { apikey: KEY, Authorization: `Bearer ${token}` }
    const cust = await fetch(`${URL}/rest/v1/customers?id=eq.${CUSTOMER_ID}&select=id,name,tenant_id,store_id`, { headers: hdrs })
    const custBody = await cust.json()
    const pets = await fetch(`${URL}/rest/v1/pets?customer_id=eq.${CUSTOMER_ID}&select=id,name,tenant_id`, { headers: hdrs })
    const petsBody = await pets.json()
    const jwtSub = token ? JSON.parse(atob(token.split('.')[1])).sub : null
    return {
      tokenPrefix: token ? token.slice(0, 25) : '(none)',
      jwtSub,
      custStatus: cust.status,
      custBody,
      petsStatus: pets.status,
      petsBody,
    }
  }, { URL, KEY, CUSTOMER_ID })
  console.log('页面内 REST 查询结果:', JSON.stringify(q, null, 1))

  // 4. 打开客户详情页并观察宠物区 DOM
  await page.goto(`/#/crm/customer/${CUSTOMER_ID}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('E2E闭环A客户-1786182451388').first().waitFor({ state: 'visible', timeout: 15_000 })
  // 等 3 秒让 pets 查询完成
  await page.waitForTimeout(3000)
  const petCountText = await page.getByText(/只 宠物/).first().textContent().catch(() => null)
  console.log('页头宠物计数文本:', petCountText)
  const bodyText = await page.locator('body').innerText()
  console.log('页面包含宠物名?', bodyText.includes(PET_NAME))
  console.log('页面包含"暂无宠物"?', bodyText.includes('暂无宠物'))
  // 打印宠物列表卡片区域
  const cards = await page.locator('.grid.gap-3').allInnerTexts().catch(() => [])
  console.log('宠物卡片区域文本:', JSON.stringify(cards))
})
