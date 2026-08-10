#!/usr/bin/env node

/**
 * 住院模块测试数据批量插入脚本
 *
 * 参考数据来源:
 *   - e2e/tests/closed-loop-c-inpatient.spec.ts(客户/宠物/入院/护理/计费/换房字段结构)
 *   - scripts/seed-demo-data.mjs(service role 直连 REST 的实现方式与字段风格)
 *
 * 范围:仅覆盖「住院」一级导航下 7 个二级界面相关表
 *   - 房态看板 : rooms / cages
 *   - 入院登记 : admissions(+ 演示客户/宠物)
 *   - 护理管理 : nursing_plans / nursing_tasks
 *   - 班次交接 : shift_handovers
 *   - 病程记录 : inpatient_progress_notes
 *   - 出院结算 : inpatient_charges / cage_transfers / admissions 结算列
 *   - 寄养管理 : boarding_stays / boarding_daily_records / boarding_service_charges
 *
 * 特点:
 *   - 读取 api/.env.local 中的 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *   - 目标租户/门店/员工动态解析(取第一个 active 租户及其第一门店)
 *   - 幂等:演示客户/宠物以「住院演示」前缀标识,重跑时先清理前次数据
 *   - 不触碰 CRM/库存/临床等其他模块数据
 *
 * 用法:
 *   node scripts/seed-inpatient-data.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ============ 1. 环境与上下文 ============ */

// 解析 .env 文件(键=值,忽略注释/空行),供 api/.env.local 与 api/.env 合并读取
function loadEnv(file) {
  const out = {}
  if (!fs.existsSync(file)) { return out }
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) { continue }
    const i = t.indexOf('=')
    if (i > 0) { out[t.slice(0, i).trim()] = t.slice(i + 1).trim() }
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
  'apikey': SR,
  'Authorization': `Bearer ${SR}`,
  'Content-Type': 'application/json',
}

// 本脚本创建的演示客户/宠物名字前缀,用于幂等清理
const DEMO_PREFIX = '住院演示'
const DEMO_CUSTOMER_MARK = `[${DEMO_PREFIX}]`

/**
 * REST 请求封装(service role 直连,绕过 RLS)
 */
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

/** 批量插入,返回带 id 的行(PostgREST 要求对象键一致,自动补齐缺失键为 null) */
async function ins(table, rows) {
  const arr = Array.isArray(rows) ? rows : [rows]
  if (arr.length === 0) { return [] }
  const keys = [...new Set(arr.flatMap(r => Object.keys(r)))]
  const normalized = arr.map(r => Object.fromEntries(keys.map(k => [k, r[k] ?? null])))
  return api(table, { method: 'POST', body: normalized, prefer: 'return=representation' })
}

const ctx = {}

/* ============ 2. 解析租户/门店/员工 ============ */

/**
 * 解析运行时上下文:第一个 active 租户、其第一门店、一个 active 员工
 * 员工取 user_id(auth.users.id)作为业务操作人,与 seed-demo-data 保持一致
 */
