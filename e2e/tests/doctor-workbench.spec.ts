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
 * 医生工作台 — 高密度一站式问诊下单闭环(改造计划 Phase 5 核心场景 1)
 *
 * 标准问诊闭环:签到/候诊 → 叫号 → 接诊 → 病历 → 处方 + 检验 + 影像 + 医嘱 → 提交诊疗方案
 * → 断言四类单据、收费项、岗位任务、患者旅程事件。
 *
 * 真实闭环要求(与 AGENTS.md 一致):
 *   - 前置数据(客户/宠物/预约/队列签到)走 Hono API(真实业务链路)
 *   - 病历、四类下单、提交全部在 /clinical/workbench 页面内 UI 完成(不跳转详情页)
 *   - 每阶段结束用 Supabase REST(已登录用户 JWT + anon key)断言数据库状态
 *
 * 运行前提:
 *   - 后端 API 可达(默认页面 origin + /api,可用 E2E_API_BASE 覆盖)
 *   - E2E_USERNAME / E2E_PASSWORD 具备医生岗位权限(doctor/queue.call/queue.manage 等)
 *   - seed 数据包含 drug 类目录项目(如 阿莫西林片)与 exam 类目录项目(血常规检查/腹部彩超),
 *     且 E2E 员工存在有效执业兽医备案(issue_prescription 硬性要求),否则测试跳过
 */
