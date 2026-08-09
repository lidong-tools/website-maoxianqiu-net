#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 批量演示数据种子(供前端人工验证,替代慢速 E2E)
 *
 * 思路:直接以 service role 直连 Supabase REST(绕过 RLS),按业务逻辑/状态机
 * 批量插入各业务域演示数据,前端登录后即可在各页面看到成体系、状态齐全的数据。
 *
 * 用法:
 *   node scripts/seed-demo-data.mjs
 *
 * 说明:
 *   - 读取 api/.env.local 中的 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *   - 目标租户/门店动态解析(取第一个 active 租户及其第一门店)
 *   - 幂等:先按 FK 依赖逆序清空该租户全部业务数据,再重新插入
 *   - 状态机按业务约定:预约 pending→confirmed→checked_in→in_progress→completed;
 *     就诊 in_progress→completed→signed;处方 draft→dispensed/cancelled;
 *     发票 draft→confirmed→paid/partially_paid/refunded/cancelled 等
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ============ 1. 环境与上下文 ============ */

// 解析 api/.env.local
function loadEnv(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

const env = {
  ...loadEnv(path.join(rootDir, 'api', '.env.local')),
  ...loadEnv(path.join(rootDir, 'api', '.env')),
}
const URL = env.SUPABASE_URL
const SR = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !SR) {
  console.error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY(请检查 api/.env.local)')
  process.exit(1)
}

const SR_HEADERS = {
  apikey: SR,
  Authorization: `Bearer ${SR}`,
  'Content-Type': 'application/json',
}