async function resolveContext() {
  const tenants = await api('tenants', { filter: 'select=id,name,status&order=created_at.asc&limit=1' })
  if (!tenants.length) { throw new Error('无可用租户') }
  ctx.tenantId = tenants[0].id
  ctx.tenantName = tenants[0].name

  const stores = await api('stores', { filter: `select=id,name,code&tenant_id=eq.${ctx.tenantId}&order=created_at.asc&limit=1` })
  if (!stores.length) { throw new Error('租户下无门店') }
  ctx.storeId = stores[0].id
  ctx.storeName = stores[0].name

  const emps = await api('employees', {
    filter: `select=id,user_id,tenant_id&tenant_id=eq.${ctx.tenantId}&status=eq.active&limit=1`,
  })
  if (!emps.length) { throw new Error('租户下无 active 员工') }
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
function bizDate(offset) {
  const d = day(offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const pad = (n, w = 4) => String(n).padStart(w, '0')
// 病程记录已签署后不可删除(审计保护),重跑种子需保证单号跨运行唯一
const RUN_ID = Date.now().toString(36)
let seq = 0
const nextRunNo = prefix => `${prefix}-${RUN_ID}-${pad(++seq)}`

/* ============ 4. 清理前次住院演示数据(FK 逆序) ============ */

/** 住院相关表,按 FK 依赖逆序清理(仅限本租户);病程记录最后单独清理(见 cleanup) */
const CLEANUP_TABLES = [
  // 寄养
  'boarding_daily_records',
  'boarding_service_charges',
  'boarding_stays',
  // 住院(病程 inpatient_progress_notes 最后删)
  'inpatient_charges',
  'cage_transfers',
  'shift_handovers',
  'nursing_tasks',
  'nursing_plans',
  'admissions',
  'cages',
  'rooms',
]

/**
 * 清理:先删本脚本创建的「住院演示」客户(pets 级联删除),再按 FK 逆序删住院相关表
 * 病程记录须在 admissions 之后删:已签署病程受审计保护(migration 117 prevent_signed_progress_note_delete),
 * 直接删会报 SIGNED_PROGRESS_NOTE_IMMUTABLE;但先删 admissions 后,演示病程(MXQ-PN-/DEMO-PN- 前缀,
 * 与真实业务 PN- 前缀不冲突)全部变为孤儿记录,审计保护对孤儿放行,可正常删除
 */
async function cleanup() {
  console.log('\n=== 清理前次住院演示数据 ===')
  // 删除本脚本创建的演示客户(pets 随 customer_id 级联删除)
  try {
    await api('customers', {
      method: 'DELETE',
      filter: `tenant_id=eq.${ctx.tenantId}&name=ilike.*${encodeURIComponent(DEMO_CUSTOMER_MARK)}*`,
    })
    console.log('  ✓ customers(住院演示前缀)')
  }
  catch (e) {
    console.warn(`  [跳过] customers: ${e.message}`)
  }
  for (const t of CLEANUP_TABLES) {
    try {
      await api(t, { method: 'DELETE', filter: `tenant_id=eq.${ctx.tenantId}` })
      console.log(`  ✓ ${t}`)
    }
    catch (e) {
      console.warn(`  [跳过] ${t}: ${e.message}`)
    }
  }
  // 病程最后删:此时演示病程引用的 admission 已删除,均为孤儿,可删
  const noteFilter = `tenant_id=eq.${ctx.tenantId}&or=(note_no.ilike.*MXQ-PN-*,note_no.ilike.*DEMO-PN-*)`
  try {
    await api('inpatient_progress_notes', { method: 'DELETE', filter: noteFilter })
    console.log('  ✓ inpatient_progress_notes(孤儿演示病程)')
  }
  catch (e) {
    console.warn(`  [跳过] inpatient_progress_notes: ${e.message}`)
  }
}

/* ============ 5. 数据统计 ============ */

const stats = {}
function track(table, rows) {
  stats[table] = (stats[table] ?? 0) + (Array.isArray(rows) ? rows.length : 1)
}

/* ============ 6. 演示客户/宠物(参考 e2e 客户/宠物字段) ============ */

/**
 * 创建住院演示客户/宠物(名字带「住院演示」前缀,便于幂等清理)
 * 字段参考 e2e closed-loop-c 的 customers/pets POST 结构
 * @returns {{custId: Object, petId: Object}} 按名字索引的 id 映射
 */
async function seedCrmMini() {
  console.log('\n=== 住院演示客户/宠物 ===')
  const custDefs = [
    { key: '团子妈', name: '演示客户-赵女士', gender: 'female', phone: '13800001001' },
    { key: '跳跳爸', name: '演示客户-刘先生', gender: 'male', phone: '13800001002' },
    { key: '旺财爸', name: '演示客户-陈先生', gender: 'male', phone: '13800001003' },
    { key: '富贵妈', name: '演示客户-周女士', gender: 'female', phone: '13800001004' },
    { key: '豆豆妈', name: '演示客户-张女士', gender: 'female', phone: '13800001005' },
    { key: '乐乐爸', name: '演示客户-杨先生', gender: 'male', phone: '13800001006' },
  ]
  const customers = await ins('customers', custDefs.map((c, i) => ({
    tenant_id: ctx.tenantId,
    store_id: ctx.storeId,
    customer_no: `MXQ-CUST-${RUN_ID}-${pad(i + 1)}`,
    name: `${DEMO_CUSTOMER_MARK}${c.name}`,
    gender: c.gender,
    phone: c.phone,
    source: 'walk_in',
    member_level: 'normal',
    remark: `住院演示数据-${RUN_ID}`,
    created_by: ctx.userId,
  })))
  track('customers', customers)
  const custId = Object.fromEntries(customers.map((c, i) => [custDefs[i].key, c.id]))

  const petDefs = [
    { key: '团子', customer: '团子妈', name: '团子', species: '猫', breed: '美短', gender: 'male', weight: 4.5 },
    { key: '跳跳', customer: '跳跳爸', name: '跳跳', species: '兔', breed: '垂耳兔', gender: 'male', weight: 1.8 },
    { key: '旺财', customer: '旺财爸', name: '旺财', species: '犬', breed: '柴犬', gender: 'male', weight: 9.2 },
    { key: '富贵', customer: '富贵妈', name: '富贵', species: '猫', breed: '蓝猫', gender: 'male', weight: 5.8 },
    { key: '豆豆', customer: '豆豆妈', name: '豆豆', species: '犬', breed: '泰迪', gender: 'female', weight: 4.2 },
    { key: '乐乐', customer: '乐乐爸', name: '乐乐', species: '犬', breed: '柯基', gender: 'female', weight: 11.0 },
  ]
  const pets = await ins('pets', petDefs.map((p, i) => ({
    tenant_id: ctx.tenantId,
    customer_id: custId[p.customer],
    name: `${DEMO_CUSTOMER_MARK}${p.name}`,
    species: p.species,
    breed: p.breed,
    gender: p.gender,
    birth_date: `${2021 - i % 3}-0${(i % 9) + 1}-1${i % 9}`,
    weight: p.weight,
    is_neutered: i % 2 === 0,
    medical_notes: '住院演示宠物',
  })))
  track('pets', pets)
  const petId = Object.fromEntries(pets.map((p, i) => [petDefs[i].key, p.id]))
  return { custId, petId }
}

/* ============ 7. 住院主数据:房间/笼位 ============ */

/**
 * 创建房间与笼位(房态看板数据来源)
 * @returns {{roomId: Object, cageId: Object}} id 映射
 */
async function seedRoomsCages() {
  console.log('\n=== 房态看板:房间/笼位 ===')
  const rooms = await ins('rooms', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, name: '住院一区', code: 'RM-WARD-1', floor: '1', room_type: 'ward', capacity: 8 },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, name: 'ICU', code: 'RM-ICU-1', floor: '2', room_type: 'icu', capacity: 2 },
  ])
  track('rooms', rooms)
  const roomId = { ward: rooms[0].id, icu: rooms[1].id }

  const cageDefs = [
    ['CAGE-W1', '住院笼位1', 'ward', 100],
    ['CAGE-W2', '住院笼位2', 'ward', 100],
    ['CAGE-W3', '住院笼位3', 'ward', 100],
    ['CAGE-W4', '住院笼位4', 'ward', 120],
    ['CAGE-W5', '住院笼位5', 'ward', 120],
    ['CAGE-W6', '住院笼位6', 'ward', 150],
    ['CAGE-ICU1', 'ICU监护1', 'icu', 300],
    ['CAGE-ICU2', 'ICU监护2', 'icu', 300],
    ['CAGE-BD1', '寄养笼位1', 'ward', 80],
    ['CAGE-BD2', '寄养笼位2', 'ward', 80],
  ]
  const cages = await ins('cages', cageDefs.map(c => ({
    tenant_id: ctx.tenantId,
    store_id: ctx.storeId,
    room_id: roomId[c[2]],
    name: c[1],
    code: c[0],
    cage_type: 'cage',
    daily_rate: c[3],
    status: 'available',
  })))
  track('cages', cages)
  const cageId = Object.fromEntries(cages.map(c => [c.code, c.id]))
  return { roomId, cageId }
}

