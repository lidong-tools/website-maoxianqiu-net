/* eslint-disable no-console -- 闭环测试步骤日志,便于运行中定位 */
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import {
  apiBaseFor,
  createApiClient,
  getAccessToken,
  newIdemKey,
  supabaseInsert,
  supabaseSelect,
} from '../helpers/api'
import { ensureLogin } from '../helpers/auth'
import { ensureChromium } from '../helpers/browser'

// 浏览器内核缺失时,除非 E2E_OPTIONAL=true,否则失败
test.skip(!ensureChromium(), 'Chromium 浏览器未安装且未设置 E2E_OPTIONAL=true')

/**
 * 闭环 C: 入院 → 房位占用 → 护理任务 → 换房 → 自动计费 → 出院
 *
 * P0-09 新增:
 *   - 入院/换房/自动计费/出院走 Hono Command + RPC(真实业务链路)
 *   - 护理任务沿用前端"浏览器直连"模式:supabaseInsert 创建 + REST PATCH 流转状态(RLS 兜底)
 *   - 每阶段用 Supabase REST 断言笼位状态/住院记录/换房历史/计费流水
 *   - 笼位费率 > 0 时才断言计费金额,费率 0 的笼位跳过费用断言(RPC 设计如此)
 *   - 唯一 runId 标识测试数据;仅允许 staging 执行
 *
 * 运行前提:
 *   - 后端 API 可达(默认页面 origin + /api,可用 E2E_API_BASE 覆盖)
 *   - E2E_USERNAME / E2E_PASSWORD 具备 inpatient.* / nursing.* / customer.create 等权限
 *   - seed 数据包含至少 2 个 available 笼位(若不足则跳过)
 */