/** REST 请求封装 */
async function api(table, { method = 'GET', filter = '', body, prefer } = {}) {
  const res = await fetch(`${URL}/rest/v1/${table}${filter ? `?${filter}` : ''}`, {
    method,
    headers: {
      ...SR_HEADERS,
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${method} ${table}${filter ? `?${filter}` : ''} -> ${res.status} ${await res.text()}`)
  }
  return res.status === 204 ? null : res.json()
}

/** 批量插入,返回带 id 的行(支持单条/数组;PostgREST 要求对象键一致,自动补齐缺失键为 null) */
async function ins(table, rows) {
  const arr = Array.isArray(rows) ? rows : [rows]
  if (arr.length === 0) return []
  const keys = [...new Set(arr.flatMap(r => Object.keys(r)))]
  const normalized = arr.map(r => Object.fromEntries(keys.map(k => [k, r[k] ?? null])))
  return api(table, { method: 'POST', body: normalized, prefer: 'return=representation' })
}

/** 按条件删除(默认按租户) */
async function del(table, filter = `tenant_id=eq.${ctx.tenantId}`) {
  try {
    await api(table, { method: 'DELETE', filter })
  }
  catch (e) {
    // 表不存在或已无数据视为可忽略
    console.warn(`  [清理跳过] ${table}: ${e.message}`)
  }
}

const ctx = {}

/* ============ 2. 解析租户/门店/员工 ============ */

async function resolveContext() {
  const tenants = await api('tenants', { filter: 'select=id,name,status&order=created_at.asc&limit=1' })
  if (!tenants.length) throw new Error('无可用租户')
  ctx.tenantId = tenants[0].id
  ctx.tenantName = tenants[0].name

  const stores = await api('stores', { filter: `select=id,name,code&tenant_id=eq.${ctx.tenantId}&order=created_at.asc&limit=1` })
  if (!stores.length) throw new Error('租户下无门店')
  ctx.storeId = stores[0].id
  ctx.storeName = stores[0].name
  ctx.storeCode = stores[0].code || 'SYS'

  // 取一个 active 员工(其 user_id 作为业务操作人)
  const emps = await api('employees', {
    filter: `select=id,user_id,tenant_id&tenant_id=eq.${ctx.tenantId}&status=eq.active&limit=1`,
  })
  if (!emps.length) throw new Error('租户下无 active 员工')
  ctx.employeeId = emps[0].id
  ctx.userId = emps[0].user_id

  console.log(`租户: ${ctx.tenantName} (${ctx.tenantId})`)
  console.log(`门店: ${ctx.storeName} (${ctx.storeId})`)
  console.log(`员工: ${ctx.employeeId}  user: ${ctx.userId}`)
}

/* ============ 3. 时间与编号工具 ============ */

const NOW = new Date()
function day(offset, hour = 10, min = 0) {
  const d = new Date(NOW)
  d.setDate(d.getDate() + offset)
  d.setHours(hour, min, 0, 0)
  return d
}
const iso = (offset, hour, min) => day(offset, hour, min).toISOString()
const bizDate = (offset) => {
  const d = day(offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const pad = (n, w = 4) => String(n).padStart(w, '0')
let seq = 0
const nextNo = (prefix) => `${prefix}-${pad(++seq)}`
// 病程记录已签署后不可删除(审计保护),重跑种子需保证单号跨运行唯一
const RUN_ID = Date.now().toString(36)
const nextRunNo = (prefix) => `${prefix}-${RUN_ID}-${pad(++seq)}`

/* ============ 4. 清空该租户业务数据(FK 逆序) ============ */

const CLEANUP_TABLES = [
  // 寄养
  'boarding_daily_records', 'boarding_service_charges', 'boarding_stays',
  // 会员/积分
  'point_transactions', 'customer_memberships', 'membership_discount_rules', 'membership_tiers',
  // 回访
  'followup_tasks',
  // 影像
  'imaging_reports', 'imaging_orders',
  // 疫苗/驱虫/提醒
  'vaccine_certificates', 'vaccinations', 'deworming_records', 'diag_reminders',
  // 检验
  'lab_result_reviews', 'critical_value_alerts', 'lab_samples', 'lab_specimens', 'lab_order_analytes', 'lab_orders',
  // 疫苗方案
  'vaccine_protocol_items', 'vaccine_protocols',
  // 住院
  'inpatient_progress_notes', 'inpatient_charges', 'cage_transfers', 'shift_handovers',
  'nursing_tasks', 'nursing_plans', 'admissions', 'cages', 'rooms',
  // 临床(医嘱/护士任务/处方)
  'medical_orders', 'nurse_tasks', 'prescription_items', 'prescriptions',
  // 收费
  'invoice_items', 'invoices', 'payments', 'refunds', 'approvals',
  // 病历/预约
  'encounter_revisions', 'encounters', 'appointments',
  // CRM
  'pet_weights', 'pets', 'customers',
  // 目录
  'store_catalog_items', 'catalog_drug_extensions', 'catalog_vaccine_extensions',
  'catalog_items', 'catalog_categories', 'diagnosis_dict', 'intake_questions',
  'lab_panels', 'lab_analytes',
  // 采购(先于库存:purchase_orders/purchase_requests/purchase_returns 引用 warehouses/suppliers,
  // purchase_return_items 引用 inventory_batches)
  'purchase_return_items', 'purchase_returns',
  'purchase_request_items', 'purchase_requests',
  'purchase_order_items', 'purchase_orders', 'suppliers',
  // 库存(注意:opening_stock_import_requests 引用 warehouses,需先删)
  'opening_stock_import_requests',
  'inventory_movements', 'inventory_balances', 'inventory_batches', 'warehouses',
  // 消息/提醒
  'message_delivery_attempts', 'message_deliveries', 'message_templates', 'reminders',
  // 日结/对账
  'closing_adjustments', 'daily_closings', 'reconciliation_records',
  // 导入(import_job_errors 无 tenant_id,由 import_jobs 级联删除)
  'employee_invite_imports', 'import_jobs',
]

async function cleanup() {
  console.log('\n=== 清理旧演示数据(按 FK 逆序) ===')
  for (const t of CLEANUP_TABLES) {
    try {
      await api(t, { method: 'DELETE', filter: `tenant_id=eq.${ctx.tenantId}` })
      console.log(`  ✓ ${t}`)
    }
    catch (e) {
      console.warn(`  [跳过] ${t}: ${e.message}`)
    }
  }
}

/* ============ 5. 数据统计 ============ */

const stats = {}
function track(table, rows) {
  stats[table] = (stats[table] ?? 0) + (Array.isArray(rows) ? rows.length : 1)
}

async function insertRow(table, row) {
  const [r] = await ins(table, row)
  track(table, 1)
  return r
}

/* ============ 6. 目录 Catalog ============ */

async function seedCatalog() {
  console.log('\n=== 目录 Catalog ===')
  const cats = await ins('catalog_categories', [
    { tenant_id: ctx.tenantId, code: 'service', name: '服务项目', sort_order: 1 },
    { tenant_id: ctx.tenantId, code: 'product', name: '商品', sort_order: 2 },
    { tenant_id: ctx.tenantId, code: 'drug', name: '药品', sort_order: 3 },
    { tenant_id: ctx.tenantId, code: 'vaccine', name: '疫苗', sort_order: 4 },
    { tenant_id: ctx.tenantId, code: 'exam', name: '检验检查', sort_order: 5 },
    { tenant_id: ctx.tenantId, code: 'consumable', name: '耗材', sort_order: 6 },
  ])
  track('catalog_categories', cats)
  const catId = Object.fromEntries(cats.map(c => [c.code, c.id]))

  const items = [
    // 药品
    { code: 'DEMO-DRUG-AMX', name: '阿莫西林胶囊', category: 'drug', unit: '片', price: 15, cost: 5, form: 'tablet' },
    { code: 'DEMO-DRUG-CFX', name: '头孢氨苄片', category: 'drug', unit: '片', price: 12, cost: 4, form: 'tablet' },
    { code: 'DEMO-DRUG-DOX', name: '多西环素片', category: 'drug', unit: '片', price: 10, cost: 3, form: 'tablet' },
    { code: 'DEMO-DRUG-MTZ', name: '甲硝唑片', category: 'drug', unit: '片', price: 8, cost: 2, form: 'tablet' },
    { code: 'DEMO-DRUG-IVM', name: '伊维菌素注射液', category: 'drug', unit: '支', price: 20, cost: 8, form: 'injection' },
    { code: 'DEMO-DRUG-PTL', name: '宠物镇痛片', category: 'drug', unit: '片', price: 6, cost: 2, form: 'tablet' },
    // 疫苗
    { code: 'DEMO-VAC-RAB', name: '狂犬疫苗', category: 'vaccine', unit: '支', price: 60, cost: 25, form: null },
    { code: 'DEMO-VAC-CDV', name: '犬瘟热疫苗', category: 'vaccine', unit: '支', price: 50, cost: 20, form: null },
    { code: 'DEMO-VAC-CPV', name: '犬细小病毒疫苗', category: 'vaccine', unit: '支', price: 55, cost: 22, form: null },
    { code: 'DEMO-VAC-FPV', name: '猫三联疫苗', category: 'vaccine', unit: '支', price: 70, cost: 28, form: null },
    // 检验检查
    { code: 'DEMO-EXM-CBC', name: '血常规', category: 'exam', unit: '项', price: 80, cost: 10, form: null },
    { code: 'DEMO-EXM-BIO', name: '生化全套', category: 'exam', unit: '项', price: 200, cost: 30, form: null },
    { code: 'DEMO-EXM-XRAY', name: 'X光检查(DR)', category: 'exam', unit: '次', price: 150, cost: 20, form: null },
    { code: 'DEMO-EXM-US', name: 'B超检查', category: 'exam', unit: '次', price: 120, cost: 15, form: null },
    // 服务项目
    { code: 'DEMO-SVC-REG', name: '门诊挂号', category: 'service', unit: '次', price: 20, cost: 0, form: null },
    { code: 'DEMO-SVC-PHY', name: '基础体检', category: 'service', unit: '次', price: 100, cost: 0, form: null },
    { code: 'DEMO-SVC-TEETH', name: '洁牙护理', category: 'service', unit: '次', price: 300, cost: 50, form: null },
    { code: 'DEMO-SVC-INFU', name: '输液护理', category: 'service', unit: '次', price: 50, cost: 5, form: null },
    // 商品
    { code: 'DEMO-PRD-FOOD', name: '处方粮(犬)', category: 'product', unit: '袋', price: 45, cost: 20, form: null },
    { code: 'DEMO-PRD-DEW', name: '体外驱虫滴剂', category: 'product', unit: '支', price: 35, cost: 12, form: null },
  ]

  const inserted = await ins('catalog_items', items.map(it => ({
    tenant_id: ctx.tenantId,
    category_id: catId[it.category],
    code: it.code,
    name: it.name,
    unit: it.unit,
    default_price: it.price,
    cost_price: it.cost,
    billing_type: it.category === 'consumable' ? 'product' : it.category,
  })))
  track('catalog_items', inserted)
  const itemId = Object.fromEntries(inserted.map(x => [x.code, x.id]))

  // 药品扩展 / 疫苗扩展
  const drugExt = items.filter(x => x.form).map(x => ({
    catalog_item_id: itemId[x.code], drug_form: x.form, manufacturer: '演示药业',
    is_controlled: x.code === 'DEMO-DRUG-MTZ',
    storage_condition: '阴凉干燥处', shelf_life_days: 730,
  }))
  if (drugExt.length) track('catalog_drug_extensions', await ins('catalog_drug_extensions', drugExt))

  const vacExt = items.filter(x => x.category === 'vaccine').map(x => ({
    catalog_item_id: itemId[x.code], vaccine_type: 'other', manufacturer: '演示生物',
    protocol_course: 1, is_required: true,
  }))
  if (vacExt.length) track('catalog_vaccine_extensions', await ins('catalog_vaccine_extensions', vacExt))

  // 门店目录:批量启用全部目录项到当前门店(收银台/开单均读取 store_catalog_items)
  const storeItems = items.map((it, idx) => ({
    tenant_id: ctx.tenantId,
    store_id: ctx.storeId,
    catalog_item_id: itemId[it.code],
    is_active: true,
    sort_order: idx + 1,
  }))
  // 保留门店价格覆盖示例(门诊挂号 30 / 血常规 90)
  for (const [code, price] of [['DEMO-SVC-REG', 30], ['DEMO-EXM-CBC', 90]]) {
    const row = storeItems.find(s => s.catalog_item_id === itemId[code])
    if (row) row.custom_price = price
  }
  const storeOverrides = await ins('store_catalog_items', storeItems)
  track('store_catalog_items', storeOverrides)

  // 诊断字典 / 问诊问题 / 检验 panel
  const diags = await ins('diagnosis_dict', [
    { tenant_id: ctx.tenantId, code: 'CDV', name: '犬瘟热', category: '传染' },
    { tenant_id: ctx.tenantId, code: 'CPV', name: '犬细小病毒病', category: '传染' },
    { tenant_id: ctx.tenantId, code: 'FPV', name: '猫瘟', category: '传染' },
    { tenant_id: ctx.tenantId, code: 'GE', name: '急性胃肠炎', category: '内科' },
    { tenant_id: ctx.tenantId, code: 'SFI', name: '皮肤真菌感染', category: '皮肤' },
    { tenant_id: ctx.tenantId, code: 'URI', name: '上呼吸道感染', category: '内科' },
    { tenant_id: ctx.tenantId, code: 'FRX', name: '股骨骨折', category: '外科' },
    { tenant_id: ctx.tenantId, code: 'CYST', name: '膀胱结石', category: '泌尿' },
  ])
  track('diagnosis_dict', diags)
  const qs = await ins('intake_questions', [
    { tenant_id: ctx.tenantId, category: 'symptom', question: '最近食欲如何?', sort_order: 1 },
    { tenant_id: ctx.tenantId, category: 'history', question: '是否按时接种疫苗?', sort_order: 2 },
  ])
  track('intake_questions', qs)

  const [panelCBC, panelBIO] = await ins('lab_panels', [
    { tenant_id: ctx.tenantId, code: 'DEMO-PANEL-CBC', name: '血常规五分类', category: 'blood', sample_type: '全血' },
    { tenant_id: ctx.tenantId, code: 'DEMO-PANEL-BIO', name: '生化全套', category: 'biochem', sample_type: '血清' },
  ])
  track('lab_panels', 2)
  const analytes = await ins('lab_analytes', [
    { panel_id: panelCBC.id, code: 'WBC', name: '白细胞', unit: '10^9/L', ref_range_low: 6, ref_range_high: 17 },
    { panel_id: panelCBC.id, code: 'RBC', name: '红细胞', unit: '10^12/L', ref_range_low: 5.5, ref_range_high: 8.5 },
    { panel_id: panelCBC.id, code: 'PLT', name: '血小板', unit: '10^9/L', ref_range_low: 200, ref_range_high: 500 },
    { panel_id: panelBIO.id, code: 'ALT', name: '丙氨酸氨基转移酶', unit: 'U/L', ref_range_low: 10, ref_range_high: 100 },
    { panel_id: panelBIO.id, code: 'CREA', name: '肌酐', unit: 'μmol/L', ref_range_low: 44, ref_range_high: 159 },
  ])
  track('lab_analytes', analytes)
  ctx.labAnalytes = {
    WBC: analytes[0].id, RBC: analytes[1].id, PLT: analytes[2].id,
    ALT: analytes[3].id, CREA: analytes[4].id,
  }

  return itemId
}

/* ============ 7. 库存 Inventory ============ */

async function seedInventory(itemId) {
  console.log('\n=== 库存 Inventory ===')
  const whDef = await insertRow('warehouses', {
    tenant_id: ctx.tenantId, store_id: ctx.storeId, name: '默认仓库', code: 'WH-DEF', is_default: true,
  })
  const whSub = await insertRow('warehouses', {
    tenant_id: ctx.tenantId, store_id: ctx.storeId, name: '二级仓库', code: 'WH-SUB', is_default: false,
  })
  ctx.warehouses = { def: whDef.id, sub: whSub.id }

  // 批次定义: [itemCode, warehouse, qty, expiryOffsetDays, unitCost]
  const batchPlan = [
    ['DEMO-DRUG-AMX', 'def', 120, 400, 5], ['DEMO-DRUG-AMX', 'def', 60, 120, 5],
    ['DEMO-DRUG-CFX', 'def', 100, 350, 4], ['DEMO-DRUG-DOX', 'def', 150, 300, 3],
    ['DEMO-DRUG-MTZ', 'def', 80, 200, 2], ['DEMO-DRUG-IVM', 'def', 60, 500, 8],
    ['DEMO-DRUG-IVM', 'sub', 30, 450, 8], ['DEMO-DRUG-PTL', 'def', 90, 250, 2],
    ['DEMO-VAC-RAB', 'def', 40, 600, 25], ['DEMO-VAC-CDV', 'def', 30, 500, 20],
    ['DEMO-VAC-CPV', 'def', 30, 500, 22], ['DEMO-VAC-FPV', 'def', 25, 480, 28],
  ]

  // 已发放(发药)扣减计划:按处方发放量回填批次
  const dispensedPlan = {
    'DEMO-DRUG-AMX': 10, 'DEMO-DRUG-CFX': 6, 'DEMO-DRUG-DOX': 8, 'DEMO-DRUG-MTZ': 4,
    'DEMO-DRUG-IVM': 3, 'DEMO-DRUG-PTL': 6,
  }

  const batches = []
  const batchRows = batchPlan.map(([code, whKey, qty, expiryDays, cost]) => ({
    tenant_id: ctx.tenantId, warehouse_id: ctx.warehouses[whKey], catalog_item_id: itemId[code],
    batch_no: `DEMO-BATCH-${code.slice(9)}-${expiryDays}`,
    received_date: bizDate(-30), expiry_date: bizDate(expiryDays),
    quantity_received: qty,
    // FEFO 从最早批次扣减
    quantity_remaining: Math.max(qty - (dispensedPlan[code] ?? 0), 0),
    unit_cost: cost, supplier: '演示药业', status: qty - (dispensedPlan[code] ?? 0) > 0 ? 'active' : 'exhausted',
  }))
  const insertedBatches = await ins('inventory_batches', batchRows)
  track('inventory_batches', insertedBatches)
  batchPlan.forEach(([code, whKey], i) => {
    batches.push({ ...insertedBatches[i], code, whKey })
  })

  // 流水 + 余额:按 (仓库,商品) 累计
  const movements = []
  const balances = new Map() // `${wh}:${itemCode}` -> {qty}
  const key = (w, c) => `${w}:${c}`
  const recvBy = new Map()
  for (const b of batches) {
    const k = key(b.warehouse_id, b.catalog_item_id)
    recvBy.set(k, (recvBy.get(k) ?? 0) + b.quantity_received)
    balances.set(k, (balances.get(k) ?? 0) + b.quantity_received)
  }
  let mSeq = 0
  for (const [code, whKey, qty] of batchPlan) {
    const w = ctx.warehouses[whKey]
    const k = key(w, itemId[code])
    const q = recvBy.get(k)
    balances.set(k, 0) // 重置,按流水顺序累计
    let running = 0
    // 1) 入库
    for (const b of batches.filter(x => x.warehouse_id === w && x.code === code)) {
      running += b.quantity_received
      movements.push({
        tenant_id: ctx.tenantId, warehouse_id: w, catalog_item_id: itemId[code], batch_id: b.id,
        movement_type: 'receive', quantity: b.quantity_received, balance_after: running,
        reference_type: 'purchase_order', reference_id: null, idempotency_key: `demo-recv-${++mSeq}`,
        operator_id: ctx.userId, created_at: iso(-20 + mSeq % 5, 9),
      })
    }
    // 2) 发药扣减
    const disp = dispensedPlan[code] ?? 0
    if (disp > 0) {
      running -= disp
      movements.push({
        tenant_id: ctx.tenantId, warehouse_id: w, catalog_item_id: itemId[code],
        batch_id: batches.find(x => x.warehouse_id === w && x.code === code)?.id ?? null,
        movement_type: 'dispense', quantity: -disp, balance_after: running,
        reference_type: 'prescription', reference_id: null, idempotency_key: `demo-disp-${++mSeq}`,
        operator_id: ctx.userId, created_at: iso(-3, 15),
      })
    }
    balances.set(k, running)
  }
  if (movements.length) track('inventory_movements', await ins('inventory_movements', movements))

  const balRows = []
  for (const [k, qty] of balances) {
    const [w, item] = k.split(':')
    balRows.push({
      tenant_id: ctx.tenantId, warehouse_id: w, catalog_item_id: item,
      quantity_on_hand: qty, quantity_reserved: 0,
    })
  }
  track('inventory_balances', await ins('inventory_balances', balRows))
}

/* ============ 8. CRM 客户/宠物 ============ */

async function seedCrm() {
  console.log('\n=== CRM 客户/宠物 ===')

  // [序号, 姓名, 性别, 手机, 等级, 积分, 余额, 来源, 状态, 生日年龄]
  const custDefs = [
    ['张伟', 'male', '13800000001', 'gold', 3200, 200, 'walk_in'],
    ['李娜', 'female', '13800000002', 'silver', 1500, 80, 'referral'],
    ['王强', 'male', '13800000003', 'diamond', 5800, 500, 'online'],
    ['刘洋', 'male', '13800000004', 'normal', 0, 0, 'walk_in'],
    ['陈静', 'female', '13800000005', 'gold', 2600, 150, 'referral'],
    ['杨帆', 'male', '13800000006', 'normal', 300, 0, 'walk_in'],
    ['赵敏', 'female', '13800000007', 'silver', 1900, 120, 'online'],
    ['孙磊', 'male', '13800000008', 'normal', 500, 0, 'walk_in'],
    ['周芳', 'female', '13800000009', 'diamond', 6100, 800, 'referral'],
    ['吴迪', 'male', '13800000010', 'normal', 100, 0, 'walk_in'],
  ]
  const customers = await ins('customers', custDefs.map((c, i) => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_no: `DEMO-CUST-${bizDate(0)}-${pad(i + 1)}`,
    name: c[0], gender: c[1], phone: c[2], member_level: c[3],
    member_points: c[4], balance: c[5], source: c[6],
    birthday: `${2000 - i * 3}-0${(i % 9) + 1}-1${i % 9}`,
    remark: '演示数据-批量客户', created_by: ctx.userId,
  })))
  track('customers', customers)
  const custId = Object.fromEntries(customers.map((c, i) => [custDefs[i][0], c.id]))
  ctx.custId = custId

  // 归档客户 + 合并客户(演示状态)
  const [archivedC] = await ins('customers', [{
    tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_no: `DEMO-CUST-${bizDate(0)}-ARCH`,
    name: '演示客户-已归档', gender: 'unknown', phone: '13800000091', member_level: 'normal',
    status: 'archived', archived_at: iso(-30), created_by: ctx.userId,
  }])
  track('customers', 1)
  const [mergedC] = await ins('customers', [{
    tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_no: `DEMO-CUST-${bizDate(0)}-MRG`,
    name: '演示客户-已合并', gender: 'unknown', phone: '13800000092', member_level: 'normal',
    status: 'merged', merged_into: custId['张伟'], archived_at: iso(-10), created_by: ctx.userId,
  }])
  track('customers', 1)

  // 宠物定义: [归属客户, 名字, 物种, 品种, 性别, 体重kg, 绝育, 风险标签, 状态]
  const petDefs = [
    ['张伟', '大黄', '犬', '金毛寻回犬', 'male', 28.5, true, [], null],
    ['张伟', '豆豆', '犬', '泰迪', 'female', 4.2, false, [], null],
    ['李娜', '咪咪', '猫', '英短', 'female', 4.8, true, [], null],
    ['李娜', '雪球', '猫', '布偶', 'male', 5.1, false, [], 'deceased'],
    ['王强', '虎子', '猫', '狸花', 'male', 5.6, false, ['aggressive'], null],
    ['王强', '花花', '猫', '加菲', 'female', 4.0, true, [], null],
    ['刘洋', '跳跳', '兔', '垂耳兔', 'male', 1.8, false, [], null],
    ['陈静', '旺财', '犬', '柴犬', 'male', 9.2, true, [], 'lost'],
    ['杨帆', '乐乐', '犬', '柯基', 'female', 11.0, true, ['allergy'], null],
    ['赵敏', '团子', '猫', '美短', 'male', 4.5, true, [], null],
    ['赵敏', '汤圆', '猫', '橘猫', 'male', 6.2, false, [], null],
    ['孙磊', '大圣', '犬', '边境牧羊犬', 'male', 18.4, true, [], null],
    ['周芳', '富贵', '猫', '蓝猫', 'male', 5.8, true, ['chronic'], null],
    ['吴迪', '灰灰', '兔', '侏儒兔', 'female', 1.2, false, [], null],
  ]
  const pets = await ins('pets', petDefs.map((p, i) => ({
    tenant_id: ctx.tenantId, customer_id: custId[p[0]], name: p[1], species: p[2], breed: p[3],
    gender: p[4], birth_date: `${2022 - i % 4}-0${(i % 9) + 1}-1${i % 9}`, weight: p[5],
    is_neutered: p[6], risk_tags: p[7], status: p[8] ?? 'active',
    medical_notes: '演示宠物', remark: '批量演示数据',
  })))
  track('pets', pets)
  ctx.petId = Object.fromEntries(pets.map((p, i) => [p.name, p.id]))

  // 体重记录
  const weights = await ins('pet_weights', petDefs.map((p, i) => ({
    tenant_id: ctx.tenantId, pet_id: pets[i].id, weight: p[5], recorded_at: iso(-1), recorded_by: ctx.userId,
  })))
  track('pet_weights', weights)

  // ===== 批量扩展:20 个生成客户 + 20 只生成宠物(列表分页/筛选验证) =====
  const genCustDefs = Array.from({ length: 20 }, (_, i) => ({
    key: 'G' + pad(i + 1),
    name: `演示客户${pad(i + 1)}`,
    gender: i % 2 ? 'female' : 'male',
    phone: `139${String(10000000 + i * 137).slice(-8)}`,
    level: ['normal', 'silver', 'gold', 'diamond'][i % 4],
    points: (i % 6) * 200 + 50,
    balance: (i % 4) * 60,
    source: ['walk_in', 'online', 'referral'][i % 3],
  }))
  const genCusts = await ins('customers', genCustDefs.map((c, i) => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_no: `DEMO-CUST-${bizDate(0)}-G${pad(i + 1)}`,
    name: c.name, gender: c.gender, phone: c.phone, member_level: c.level,
    member_points: c.points, balance: c.balance, source: c.source,
    birthday: `${1995 + (i % 15)}-${(i % 12) + 1}-15`,
    remark: '演示数据-生成客户', created_by: ctx.userId,
  })))
  track('customers', genCusts)
  genCustDefs.forEach((c, i) => { ctx.custId[c.key] = genCusts[i].id })

  const genPetDefs = genCustDefs.map((c, i) => ({
    key: c.key,
    name: `演示宠${pad(i + 1)}`,
    species: ['犬', '猫', '兔', '仓鼠'][i % 4],
    breed: ['比熊', '暹罗猫', '垂耳兔', '金丝熊'][i % 4],
    gender: i % 2 ? 'female' : 'male',
    weight: 2 + (i % 15) * 1.5,
    neutered: i % 3 === 0,
  }))
  const genPets = await ins('pets', genPetDefs.map((p, i) => ({
    tenant_id: ctx.tenantId, customer_id: ctx.custId[p.key], name: p.name, species: p.species, breed: p.breed,
    gender: p.gender, birth_date: `${2020 + (i % 4)}-${(i % 9) + 1}-10`,
    weight: p.weight, is_neutered: p.neutered, status: 'active',
    medical_notes: '批量生成宠物', remark: '演示数据-生成宠物',
  })))
  track('pets', genPets)
  genPetDefs.forEach((p, i) => { ctx.petId[p.key] = genPets[i].id })

  const genWeights = await ins('pet_weights', genPets.map((p, i) => ({
    tenant_id: ctx.tenantId, pet_id: p.id, weight: genPetDefs[i].weight, recorded_at: iso(-1), recorded_by: ctx.userId,
  })))
  track('pet_weights', genWeights)
}

/* ============ 9. 临床 Clinical ============ */

async function seedClinical(itemId) {
  console.log('\n=== 临床 Clinical ===')
  const appts = [
    // 今日待就诊 / 候诊 / 就诊中
    { customer: '张伟', pet: '大黄', reason: '咳嗽发热复诊', offset: 0, hour: 11, status: 'checked_in', source: 'online' },
    { customer: '李娜', pet: '咪咪', reason: '食欲不振检查', offset: 0, hour: 14, status: 'in_progress', source: 'walk_in' },
    { customer: '陈静', pet: '旺财', reason: '疫苗接种', offset: 0, hour: 16, status: 'pending', source: 'online' },
    { customer: '孙磊', pet: '大圣', reason: '摔伤检查', offset: 0, hour: 15, status: 'confirmed', source: 'phone' },
    // 历史完成
    { customer: '张伟', pet: '大黄', reason: '犬瘟热初诊', offset: -7, hour: 10, status: 'completed', source: 'online' },
    { customer: '李娜', pet: '咪咪', reason: '绝育术后复查', offset: -1, hour: 11, status: 'completed', source: 'walk_in' },
    { customer: '王强', pet: '雪球', reason: '呼吸道感染', offset: -14, hour: 9, status: 'completed', source: 'online' },
    { customer: '王强', pet: '虎子', reason: '猫瘟排查', offset: -30, hour: 10, status: 'completed', source: 'walk_in' },
    { customer: '王强', pet: '花花', reason: '皮肤真菌感染', offset: -2, hour: 14, status: 'completed', source: 'walk_in' },
    { customer: '孙磊', pet: '大圣', reason: '体检复查', offset: -1, hour: 9, status: 'completed', source: 'online' },
    { customer: '周芳', pet: '富贵', reason: '膀胱结石复查', offset: 0, hour: 10, status: 'completed', source: 'online' },
    // 未来预约
    { customer: '赵敏', pet: '团子', reason: '疫苗加强针', offset: 5, hour: 10, status: 'pending', source: 'online' },
    { customer: '赵敏', pet: '汤圆', reason: '年度体检', offset: 7, hour: 15, status: 'confirmed', source: 'phone' },
    { customer: '陈静', pet: '旺财', reason: '复诊', offset: 3, hour: 14, status: 'confirmed', source: 'online' },
    // 取消 / 失约
    { customer: '陈静', pet: '旺财', reason: '洗澡美容', offset: -5, hour: 16, status: 'cancelled', source: 'phone' },
    { customer: '杨帆', pet: '乐乐', reason: '过敏复诊', offset: -3, hour: 10, status: 'no_show', source: 'walk_in' },
  ]
  const apptRows = await ins('appointments', appts.map(a => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId,
    customer_id: ctx.custId[a.customer], pet_id: ctx.petId[a.pet], doctor_id: ctx.userId,
    scheduled_start: iso(a.offset, a.hour), scheduled_end: iso(a.offset, a.hour, 30),
    reason: `演示-${a.reason}`, status: a.status, source: a.source,
    created_by: ctx.userId, remark: '批量演示预约',
  })))
  track('appointments', apptRows)
  // 预约 → 病历映射
  const encPlan = [
    { appt: 0, pet: '大黄', status: 'in_progress', offset: 0, complaint: '咳嗽发热3天,精神差,食欲下降', text: '现病史:咳嗽发热,抗生素治疗后缓解不明显' },
    { appt: 4, pet: '大黄', status: 'signed', offset: -7, complaint: '发热、眼鼻分泌物,疑犬瘟', text: '确诊犬瘟热,已隔离治疗' },
    { appt: 5, pet: '咪咪', status: 'completed', offset: -1, complaint: '绝育术后恢复良好', text: '伤口愈合良好,建议一周后拆线' },
    { appt: 1, pet: '咪咪', status: 'in_progress', offset: 0, complaint: '食欲不振3天,偶有呕吐', text: '查体:体温38.9℃,腹部触诊未见异常' },
    { appt: 6, pet: '雪球', status: 'signed', offset: -14, complaint: '流鼻涕、打喷嚏', text: '诊断为上呼吸道感染,对症治疗' },
    { appt: 7, pet: '虎子', status: 'signed', offset: -30, complaint: '发热呕吐,疑似猫瘟', text: '猫瘟排查阴性,支持治疗' },
    { appt: 8, pet: '花花', status: 'completed', offset: -2, complaint: '皮肤脱毛、红斑', text: '确诊皮肤真菌感染,外用抗真菌药' },
    { appt: 9, pet: '大圣', status: 'signed', offset: -1, complaint: '运动后跛行', text: 'X光未见骨折,软组织挫伤' },
    { appt: 10, pet: '富贵', status: 'signed', offset: 0, complaint: '排尿困难,血尿', text: 'B超提示膀胱结石,建议手术' },
  ]
  const encounters = await ins('encounters', encPlan.map(e => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId,
    appointment_id: apptRows[e.appt].id,
    customer_id: apptRows[e.appt].customer_id, pet_id: apptRows[e.appt].pet_id,
    doctor_id: ctx.userId,
    started_at: iso(e.offset, e.offset === 0 ? 10 : 9), ended_at: e.status === 'in_progress' ? null : iso(e.offset, 11),
    status: e.status, chief_complaint: `演示-${e.complaint}`, history_present: e.text,
    diagnosis_codes: ['GE'], diagnosis_text: '演示诊断:急性胃肠炎',
    treatment_plan: '对症支持治疗,3日后复查',
    signed_by: e.status === 'signed' ? ctx.userId : null,
    signed_at: e.status === 'signed' ? iso(e.offset, 12) : null,
  })))
  track('encounters', encounters)
  ctx.encId = Object.fromEntries(encounters.map((en, i) => [encPlan[i].pet + '-' + encPlan[i].status, en.id]))
  // 额外独立就诊(无预约)
  const [enc10] = await ins('encounters', [{
    tenant_id: ctx.tenantId, store_id: ctx.storeId, appointment_id: null,
    customer_id: ctx.custId['吴迪'], pet_id: ctx.petId['灰灰'], doctor_id: ctx.userId,
    started_at: iso(0, 10), status: 'in_progress',
    chief_complaint: '演示-拉稀腹泻', history_present: '食用生冷蔬菜后腹泻2天',
    diagnosis_codes: ['GE'], diagnosis_text: '演示诊断:急性肠炎', treatment_plan: '补液+益生菌',
  }])
  track('encounters', 1)
  ctx.encId['灰灰'] = enc10.id

  // 修订记录(已签署病历演示)
  const revisions = await ins('encounter_revisions', [
    { encounter_id: ctx.encId['大黄-signed'], revision_no: 1, content_diff: { chief_complaint: '咳嗽发热3天(复诊记录)' }, revised_by: ctx.userId, reason: '演示-补充复诊记录' },
    { encounter_id: ctx.encId['雪球-signed'], revision_no: 1, content_diff: { diagnosis_text: '上呼吸道感染(细菌性)' }, revised_by: ctx.userId, reason: '演示-修正诊断' },
  ])
  track('encounter_revisions', revisions)

  // 处方: [就诊key, 商品code, 数量, 状态]
  const rxPlan = [
    { enc: '大黄-in_progress', items: [{ code: 'DEMO-DRUG-AMX', qty: 14 }], status: 'draft' },
    { enc: '大黄-signed', items: [{ code: 'DEMO-DRUG-AMX', qty: 10 }, { code: 'DEMO-SVC-INFU', qty: 3 }], status: 'dispensed' },
    { enc: '咪咪-completed', items: [{ code: 'DEMO-DRUG-CFX', qty: 6 }], status: 'dispensed' },
    { enc: '雪球-signed', items: [{ code: 'DEMO-DRUG-CFX', qty: 6 }, { code: 'DEMO-DRUG-DOX', qty: 8 }], status: 'dispensed' },
    { enc: '虎子-signed', items: [{ code: 'DEMO-DRUG-DOX', qty: 5 }], status: 'cancelled' },
    { enc: '花花-completed', items: [{ code: 'DEMO-DRUG-PTL', qty: 6 }], status: 'dispensed' },
    { enc: '大圣-signed', items: [{ code: 'DEMO-DRUG-PTL', qty: 6 }, { code: 'DEMO-DRUG-IVM', qty: 2 }], status: 'dispensed' },
    { enc: '富贵-signed', items: [{ code: 'DEMO-DRUG-MTZ', qty: 4 }], status: 'dispensed' },
    { enc: '咪咪-in_progress', items: [{ code: 'DEMO-DRUG-DOX', qty: 7 }], status: 'draft' },
  ]
  const rxRows = []
  for (const r of rxPlan) {
    const enc = encounters[encPlan.findIndex(e => e.pet + '-' + e.status === r.enc) ?? -1]
    const [rx] = await ins('prescriptions', [{
      tenant_id: ctx.tenantId, store_id: ctx.storeId, encounter_id: ctx.encId[r.enc],
      customer_id: enc.customer_id, pet_id: enc.pet_id, doctor_id: ctx.userId, status: r.status,
    }])
    rxRows.push(rx)
    const items = await ins('prescription_items', r.items.map((it, i) => ({
      prescription_id: rx.id, catalog_item_id: itemId[it.code],
      drug_name: getItemName(it.code, itemId) || it.code,
      dosage: '按体重', frequency: '每日2次', duration_days: 7, quantity: it.qty, unit: '片/次',
      instructions: '饭后服用', sort_order: i,
    })))
    track('prescription_items', items)
  }
  track('prescriptions', rxRows)
  ctx.rxByStatus = rxRows

  // 医嘱 + 护士任务
  const [mo1, mo2] = await ins('medical_orders', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, encounter_id: ctx.encId['大黄-in_progress'], pet_id: ctx.petId['大黄'], customer_id: ctx.custId['张伟'], order_no: nextNo('DEMO-MO'), order_type: 'medication', item_name: '阿莫西林口服', dosage: '1片', frequency: 'bid', status: 'active', created_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, encounter_id: ctx.encId['大黄-in_progress'], pet_id: ctx.petId['大黄'], customer_id: ctx.custId['张伟'], order_no: nextNo('DEMO-MO'), order_type: 'infusion', item_name: '静脉输液', dosage: '250ml', frequency: 'qd', status: 'active', created_by: ctx.userId },
  ])
  track('medical_orders', 2)
  const [mo3] = await ins('medical_orders', [{
    tenant_id: ctx.tenantId, store_id: ctx.storeId, encounter_id: ctx.encId['咪咪-in_progress'], pet_id: ctx.petId['咪咪'], customer_id: ctx.custId['李娜'],
    order_no: nextNo('DEMO-MO'), order_type: 'treatment', item_name: '皮下补液', dosage: '50ml', frequency: 'qd',
    status: 'completed', created_by: ctx.userId, completed_at: iso(0, 12), completed_by: ctx.userId,
  }])
  track('medical_orders', 1)

  const ntRows = await ins('nurse_tasks', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, encounter_id: ctx.encId['大黄-in_progress'], pet_id: ctx.petId['大黄'], assigned_to: ctx.userId, task_type: 'medication', description: '演示-喂服阿莫西林', scheduled_at: iso(0, 14), status: 'pending', started_at: null, completed_at: null, completed_by: null, source_type: 'medical_order', source_id: mo1.id },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, encounter_id: ctx.encId['大黄-in_progress'], pet_id: ctx.petId['大黄'], assigned_to: ctx.userId, task_type: 'care', description: '演示-输液观察', scheduled_at: iso(0, 15), status: 'in_progress', started_at: iso(0, 15), completed_at: null, completed_by: null, source_type: 'medical_order', source_id: mo2.id },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, encounter_id: ctx.encId['咪咪-in_progress'], pet_id: ctx.petId['咪咪'], assigned_to: ctx.userId, task_type: 'observation', description: '演示-皮下补液已完成', scheduled_at: iso(0, 11), status: 'done', started_at: iso(0, 11), completed_at: iso(0, 12), completed_by: ctx.userId, source_type: 'medical_order', source_id: mo3.id },
  ])
  track('nurse_tasks', ntRows)

  // ===== 批量扩展:24 个生成预约(状态轮换,列表/筛选验证) =====
  const genStatuses = ['pending', 'confirmed', 'completed', 'completed', 'cancelled', 'no_show', 'checked_in', 'in_progress']
  const genAppts = Array.from({ length: 24 }, (_, i) => {
    const gkey = 'G' + pad((i % 20) + 1)
    const status = genStatuses[i % genStatuses.length]
    const offset = status === 'pending' || status === 'confirmed'
      ? 1 + (i % 6)
      : status === 'completed' || status === 'cancelled' || status === 'no_show'
        ? -(1 + (i % 12))
        : 0
    return {
      customer: gkey, pet: gkey, reason: `批量${i + 1}号预约`,
      offset, hour: 9 + (i % 8), status, source: ['online', 'walk_in', 'phone'][i % 3],
    }
  })
  const genApptRows = await ins('appointments', genAppts.map(a => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId,
    customer_id: ctx.custId[a.customer], pet_id: ctx.petId[a.pet], doctor_id: ctx.userId,
    scheduled_start: iso(a.offset, a.hour), scheduled_end: iso(a.offset, a.hour, 30),
    reason: `演示-${a.reason}`, status: a.status, source: a.source,
    created_by: ctx.userId, remark: '批量演示预约',
  })))
  track('appointments', genApptRows)
  ctx.genAppts = genApptRows

  // 为其中 completed/checked_in/in_progress 的预约生成就诊
  const genEncPlan = []
  for (let i = 0; i < genAppts.length; i++) {
    const a = genAppts[i]
    if (a.status === 'completed' || a.status === 'checked_in' || a.status === 'in_progress') {
      genEncPlan.push({ appt: i, offset: a.offset, status: a.status === 'in_progress' ? 'in_progress' : i % 2 ? 'signed' : 'completed' })
    }
  }
  const genEncs = await ins('encounters', genEncPlan.map(e => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId,
    appointment_id: genApptRows[e.appt].id,
    customer_id: genApptRows[e.appt].customer_id, pet_id: genApptRows[e.appt].pet_id,
    doctor_id: ctx.userId,
    started_at: iso(e.offset, 9), ended_at: e.status === 'in_progress' ? null : iso(e.offset, 11),
    status: e.status, chief_complaint: `演示-批量就诊${e.appt + 1}`,
    history_present: '批量演示病史', diagnosis_codes: ['GE'], diagnosis_text: '演示诊断:消化道症状',
    treatment_plan: '对症支持治疗',
    signed_by: e.status === 'signed' ? ctx.userId : null,
    signed_at: e.status === 'signed' ? iso(e.offset, 12) : null,
  })))
  track('encounters', genEncs)
  genEncPlan.forEach((e, i) => { ctx.encId['GENC' + pad(i + 1)] = genEncs[i].id })
  // 供发票/处方扩展引用
  ctx.genEncs = genEncPlan.map((e, i) => ({
    key: 'GENC' + pad(i + 1), id: genEncs[i].id, status: e.status,
    customer_id: genEncs[i].customer_id, pet_id: genEncs[i].pet_id,
  }))
}

async function getItemName(code, itemId) {
  const names = {
    'DEMO-DRUG-AMX': '阿莫西林胶囊', 'DEMO-DRUG-CFX': '头孢氨苄片', 'DEMO-DRUG-DOX': '多西环素片',
    'DEMO-DRUG-MTZ': '甲硝唑片', 'DEMO-DRUG-IVM': '伊维菌素注射液', 'DEMO-DRUG-PTL': '宠物镇痛片',
    'DEMO-SVC-INFU': '输液护理', 'DEMO-SVC-REG': '门诊挂号', 'DEMO-EXM-CBC': '血常规',
  }
  return names[code]
}

/* ============ 10. 收费 Billing ============ */

async function seedBilling(itemId) {
  console.log('\n=== 收费 Billing ===')
  // 发票定义: [就诊key, 状态, 明细[[code, qty, price]], 折扣, 支付]
  const invPlan = [
    { enc: '大黄-signed', status: 'paid', items: [['DEMO-DRUG-AMX', 10, 15], ['DEMO-SVC-INFU', 3, 50]], discount: 0, pay: 'cash', payAmt: null },
    { enc: '咪咪-completed', status: 'paid', items: [['DEMO-DRUG-CFX', 6, 12]], discount: 0, pay: 'wechat', payAmt: null },
    { enc: '雪球-signed', status: 'refunded', items: [['DEMO-DRUG-CFX', 6, 12], ['DEMO-DRUG-DOX', 8, 10]], discount: 0, pay: 'alipay', payAmt: null },
    { enc: '虎子-signed', status: 'cancelled', items: [['DEMO-DRUG-DOX', 5, 10]], discount: 0, pay: null, payAmt: null },
    { enc: '花花-completed', status: 'paid', items: [['DEMO-DRUG-PTL', 6, 6]], discount: 0, pay: 'cash', payAmt: null },
    { enc: '大圣-signed', status: 'paid', items: [['DEMO-DRUG-PTL', 6, 6], ['DEMO-EXM-XRAY', 1, 150]], discount: 15, pay: 'card', payAmt: null },
    { enc: '富贵-signed', status: 'partially_paid', items: [['DEMO-DRUG-MTZ', 4, 8], ['DEMO-EXM-US', 1, 120]], discount: 0, pay: 'cash', payAmt: 80 },
    { enc: '大黄-in_progress', status: 'draft', items: [['DEMO-DRUG-AMX', 14, 15]], discount: 0, pay: null, payAmt: null },
    { enc: '咪咪-in_progress', status: 'draft', items: [['DEMO-DRUG-DOX', 7, 10]], discount: 0, pay: null, payAmt: null },
    { enc: '灰灰', status: 'confirmed', items: [['DEMO-SVC-REG', 1, 20], ['DEMO-DRUG-DOX', 5, 10]], discount: 0, pay: null, payAmt: null },
  ]

  const encByKey = {}
  const allEnc = await api('encounters', { filter: `select=id,customer_id,pet_id&tenant_id=eq.${ctx.tenantId}&limit=100` })
  for (const e of allEnc) {
    if (e.id === ctx.encId['大黄-in_progress']) encByKey['大黄-in_progress'] = e
    if (e.id === ctx.encId['大黄-signed']) encByKey['大黄-signed'] = e
    if (e.id === ctx.encId['咪咪-completed']) encByKey['咪咪-completed'] = e
    if (e.id === ctx.encId['咪咪-in_progress']) encByKey['咪咪-in_progress'] = e
    if (e.id === ctx.encId['雪球-signed']) encByKey['雪球-signed'] = e
    if (e.id === ctx.encId['虎子-signed']) encByKey['虎子-signed'] = e
    if (e.id === ctx.encId['花花-completed']) encByKey['花花-completed'] = e
    if (e.id === ctx.encId['大圣-signed']) encByKey['大圣-signed'] = e
    if (e.id === ctx.encId['富贵-signed']) encByKey['富贵-signed'] = e
    if (e.id === ctx.encId['灰灰']) encByKey['灰灰'] = e
  }

  let invSeq = 0
  for (const plan of invPlan) {
    const enc = encByKey[plan.enc]
    const subtotal = plan.items.reduce((s, it) => s + it[1] * it[2], 0)
    const total = Math.max(subtotal - plan.discount, 0)
    const paid = plan.status === 'paid' ? total
      : plan.status === 'partially_paid' ? (plan.payAmt ?? total / 2)
        : plan.status === 'refunded' ? total : 0
    const invNo = `DEMO-INV-${bizDate(0)}-${pad(++invSeq)}`
    const [inv] = await ins('invoices', [{
      tenant_id: ctx.tenantId, store_id: ctx.storeId, invoice_no: invNo,
      customer_id: enc.customer_id, pet_id: enc.pet_id, encounter_id: enc.id,
      subtotal, discount_amount: plan.discount, tax_amount: 0, total, paid_amount: paid,
      status: plan.status, payment_method: plan.pay,
      confirmed_at: ['paid', 'partially_paid', 'refunded', 'confirmed'].includes(plan.status) ? iso(-2, 11) : null,
      confirmed_by: ctx.userId, created_by: ctx.userId,
    }])
    track('invoices', 1)
    const items = await ins('invoice_items', plan.items.map((it, i) => ({
      tenant_id: ctx.tenantId, invoice_id: inv.id, catalog_item_id: itemId[it[0]],
      name: it[0], unit_price: it[2], quantity: it[1], amount: it[1] * it[2], sort_order: i,
      category: it[0].startsWith('DEMO-DRUG') ? 'drug' : it[0].startsWith('DEMO-EXM') ? 'exam' : it[0].startsWith('DEMO-VAC') ? 'vaccine' : 'service',
    })))
    track('invoice_items', items)
    ctx.invByKey = { ...(ctx.invByKey ?? {}), [plan.enc]: inv }

    // 支付
    if (paid > 0) {
      const pmt = await insertRow('payments', {
        tenant_id: ctx.tenantId, invoice_id: inv.id, amount: paid,
        method: plan.pay, transaction_no: `DEMO-PAY-${pad(invSeq)}-${Date.now()}`,
        idempotency_key: `demo-pay-${invSeq}`, operator_id: ctx.userId,
      })
      ctx.paymentOf = { ...(ctx.paymentOf ?? {}), [plan.enc]: pmt.id }
      // 退款场景
      if (plan.status === 'refunded') {
        await insertRow('refunds', {
          tenant_id: ctx.tenantId, invoice_id: inv.id, payment_id: pmt.id, amount: total,
          reason: '演示-客户申请退款', idempotency_key: `demo-refund-${invSeq}`, operator_id: ctx.userId,
        })
      }
    }
  }

  // 审批记录(大额折扣演示)
  const appr = await ins('approvals', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, entity_type: 'invoice_discount', entity_id: ctx.invByKey['大圣-signed']?.id, requested_by: ctx.userId, reason: '演示-会员折扣15元', status: 'approved', approved_by: ctx.userId, approved_at: iso(-1), approval_metadata: { discount: 15 } },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, entity_type: 'refund', entity_id: ctx.invByKey['雪球-signed']?.id, requested_by: ctx.userId, reason: '演示-待审批退款', status: 'pending', approval_metadata: { amount: 152 } },
  ])
  track('approvals', appr)

  // ===== 批量扩展:为生成就诊追加发票(状态轮换,收银台/账单列表验证) =====
  const genInvStatuses = ['paid', 'paid', 'paid', 'paid', 'draft', 'draft', 'confirmed', 'confirmed', 'partially_paid', 'refunded', 'cancelled', 'paid']
  const genPayMethods = ['cash', 'wechat', 'alipay', 'card']
  const genEncs = ctx.genEncs ?? []
  for (let i = 0; i < genEncs.length && i < genInvStatuses.length; i++) {
    const enc = genEncs[i]
    const status = genInvStatuses[i]
    // signed 就诊才允许已收款终态,其余走未收款流转
    const effStatus = (['paid', 'partially_paid', 'refunded'].includes(status) && enc.status !== 'signed') ? 'confirmed' : status
    const items = [['DEMO-DRUG-AMX', 2 + (i % 5), 15], ['DEMO-SVC-REG', 1, 20]]
    const subtotal = items.reduce((s, it) => s + it[1] * it[2], 0)
    const total = subtotal
    const paid = effStatus === 'paid' ? total
      : effStatus === 'partially_paid' ? Math.round(total / 2)
        : effStatus === 'refunded' ? total : 0
    const invNo = `DEMO-INV-${bizDate(0)}-G${pad(i + 1)}`
    const [inv] = await ins('invoices', [{
      tenant_id: ctx.tenantId, store_id: ctx.storeId, invoice_no: invNo,
      customer_id: enc.customer_id, pet_id: enc.pet_id, encounter_id: enc.id,
      subtotal, discount_amount: 0, tax_amount: 0, total, paid_amount: paid,
      status: effStatus,
      payment_method: paid > 0 ? genPayMethods[i % 4] : null,
      confirmed_at: ['paid', 'partially_paid', 'refunded', 'confirmed'].includes(effStatus) ? iso(-1, 11) : null,
      confirmed_by: ctx.userId, created_by: ctx.userId,
    }])
    track('invoices', 1)
    const invItems = await ins('invoice_items', items.map((it, j) => ({
      tenant_id: ctx.tenantId, invoice_id: inv.id, catalog_item_id: itemId[it[0]],
      name: it[0], unit_price: it[2], quantity: it[1], amount: it[1] * it[2], sort_order: j,
      category: it[0].startsWith('DEMO-DRUG') ? 'drug' : 'service',
    })))
    track('invoice_items', invItems)
    if (paid > 0) {
      await insertRow('payments', {
        tenant_id: ctx.tenantId, invoice_id: inv.id, amount: paid,
        method: genPayMethods[i % 4], transaction_no: `DEMO-PAY-G${pad(i + 1)}`,
        idempotency_key: `demo-pay-gen-${i}`, operator_id: ctx.userId,
      })
      if (effStatus === 'refunded') {
        await insertRow('refunds', {
          tenant_id: ctx.tenantId, invoice_id: inv.id, amount: total,
          reason: '演示-生成发票退款', idempotency_key: `demo-refund-gen-${i}`, operator_id: ctx.userId,
        })
      }
    }
  }
}

/* ============ 11. 住院 Inpatient ============ */

async function seedInpatient(itemId) {
  console.log('\n=== 住院 Inpatient ===')
  const rooms = await ins('rooms', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, name: '住院一区', code: 'RM-WARD-1', floor: '1', room_type: 'ward', capacity: 8 },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, name: 'ICU', code: 'RM-ICU-1', floor: '2', room_type: 'icu', capacity: 2 },
  ])
  track('rooms', rooms)
  const roomId = { ward: rooms[0].id, icu: rooms[1].id }

  const cageDefs = [
    ['CAGE-W1', '住院笼位1', 'ward', 100], ['CAGE-W2', '住院笼位2', 'ward', 100],
    ['CAGE-W3', '住院笼位3', 'ward', 100], ['CAGE-W4', '住院笼位4', 'ward', 120],
    ['CAGE-W5', '住院笼位5', 'ward', 120], ['CAGE-W6', '住院笼位6', 'ward', 150],
    ['CAGE-ICU1', 'ICU监护1', 'icu', 300], ['CAGE-ICU2', 'ICU监护2', 'icu', 300],
    ['CAGE-BD1', '寄养笼位1', 'ward', 80], ['CAGE-BD2', '寄养笼位2', 'ward', 80],
  ]
  const cages = await ins('cages', cageDefs.map(c => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId, room_id: roomId[c[2]],
    name: c[1], code: c[0], cage_type: 'cage', daily_rate: c[3], status: 'available',
  })))
  track('cages', cages)
  ctx.cageId = Object.fromEntries(cages.map(c => [c.code, c.id]))

  // 住院记录: [客户, 宠物, 笼位, 状态, 入院偏移天, 结算]
  const admDefs = [
    { customer: '赵敏', pet: '团子', cage: 'CAGE-W1', status: 'admitted', offset: -1, reason: '尿道感染住院观察', settlement: null },
    { customer: '刘洋', pet: '跳跳', cage: 'CAGE-W2', status: 'admitted', offset: -2, reason: '胃肠炎住院补液', settlement: null },
    { customer: '吴迪', pet: '灰灰', cage: 'CAGE-BD1', status: 'discharged', offset: -4, reason: '轻度中暑观察', settlement: { status: 'settled', total: 680, paid: 680 } },
  ]
  const admissions = await ins('admissions', admDefs.map(a => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId,
    customer_id: ctx.custId[a.customer], pet_id: ctx.petId[a.pet], cage_id: ctx.cageId[a.cage],
    doctor_id: ctx.userId, admission_reason: `演示-${a.reason}`,
    admitted_at: iso(a.offset, 10), status: a.status,
    discharged_at: a.status === 'discharged' ? iso(a.offset + 1, 11) : null,
    discharge_reason: a.status === 'discharged' ? '病情好转' : null,
    discharge_notes: a.status === 'discharged' ? '体温正常,食欲恢复' : null,
    total_charge: a.settlement?.total ?? (a.status === 'admitted' ? 320 : 0),
    settlement_status: a.settlement?.status ?? 'unsettled',
    settlement_no: a.settlement ? nextNo('DEMO-STL') : null,
    receivable_amount: a.settlement?.total ?? 0, paid_amount: a.settlement?.paid ?? 0,
    finalized_at: a.settlement ? iso(a.offset + 1, 11) : null,
  })))
  track('admissions', admissions)
  ctx.admId = { W1: admissions[0].id, W2: admissions[1].id, BD1: admissions[2].id }

  // 更新笼位占用
  const cageUpdates = [
    { id: ctx.cageId['CAGE-W1'], admission: admissions[0].id },
    { id: ctx.cageId['CAGE-W2'], admission: admissions[1].id },
  ]
  for (const u of cageUpdates) {
    await api('cages', {
      method: 'PATCH', filter: `id=eq.${u.id}`, body: { status: 'occupied', current_admission_id: u.admission },
    })
  }
  // 已出院笼位恢复
  await api('cages', {
    method: 'PATCH', filter: `id=eq.${ctx.cageId['CAGE-BD1']}`, body: { status: 'available', current_admission_id: null },
  })

  // 病程记录
  const notes = await ins('inpatient_progress_notes', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[0].id, pet_id: ctx.petId['团子'], note_no: nextRunNo('DEMO-PN'), note_type: 'daily', content: '入院第2天,精神状态好转,体温38.6℃,继续抗感染治疗', status: 'signed', recorded_at: iso(-1, 9), recorded_by: ctx.userId, signed_at: iso(-1, 10), signed_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[0].id, pet_id: ctx.petId['团子'], note_no: nextRunNo('DEMO-PN'), note_type: 'daily', content: '今日复查血常规,白细胞恢复正常,准备明日出院', status: 'draft', recorded_at: iso(0, 9), recorded_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[1].id, pet_id: ctx.petId['跳跳'], note_no: nextRunNo('DEMO-PN'), note_type: 'daily', content: '补液后呕吐停止,已少量进食', status: 'signed', recorded_at: iso(-1, 16), recorded_by: ctx.userId, signed_at: iso(-1, 17), signed_by: ctx.userId },
  ])
  track('inpatient_progress_notes', notes)

  // 护理计划 + 护理任务
  const [plan] = await ins('nursing_plans', [{
    tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[0].id, pet_id: ctx.petId['团子'],
    plan_name: '演示-抗感染护理', frequency: 'q8h', start_date: bizDate(-1), is_active: true, created_by: ctx.userId,
  }])
  track('nursing_plans', 1)
  const ntasks = await ins('nursing_tasks', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[0].id, pet_id: ctx.petId['团子'], plan_id: plan.id, task_type: 'medication', description: '喂服抗生素', scheduled_at: iso(0, 8), assigned_to: ctx.userId, status: 'done', completed_at: iso(0, 8, 30), completed_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[0].id, pet_id: ctx.petId['团子'], plan_id: plan.id, task_type: 'observation', description: '监测体温', scheduled_at: iso(0, 12), assigned_to: ctx.userId, status: 'pending' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[1].id, pet_id: ctx.petId['跳跳'], task_type: 'feeding', description: '少量饲喂', scheduled_at: iso(0, 10), assigned_to: ctx.userId, status: 'pending' },
  ])
  track('nursing_tasks', ntasks)

  // 住院收费
  const charges = await ins('inpatient_charges', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[0].id, charge_date: bizDate(-1), catalog_item_id: itemId['DEMO-SVC-INFU'], description: '输液护理', quantity: 2, unit_price: 50, amount: 100, is_auto: true },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[0].id, charge_date: bizDate(0), catalog_item_id: itemId['DEMO-SVC-INFU'], description: '输液护理', quantity: 1, unit_price: 50, amount: 50, is_auto: true },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[0].id, charge_date: bizDate(0), catalog_item_id: itemId['DEMO-EXM-CBC'], description: '血常规复查', quantity: 1, unit_price: 80, amount: 80, is_auto: false },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: admissions[2].id, charge_date: bizDate(-4), catalog_item_id: itemId['DEMO-SVC-REG'], description: '住院观察费', quantity: 4, unit_price: 150, amount: 600, is_auto: true },
  ])
  track('inpatient_charges', charges)

  // 交接班
  const hds = await ins('shift_handovers', [{
    tenant_id: ctx.tenantId, store_id: ctx.storeId, shift_date: bizDate(0), shift_type: 'morning',
    outgoing_user: ctx.userId, incoming_user: ctx.userId,
  }])
  track('shift_handovers', hds)

  // ===== 批量扩展:2 个生成住院记录(旺财/富贵,占用剩余笼位) =====
  const genAdmDefs = [
    { customer: '陈静', pet: '旺财', cage: 'CAGE-W6', offset: 0, reason: '犬瘟恢复期住院观察' },
    { customer: '周芳', pet: '富贵', cage: 'CAGE-ICU1', offset: 0, reason: '膀胱结石术后ICU监护' },
  ]
  const genAdms = await ins('admissions', genAdmDefs.map(a => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId,
    customer_id: ctx.custId[a.customer], pet_id: ctx.petId[a.pet], cage_id: ctx.cageId[a.cage],
    doctor_id: ctx.userId, admission_reason: `演示-${a.reason}`,
    admitted_at: iso(a.offset, 10), status: 'admitted',
    total_charge: a.pet === '富贵' ? 680 : 260,
    settlement_status: 'unsettled', receivable_amount: 0, paid_amount: 0,
  })))
  track('admissions', genAdms)
  for (const [i, a] of genAdmDefs.entries()) {
    await api('cages', {
      method: 'PATCH', filter: `id=eq.${ctx.cageId[a.cage]}`, body: { status: 'occupied', current_admission_id: genAdms[i].id },
    })
  }
  // 生成病程 + 住院收费(演示病房/ICU 明细)
  const genNotes = await ins('inpatient_progress_notes', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: genAdms[0].id, pet_id: ctx.petId['旺财'], note_no: nextRunNo('DEMO-PN'), note_type: 'daily', content: '犬瘟恢复期,饮食正常,继续口服维生素', status: 'signed', recorded_at: iso(0, 9), recorded_by: ctx.userId, signed_at: iso(0, 10), signed_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: genAdms[1].id, pet_id: ctx.petId['富贵'], note_no: nextRunNo('DEMO-PN'), note_type: 'postop', content: '术后首日,留置导尿管通畅,心电监护稳定', status: 'draft', recorded_at: iso(0, 9), recorded_by: ctx.userId },
  ])
  track('inpatient_progress_notes', genNotes)
  const genCharges = await ins('inpatient_charges', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: genAdms[0].id, charge_date: bizDate(0), catalog_item_id: itemId['DEMO-SVC-INFU'], description: '住院观察费', quantity: 1, unit_price: 260, amount: 260, is_auto: true },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: genAdms[1].id, charge_date: bizDate(0), catalog_item_id: itemId['DEMO-EXM-US'], description: '术后B超复查', quantity: 1, unit_price: 120, amount: 120, is_auto: false },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: genAdms[1].id, charge_date: bizDate(0), catalog_item_id: itemId['DEMO-SVC-INFU'], description: 'ICU监护费', quantity: 1, unit_price: 300, amount: 300, is_auto: true },
  ])
  track('inpatient_charges', genCharges)
}

/* ============ 12. 检验/疫苗/驱虫 Diagnostics ============ */

async function seedDiagnostics(itemId) {
  console.log('\n=== 检验/疫苗/驱虫 Diagnostics ===')

  // 检验申请
  const labPlan = [
    { pet: '大黄', customer: '张伟', status: 'requested', offset: 0, panel: 'DEMO-PANEL-CBC' },
    { pet: '咪咪', customer: '李娜', status: 'collected', offset: -1, panel: 'DEMO-PANEL-CBC' },
    { pet: '大圣', customer: '孙磊', status: 'completed', offset: -1, panel: 'DEMO-PANEL-CBC' },
    { pet: '富贵', customer: '周芳', status: 'completed', offset: 0, panel: 'DEMO-PANEL-BIO', critical: true },
    { pet: '灰灰', customer: '吴迪', status: 'cancelled', offset: -2, panel: 'DEMO-PANEL-CBC' },
  ]
  const labs = await ins('lab_orders', labPlan.map((l, i) => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId,
    customer_id: ctx.custId[l.customer], pet_id: ctx.petId[l.pet],
    order_no: nextNo('DEMO-LAB'), status: l.status, requested_by: ctx.userId,
    requested_at: iso(l.offset, 10), collected_at: l.status === 'requested' ? null : iso(l.offset, 10, 30),
    completed_at: l.status === 'completed' ? iso(l.offset, 14) : null, remark: '演示检验',
  })))
  track('lab_orders', labs)
  ctx.labId = Object.fromEntries(labs.map((l, i) => [labPlan[i].pet, l.id]))

  // 标本(旧 lab_specimens 简单采集记录)+ 标本(lab_samples 新流转模型)
  const specimenPlan = [
    { pet: '咪咪', spec: 'collected', sample: 'received' },
    { pet: '大圣', spec: 'discarded', sample: 'completed' },
    { pet: '富贵', spec: 'received', sample: 'completed' },
  ]
  const specimens = await ins('lab_specimens', specimenPlan.map(s => ({
    tenant_id: ctx.tenantId,
    lab_order_id: ctx.labId[s.pet],
    specimen_type: 'blood', collection_method: '静脉采血',
    collected_at: iso(-1, 10, 30), collected_by: ctx.userId,
    container_id: `CT-${s.pet}`, storage_condition: '2-8℃',
    status: s.spec, received_at: s.spec === 'discarded' ? iso(-1, 15) : iso(-1, 14), received_by: ctx.userId,
  })))
  track('lab_specimens', specimens)

  const labSamples = await ins('lab_samples', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, lab_order_id: ctx.labId['咪咪'], sample_no: nextNo('DEMO-LS'), sample_type: 'blood', status: 'received', planned_at: iso(-1, 9), planned_by: ctx.userId, collected_at: iso(-1, 10, 30), collected_by: ctx.userId, received_at: iso(-1, 11), received_by: ctx.userId, container: 'EDTA抗凝管', storage_condition: '2-8℃' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, lab_order_id: ctx.labId['大圣'], sample_no: nextNo('DEMO-LS'), sample_type: 'blood', status: 'completed', planned_at: iso(-1, 9), planned_by: ctx.userId, collected_at: iso(-1, 10), collected_by: ctx.userId, received_at: iso(-1, 10, 40), received_by: ctx.userId, container: 'EDTA抗凝管' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, lab_order_id: ctx.labId['富贵'], sample_no: nextNo('DEMO-LS'), sample_type: 'blood', status: 'testing', planned_at: iso(0, 9), planned_by: ctx.userId, collected_at: iso(0, 10), collected_by: ctx.userId, received_at: iso(0, 10, 30), received_by: ctx.userId, container: '促凝管', remark: '溶血风险,请复核' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, lab_order_id: ctx.labId['灰灰'], sample_no: nextNo('DEMO-LS'), sample_type: 'blood', status: 'rejected', planned_at: iso(-2, 9), planned_by: ctx.userId, rejected_at: iso(-2, 11), rejected_by: ctx.userId, reject_reason: '标本量不足', container: 'EDTA抗凝管' },
  ])
  track('lab_samples', labSamples)
  ctx.sampleId = { 咪咪: labSamples[0].id, 大圣: labSamples[1].id, 富贵: labSamples[2].id }

  // 检验结果项(正常/异常/危急值)
  // [pet, analyteKey, resultNumeric, flag, isAbnormal, isCritical]
  const resultPlan = [
    { pet: '大圣', key: 'WBC', val: 10.5, flag: null, ab: false, cr: false },
    { pet: '大圣', key: 'RBC', val: 6.8, flag: null, ab: false, cr: false },
    { pet: '大圣', key: 'PLT', val: 350, flag: null, ab: false, cr: false },
    { pet: '富贵', key: 'ALT', val: 320, flag: 'high', ab: true, cr: true },
    { pet: '富贵', key: 'CREA', val: 88, flag: null, ab: false, cr: false },
  ]
  const analytes = await ins('lab_order_analytes', resultPlan.map(r => ({
    lab_order_id: ctx.labId[r.pet],
    analyte_id: ctx.labAnalytes[r.key],
    result_value: String(r.val),
    result_numeric: r.val,
    is_abnormal: r.ab, is_critical: r.cr, flag: r.flag,
    resulted_at: r.cr ? iso(0, 13) : iso(-1, 13),
    resulted_by: ctx.userId, note: r.cr ? '复查确认偏高' : null,
  })))
  track('lab_order_analytes', analytes)
  ctx.resultOf = Object.fromEntries(resultPlan.map((r, i) => [r.pet + '-' + r.key, analytes[i].id]))

  // 危急值告警(1 pending + 1 acknowledged 演示)
  const alerts = await ins('critical_value_alerts', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, lab_order_id: ctx.labId['富贵'], analyte_id: ctx.labAnalytes['ALT'], pet_id: ctx.petId['富贵'], alert_level: 'critical', message: '检验危急值:ALT 320 U/L,请立即复查', status: 'pending' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, lab_order_id: ctx.labId['大圣'], analyte_id: ctx.labAnalytes['PLT'], pet_id: ctx.petId['大圣'], alert_level: 'significant', message: '血小板计数接近下限', status: 'acknowledged', acknowledged_by: ctx.userId, acknowledged_at: iso(-1, 14) },
  ])
  track('critical_value_alerts', alerts)

  // 结果审核(双签:大圣 approved)
  const reviews = await ins('lab_result_reviews', [
    { lab_order_id: ctx.labId['大圣'], reviewed_by: ctx.userId, decision: 'approved', comment: '结果与临床相符', reviewed_at: iso(-1, 14, 30) },
  ])
  track('lab_result_reviews', reviews)

  // 疫苗方案(犬基础免疫 + 猫三联)
  const protocols = await ins('vaccine_protocols', [
    { tenant_id: ctx.tenantId, code: 'DOG-CORE', name: '犬基础免疫程序', species: 'dog', description: '狂犬+犬瘟+细小核心免疫', is_active: true },
    { tenant_id: ctx.tenantId, code: 'CAT-CORE', name: '猫基础免疫程序', species: 'cat', description: '猫三联核心免疫', is_active: true },
  ])
  track('vaccine_protocols', protocols)
  const [pDog, pCat] = protocols
  const protItems = await ins('vaccine_protocol_items', [
    { protocol_id: pDog.id, vaccine_catalog_item_id: itemId['DEMO-VAC-RAB'], dose_no: 1, min_age_weeks: 12, is_required: true, remark: '首年基础针' },
    { protocol_id: pDog.id, vaccine_catalog_item_id: itemId['DEMO-VAC-CDV'], dose_no: 1, min_age_weeks: 8, interval_days: 21, is_required: true },
    { protocol_id: pDog.id, vaccine_catalog_item_id: itemId['DEMO-VAC-CPV'], dose_no: 2, min_age_weeks: 11, interval_days: 21, is_required: true, remark: '加强针' },
    { protocol_id: pCat.id, vaccine_catalog_item_id: itemId['DEMO-VAC-FPV'], dose_no: 1, min_age_weeks: 8, is_required: true },
  ])
  track('vaccine_protocol_items', protItems)

  // 疫苗接种(administered/scheduled/overdue 多状态)
  const vaccinations = await ins('vaccinations', [
    // 旺财:狂犬已接种(签发证书),犬瘟已接种,细小待接种
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['陈静'], pet_id: ctx.petId['旺财'], vaccine_catalog_item_id: itemId['DEMO-VAC-RAB'], dose_no: 1, scheduled_date: iso(-60, 10), administered_date: iso(-60, 10, 30), administered_by: ctx.userId, batch_no: 'VAC-RAB-01', manufacturer: '演示生物', status: 'administered', next_due_date: iso(305) },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['陈静'], pet_id: ctx.petId['旺财'], vaccine_catalog_item_id: itemId['DEMO-VAC-CDV'], dose_no: 1, scheduled_date: iso(-30, 10), administered_date: iso(-30, 10, 30), administered_by: ctx.userId, batch_no: 'VAC-CDV-01', manufacturer: '演示生物', status: 'administered' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['陈静'], pet_id: ctx.petId['旺财'], vaccine_catalog_item_id: itemId['DEMO-VAC-CPV'], dose_no: 2, scheduled_date: iso(5, 10), status: 'scheduled' },
    // 咪咪:猫三联已接种
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['李娜'], pet_id: ctx.petId['咪咪'], vaccine_catalog_item_id: itemId['DEMO-VAC-FPV'], dose_no: 1, scheduled_date: iso(-45, 10), administered_date: iso(-45, 10, 30), administered_by: ctx.userId, batch_no: 'VAC-FPV-01', manufacturer: '演示生物', status: 'administered' },
    // 乐乐:狂犬已逾期未接种
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['杨帆'], pet_id: ctx.petId['乐乐'], vaccine_catalog_item_id: itemId['DEMO-VAC-RAB'], dose_no: 1, scheduled_date: iso(-10, 10), status: 'overdue' },
    // 团子:待接种
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['赵敏'], pet_id: ctx.petId['团子'], vaccine_catalog_item_id: itemId['DEMO-VAC-FPV'], dose_no: 1, scheduled_date: iso(3, 10), status: 'scheduled' },
  ])
  track('vaccinations', vaccinations)
  ctx.vaccId = { 旺财狂犬: vaccinations[0].id, 旺财犬瘟: vaccinations[1].id, 旺财细小: vaccinations[2].id }

  // 驱虫记录(done/scheduled)
  const deworm = await ins('deworming_records', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['张伟'], pet_id: ctx.petId['大黄'], drug_catalog_item_id: itemId['DEMO-PRD-DEW'], drug_name: '体外驱虫滴剂', dose: '1管', administered_date: iso(-30, 10), administered_by: ctx.userId, next_due_date: iso(60), parasite_type: 'external', status: 'done' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['张伟'], pet_id: ctx.petId['大黄'], drug_catalog_item_id: itemId['DEMO-DRUG-MTZ'], drug_name: '甲硝唑片(体内驱虫)', dose: '1片', administered_date: iso(-30, 10), administered_by: ctx.userId, next_due_date: iso(30), parasite_type: 'internal', status: 'done' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['赵敏'], pet_id: ctx.petId['团子'], drug_catalog_item_id: itemId['DEMO-PRD-DEW'], drug_name: '体外驱虫滴剂', dose: '1管', administered_date: iso(7, 10), next_due_date: iso(7), parasite_type: 'external', status: 'scheduled' },
  ])
  track('deworming_records', deworm)

  // 疫苗证明(旺财狂犬签发)
  const certs = await ins('vaccine_certificates', [{
    tenant_id: ctx.tenantId, store_id: ctx.storeId, pet_id: ctx.petId['旺财'], customer_id: ctx.custId['陈静'],
    vaccination_id: ctx.vaccId['旺财狂犬'], certificate_no: `DEMO-VC-${bizDate(0)}-000001`,
    issued_date: iso(-60, 11), issued_by: ctx.userId,
    certificate_data: { vaccine: '狂犬疫苗', batch_no: 'VAC-RAB-01', manufacturer: '演示生物', dose_no: 1 },
    status: 'issued',
  }])
  track('vaccine_certificates', certs)

  // 诊断提醒(pending 乐乐狂犬 / pending 团子驱虫 / sent 旺财细小)
  const reminders = await ins('diag_reminders', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['杨帆'], pet_id: ctx.petId['乐乐'], reminder_type: 'vaccine', reference_id: vaccinations[4].id, due_date: iso(-10), status: 'pending' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['赵敏'], pet_id: ctx.petId['团子'], reminder_type: 'deworming', reference_id: deworm[2].id, due_date: iso(7), status: 'pending' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['陈静'], pet_id: ctx.petId['旺财'], reminder_type: 'vaccine', reference_id: ctx.vaccId['旺财细小'], due_date: iso(5), status: 'sent', sent_at: iso(-1, 9) },
  ])
  track('diag_reminders', reminders)
}

/* ============ 13. 寄养 Boarding ============ */

async function seedBoarding(itemId) {
  console.log('\n=== 寄养 Boarding ===')

  // 寄养单:[客户, 宠物, 笼位, 状态, 入住偏移, 预计离店偏移, 实际离店偏移]
  const stayPlan = [
    { customer: '张伟', pet: '豆豆', cage: 'CAGE-BD1', status: 'in_service', in: -2, out: 3, realOut: null },
    { customer: '杨帆', pet: '乐乐', cage: 'CAGE-W3', status: 'checked_in', in: 0, out: 4, realOut: null },
    { customer: '孙磊', pet: '大圣', cage: 'CAGE-W4', status: 'checkout_pending', in: -1, out: 2, realOut: null },
    { customer: '陈静', pet: '旺财', cage: 'CAGE-BD2', status: 'planned', in: 2, out: 6, realOut: null },
    { customer: '王强', pet: '花花', cage: 'CAGE-W5', status: 'checked_out', in: -5, out: 3, realOut: -2 },
    { customer: '吴迪', pet: '灰灰', cage: 'CAGE-ICU2', status: 'cancelled', in: -1, out: 3, realOut: null },
  ]
  const stays = await ins('boarding_stays', stayPlan.map((s, i) => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId,
    boarding_no: `DEMO-BOARD-${pad(i + 1)}`,
    customer_id: ctx.custId[s.customer], pet_id: ctx.petId[s.pet], cage_id: ctx.cageId[s.cage],
    check_in_at: s.status === 'planned' ? null : iso(s.in, 11),
    expected_check_out_at: iso(s.out, 12),
    checked_out_at: s.realOut ? iso(s.realOut, 12) : null,
    status: s.status,
    diet_notes: s.pet === '豆豆' ? '每日两餐,处方粮' : '常规犬粮',
    walking_notes: s.pet === '乐乐' ? '外出需牵绳,怕生' : null,
    medication_notes: s.pet === '豆豆' ? '早晚各一粒护肝药' : null,
    vaccine_verified: true, risk_acknowledged: true,
    emergency_contact: { name: s.customer, phone: '13900000000', relation: '主人' },
    total_charge: s.status === 'checked_out' ? 340 : s.status === 'cancelled' ? 0 : 180,
    created_by: ctx.userId,
  })))
  track('boarding_stays', stays)
  ctx.stayId = Object.fromEntries(stays.map((st, i) => [stayPlan[i].pet, st.id]))

  // 更新占用笼位状态(住院/寄养单占用互斥)
  const occupied = [
    { cage: 'CAGE-BD1', stay: stays[0].id },
    { cage: 'CAGE-W3', stay: stays[1].id },
    { cage: 'CAGE-W4', stay: stays[2].id },
  ]
  for (const o of occupied) {
    await api('cages', { method: 'PATCH', filter: `id=eq.${ctx.cageId[o.cage]}`, body: { status: 'occupied', current_boarding_stay_id: o.stay } })
  }
  // 已离店笼位释放
  await api('cages', { method: 'PATCH', filter: `id=eq.${ctx.cageId['CAGE-W5']}`, body: { status: 'available', current_boarding_stay_id: null } })

  // 每日照护记录(在住寄养单)
  const daily = await ins('boarding_daily_records', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: stays[0].id, record_date: bizDate(-1), feeding: '早晚各一餐,食欲好', walking: '上午遛30分钟', medication: '护肝药已喂', condition: '精神良好', recorded_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: stays[0].id, record_date: bizDate(0), feeding: '食欲正常', walking: '下午遛20分钟', condition: '状态稳定', recorded_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: stays[1].id, record_date: bizDate(0), feeding: '少食,有应激', condition: '新环境,需观察', recorded_by: ctx.userId },
  ])
  track('boarding_daily_records', daily)

  // 寄养附加服务费
  const charges = await ins('boarding_service_charges', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: stays[0].id, catalog_item_id: itemId['DEMO-SVC-TEETH'], description: '寄养洁牙护理', quantity: 1, unit_price: 80, amount: 80, charge_date: bizDate(-1), created_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: stays[2].id, catalog_item_id: itemId['DEMO-PRD-FOOD'], description: '处方粮加餐', quantity: 1, unit_price: 30, amount: 30, charge_date: bizDate(0), created_by: ctx.userId },
  ])
  track('boarding_service_charges', charges)
}

/* ============ 14. 采购 Purchasing ============ */

async function seedPurchasing(itemId) {
  console.log('\n=== 采购 Purchasing ===')
  const suppliers = await ins('suppliers', [
    { tenant_id: ctx.tenantId, supplier_no: 'DEMO-SUP-001', name: '演示动物药业', contact_name: '李经理', phone: '021-88888801', address: '上海市闵行区药城路1号', unified_credit_code: '91310000DEMO0001', payment_terms: '月结30天', status: 'active', categories: ['药品', '疫苗'], notes: '主供应商' },
    { tenant_id: ctx.tenantId, supplier_no: 'DEMO-SUP-002', name: '演示宠物用品商行', contact_name: '王女士', phone: '021-88888802', address: '上海市浦东新区商城路2号', unified_credit_code: '91310000DEMO0002', payment_terms: '现结', status: 'inactive', categories: ['耗材', '商品'], notes: '已停止合作' },
  ])
  track('suppliers', suppliers)
  const [supA, supB] = suppliers

  // 采购单:[状态, 供应商, 明细[[code, orderedQty, unitCost, receivedQty]], 备注]
  const poPlan = [
    { status: 'posted', supplier: supA, items: [['DEMO-DRUG-AMX', 100, 5, 100], ['DEMO-DRUG-CFX', 50, 4, 50]], days: -30 },
    { status: 'received', supplier: supA, items: [['DEMO-DRUG-IVM', 30, 8, 30]], days: -10 },
    { status: 'approved', supplier: supA, items: [['DEMO-DRUG-DOX', 100, 3, 0]], days: -3 },
    { status: 'submitted', supplier: supA, items: [['DEMO-DRUG-MTZ', 50, 2, 0]], days: -1 },
    { status: 'draft', supplier: supB, items: [['DEMO-DRUG-PTL', 60, 2, 0]], days: 0 },
    { status: 'partially_received', supplier: supA, items: [['DEMO-VAC-RAB', 20, 25, 10]], days: -2 },
    { status: 'cancelled', supplier: supA, items: [['DEMO-VAC-CDV', 20, 20, 0]], days: -5 },
  ]
  const pos = []
  for (const [i, p] of poPlan.entries()) {
    const total = p.items.reduce((s, it) => s + it[1] * it[2], 0)
    const row = {
      tenant_id: ctx.tenantId, store_id: ctx.storeId, warehouse_id: ctx.warehouses.def,
      po_no: `DEMO-PO-${pad(i + 1)}`, supplier_id: p.supplier.id, status: p.status,
      expected_at: bizDate(p.days + 7), total_cost: total, note: `演示采购单-${p.status}`,
      created_by: ctx.userId,
    }
    // 状态时间线字段(按状态机推进填列)
    if (['submitted', 'approved', 'received', 'partially_received', 'posted', 'cancelled'].includes(p.status)) {
      row.submitted_by = ctx.userId
      row.submitted_at = iso(p.days, 9)
    }
    if (['approved', 'received', 'partially_received', 'posted'].includes(p.status)) {
      row.approved_by = ctx.userId
      row.approved_at = iso(p.days, 10)
    }
    if (['received', 'partially_received', 'posted'].includes(p.status)) {
      row.received_by = ctx.userId
      row.received_at = iso(p.days, 11)
    }
    if (p.status === 'posted') {
      row.posted_by = ctx.userId
      row.posted_at = iso(p.days, 12)
    }
    if (p.status === 'cancelled') {
      row.cancelled_by = ctx.userId
      row.cancelled_at = iso(p.days, 13)
    }
    const [po] = await ins('purchase_orders', [row])
    pos.push(po)
    const items = await ins('purchase_order_items', p.items.map(it => ({
      tenant_id: ctx.tenantId, purchase_order_id: po.id, catalog_item_id: itemId[it[0]],
      ordered_qty: it[1], received_qty: it[3] ?? 0, unit_cost: it[2],
      batch_no: it[3] > 0 ? `DEMO-PO-B-${pad(i + 1)}` : null,
      expires_at: it[3] > 0 ? bizDate(400) : null,
    })))
    track('purchase_order_items', items)
  }
  track('purchase_orders', pos)

  // ===== 批量扩展:3 张生成采购单(posted/submitted/draft,列表滚动验证) =====
  const genPoPlan = [
    { status: 'posted', supplier: supA, items: [['DEMO-VAC-FPV', 30, 28, 30]], days: -8 },
    { status: 'submitted', supplier: supA, items: [['DEMO-PRD-FOOD', 40, 15, 0]], days: -1 },
    { status: 'draft', supplier: supB, items: [['DEMO-PRD-DEW', 25, 10, 0]], days: 0 },
  ]
  for (const [i, p] of genPoPlan.entries()) {
    const total = p.items.reduce((s, it) => s + it[1] * it[2], 0)
    const row = {
      tenant_id: ctx.tenantId, store_id: ctx.storeId, warehouse_id: ctx.warehouses.def,
      po_no: `DEMO-PO-G${pad(i + 1)}`, supplier_id: p.supplier.id, status: p.status,
      expected_at: bizDate(p.days + 7), total_cost: total, note: `演示-生成采购单`,
      created_by: ctx.userId,
    }
    if (p.status === 'submitted' || p.status === 'posted') {
      row.submitted_by = ctx.userId
      row.submitted_at = iso(p.days, 9)
    }
    if (p.status === 'posted') {
      row.approved_by = ctx.userId
      row.approved_at = iso(p.days, 10)
      row.received_by = ctx.userId
      row.received_at = iso(p.days, 11)
      row.posted_by = ctx.userId
      row.posted_at = iso(p.days, 12)
    }
    const [gpo] = await ins('purchase_orders', [row])
    const gitems = await ins('purchase_order_items', p.items.map(it => ({
      tenant_id: ctx.tenantId, purchase_order_id: gpo.id, catalog_item_id: itemId[it[0]],
      ordered_qty: it[1], received_qty: it[3] ?? 0, unit_cost: it[2],
      batch_no: it[3] > 0 ? `DEMO-PO-B-G${pad(i + 1)}` : null,
      expires_at: it[3] > 0 ? bizDate(400) : null,
    })))
    track('purchase_order_items', gitems)
  }
  track('purchase_orders', genPoPlan)
}

/* ============ 15. 影像 Imaging ============ */

async function seedImaging(itemId) {
  console.log('\n=== 影像 Imaging ===')
  // [key, 宠物, 客户, 类型, 状态, 偏移, 关联就诊key]
  const imgPlan = [
    { pet: '大圣', customer: '孙磊', type: 'xray', status: 'published', offset: -1, enc: '大圣-signed' },
    { pet: '富贵', customer: '周芳', type: 'ultrasound', status: 'reported', offset: 0, enc: '富贵-signed' },
    { pet: '大黄', customer: '张伟', type: 'xray', status: 'in_progress', offset: 0, enc: '大黄-in_progress' },
    { pet: '咪咪', customer: '李娜', type: 'ultrasound', status: 'scheduled', offset: 1, enc: '咪咪-in_progress' },
    { pet: '虎子', customer: '王强', type: 'xray', status: 'requested', offset: 0, enc: '虎子-signed' },
    { pet: '乐乐', customer: '杨帆', type: 'xray', status: 'cancelled', offset: -3, enc: null },
  ]
  const orders = await ins('imaging_orders', imgPlan.map((g, i) => ({
    tenant_id: ctx.tenantId, store_id: ctx.storeId,
    order_no: `DEMO-IMG-${pad(i + 1)}`,
    encounter_id: g.enc ? ctx.encId[g.enc] : null,
    customer_id: ctx.custId[g.customer], pet_id: ctx.petId[g.pet],
    requested_by: ctx.userId,
    imaging_type: g.type, catalog_item_id: itemId[g.type === 'xray' ? 'DEMO-EXM-XRAY' : 'DEMO-EXM-US'],
    scheduled_at: iso(g.offset, 10),
    performed_at: ['performed', 'reported', 'reviewed', 'published'].includes(g.status) ? iso(g.offset, 10, 30) : null,
    performed_by: ['performed', 'reported', 'reviewed', 'published'].includes(g.status) ? ctx.userId : null,
    status: g.status,
    clinical_question: g.type === 'xray' ? '检查骨骼有无异常' : '探查腹腔情况',
    notes: '演示影像申请',
  })))
  track('imaging_orders', orders)
  ctx.imgId = Object.fromEntries(orders.map((o, i) => [imgPlan[i].pet, o.id]))

  // 影像报告(已报告/已发布)
  const reports = await ins('imaging_reports', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, imaging_order_id: ctx.imgId['大圣'], version: 1, findings: '右侧前肢软组织肿胀,未见明显骨折线', impression: '软组织挫伤,排除骨折', recommendation: '冷敷并减少运动,一周后复查', author_id: ctx.userId, reviewer_id: ctx.userId, status: 'published', published_at: iso(-1, 15) },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, imaging_order_id: ctx.imgId['富贵'], version: 1, findings: '膀胱内可见一约1.2cm高回声团块', impression: '膀胱结石待排', recommendation: '建议手术取石', author_id: ctx.userId, status: 'submitted' },
  ])
  track('imaging_reports', reports)

  // ===== 批量扩展:补全 performed/reviewed 状态 + 1 张报告 =====
  const genImgs = await ins('imaging_orders', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, order_no: nextNo('DEMO-IMG'), encounter_id: ctx.encId['大圣-signed'], customer_id: ctx.custId['孙磊'], pet_id: ctx.petId['大圣'], requested_by: ctx.userId, imaging_type: 'xray', catalog_item_id: itemId['DEMO-EXM-XRAY'], scheduled_at: iso(-1, 10), performed_at: iso(-1, 10, 30), performed_by: ctx.userId, status: 'performed', clinical_question: '复查前肢恢复情况', notes: '演示-已执行待报告' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, order_no: nextNo('DEMO-IMG'), encounter_id: ctx.encId['富贵-signed'], customer_id: ctx.custId['周芳'], pet_id: ctx.petId['富贵'], requested_by: ctx.userId, imaging_type: 'ultrasound', catalog_item_id: itemId['DEMO-EXM-US'], scheduled_at: iso(-1, 14), performed_at: iso(-1, 14, 30), performed_by: ctx.userId, status: 'reviewed', clinical_question: '膀胱结石复查', notes: '演示-已审核待发布' },
  ])
  track('imaging_orders', genImgs)
  const genReports = await ins('imaging_reports', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, imaging_order_id: genImgs[1].id, version: 1, findings: '膀胱内高回声团块较前缩小至约0.8cm', impression: '结石较前缩小,保守治疗有效', recommendation: '继续保守治疗,一月后复查', author_id: ctx.userId, reviewer_id: ctx.userId, status: 'reviewed' },
  ])
  track('imaging_reports', genReports)
}

/* ============ 16. 日结/对账 Closing ============ */

async function seedClosing() {
  console.log('\n=== 日结/对账 Closing ===')

  // [日期偏移, 状态, 实收, 调整]
  const closePlan = [
    { offset: -3, status: 'adjusted', paid: 1200, adj: { type: 'cash_short', amount: -20, reason: '演示-现金盘点短款20元' } },
    { offset: -2, status: 'closed', paid: 1800, adj: null },
    { offset: -1, status: 'closed', paid: 950, adj: null },
    { offset: 0, status: 'open', paid: 0, adj: null },
  ]
  const closings = []
  for (const c of closePlan) {
    const [dc] = await ins('daily_closings', [{
      tenant_id: ctx.tenantId, store_id: ctx.storeId, business_date: bizDate(c.offset),
      status: c.status,
      gross_amount: c.status === 'open' ? 0 : c.paid + 200,
      paid_amount: c.status === 'open' ? 0 : c.paid,
      refund_amount: c.status === 'open' ? 0 : 80,
      receivable_amount: c.status === 'open' ? 620 : 0,
      cash_amount: c.status === 'open' ? 0 : Math.round(c.paid * 0.4),
      card_amount: c.status === 'open' ? 0 : Math.round(c.paid * 0.2),
      wechat_amount: c.status === 'open' ? 0 : Math.round(c.paid * 0.25),
      alipay_amount: c.status === 'open' ? 0 : Math.round(c.paid * 0.15),
      stored_value_amount: 0, other_amount: 0,
      invoice_count: c.status === 'open' ? 0 : 3,
      snapshot: c.status === 'open' ? {} : { invoices: 3, payments: 4 },
      adjustment_summary: c.status === 'adjusted' ? { count: 1, total: -20, items: ['cash_short'] } : { count: 0, total: 0, items: [] },
      closed_at: c.status === 'open' ? null : iso(c.offset, 18),
      closed_by: ctx.employeeId,
      created_by: ctx.employeeId,
      ...(c.status === 'adjusted' ? { adjusted_at: iso(c.offset, 19), adjusted_by: ctx.employeeId } : {}),
    }])
    closings.push(dc)
    track('daily_closings', 1)
    if (c.adj) {
      const adjRows = await ins('closing_adjustments', [{
        tenant_id: ctx.tenantId, store_id: ctx.storeId, business_date: bizDate(c.offset),
        closing_id: dc.id, adjustment_type: c.adj.type, amount: c.adj.amount,
        reason: c.adj.reason, operator_employee_id: ctx.employeeId,
      }])
      track('closing_adjustments', adjRows)
    }
  }

  // 对账记录(closed 日期的渠道拆分)
  const reconRows = []
  for (const c of closePlan.slice(0, 2)) {
    const dc = closings[closePlan.indexOf(c)]
    const channels = [
      { channel: 'cash', expected: 480, actual: 480, status: 'matched' },
      { channel: 'wechat', expected: 300, actual: 290, status: 'difference_confirmed', diff: -10 },
      { channel: 'alipay', expected: 180, actual: 180, status: 'confirmed' },
    ]
    for (const ch of channels) {
      reconRows.push({
        tenant_id: ctx.tenantId, store_id: ctx.storeId, business_date: bizDate(c.offset),
        closing_id: dc.id, channel: ch.channel,
        system_expected: ch.expected, actual_amount: ch.actual,
        difference: ch.diff ?? ch.actual - ch.expected,
        difference_reason: ch.diff ? '演示-渠道金额差异' : null,
        status: ch.status,
        confirmed_by: ch.status === 'matched' ? ctx.employeeId : null,
        confirmed_at: ch.status === 'matched' ? iso(c.offset, 20) : null,
        created_by: ctx.employeeId,
      })
    }
  }
  track('reconciliation_records', await ins('reconciliation_records', reconRows))
}

/* ============ 17. 回访 Followup ============ */

async function seedFollowup() {
  console.log('\n=== 客户回访 Followup ===')
  // [宠物, 客户, 任务类型, 状态, 偏移, 渠道]
  const fPlan = [
    { pet: '大黄', customer: '张伟', type: 'post_visit', status: 'completed', offset: -2, channel: 'phone', result: 'contacted', note: '已联系,恢复良好' },
    { pet: '咪咪', customer: '李娜', type: 'recheck', status: 'in_progress', offset: 0, channel: 'wechat', result: null, note: '等待回复' },
    { pet: '旺财', customer: '陈静', type: 'medication', status: 'pending', offset: 1, channel: 'sms', result: null, note: null },
    { pet: '乐乐', customer: '杨帆', type: 'customer_care', status: 'cancelled', offset: -1, channel: 'phone', result: null, note: null },
  ]
  const tasks = await ins('followup_tasks', fPlan.map((f, i) => {
    const row = {
      tenant_id: ctx.tenantId, store_id: ctx.storeId,
      customer_id: ctx.custId[f.customer], pet_id: ctx.petId[f.pet],
      source_type: f.type === 'post_visit' ? 'encounter' : 'manual',
      source_id: f.type === 'post_visit' ? ctx.encId['大黄-signed'] : null,
      task_type: f.type, scheduled_at: iso(f.offset, 14),
      assignee_employee_id: ctx.employeeId, channel: f.channel,
      status: f.status, created_by: ctx.userId,
    }
    if (f.status === 'completed') {
      row.result_code = f.result
      row.result_note = f.note
      row.started_at = iso(f.offset, 14)
      row.completed_at = iso(f.offset, 15)
      row.completed_by = ctx.userId
    }
    if (f.status === 'in_progress') row.started_at = iso(f.offset, 14)
    if (f.status === 'cancelled') row.cancel_reason = '演示-客户拒绝回访'
    return row
  }))
  track('followup_tasks', tasks)

  // ===== 批量扩展:24 条回访任务(状态/任务类型/来源/渠道/结果全覆盖) =====
  const namedPairs = [['张伟', '大黄'], ['陈静', '旺财'], ['周芳', '富贵'], ['李娜', '咪咪'], ['孙磊', '大圣']]
  const genFollowPlan = Array.from({ length: 24 }, (_, i) => {
    const gkey = 'G' + pad((i % 20) + 1)
    // 状态轮换:completed/in_progress/pending/cancelled
    const status = ['completed', 'in_progress', 'pending', 'cancelled'][i % 4]
    const taskType = ['post_visit', 'post_discharge', 'medication', 'recheck', 'customer_care', 'other'][i % 6]
    const channel = ['phone', 'wechat', 'sms', 'in_person', 'other'][i % 5]
    // 偏移:待办→未来1-6天;进行中→今日;已完成/取消→过去1-12天
    const offset = status === 'pending' ? 1 + (i % 6)
      : status === 'in_progress' ? 0
        : -(1 + (i % 12))
    // 需要业务单据来源的任务(术后/出院)用生成客户+真实单据;其余轮换命名/生成客户
    let sourceType = 'manual'
    let sourceId = null
    let pair = [gkey, gkey]
    if (taskType === 'post_visit') {
      sourceType = 'encounter'
      sourceId = ctx.genEncs[i % ctx.genEncs.length]?.id ?? null
    }
    else if (taskType === 'post_discharge') {
      sourceType = 'discharge'
      sourceId = ctx.admId?.BD1 ?? null
    }
    else if (i % 3 === 0) {
      sourceType = ['reminder', 'complaint'][i % 2]
    }
    if (taskType !== 'post_visit' && taskType !== 'post_discharge' && i % 3 === 0) {
      pair = namedPairs[(i / 3) % namedPairs.length]
    }
    const row = {
      tenant_id: ctx.tenantId, store_id: ctx.storeId,
      customer_id: ctx.custId[pair[0]], pet_id: ctx.petId[pair[1]],
      source_type: sourceType, source_id: sourceId,
      task_type: taskType, scheduled_at: iso(offset, 9 + (i % 8)),
      assignee_employee_id: ctx.employeeId, channel,
      status, created_by: ctx.userId,
    }
    if (status === 'completed') {
      row.result_code = ['contacted', 'contacted', 'unreachable', 'rescheduled', 'other'][i % 5]
      row.result_note = '演示-回访完成登记'
      row.started_at = iso(offset, 9)
      row.completed_at = iso(offset, 10)
      row.completed_by = ctx.userId
    }
    if (status === 'in_progress') row.started_at = iso(0, 9)
    if (status === 'cancelled') row.cancel_reason = '演示-客户要求取消回访'
    return row
  })
  track('followup_tasks', await ins('followup_tasks', genFollowPlan))
}

/* ============ 18. 会员/积分 Membership ============ */

async function seedMembership() {
  console.log('\n=== 会员/积分 Membership ===')
  const tiers = await ins('membership_tiers', [
    { tenant_id: ctx.tenantId, code: 'normal', name: '普通会员', discount_percent: 100, points_multiplier: 1, sort_order: 1 },
    { tenant_id: ctx.tenantId, code: 'silver', name: '银卡会员', discount_percent: 95, points_multiplier: 1.2, sort_order: 2 },
    { tenant_id: ctx.tenantId, code: 'gold', name: '金卡会员', discount_percent: 90, points_multiplier: 1.5, sort_order: 3 },
    { tenant_id: ctx.tenantId, code: 'diamond', name: '钻石会员', discount_percent: 85, points_multiplier: 2, sort_order: 4 },
  ])
  track('membership_tiers', tiers)
  const tierId = Object.fromEntries(tiers.map(t => [t.code, t.id]))

  // 会员关系(与 customers.member_level 对齐)
  const memberDefs = [
    ['张伟', 'gold', 3200], ['李娜', 'silver', 1500], ['王强', 'diamond', 5800],
    ['陈静', 'gold', 2600], ['赵敏', 'silver', 1900], ['周芳', 'diamond', 6100],
  ]
  const memberships = await ins('customer_memberships', memberDefs.map((m, i) => ({
    tenant_id: ctx.tenantId, customer_id: ctx.custId[m[0]], tier_id: tierId[m[1]],
    points_balance: m[2], joined_at: iso(-90 + i * 5),
    expires_at: iso(275),
  })))
  track('customer_memberships', memberships)

  // 积分流水(不可变)
  const points = await ins('point_transactions', [
    { tenant_id: ctx.tenantId, customer_id: ctx.custId['张伟'], delta: 120, reason: 'purchase', reference_type: 'encounter', balance_after: 3120, operator_id: ctx.userId },
    { tenant_id: ctx.tenantId, customer_id: ctx.custId['张伟'], delta: -100, reason: 'redeem', reference_type: 'order', balance_after: 3020, operator_id: ctx.userId },
    { tenant_id: ctx.tenantId, customer_id: ctx.custId['王强'], delta: 260, reason: 'purchase', reference_type: 'encounter', balance_after: 6060, operator_id: ctx.userId },
    { tenant_id: ctx.tenantId, customer_id: ctx.custId['周芳'], delta: 200, reason: 'adjust', reference_type: 'import', balance_after: 6300, operator_id: ctx.userId },
    { tenant_id: ctx.tenantId, customer_id: ctx.custId['李娜'], delta: -50, reason: 'expiry', reference_type: null, balance_after: 1450, operator_id: ctx.userId },
  ])
  track('point_transactions', points)
}

/* ============ 19. 消息/提醒 Messaging ============ */

async function seedMessages() {
  console.log('\n=== 消息/提醒 Messaging ===')
  const templates = await ins('message_templates', [
    { tenant_id: ctx.tenantId, code: 'VACCINE_REMIND', name: '疫苗到期提醒', channel: 'sms', subject: null, body: '尊敬的{name},您的宠物{pet}疫苗将于{due}到期,请及时预约接种。', variables: { name: 'text', pet: 'text', due: 'date' }, is_active: true, version: 1 },
    { tenant_id: ctx.tenantId, code: 'REVISIT', name: '复诊提醒', channel: 'wechat', subject: '复诊预约提醒', body: '{pet}复诊预约在{date},请提前安排。', variables: { pet: 'text', date: 'date' }, is_active: true, version: 1 },
    { tenant_id: ctx.tenantId, code: 'BIRTHDAY', name: '生日祝福', channel: 'wechat', subject: '生日快乐', body: '祝{pet}生日快乐!到店可享宠物蛋糕一份。', variables: { pet: 'text' }, is_active: true, version: 1 },
  ])
  track('message_templates', templates)

  const reminders = await ins('reminders', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['杨帆'], pet_id: ctx.petId['乐乐'], type: 'vaccine', scheduled_at: iso(-10), status: 'pending', payload: { vaccine: '狂犬疫苗' } },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['张伟'], pet_id: ctx.petId['大黄'], type: 'revisit', scheduled_at: iso(2), status: 'pending', payload: { reason: '术后复查' } },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['周芳'], pet_id: ctx.petId['富贵'], type: 'birthday', scheduled_at: iso(6), status: 'sent', sent_at: iso(5, 9), payload: {} },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, customer_id: ctx.custId['陈静'], pet_id: ctx.petId['旺财'], type: 'vaccine', scheduled_at: iso(-1), status: 'cancelled', payload: { vaccine: '细小疫苗' } },
  ])
  track('reminders', reminders)

  const deliveries = await ins('message_deliveries', [
    { tenant_id: ctx.tenantId, reminder_id: reminders[0].id, template_id: templates[0].id, channel: 'sms', recipient: '13800000006', content_snapshot: '尊敬的杨帆,您的宠物乐乐狂犬疫苗已到期,请及时预约接种。', provider_message_id: 'SMS-0001', status: 'sent', attempts: 1, sent_at: iso(-10, 9) },
    { tenant_id: ctx.tenantId, reminder_id: reminders[2].id, template_id: templates[2].id, channel: 'wechat', recipient: 'demo-openid-zhoufang', content_snapshot: '祝富贵生日快乐!到店可享宠物蛋糕一份。', provider_message_id: 'WX-0002', status: 'sent', attempts: 1, sent_at: iso(5, 9) },
    { tenant_id: ctx.tenantId, reminder_id: null, template_id: templates[1].id, channel: 'wechat', recipient: 'demo-openid-zhangwei', content_snapshot: '大黄复诊预约在明日,请提前安排。', status: 'queued', attempts: 0 },
    { tenant_id: ctx.tenantId, reminder_id: reminders[3].id, template_id: templates[0].id, channel: 'sms', recipient: '13800000005', content_snapshot: '尊敬的陈静,您的宠物旺财细小疫苗将到期。', status: 'failed', error: '供应商通道错误', attempts: 2 },
  ])
  track('message_deliveries', deliveries)

  const attempts = await ins('message_delivery_attempts', [
    { delivery_id: deliveries[0].id, provider: 'aliyun_sms', attempt_no: 1, request_snapshot: { phone: '13800000006', tpl: 'VACCINE_REMIND' }, response_snapshot: { code: 'OK' }, status: 'delivered' },
    { delivery_id: deliveries[3].id, provider: 'aliyun_sms', attempt_no: 1, request_snapshot: { phone: '13800000005' }, response_snapshot: { code: 'TIMEOUT' }, status: 'failed', error_code: 'TIMEOUT', error_message: '请求超时' },
    { delivery_id: deliveries[3].id, provider: 'aliyun_sms', attempt_no: 2, request_snapshot: { phone: '13800000005' }, response_snapshot: { code: 'THROTTLE' }, status: 'failed', error_code: 'THROTTLE', error_message: '触发限流' },
  ])
  track('message_delivery_attempts', attempts)
}

/* ============ 20. 导入任务 Import ============ */

async function seedImport() {
  console.log('\n=== 导入任务 Import ===')
  const jobs = await ins('import_jobs', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, type: 'customer', status: 'completed', total_rows: 100, success_count: 98, failed_count: 2, created_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, type: 'pet', status: 'completed', total_rows: 80, success_count: 80, failed_count: 0, created_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, type: 'customer', status: 'failed', total_rows: 50, success_count: 0, failed_count: 50, error_file_key: 'imports/demo-failures.csv', created_by: ctx.userId },
  ])
  track('import_jobs', jobs)
}

/* ============ 21. 汇总与入口 ============ */

function printStats() {
  console.log('\n===== 插入汇总 =====')
  const total = Object.values(stats).reduce((s, n) => s + n, 0)
  for (const [t, n] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(32)} ${String(n).padStart(4)}`)
  }
  console.log(`  ${'TOTAL'.padEnd(32)} ${String(total).padStart(4)}`)
}

async function main() {
  console.log('=== 批量演示数据种子 ===')
  await resolveContext()
  await cleanup()

  const itemId = await seedCatalog()
  await seedInventory(itemId)
  await seedCrm()
  await seedClinical(itemId)
  await seedBilling(itemId)
  await seedInpatient(itemId)
  await seedDiagnostics(itemId)
  await seedBoarding(itemId)
  await seedPurchasing(itemId)
  await seedImaging(itemId)
  await seedClosing()
  await seedFollowup()
  await seedMembership()
  await seedMessages()
  await seedImport()

  printStats()
  console.log('\n完成!前端登录后即可在各业务页面查看演示数据。')
}

main().catch((e) => {
  console.error('\n种子执行失败:', e)
  process.exit(1)
})