/* ============ 8. 住院核心业务数据 ============ */

/**
 * 插入住院记录 + 病程 + 护理 + 计费 + 换房 + 交接班
 * 覆盖入院登记/护理管理/病程记录/出院结算/班次交接界面
 * @param {Object} ids 依赖的 id 映射(custId/petId/cageId/itemId)
 * @returns {Object} 关键行 id(admissionId 等),供寄养步骤引用
 */
async function seedInpatient(ids) {
  const { custId, petId, cageId, itemId } = ids
  console.log('\n=== 住院:入院/护理/病程/计费/换房/交接 ===')

  // 住院记录:[客户, 宠物, 笼位, 状态, 入院偏移天, 结算]
  // - 前 3 条在住(admitted),后 2 条已出院(discharged + settled)
  // - 结算字段对应 20260809000048_discharge_settlement 扩展列
  const admDefs = [
    { pet: '团子', cage: 'CAGE-W1', status: 'admitted', offset: -1, reason: '尿道感染住院观察', settlement: null, total: 320 },
    { pet: '跳跳', cage: 'CAGE-W2', status: 'admitted', offset: -2, reason: '胃肠炎住院补液', settlement: null, total: 280 },
    { pet: '富贵', cage: 'CAGE-ICU1', status: 'admitted', offset: 0, reason: '膀胱结石术后ICU监护', settlement: null, total: 680 },
    { pet: '旺财', cage: 'CAGE-W3', status: 'discharged', offset: -5, reason: '犬瘟恢复期住院观察', settlement: { status: 'settled', total: 720, paid: 720 }, total: 720 },
    { pet: '豆豆', cage: 'CAGE-W4', status: 'discharged', offset: -8, reason: '髌骨脱位术后住院', settlement: { status: 'settled', total: 1080, paid: 1080 }, total: 1080 },
  ]
  const admissions = await ins('admissions', admDefs.map((a, i) => ({
    tenant_id: ctx.tenantId,
    store_id: ctx.storeId,
    customer_id: custId[`${a.pet}妈`] ?? custId[`${a.pet}爸`],
    pet_id: petId[a.pet],
    cage_id: cageId[a.cage],
    doctor_id: ctx.userId,
    admission_reason: `${DEMO_PREFIX}-${a.reason}`,
    admitted_at: iso(a.offset, 10),
    status: a.status,
    discharged_at: a.status === 'discharged' ? iso(a.offset + 2, 11) : null,
    discharge_reason: a.status === 'discharged' ? '病情好转,临床治愈' : null,
    discharge_notes: a.status === 'discharged' ? '体温正常,食欲恢复,可出院' : null,
    total_charge: a.total,
    settlement_status: a.settlement?.status ?? 'unsettled',
    settlement_no: a.settlement ? `MXQ-STL-${RUN_ID}-${pad(i + 1)}` : null,
    receivable_amount: a.settlement?.total ?? 0,
    paid_amount: a.settlement?.paid ?? 0,
    finalized_at: a.settlement ? iso(a.offset + 2, 12) : null,
  })))
  track('admissions', admissions)
  ctx.admId = Object.fromEntries(admDefs.map((a, i) => [a.pet, admissions[i].id]))

  // 病程记录(覆盖 daily/critical/postop/discharge 类型, draft/signed 状态)
  const notes = await ins('inpatient_progress_notes', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['团子'], pet_id: petId['团子'], note_no: nextRunNo('MXQ-PN'), note_type: 'daily', content: '入院第2天,精神状态好转,体温38.6℃,继续抗感染治疗', status: 'signed', recorded_at: iso(-1, 9), recorded_by: ctx.userId, signed_at: iso(-1, 10), signed_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['团子'], pet_id: petId['团子'], note_no: nextRunNo('MXQ-PN'), note_type: 'daily', content: '今日复查血常规,白细胞恢复正常,准备明日出院', status: 'draft', recorded_at: iso(0, 9), recorded_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['跳跳'], pet_id: petId['跳跳'], note_no: nextRunNo('MXQ-PN'), note_type: 'daily', content: '补液后呕吐停止,已少量进食', status: 'signed', recorded_at: iso(-1, 16), recorded_by: ctx.userId, signed_at: iso(-1, 17), signed_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['富贵'], pet_id: petId['富贵'], note_no: nextRunNo('MXQ-PN'), note_type: 'postop', content: '术后首日,留置导尿管通畅,心电监护稳定', status: 'draft', recorded_at: iso(0, 9), recorded_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['旺财'], pet_id: petId['旺财'], note_no: nextRunNo('MXQ-PN'), note_type: 'discharge', content: '出院小结:犬瘟恢复期结束,各项指标正常,医嘱定期复查', status: 'signed', recorded_at: iso(-3, 9), recorded_by: ctx.userId, signed_at: iso(-3, 10), signed_by: ctx.userId },
  ])
  track('inpatient_progress_notes', notes)

  // 护理计划 + 护理任务(覆盖 pending/in_progress/done 状态与多种任务类型)
  const [plan] = await ins('nursing_plans', [{
    tenant_id: ctx.tenantId,
    store_id: ctx.storeId,
    admission_id: ctx.admId['团子'],
    pet_id: petId['团子'],
    plan_name: `${DEMO_PREFIX}-抗感染护理`,
    frequency: 'q8h',
    start_date: bizDate(-1),
    is_active: true,
    created_by: ctx.userId,
  }])
  track('nursing_plans', 1)
  const ntasks = await ins('nursing_tasks', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['团子'], pet_id: petId['团子'], plan_id: plan.id, task_type: 'medication', description: '喂服抗生素', scheduled_at: iso(0, 8), assigned_to: ctx.userId, status: 'done', completed_at: iso(0, 8, 30), completed_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['团子'], pet_id: petId['团子'], plan_id: plan.id, task_type: 'observation', description: '监测体温', scheduled_at: iso(0, 12), assigned_to: ctx.userId, status: 'pending' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['跳跳'], pet_id: petId['跳跳'], task_type: 'feeding', description: '少量饲喂', scheduled_at: iso(0, 10), assigned_to: ctx.userId, status: 'in_progress' },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['富贵'], pet_id: petId['富贵'], task_type: 'fluid', description: '静脉补液', scheduled_at: iso(0, 9), assigned_to: ctx.userId, status: 'done', completed_at: iso(0, 11), completed_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['富贵'], pet_id: petId['富贵'], task_type: 'wound_care', description: '伤口换药', scheduled_at: iso(0, 14), assigned_to: ctx.userId, status: 'pending' },
  ])
  track('nursing_tasks', ntasks)

  // 住院收费(出院结算界面:auto 自动计费 + 手动项目,覆盖多条)
  const charges = await ins('inpatient_charges', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['团子'], charge_date: bizDate(-1), catalog_item_id: itemId?.service ?? null, description: '输液护理', quantity: 2, unit_price: 50, amount: 100, is_auto: true },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['团子'], charge_date: bizDate(0), catalog_item_id: itemId?.service ?? null, description: '输液护理', quantity: 1, unit_price: 50, amount: 50, is_auto: true },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['团子'], charge_date: bizDate(0), catalog_item_id: itemId?.exam ?? null, description: '血常规复查', quantity: 1, unit_price: 80, amount: 80, is_auto: false },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['富贵'], charge_date: bizDate(0), catalog_item_id: itemId?.service ?? null, description: 'ICU监护费', quantity: 1, unit_price: 300, amount: 300, is_auto: true },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['旺财'], charge_date: bizDate(-5), catalog_item_id: itemId?.service ?? null, description: '住院观察费', quantity: 5, unit_price: 100, amount: 500, is_auto: true },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['旺财'], charge_date: bizDate(-5), catalog_item_id: itemId?.exam ?? null, description: 'X光复查', quantity: 1, unit_price: 150, amount: 150, is_auto: false },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['豆豆'], charge_date: bizDate(-8), catalog_item_id: itemId?.service ?? null, description: '住院观察费', quantity: 8, unit_price: 120, amount: 960, is_auto: true },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['豆豆'], charge_date: bizDate(-8), catalog_item_id: itemId?.exam ?? null, description: '术后B超复查', quantity: 1, unit_price: 120, amount: 120, is_auto: false },
  ])
  track('inpatient_charges', charges)

  // 换房历史(出院结算/房态:旺财从 W1 换至 W3,豆豆从 W2 换至 W4)
  const transfers = await ins('cage_transfers', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['旺财'], from_cage_id: cageId['CAGE-W1'], to_cage_id: cageId['CAGE-W3'], reason: '病情好转转入普通病房', operator_id: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: ctx.admId['豆豆'], from_cage_id: cageId['CAGE-W2'], to_cage_id: cageId['CAGE-W4'], reason: '术后稳定转入普通病房', operator_id: ctx.userId },
  ])
  track('cage_transfers', transfers)

  // 班次交接(覆盖 morning/evening 两种班次)
  const hds = await ins('shift_handovers', [
    {
      tenant_id: ctx.tenantId,
      store_id: ctx.storeId,
      shift_date: bizDate(0),
      shift_type: 'morning',
      outgoing_user: ctx.userId,
      incoming_user: ctx.userId,
      summary: { pets: ['团子', '跳跳', '富贵'], highlights: '富贵术后首日,需重点关注引流管', acknowledged: false },
    },
    {
      tenant_id: ctx.tenantId,
      store_id: ctx.storeId,
      shift_date: bizDate(-1),
      shift_type: 'evening',
      outgoing_user: ctx.userId,
      incoming_user: ctx.userId,
      summary: { pets: ['团子'], highlights: '团子夜间体温平稳', acknowledged: true, acknowledgedBy: ctx.userId },
      acknowledged_at: iso(-1, 20),
      acknowledged_by: ctx.userId,
    },
  ])
  track('shift_handovers', hds)

  return ctx.admId
}