test.describe('闭环 C — 住院闭环(串行)', () => {
  test.describe.configure({ mode: 'serial' })

  const runId = Date.now()

  test('入院→护理→换房→计费→出院', async ({ page, request }) => {
    const loggedIn = await ensureLogin(page)
    test.skip(!loggedIn, '登录失败,无法执行闭环测试')

    const token = await getAccessToken(page)
    expect(token).toBeTruthy()
    const api = createApiClient(request, apiBaseFor(page), token)

    // 前置:租户/门店
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

    // 前置:至少 2 个 available 笼位(优先高费率,便于计费断言)
    // AUD-008:缺 seed(可用笼位不足)视为环境不完整,直接失败而非跳过
    const cages = (await supabaseSelect<{ id: string, name: string, daily_rate: number }[]>(
      page,
      'cages',
      `select=id,name,daily_rate&store_id=eq.${storeId}&status=eq.available&order=daily_rate.desc&limit=2`,
    ))
    expect(cages.length).toBeGreaterThanOrEqual(2)
    const [cageA, cageB] = cages

    /* ========== 1. 客户 + 宠物:API 创建 ========== */
    console.log('[闭环C] 步骤1 创建客户与宠物')
    const customerRes = (await api.post('/customers', {
      tenantId,
      storeId,
      name: `E2E闭环C客户-${runId}`,
      gender: 'unknown',
      phone: `139${String(runId).slice(-8)}`,
    })) as { data: { id: string } }
    const customerId = customerRes.data.id
    const petRes = (await api.post('/pets', {
      tenantId,
      customerId,
      name: `E2E闭环C宠物-${runId}`,
      species: '猫',
      gender: 'male',
    })) as { data: { id: string } }
    const petId = petRes.data.id
    const pets = (await supabaseSelect<{ customer_id: string }[]>(
      page,
      'pets',
      `select=customer_id&id=eq.${petId}`,
    ))
    expect(pets[0].customer_id).toBe(customerId)

    /* ========== 2. 入院:API → 笼位占用断言 ========== */
    console.log('[闭环C] 步骤2 入院')
    const admitRes = (await api.post('/inpatient/admit', {
      tenantId,
      storeId,
      customerId,
      petId,
      cageId: cageA.id,
      admissionReason: `E2E住院-${runId}`,
      idempotencyKey: newIdemKey('e2e-c-admit'),
    })) as { data: { admissionId: string, status: string } }
    const admissionId = admitRes.data.admissionId
    expect(admitRes.data.status).toBe('admitted')
    // 数据库断言:admission 归属正确 + 笼位 A 已占用
    const admissions = (await supabaseSelect<{ status: string, customer_id: string, pet_id: string, cage_id: string }[]>(
      page,
      'admissions',
      `select=status,customer_id,pet_id,cage_id&id=eq.${admissionId}`,
    ))
    expect(admissions.length).toBe(1)
    expect(admissions[0].status).toBe('admitted')
    expect(admissions[0].customer_id).toBe(customerId)
    expect(admissions[0].pet_id).toBe(petId)
    expect(admissions[0].cage_id).toBe(cageA.id)
    const cageAState = (await supabaseSelect<{ status: string, current_admission_id: string | null }[]>(
      page,
      'cages',
      `select=status,current_admission_id&id=eq.${cageA.id}`,
    ))
    expect(cageAState[0].status).toBe('occupied')
    expect(cageAState[0].current_admission_id).toBe(admissionId)

    /* ========== 3. 护理任务:创建 + 状态流转 ========== */
    console.log('[闭环C] 步骤3 护理任务')
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const taskRes = (await supabaseInsert<{ id: string, status: string }[]>(page, 'nursing_tasks', {
      tenant_id: tenantId,
      store_id: storeId,
      admission_id: admissionId,
      pet_id: petId,
      plan_id: null,
      task_type: 'medication',
      description: `E2E喂药-${runId}`,
      scheduled_at: scheduledAt,
      assigned_to: null,
    }))
    expect(taskRes.length).toBe(1)
    const taskId = taskRes[0].id
    expect(taskRes[0].status).toBe('pending')
    // 状态流转:pending → done(RLS 须 nursing.manage)
    await supabasePatch(page, 'nursing_tasks', taskId, { status: 'done', completed_at: new Date().toISOString() })
    const taskDone = (await supabaseSelect<{ status: string, completed_at: string | null }[]>(
      page,
      'nursing_tasks',
      `select=status,completed_at&id=eq.${taskId}`,
    ))
    expect(taskDone[0].status).toBe('done')
    expect(taskDone[0].completed_at).toBeTruthy()

    /* ========== 4. 换房:API → 新旧笼位状态断言 ========== */
    console.log('[闭环C] 步骤4 换房')
    await api.post('/inpatient/transfer', {
      admissionId,
      newCageId: cageB.id,
      reason: 'E2E换房',
      idempotencyKey: newIdemKey('e2e-c-transfer'),
    })
    // 数据库断言:旧笼位释放 + 新笼位占用 + admission 更新
    const cageAReleased = (await supabaseSelect<{ status: string, current_admission_id: string | null }[]>(
      page,
      'cages',
      `select=status,current_admission_id&id=eq.${cageA.id}`,
    ))
    expect(cageAReleased[0].status).toBe('available')
    expect(cageAReleased[0].current_admission_id).toBeNull()
    const cageBOccupied = (await supabaseSelect<{ status: string, current_admission_id: string | null }[]>(
      page,
      'cages',
      `select=status,current_admission_id&id=eq.${cageB.id}`,
    ))
    expect(cageBOccupied[0].status).toBe('occupied')
    expect(cageBOccupied[0].current_admission_id).toBe(admissionId)
    const admissionMoved = (await supabaseSelect<{ cage_id: string }[]>(
      page,
      'admissions',
      `select=cage_id&id=eq.${admissionId}`,
    ))
    expect(admissionMoved[0].cage_id).toBe(cageB.id)
    const transfers = (await supabaseSelect<{ from_cage_id: string, to_cage_id: string }[]>(
      page,
      'cage_transfers',
      `select=from_cage_id,to_cage_id&admission_id=eq.${admissionId}&limit=1`,
    ))
    expect(transfers.length).toBe(1)
    expect(transfers[0].from_cage_id).toBe(cageA.id)
    expect(transfers[0].to_cage_id).toBe(cageB.id)

    /* ========== 5. 自动计费:API → 计费流水断言 ========== */
    console.log('[闭环C] 步骤5 自动计费')
    const chargeRes = (await api.post('/inpatient/charges/generate', {
      targetDate: new Date().toISOString().slice(0, 10),
    })) as { data: { targetDate: string, generatedCount: number } }
    expect(chargeRes.data.generatedCount).toBeGreaterThanOrEqual(0)
    const charges = (await supabaseSelect<{ amount: number, is_auto: boolean, description: string }[]>(
      page,
      'inpatient_charges',
      `select=amount,is_auto,description&admission_id=eq.${admissionId}&limit=5`,
    ))
    // 笼位费率 > 0 时才断言计费金额(RPC 设计:费率 0 跳过计费)
    if (cageB.daily_rate > 0) {
      expect(charges.length).toBeGreaterThan(0)
      expect(charges[0].amount).toBe(Number(cageB.daily_rate))
      expect(charges[0].is_auto).toBe(true)
    }

    /* ========== 6. 出院:API → 笼位释放 + 费用汇总断言 ========== */
    console.log('[闭环C] 步骤6 出院')
    const dischargeRes = (await api.post('/inpatient/discharge', {
      admissionId,
      dischargeReason: '康复出院',
      dischargeNotes: 'E2E 出院',
      idempotencyKey: newIdemKey('e2e-c-discharge'),
    })) as { data: { status: string, totalCharge: number } }
    expect(dischargeRes.data.status).toBe('discharged')
    const admissionDone = (await supabaseSelect<{ status: string, discharged_at: string | null, total_charge: number }[]>(
      page,
      'admissions',
      `select=status,discharged_at,total_charge&id=eq.${admissionId}`,
    ))
    expect(admissionDone[0].status).toBe('discharged')
    expect(admissionDone[0].discharged_at).toBeTruthy()
    // 笼位 B 已释放(REST 可见性可能有延迟,轮询断言)
    await expect
      .poll(async () => {
        const rows = await supabaseSelect<{ status: string, current_admission_id: string | null }[]>(
          page,
          'cages',
          `select=status,current_admission_id&id=eq.${cageB.id}`,
        )
        return rows[0]
      }, { timeout: 30_000 })
      .toEqual({ status: 'available', current_admission_id: null })
    // 费用汇总 = 自动计费金额(费率 > 0 时)
    if (cageB.daily_rate > 0) {
      expect(admissionDone[0].total_charge).toBe(Number(cageB.daily_rate))
    }

    /* ========== 7. UI 冒烟:房态看板渲染 ========== */
    console.log('[闭环C] 步骤7 房态看板冒烟')
    await page.goto('/#/inpatient/dashboard', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('房态看板').first()).toBeVisible({ timeout: 30_000 })
    // 笼位以卡片网格渲染(通用 Tailwind class),断言至少渲染出一个笼位卡片
    await expect(page.locator('div.grid > div').first()).toBeVisible()

    console.log(`[闭环C] 完成:customer=${customerId} pet=${petId} admission=${admissionId} task=${taskId}`)
  })
})

/**
 * 在页面上下文内用 Supabase REST 更新(PATCH),复用已登录用户 JWT + anon key。
 * 护理任务状态流转沿用前端"浏览器直连"模式,RLS 兜底校验权限。
 * @param page 页面实例(须已登录)
 * @param table 表名
 * @param id 行 id(按 id=eq. 过滤)
 * @param patch 待更新字段(字段名为下划线格式)
 * @returns 更新后的行数组(Prefer: return=representation)
 */
async function supabasePatch<T>(page: Page, table: string, id: string, patch: Record<string, unknown>): Promise<T> {
  const url = process.env.VITE_SUPABASE_URL ?? ''
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? ''
  if (!url || !anonKey) {
    throw new Error('缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY,无法直连 Supabase 更新')
  }
  return page.evaluate(async ({ url, anonKey, table, id, patch }) => {
    const token = localStorage.getItem('token') ?? ''
    const res = await fetch(`${url}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      throw new Error(`Supabase REST 更新 ${table} 失败(${res.status}): ${await res.text()}`)
    }
    return res.json()
  }, { url, anonKey, table, id, patch })
}