test.describe('医生工作台 — 一站式问诊下单闭环(串行)', () => {
  test.describe.configure({ mode: 'serial' })

  // 唯一 runId,保证每次运行数据不冲突
  const runId = Date.now()
  const customerName = `E2E工作台客户-${runId}`
  const petName = `E2E工作台宠物-${runId}`
  const reason = `E2E工作台就诊-${runId}`

  test('叫号→接诊→病历→四类下单→提交→四类单据/收费/任务/事件断言', async ({ page, request }) => {
    const loggedIn = await ensureLogin(page)
    test.skip(!loggedIn, '登录失败,无法执行工作台闭环测试')

    const token = await getAccessToken(page)
    expect(token).toBeTruthy()
    const api = createApiClient(request, apiBaseFor(page), token)

    /* ========== 1. 环境前置检查:兽医备案 + 目录项目(缺一即跳过,避免处方/检验选择失败) ========== */
    console.log('[工作台] 步骤1 环境前置检查')
    const tenants0 = (await supabaseSelect<{ id: string }[]>(page, 'tenants', 'select=id&limit=1'))
    expect(tenants0.length).toBe(1)
    const tenantId = tenants0[0].id
    const stores0 = (await supabaseSelect<{ id: string }[]>(
      page,
      'stores',
      `select=id&tenant_id=eq.${tenantId}&limit=1`,
    ))
    expect(stores0.length).toBe(1)
    const storeId = stores0[0].id
    const vetRegs = (await supabaseSelect<{ id: string }[]>(
      page,
      'veterinarian_registrations',
      `select=id&tenant_id=eq.${tenantId}&status=eq.active&limit=1`,
    ))
    const drugItems = (await supabaseSelect<{ id: string, name: string }[]>(
      page,
      'catalog_items',
      `select=id,name&tenant_id=eq.${tenantId}&billing_type=eq.drug&is_active=eq.true&limit=1`,
    ))
    const examItems = (await supabaseSelect<{ id: string, name: string }[]>(
      page,
      'catalog_items',
      `select=id,name&tenant_id=eq.${tenantId}&billing_type=eq.exam&is_active=eq.true&limit=5`,
    ))
    test.skip(vetRegs.length === 0, '当前租户无有效执业兽医备案,处方开具不可用')
    test.skip(drugItems.length === 0 || examItems.length === 0, '缺少 drug/exam 类目录项目,无法完成四类下单')
    const drugName = drugItems[0].name
    const labName = examItems[0].name
    const imagingName = examItems.length > 1 ? examItems[1].name : examItems[0].name

    /* ========== 2. 客户 / 宠物 / 预约(API)+ 队列签到(waiting,免分诊) ========== */
    console.log('[工作台] 步骤2 前置数据与队列签到')
    const created = (await api.post('/customers', {
      tenantId,
      storeId,
      name: customerName,
      gender: 'unknown',
      phone: `139${String(runId).slice(-8)}`,
    })) as { data: { id: string } }
    const customerId = created.data.id
    const petRes = (await api.post('/pets', {
      tenantId,
      customerId,
      name: petName,
      species: '犬',
      gender: 'unknown',
    })) as { data: { id: string } }
    const petId = petRes.data.id
    // 工作台"今日预约/候诊队列"按本地今天过滤,预约时间须落在今天内
    const start = new Date(Date.now() + 30 * 60 * 1000)
    start.setHours(Math.min(start.getHours(), 23))
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
    await api.post(`/clinical/appointments/${appointmentId}/transition`, { targetStatus: 'confirmed' })
    // 前台签到:创建候诊队列条目(triageRequired=false → 直接 waiting,医生队列"待叫号"段可见)
    await api.post('/clinical/queue/check-in', {
      appointmentId,
      triageRequired: false,
      serviceType: 'outpatient',
      actorRole: 'receptionist',
      sourceWorkbench: 'frontdesk',
      idempotencyKey: newIdemKey('e2e-checkin'),
    })
    const queueRows = (await supabaseSelect<{ id: string, status: string }[]>(
      page,
      'clinical_queue_entries',
      `select=id,status&appointment_id=eq.${appointmentId}`,
    ))
    expect(queueRows.length).toBe(1)
    expect(queueRows[0].status).toBe('waiting')

    /* ========== 3. 工作台 UI:叫号(waiting→called)→ 开始接诊(called→in_consultation) ========== */
    console.log('[工作台] 步骤3 叫号与接诊')
    await page.goto('/#/clinical/workbench', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('医生工作台').first()).toBeVisible()
    let queueRow = page.locator('div.border.rounded-md.cursor-pointer').filter({ hasText: reason }).first()
    await expect(queueRow).toBeVisible({ timeout: 30_000 })
    // 叫号:waiting → called
    await queueRow.getByRole('button', { name: '叫号' }).click()
    // 队列刷新后该行进入"已叫号"段,出现"开始接诊"
    queueRow = page.locator('div.border.rounded-md.cursor-pointer').filter({ hasText: reason }).first()
    await expect(queueRow.getByRole('button', { name: '开始接诊' })).toBeVisible({ timeout: 30_000 })
    await queueRow.getByRole('button', { name: '开始接诊' }).click()
    // 接诊后自动创建就诊并载入病历编辑器(不跳转其他页面)
    await expect(page.getByPlaceholder('宠物主诉').first()).toBeVisible({ timeout: 30_000 })
    const appts = (await supabaseSelect<{ status: string }[]>(
      page,
      'appointments',
      `select=status&id=eq.${appointmentId}`,
    ))
    expect(appts[0].status).toBe('in_progress')
    const encCreated = (await supabaseSelect<{ id: string, status: string, clinical_status: string }[]>(
      page,
      'encounters',
      `select=id,status,clinical_status&appointment_id=eq.${appointmentId}`,
    ))
    expect(encCreated.length).toBe(1)
    expect(encCreated[0].status).toBe('in_progress')
    expect(encCreated[0].clinical_status).toBe('active')
    const encounterId = encCreated[0].id

    /* ========== 4. 病历 UI:主诉/现病史/体检/诊断/治疗方案 + 保存草稿 ========== */
    console.log('[工作台] 步骤4 病历填写')
    const complaint = `E2E工作台主诉-${runId}`
    await page.getByPlaceholder('宠物主诉').last().fill(complaint)
    await page.getByPlaceholder('病史描述').last().fill(`E2E工作台现病史-${runId}`)
    await page.getByPlaceholder('体检发现').last().fill('体温38.9,精神尚可')
    await page.getByPlaceholder('诊断结论').last().fill('急性胃肠炎')
    await page.getByPlaceholder('治疗方案').last().fill('补液+抗生素,观察2天')
    await page.getByRole('button', { name: '保存草稿' }).click()
    // 等待保存完成(底部状态栏出现"已保存 HH:MM:SS")
    await expect(page.getByText(/已保存 \d{1,2}:\d{2}:\d{2}/).first()).toBeVisible({ timeout: 30_000 })

    /* ========== 5. 处方 UI:目录选药 + 剂量/频次/数量/单位/用法 + 保存并开具 ========== */
    console.log('[工作台] 步骤5 处方开具(UI)')
    await pickCatalogItem(page, '搜索药品', drugName)
    await page.getByPlaceholder('剂量').last().fill('1片')
    await page.getByPlaceholder('频次').last().fill('每日2次')
    await page.getByPlaceholder('数量').last().fill('2')
    await page.getByPlaceholder('单位').last().fill('片')
    await page.getByPlaceholder('用法/备注(如:饭后口服)').last().fill('饭后喂服')
    await page.getByRole('button', { name: '保存并开具处方' }).click()
    await expect(page.getByText('处方已开具,药品费用已同步到客户待付款').first()).toBeVisible({ timeout: 30_000 })
    // 处方列表出现所选药品
    await expect(page.getByText(drugName).first()).toBeVisible({ timeout: 30_000 })

    /* ========== 6. 检验 UI:目录选检验项目 + 备注 + 创建申请 ========== */
    console.log('[工作台] 步骤6 检验申请(UI)')
    await page.getByText('检验(0)', { exact: true }).click()
    await pickCatalogItem(page, '搜索检验项目', labName)
    await page.getByPlaceholder('样本要求或备注(可选)').last().fill('EDTA抗凝')
    await page.getByRole('button', { name: '创建检验申请' }).click()
    await expect(page.getByText('检验申请已创建,费用已同步到客户待付款').first()).toBeVisible({ timeout: 30_000 })

    /* ========== 7. 影像 UI:目录选影像项目 + 影像类型 + 临床问题 + 创建申请 ========== */
    console.log('[工作台] 步骤7 影像申请(UI)')
    await page.getByText('影像(0)', { exact: true }).click()
    await pickCatalogItem(page, '搜索影像检查', imagingName)
    // 影像类型(默认 other)改为超声:最后一个 combobox 为影像类型选择器
    await page.locator('[role="combobox"]').filter({ visible: true }).last().click()
    await page.getByRole('option', { name: '超声' }).click()
    await page.getByPlaceholder('请描述检查目的/临床问题').last().fill('排查肠梗阻可能')
    await page.getByRole('button', { name: '创建影像申请' }).click()
    await expect(page.getByText('影像申请已创建,费用已同步到客户待付款').first()).toBeVisible({ timeout: 30_000 })

    /* ========== 8. 医嘱 UI:类型/项目/剂量/频次/数量/单位/说明 + 开立 ========== */
    console.log('[工作台] 步骤8 医嘱开立(UI)')
    await page.getByText('医嘱(0)', { exact: true }).click()
    await page.getByPlaceholder('如:皮下补液/伤口换药').last().fill('皮下补液')
    await page.getByPlaceholder('如:5ml').last().fill('200ml')
    await page.getByPlaceholder('如:每日1次').last().fill('每日1次')
    await page.locator('input[type="number"]').last().fill('1')
    await page.getByPlaceholder('如:次').last().fill('次')
    await page.getByPlaceholder('执行注意事项/计划时间(可选)').last().fill('30分钟内执行')
    await page.getByRole('button', { name: '开立医嘱' }).click()
    await expect(page.getByText('医嘱已开立,护士任务已生成').first()).toBeVisible({ timeout: 30_000 })

    /* ========== 9. 提交诊疗方案:确认摘要(四类单据/费用/下游)→ 原子提交 → 停留工作台 ========== */
    console.log('[工作台] 步骤9 提交诊疗方案')
    await page.getByRole('button', { name: '提交诊疗方案' }).click()
    const dialog = page.locator('.fa-modal, [role="dialog"]').last()
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    // 确认摘要:处方药品与预计待收金额可见
    await expect(dialog.getByText(drugName).first()).toBeVisible({ timeout: 20_000 })
    await expect(dialog.getByText('预计待收金额').first()).toBeVisible({ timeout: 20_000 })
    await clickConfirmInDialog(page)
    // 原子提交成功后停留工作台并弹出成功提示
    await expect(page.getByText('诊疗方案已提交,下游岗位待办已保留').first()).toBeVisible({ timeout: 30_000 })

    /* ========== 10. 数据库断言:四类单据/收费/岗位任务/旅程事件 ========== */
    console.log('[工作台] 步骤10 数据库断言')
    // encounter:临床状态推进到 plan_ready(status 仍为 in_progress,待发药/签署)
    const encFinal = (await supabaseSelect<{ clinical_status: string, status: string }[]>(
      page,
      'encounters',
      `select=clinical_status,status&id=eq.${encounterId}`,
    ))
    expect(encFinal[0].status).toBe('in_progress')
    expect(encFinal[0].clinical_status).toBe('plan_ready')
    // 处方:issued + 明细含所选药品
    const rxs = (await supabaseSelect<{ id: string, status: string }[]>(
      page,
      'prescriptions',
      `select=id,status&encounter_id=eq.${encounterId}`,
    ))
    expect(rxs.length).toBeGreaterThanOrEqual(1)
    expect(rxs[0].status).toBe('issued')
    const rxItems = (await supabaseSelect<{ drug_name: string }[]>(
      page,
      'prescription_items',
      `select=drug_name&prescription_id=eq.${rxs[0].id}`,
    ))
    expect(rxItems.some(item => item.drug_name.includes(drugName))).toBeTruthy()
    // 检验 / 影像申请
    const labs = (await supabaseSelect<{ id: string, status: string }[]>(
      page,
      'lab_orders',
      `select=id,status&encounter_id=eq.${encounterId}`,
    ))
    expect(labs.length).toBeGreaterThanOrEqual(1)
    expect(labs[0].status).toBe('requested')
    const imgs = (await supabaseSelect<{ id: string, status: string }[]>(
      page,
      'imaging_orders',
      `select=id,status&encounter_id=eq.${encounterId}`,
    ))
    expect(imgs.length).toBeGreaterThanOrEqual(1)
    expect(imgs[0].status).toBe('requested')
    // 医嘱 + 护士任务
    const meds = (await supabaseSelect<{ id: string, item_name: string }[]>(
      page,
      'medical_orders',
      `select=id,item_name&encounter_id=eq.${encounterId}`,
    ))
    expect(meds.length).toBeGreaterThanOrEqual(1)
    const nurseTasks = (await supabaseSelect<{ id: string }[]>(
      page,
      'nurse_tasks',
      `select=id&encounter_id=eq.${encounterId}`,
    ))
    expect(nurseTasks.length).toBeGreaterThanOrEqual(1)
    // 收费项:处方 + 检验 + 影像 至少 3 条(由触发器/开具同步生成)
    const charges = (await supabaseSelect<{ id: string, status: string }[]>(
      page,
      'encounter_charge_items',
      `select=id,status&encounter_id=eq.${encounterId}`,
    ))
    expect(charges.length).toBeGreaterThanOrEqual(3)
    expect(charges.every(c => c.status === 'pending')).toBeTruthy()
    // 岗位任务:药房 / 检验 / 影像
    const tasks = (await supabaseSelect<{ owner_role: string }[]>(
      page,
      'workflow_tasks',
      `select=owner_role&encounter_id=eq.${encounterId}&owner_role=in.(pharmacist,lab_technician,imaging_technician)`,
    ))
    const taskRoles = new Set(tasks.map(task => task.owner_role))
    for (const role of ['pharmacist', 'lab_technician', 'imaging_technician']) {
      expect(taskRoles.has(role)).toBeTruthy()
    }
    // 患者旅程:plan/commit 原子事件仅一条(幂等)
    const committed = (await supabaseSelect<{ id: string }[]>(
      page,
      'patient_journey_events',
      `select=id&encounter_id=eq.${encounterId}&event_type=eq.encounter.plan_committed`,
    ))
    expect(committed.length).toBe(1)

    console.log(`[工作台] 完成:customer=${customerId} pet=${petId} encounter=${encounterId}`)
  })
})

/** 定位当前打开的确认弹窗并点击其"确定"按钮(FaModal 确认按钮文案兼容) */
async function clickConfirmInDialog(page: import('@playwright/test').Page) {
  const dialog = page.locator('.fa-modal, [role="dialog"]').last()
  await dialog.waitFor({ state: 'visible', timeout: 20_000 })
  // 确认按钮:排除"取消"后取最后一个可见按钮
  await dialog.locator('button').filter({ hasNotText: '取消' }).last().click()
}

/**
 * 在远程搜索目录选择器中输入关键字并选中首个匹配项(reka-ui Select filterable)。
 * @param page 页面实例
 * @param placeholder 选择器占位符(如"搜索药品"/"搜索检验项目")
 * @param keyword 搜索关键字(须能命中目录项目名称)
 */
async function pickCatalogItem(page: import('@playwright/test').Page, placeholder: string, keyword: string) {
  const input = page.getByPlaceholder(placeholder)
  await input.click()
  await input.fill(keyword)
  // 防抖 300ms + 远程查询后选项渲染,等待首个匹配项出现再点击
  const option = page.locator('[role="option"]').filter({ hasText: keyword }).first()
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
}