/* ============ 9. 寄养数据 ============ */

/**
 * 插入寄养单 + 每日照护 + 附加服务费(寄养管理界面)
 * 覆盖 planned/checked_in/in_service/checkout_pending/checked_out/cancelled 全状态
 * @param {Object} ids 依赖的 id 映射(custId/petId/cageId/itemId)
 */
async function seedBoarding(ids) {
  const { custId, petId, cageId, itemId } = ids
  console.log('\n=== 寄养:寄养单/照护记录/附加服务费 ===')

  // 寄养单:[宠物, 笼位, 状态, 入住偏移, 预计离店偏移, 实际离店偏移]
  const stayPlan = [
    { pet: '豆豆', cage: 'CAGE-BD1', status: 'in_service', in: -2, out: 3, realOut: null },
    { pet: '乐乐', cage: 'CAGE-BD2', status: 'checked_in', in: 0, out: 4, realOut: null },
    { pet: '团子', cage: 'CAGE-W5', status: 'checkout_pending', in: -1, out: 1, realOut: null },
    { pet: '跳跳', cage: 'CAGE-W6', status: 'planned', in: 2, out: 6, realOut: null },
    { pet: '旺财', cage: 'CAGE-W1', status: 'checked_out', in: -10, out: 3, realOut: -6 },
    { pet: '富贵', cage: 'CAGE-ICU2', status: 'cancelled', in: -1, out: 3, realOut: null },
  ]
  const stays = await ins('boarding_stays', stayPlan.map((s, i) => ({
    tenant_id: ctx.tenantId,
    store_id: ctx.storeId,
    boarding_no: `MXQ-BOARD-${RUN_ID}-${pad(i + 1)}`,
    customer_id: custId[`${s.pet}妈`] ?? custId[`${s.pet}爸`],
    pet_id: petId[s.pet],
    cage_id: cageId[s.cage],
    check_in_at: s.status === 'planned' ? null : iso(s.in, 11),
    expected_check_out_at: iso(s.out, 12),
    checked_out_at: s.realOut ? iso(s.realOut, 12) : null,
    status: s.status,
    diet_notes: s.pet === '豆豆' ? '每日两餐,处方粮' : '常规犬粮',
    walking_notes: s.pet === '乐乐' ? '外出需牵绳,怕生' : null,
    medication_notes: s.pet === '豆豆' ? '早晚各一粒护肝药' : null,
    vaccine_verified: true,
    risk_acknowledged: true,
    emergency_contact: { name: s.pet, phone: '13900001000', relation: '主人' },
    total_charge: s.status === 'checked_out' ? 340 : s.status === 'cancelled' ? 0 : 180,
    created_by: ctx.userId,
  })))
  track('boarding_stays', stays)
  ctx.stayId = Object.fromEntries(stays.map((st, i) => [stayPlan[i].pet, st.id]))

  // 每日照护记录(在住寄养单)
  const daily = await ins('boarding_daily_records', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: ctx.stayId['豆豆'], record_date: bizDate(-1), feeding: '早晚各一餐,食欲好', walking: '上午遛30分钟', medication: '护肝药已喂', condition: '精神良好', recorded_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: ctx.stayId['豆豆'], record_date: bizDate(0), feeding: '食欲正常', walking: '下午遛20分钟', condition: '状态稳定', recorded_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: ctx.stayId['乐乐'], record_date: bizDate(0), feeding: '少食,有应激', condition: '新环境,需观察', recorded_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: ctx.stayId['团子'], record_date: bizDate(-1), feeding: '食欲恢复', condition: '等待主人接回', recorded_by: ctx.userId },
  ])
  track('boarding_daily_records', daily)

  // 寄养附加服务费
  const charges = await ins('boarding_service_charges', [
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: ctx.stayId['豆豆'], catalog_item_id: itemId?.service ?? null, description: '寄养洁牙护理', quantity: 1, unit_price: 80, amount: 80, charge_date: bizDate(-1), created_by: ctx.userId },
    { tenant_id: ctx.tenantId, store_id: ctx.storeId, boarding_stay_id: ctx.stayId['团子'], catalog_item_id: itemId?.product ?? null, description: '处方粮加餐', quantity: 1, unit_price: 30, amount: 30, charge_date: bizDate(0), created_by: ctx.userId },
  ])
  track('boarding_service_charges', charges)
}

