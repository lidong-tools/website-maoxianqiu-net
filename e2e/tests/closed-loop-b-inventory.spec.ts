/* eslint-disable no-console -- 闭环测试步骤日志,便于运行中定位 */
import { expect, test } from '@playwright/test'
import {
  apiBaseFor,
  createApiClient,
  getAccessToken,
  newIdemKey,
  supabaseSelect,
} from '../helpers/api'
import { ensureLogin } from '../helpers/auth'
import { ensureChromium } from '../helpers/browser'

// 浏览器内核缺失时,除非 E2E_OPTIONAL=true,否则失败
test.skip(!ensureChromium(), 'Chromium 浏览器未安装且未设置 E2E_OPTIONAL=true')

/**
 * 闭环 B: 入库 → 余额 → 盘点 → 调拨 → 流水
 *
 * P0-09 新增:
 *   - 过账(入库/盘点/调拨)走 Hono Command + RPC,幂等键保证不重复
 *   - 每阶段用 Supabase REST 断言余额与流水(movement 不可变)
 *   - 盘点用 UI 操作(盘点页输入盘点数量并提交),其余走 API
 *   - 唯一 runId 标识测试数据;仅允许 staging 执行
 */
test.describe('闭环 B — 库存闭环(串行)', () => {
  test.describe.configure({ mode: 'serial' })

  const runId = Date.now()

  test('入库→余额→盘点→调拨→流水', async ({ page, request }) => {
    const loggedIn = await ensureLogin(page)
    test.skip(!loggedIn, '登录失败,无法执行闭环测试')

    const token = await getAccessToken(page)
    expect(token).toBeTruthy()
    const api = createApiClient(request, apiBaseFor(page), token)

    // 前置:取当前用户可见租户/门店/仓库与商品
    const tenants = (await supabaseSelect<{ id: string }[]>(page, 'tenants', 'select=id&limit=1'))
    expect(tenants.length).toBe(1)
    const tenantId = tenants[0].id
    const stores = (await supabaseSelect<{ id: string }[]>(
      page,
      'stores',
      `select=id&tenant_id=eq.${tenantId}&limit=1`,
    ))
    expect(stores.length).toBe(1)
    const storeId = stores[0].id
    const warehouses = (await supabaseSelect<{ id: string, name: string }[]>(
      page,
      'warehouses',
      `select=id,name&store_id=eq.${storeId}&limit=2`,
    ))
    expect(warehouses.length).toBeGreaterThanOrEqual(2)
    const [warehouseA, warehouseB] = warehouses

    // 商品:使用 seed 中的 drug 类目录商品(AUD-008:缺 seed 直接失败,不允许跳过)
    const drugs = (await supabaseSelect<{ id: string, name: string }[]>(
      page,
      'catalog_items',
      `select=id,name&billing_type=eq.drug&limit=1`,
    ))
    expect(drugs.length).toBeGreaterThan(0)
    const item = drugs[0]

    /* ========== 1. 入库 50 → 余额断言 + receive 流水 ========== */
    console.log('[闭环B] 步骤1 入库')
    await api.post('/inventory/goods-receipt', {
      tenantId,
      warehouseId: warehouseA.id,
      catalogItemId: item.id,
      batchNo: `E2E-B-${runId}`,
      quantity: 50,
      unitCost: 5,
      idempotencyKey: newIdemKey('e2e-b-receipt'),
    })
    const balanceA1 = await getBalance(page, warehouseA.id, item.id)
    expect(balanceA1.quantity_on_hand).toBe(50)
    const receiveMovements = (await supabaseSelect<{ movement_type: string }[]>(
      page,
      'inventory_movements',
      `select=movement_type&warehouse_id=eq.${warehouseA.id}&catalog_item_id=eq.${item.id}&movement_type=eq.receive&limit=5`,
    ))
    expect(receiveMovements.length).toBeGreaterThan(0)

    /* ========== 2. 盘点:UI 输入盘点数量 40 并提交 ========== */
    console.log('[闭环B] 步骤2 盘点(UI)')
    await page.goto('/#/inventory/count', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('盘点工作表').first()).toBeVisible()
    // 盘点页自动选中第一个仓库(FaSelect 触发器显示仓库名),验证已选仓库即 warehouseA
    await expect(page.getByText(warehouseA.name, { exact: true }).first()).toBeVisible()
    // 在商品行(按商品 ID 前 8 位匹配)输入盘点数量 40
    const row = page.locator('table tbody tr').filter({ hasText: item.id.slice(0, 8) }).first()
    await row.locator('input').first().fill('40')
    await page.getByRole('button', { name: '提交盘点' }).click()
    // 断言:余额调整为 40,且存在盘点流水
    await expect
      .poll(async () => (await getBalance(page, warehouseA.id, item.id)).quantity_on_hand, { timeout: 30_000 })
      .toBe(40)
    const adjustMovements = (await supabaseSelect<{ movement_type: string }[]>(
      page,
      'inventory_movements',
      `select=movement_type&warehouse_id=eq.${warehouseA.id}&catalog_item_id=eq.${item.id}&movement_type=eq.adjust&limit=5`,
    ))
    expect(adjustMovements.length).toBeGreaterThan(0)

    /* ========== 3. 调拨 10 (A→B) ========== */
    console.log('[闭环B] 步骤3 调拨')
    await api.post('/inventory/transfer', {
      tenantId,
      fromWarehouseId: warehouseA.id,
      toWarehouseId: warehouseB.id,
      catalogItemId: item.id,
      quantity: 10,
      idempotencyKey: newIdemKey('e2e-b-transfer'),
    })
    const balanceA2 = await getBalance(page, warehouseA.id, item.id)
    const balanceB = await getBalance(page, warehouseB.id, item.id)
    expect(balanceA2.quantity_on_hand).toBe(30)
    expect(balanceB.quantity_on_hand).toBe(10)
    const transferOut = (await supabaseSelect<{ movement_type: string }[]>(
      page,
      'inventory_movements',
      `select=movement_type&warehouse_id=eq.${warehouseA.id}&catalog_item_id=eq.${item.id}&movement_type=eq.transfer_out&limit=5`,
    ))
    const transferIn = (await supabaseSelect<{ movement_type: string }[]>(
      page,
      'inventory_movements',
      `select=movement_type&warehouse_id=eq.${warehouseB.id}&catalog_item_id=eq.${item.id}&movement_type=eq.transfer_in&limit=5`,
    ))
    expect(transferOut.length).toBeGreaterThan(0)
    expect(transferIn.length).toBeGreaterThan(0)

    /* ========== 4. UI 冒烟:入库页余额表与流水表渲染 ========== */
    console.log('[闭环B] 步骤4 入库页冒烟')
    await page.goto('/#/inventory/receipt', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('库存余额').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('最近流水').first()).toBeVisible()
    await expect(page.locator('table').first()).toBeVisible()

    console.log(`[闭环B] 完成:item=${item.id} warehouseA=${warehouseA.id} warehouseB=${warehouseB.id}`)
  })
})

/** 查询指定仓库/商品的库存余额(不存在时返回 0 余额) */
async function getBalance(page: import('@playwright/test').Page, warehouseId: string, catalogItemId: string) {
  const rows = (await supabaseSelect<{ quantity_on_hand: number, quantity_reserved: number }[]>(
    page,
    'inventory_balances',
    `select=quantity_on_hand,quantity_reserved&warehouse_id=eq.${warehouseId}&catalog_item_id=eq.${catalogItemId}&limit=1`,
  ))
  return rows[0] ?? { quantity_on_hand: 0, quantity_reserved: 0 }
}
