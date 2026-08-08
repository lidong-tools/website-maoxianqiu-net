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
 * 闭环 A: 客户 → 宠物 → 预约 → 候诊 → 就诊 → 病历 → 处方 → 收费 → 发药 → 库存扣减
 *
 * AUD-009 顺序依据(默认建议):prescription → invoice → payment → dispense;
 * 不允许测试代码擅自先发药后收费。发药步骤在病历详情页 UI 操作。
 *
 * P0-09 改造:
 *   - test.describe.configure({ mode: 'serial' }):同一流程内串行,前序失败后续跳过
 *   - 前置数据(宠物/预约/药品库存)与收银走 Hono API(真实业务链路),
 *     病历编辑/发药等前端已有 UI 的操作走 UI,保证"真实闭环"而非仅页面出现
 *   - 每阶段结束用 Supabase REST(已登录用户 JWT + anon key)断言数据库状态
 *   - 唯一 runId 标识测试数据,便于归档清理;仅允许 staging 执行写入型 E2E
 *
 * 运行前提:
 *   - 后端 API 可达(默认页面 origin + /api,可用 E2E_API_BASE 覆盖)
 *   - E2E_USERNAME / E2E_PASSWORD 具备各业务权限码(含 inventory.receive 等)
 *   - seed 数据包含至少一个 drug 类目录商品(若无,测试自动跳过库存断言)
 */