/* ============ 10. 笼位占用状态同步 ============ */

/**
 * 按业务事实更新笼位状态:
 *   - 在住入院占用笼位 → occupied + current_admission_id
 *   - 在住/待离店寄养占用笼位 → occupied + current_boarding_stay_id(住院/寄养互斥)
 *   - 其余笼位保持 available
 */
async function syncCageStatus(cageId) {
  console.log('\n=== 同步笼位占用状态 ===')
  const occupiedByAdmission = [
    { cage: 'CAGE-W1', admission: ctx.admId['团子'] },
    { cage: 'CAGE-W2', admission: ctx.admId['跳跳'] },
    { cage: 'CAGE-ICU1', admission: ctx.admId['富贵'] },
  ]
  for (const o of occupiedByAdmission) {
    await api('cages', {
      method: 'PATCH',
      filter: `id=eq.${cageId[o.cage]}`,
      body: { status: 'occupied', current_admission_id: o.admission, current_boarding_stay_id: null },
    })
  }
  const occupiedByBoarding = [
    { cage: 'CAGE-BD1', stay: ctx.stayId['豆豆'] },
    { cage: 'CAGE-BD2', stay: ctx.stayId['乐乐'] },
    { cage: 'CAGE-W5', stay: ctx.stayId['团子'] },
  ]
  for (const o of occupiedByBoarding) {
    await api('cages', {
      method: 'PATCH',
      filter: `id=eq.${cageId[o.cage]}`,
      body: { status: 'occupied', current_admission_id: null, current_boarding_stay_id: o.stay },
    })
  }
  console.log('  ✓ 已按业务事实更新笼位状态')
}