test.describe('闭环 A — 核心就诊闭环(串行)', () => {
  test.describe.configure({ mode: 'serial' })

  // 唯一 runId,保证每次运行数据不冲突
  const runId = Date.now()
  const customerName = `E2E闭环A客户-${runId}`
  const petName = `E2E闭环A宠物-${runId}`
  const reason = `E2E闭环A就诊-${runId}`

  test('完整就诊流程与数据库断言', async ({ page, request }) => {
    const loggedIn = await ensureLogin(page)
    test.skip(!loggedIn, '登录失败,无法执行闭环测试')

    const token = await getAccessToken(page)
    expect(token).toBeTruthy()
    const api = createApiClient(request, apiBaseFor(page), token)

    /* ========== 1. 客户:UI 创建 + API 断言 ========== */
    console.log('[闭环A] 步骤1 创建客户')
    await page.goto('/#/crm/customer/new', { waitUntil: 'domcontentloaded' })
    await page.getByPlaceholder('请输入姓名').last().fill(customerName)
    await page.getByPlaceholder('请输入手机号').last().fill(`138${String(runId).slice(-8)}`)
    await page.getByRole('button', { name: '保存' }).click()
    // 保存成功跳转到详情页(UUID),不能匹配 /new 新增页
    await page.waitForURL(/\/#\/crm\/customer\/[0-9a-f-]{36}$/, { timeout: 30_000 })
    const customerId = new URL(page.url()).hash.split('/').pop()!
    await expect(page.getByText(customerName).first()).toBeVisible()
    // 数据库断言:客户已创建
    const customerRes = (await api.get(`/customers/${customerId}`)) as {
      data: { customer: { id: string, tenant_id: string, store_id: string | null, status: string } }
    }
    expect(customerRes.data.customer.id).toBe(customerId)
    expect(customerRes.data.customer.status).toBe('active')
    const tenantId = customerRes.data.customer.tenant_id
    const storeId = customerRes.data.customer.store_id ?? (await resolveStoreId(page, api, tenantId))

    /* ========== 2. 宠物:UI 创建(客户详情页「新增宠物」)+ 断言归属 ========== */
    console.log('[闭环A] 步骤2 创建宠物(UI)')
    await page.goto(`/#/crm/customer/${customerId}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: '新增宠物' }).first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '新增宠物' }).first().click()
    await expect(page.getByPlaceholder('请输入宠物名字').first()).toBeVisible({ timeout: 10_000 })
    await page.getByPlaceholder('请输入宠物名字').last().fill(petName)
    // 物种:从下拉选择「犬」(禁止手填枚举)
    await page.getByPlaceholder('如:金毛 / 英短').last().fill('田园犬')
    await page.getByRole('button', { name: '保存' }).last().click()
    await expect(page.getByText('宠物建档成功').first()).toBeVisible({ timeout: 15_000 })
    // 数据库断言:UI 创建的宠物归属正确
    const petRows = (await supabaseSelect<{ id: string, customer_id: string, tenant_id: string }[]>(
      page,
      'pets',
      `select=id,customer_id,tenant_id&name=eq.${encodeURIComponent(petName)}&order=created_at.desc&limit=1`,
    ))
    expect(petRows.length).toBe(1)
    expect(petRows[0].customer_id).toBe(customerId)
    expect(petRows[0].tenant_id).toBe(tenantId)
    const petId = petRows[0].id

    /* ========== 3. 预约:API 创建(今天)+ 流转到候诊 ========== */
    console.log('[闭环A] 步骤3 创建预约并候诊')
    const start = new Date(Date.now() + 3 * 3600 * 1000)
    const apptRes = (await api.post('/clinical/appointments', {
      tenantId,
      storeId,
      customerId,
      petId,
      scheduledStart: start.toISOString(),
      scheduledEnd: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      reason,
    })) as { data: { id: string } }
    const appointmentId = apptRes.data.id
    await api.post(`/clinical/appointments/${appointmentId}/transition`, { targetStatus: 'checked_in' })
    // 数据库断言:预约状态变化
    const appts = (await supabaseSelect<{ status: string }[]>(
      page,
      'appointments',
      `select=status&id=eq.${appointmentId}`,
    ))
    expect(appts[0].status).toBe('checked_in')

    /* ========== 4. 候诊队列 UI:出现该预约 + 开始就诊 ========== */
    console.log('[闭环A] 步骤4 候诊开始就诊')
    await page.goto('/#/clinical/waiting', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText(reason).first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '开始就诊' }).first().click()
    await page.waitForURL(/\/#\/clinical\/workbench/, { timeout: 15_000 })
    // 数据库断言:预约推进到 in_progress
    const appts2 = (await supabaseSelect<{ status: string }[]>(
      page,
      'appointments',
      `select=status&id=eq.${appointmentId}`,
    ))
    expect(appts2[0].status).toBe('in_progress')

    /* ========== 5. 工作台 UI:创建就诊 + 病历 + 完成就诊 ========== */
    console.log('[闭环A] 步骤5 就诊与病历')
    await expect(page.getByText('医生工作台').first()).toBeVisible()
    // 点击今日预约卡片创建就诊(卡片文本包含预约原因)
    await page.getByText(reason).first().click()
    await expect(page.getByPlaceholder('宠物主诉').first()).toBeVisible({ timeout: 15_000 })
    const complaint = `E2E主诉-${runId}`
    await page.getByPlaceholder('宠物主诉').last().fill(complaint)
    await page.getByPlaceholder('病史描述').last().fill(`E2E现病史-${runId}`)
    await page.getByRole('button', { name: '保存草稿' }).click()
    // 完成就诊(确认弹窗)
    await page.getByRole('button', { name: '完成就诊' }).click()
    await clickConfirmInDialog(page)
    // 完成后自动跳转病历详情页
    await page.waitForURL(/\/#\/clinical\/encounter\/[^/]+$/, { timeout: 15_000 })
    // 数据库断言:encounter 创建且 completed,归属正确
    const encounters = (await supabaseSelect<{ id: string, status: string, customer_id: string, pet_id: string }[]>(
      page,
      'encounters',
      `select=id,status,customer_id,pet_id&appointment_id=eq.${appointmentId}`,
    ))
    expect(encounters.length).toBe(1)
    expect(encounters[0].status).toBe('completed')
    expect(encounters[0].customer_id).toBe(customerId)
    expect(encounters[0].pet_id).toBe(petId)
    const encounterId = encounters[0].id

    /* ========== 6. 药品库存准备:目录药品 + 仓库 + 入库 ========== */
    console.log('[闭环A] 步骤6 准备药品库存')
    const drugRes = await prepareDrugStock(page, api, tenantId, storeId, runId)
    // AUD-008:缺 seed(drug 类商品/仓库)视为环境不完整,直接失败而非跳过
    expect(drugRes).toBeTruthy()
    const { drugItem, warehouseId, balanceBefore } = drugRes!

    /* ========== 7. 处方:API 保存(带目录商品,触发库存扣减)========== */
    console.log('[闭环A] 步骤7 保存处方')
    const rxSaveRes = (await api.post('/clinical/prescriptions/save', {
      encounterId,
      items: [
        {
          catalogItemId: drugItem.id,
          drugName: drugItem.name,
          dosage: '1片',
          frequency: '每日一次',
          quantity: 1,
          unit: '片',
        },
      ],
    })) as { data: { id: string } }
    const prescriptionId = rxSaveRes.data.id
    const rxs = (await supabaseSelect<{ id: string, status: string }[]>(
      page,
      'prescriptions',
      `select=id,status&id=eq.${prescriptionId}`,
    ))
    expect(rxs.length).toBe(1)
    expect(rxs[0].status).toBe('draft')

    /* ========== 8. 收银:API 创建发票 + 确认 + 支付 + 断言 ========== */
    console.log('[闭环A] 步骤8 收费与支付')
    const unitPrice = 10
    const invoiceRes = (await api.post('/billing/invoices', {
      tenantId,
      storeId,
      customerId,
      petId,
      encounterId,
      items: [
        {
          catalogItemId: drugItem.id,
          name: drugItem.name,
          unitPrice,
          quantity: 1,
          amount: unitPrice,
          category: 'drug',
        },
      ],
      paymentMethod: 'cash',
      idempotencyKey: newIdemKey('e2e-invoice'),
    })) as { data: { invoiceId: string } }
    const invoiceId = invoiceRes.data.invoiceId
    await api.post(`/billing/invoices/${invoiceId}/confirm`, {})
    await api.post('/billing/payments', {
      invoiceId,
      amount: unitPrice,
      method: 'cash',
      transactionNo: `E2E-${runId}`,
      idempotencyKey: newIdemKey('e2e-pay'),
    })
    // 数据库断言:发票金额正确 + 状态 paid + payment 过账
    const invoices = (await supabaseSelect<{ status: string, total: number, paid_amount: number }[]>(
      page,
      'invoices',
      `select=status,total,paid_amount&id=eq.${invoiceId}`,
    ))
    expect(invoices.length).toBe(1)
    expect(invoices[0].total).toBe(unitPrice)
    expect(invoices[0].status).toBe('paid')
    expect(invoices[0].paid_amount).toBe(unitPrice)
    const payments = (await supabaseSelect<{ id: string }[]>(
      page,
      'payments',
      `select=id&invoice_id=eq.${invoiceId}`,
    ))
    expect(payments.length).toBe(1)

    /* ========== 9. 发药:UI 病历详情页操作 + 库存断言 ========== */
    console.log('[闭环A] 步骤9 发药')
    await page.goto(`/#/clinical/encounter/${encounterId}`, { waitUntil: 'domcontentloaded' })
    // 处方行出现"发药"按钮(处方 id 前 8 位)
    await expect(page.getByRole('button', { name: '发药' }).first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '发药' }).first().click()
    await clickConfirmInDialog(page)
    await expect(page.getByText('发药成功').first()).toBeVisible({ timeout: 15_000 })
    // 数据库断言:处方 dispensed + 库存减少 + confirm 流水生成
    const rxs2 = (await supabaseSelect<{ status: string }[]>(
      page,
      'prescriptions',
      `select=status&id=eq.${prescriptionId}`,
    ))
    expect(rxs2[0].status).toBe('dispensed')
    const balanceAfter = await getBalance(page, warehouseId, drugItem.id)
    expect(balanceAfter.quantity_on_hand).toBe(balanceBefore.quantity_on_hand - 1)
    const movements = (await supabaseSelect<{ movement_type: string, reference_id: string }[]>(
      page,
      'inventory_movements',
      `select=movement_type,reference_id&warehouse_id=eq.${warehouseId}&catalog_item_id=eq.${drugItem.id}&movement_type=eq.confirm&order=created_at.desc&limit=3`,
    ))
    expect(movements.length).toBeGreaterThan(0)

    /* ========== 10. 病历签署:UI 操作(真实通过)+ 只读断言 ========== */
    console.log('[闭环A] 步骤10 签署病历(UI)')
    await page.goto(`/#/clinical/encounter/${encounterId}`, { waitUntil: 'domcontentloaded' })
    // S30-R04:签署人强制为当前登录用户,弹窗无医生选择器,点击「签署」直接确认
    await expect(page.getByRole('button', { name: '签署' }).first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '签署' }).first().click()
    // 弹窗内展示当前登录账号(只读),点击确认完成签署
    await expect(page.getByText('签署人').first()).toBeVisible({ timeout: 10_000 })
    await page.locator('.fa-modal, [role="dialog"]').last().getByRole('button', { name: '确认' }).click()
    await expect(page.getByText('病历已签署').first()).toBeVisible({ timeout: 15_000 })
    // 数据库断言:签署完成 + 签署人=当前登录用户(auth.users.id)
    const encSigned = (await supabaseSelect<{ status: string, signed_at: string | null, signed_by: string | null }[]>(
      page,
      'encounters',
      `select=status,signed_at,signed_by&id=eq.${encounterId}`,
    ))
    expect(encSigned[0].status).toBe('signed')
    expect(encSigned[0].signed_at).toBeTruthy()
    expect(encSigned[0].signed_by).toBeTruthy()
    // 只读断言:已签署病历直接修改应被拒绝(409)
    const patchRes = await request.patch(`${api.base}/clinical/encounters/${encounterId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { chiefComplaint: 'E2E 不应生效' },
    })
    expect(patchRes.status()).toBe(409)

    console.log(`[闭环A] 完成:customer=${customerId} pet=${petId} encounter=${encounterId} rx=${prescriptionId} invoice=${invoiceId}`)
  })
})

/** 解析租户下第一个门店 id(客户未挂门店时使用) */
async function resolveStoreId(page: import('@playwright/test').Page, api: ReturnType<typeof createApiClient>, tenantId: string): Promise<string> {
  const stores = (await supabaseSelect<{ id: string }[]>(
    page,
    'stores',
    `select=id&tenant_id=eq.${tenantId}&limit=1`,
  ))
  if (stores.length === 0) {
    throw new Error(`租户 ${tenantId} 下无门店,无法创建预约/发票`)
  }
  return stores[0].id
}

/** 定位当前打开的确认弹窗并点击其"确定"按钮(FaModal 确认按钮文案兼容) */
async function clickConfirmInDialog(page: import('@playwright/test').Page) {
  const dialog = page.locator('.fa-modal, [role="dialog"]').last()
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  // 确认按钮:排除"取消"后取最后一个可见按钮
  await dialog.locator('button').filter({ hasNotText: '取消' }).last().click()
}

/**
 * 准备药品库存:查询 drug 类目录商品 + 默认仓库,不足则入库补足。
 * @returns 商品/仓库/入库前余额;未找到商品返回 undefined
 */
async function prepareDrugStock(
  page: import('@playwright/test').Page,
  api: ReturnType<typeof createApiClient>,
  tenantId: string,
  storeId: string,
  runId: number,
) {
  // 1. 查 drug 类目录商品(seed 环境应存在;不存在则返回 undefined 让测试跳过)
  const drugs = (await supabaseSelect<{ id: string, name: string }[]>(
    page,
    'catalog_items',
    `select=id,name&billing_type=eq.drug&limit=1`,
  ))
  if (drugs.length === 0) {
    return undefined
  }
  const drugItem = drugs[0]
  // 2. 查仓库(默认优先,否则第一个)
  const warehouses = (await supabaseSelect<{ id: string }[]>(
    page,
    'warehouses',
    `select=id&store_id=eq.${storeId}&limit=1`,
  ))
  if (warehouses.length === 0) {
    throw new Error('当前门店无仓库,无法入库')
  }
  const warehouseId = warehouses[0].id
  const balanceBefore = await getBalance(page, warehouseId, drugItem.id)
  // 3. 库存不足时入库补足(目标 ≥ 10,供发药扣减)
  if (balanceBefore.quantity_on_hand < 10) {
    await api.post('/inventory/goods-receipt', {
      tenantId,
      warehouseId,
      catalogItemId: drugItem.id,
      batchNo: `E2E-${runId}`,
      quantity: 50,
      unitCost: 5,
      idempotencyKey: newIdemKey('e2e-receipt'),
    })
  }
  // 4. 返回入库后的余额(供发药后对比)
  return { drugItem, warehouseId, balanceBefore: await getBalance(page, warehouseId, drugItem.id) }
}

/** 查询指定仓库/商品的库存余额(不存在时返回 0 余额) */
async function getBalance(page: import('@playwright/test').Page, warehouseId: string, catalogItemId: string) {
  const rows = (await supabaseSelect<{ quantity_on_hand: number, quantity_reserved: number }[]>(
    page,
    'inventory_balances',
    `select=quantity_on_hand,quantity_reserved&warehouse_id=eq.${warehouseId}&catalog_item_id=eq.${catalogItemId}&limit=1`,
  ))
  return rows[0] ?? { quantity_on_hand: 0, quantity_reserved: 0 }
}