/* ============ 11. 目录项解析(计费关联用,可选) ============ */

/**
 * 解析租户下已有的目录项(service/exam/product 各取一个,计费表 catalog_item_id 用)
 * 找不到时返回 null,不影响插入(字段可空)
 * @returns {Object|null} { service, exam, product }
 */
async function resolveCatalogItems() {
  try {
    const [service] = await api('catalog_items', { filter: 'select=id&billing_type=eq.service&limit=1' })
    const [exam] = await api('catalog_items', { filter: 'select=id&billing_type=eq.exam&limit=1' })
    const [product] = await api('catalog_items', { filter: 'select=id&billing_type=eq.product&limit=1' })
    return {
      service: service?.id ?? null,
      exam: exam?.id ?? null,
      product: product?.id ?? null,
    }
  }
  catch {
    return null
  }
}

/* ============ 12. 主流程 ============ */

async function main() {
  await resolveContext()
  const itemId = await resolveCatalogItems()
  await cleanup()

  const { custId, petId } = await seedCrmMini()
  const { cageId } = await seedRoomsCages()
  await seedInpatient({ custId, petId, cageId, itemId })
  await seedBoarding({ custId, petId, cageId, itemId })
  await syncCageStatus(cageId)

  console.log('\n=== 插入统计 ===')
  for (const [table, n] of Object.entries(stats)) {
    console.log(`  ${table}: ${n}`)
  }

  // 兜底检查:清理后仍残留的演示病程(正常应为 0;若删除失败则提示,需确认 GUC 放行头是否生效)
  try {
    const leftovers = await api('inpatient_progress_notes', {
      filter: `tenant_id=eq.${ctx.tenantId}&or=(note_no.ilike.*MXQ-PN-*,note_no.ilike.*DEMO-PN-*)&select=note_no,status`,
    })
    if (leftovers.length > 0) {
      console.warn(`\n[提示] 仍有 ${leftovers.length} 条演示病程残留(清理未完全生效,可能为已签署且引用在住住院记录的非孤儿记录)。`)
      console.warn('可在 Supabase SQL Editor 中执行以下 SQL 手工清理(仅演示前缀,不影响真实业务 PN- 病程):')
      console.warn(`  delete from public.inpatient_progress_notes where tenant_id = '${ctx.tenantId}' and (note_no like 'MXQ-PN-%' or note_no like 'DEMO-PN-%') and status = 'draft';`)
    }
  }
  catch {
    // 检查失败不阻塞主流程
  }
  console.log(`\n完成:租户=${ctx.tenantName} 门店=${ctx.storeName} runId=${RUN_ID}`)
}

main().catch((e) => {
  console.error('脚本执行失败:', e.message)
  process.exit(1)
})
