#!/usr/bin/env node

/**
 * 护理管理界面批量测试数据种子脚本(/inpatient/nursing)
 *
 * 参考数据来源:
 *   - e2e/tests/closed-loop-c-inpatient.spec.ts:护理任务 nursing_tasks 的字段结构
 *     (tenant_id / store_id / admission_id / pet_id / plan_id / task_type /
 *      description / scheduled_at / assigned_to)
 *   - scripts/seed-inpatient-data.mjs:service role 直连 REST 的实现方式、
 *     幂等清理、时间工具与上下文解析
 *
 * 范围:仅护理管理界面相关表
 *   - nursing_plans  护理计划
 *   - nursing_tasks  护理任务(前端按 admission_id + 当天日期过滤,见 api/modules/inpatient.ts listNursingTasks)
 *   - admissions / cages / customers / pets(在院患者不足时补充)
 *
 * 特点:
 *   - 读取 api/.env.local 中的 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *   - 目标租户/门店/员工动态解析(取第一个 active 租户及其第一门店)
 *   - 幂等:重跑时先清空该租户全部护理计划/任务(演示数据,可安全重建),
 *     再为全部「在院」患者批量重建;自建的「护理演示」入院/客户也会被清理重建
 *   - 在院患者不足目标数时,自动创建「护理演示」客户/宠物并办理入院(占满可用笼位)
 *   - 护理任务覆盖全部 task_type(medication/feeding/walking/observation/wound_care/fluid/other)
 *     与全部 status(pending/in_progress/done/skipped),时间分布在昨天/今天/明天
 *
 * 用法:
 *   node scripts/seed-nursing-data.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ============ 1. 环境与上下文 ============ */

/** 解析 .env 文件(键=值,忽略注释/空行) */
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

/** 本脚本创建的演示数据标识(客户名/入院原因前缀,用于幂等清理) */
const DEMO_PREFIX = '护理演示'
const DEMO_MARK = `[${DEMO_PREFIX}]`

/** 目标在院患者数(不足时自动创建入院补齐) */
const TARGET_INPATIENT = 7

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
 * 解析运行时上下文:第一个 active 租户、其第一门店、一个 active 且 user_id 非空的员工
 * 员工取 user_id(auth.users.id)作为业务操作人
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
    filter: `select=id,user_id,tenant_id&tenant_id=eq.${ctx.tenantId}&status=eq.active&limit=50`,
  })
  const emp = emps.find(e => e.user_id) ?? emps[0]
  if (!emp) { throw new Error('租户下无 active 员工') }
  ctx.employeeId = emp.id
  ctx.userId = emp.user_id

  console.log(`租户: ${ctx.tenantName} (${ctx.tenantId})`)
  console.log(`门店: ${ctx.storeName} (${ctx.storeId})`)
  console.log(`员工: ${ctx.employeeId}  user: ${ctx.userId}`)
}

/* ============ 3. 时间与编号工具 ============ */

/**
 * 生成 UTC 日期偏移 N 天、UTC 时刻 HH:MM 的 ISO 时间戳。
 * 前端 listNursingTasks 用 new Date().toISOString().slice(0,10)(UTC 日期)按天过滤,
 * 任务必须落在 UTC 当天内才会在「今天」查询中可见,故以 UTC 日期为基准。
 * @param offsetDays UTC 日期偏移(0=今天,-1=昨天,1=明天)
 * @param hourUtc UTC 小时(如 0 对应 UTC+8 的 08:00,10 对应 18:00)
 * @param minute 分钟(默认 0)
 */
function atUtc(offsetDays, hourUtc, minute = 0) {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, hourUtc, minute)).toISOString()
}

/** 基于 UTC 日期的业务日期字符串(yyyy-MM-dd,与前端过滤口径一致) */
function bizDate(offsetDays) {
  const d = new Date()
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetDays))
  return `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, '0')}-${String(u.getUTCDate()).padStart(2, '0')}`
}

const RUN_ID = Date.now().toString(36)
const pad = (n, w = 4) => String(n).padStart(w, '0')

/* ============ 4. 幂等清理 ============ */

const stats = {}
function track(table, rows) {
  stats[table] = (stats[table] ?? 0) + (Array.isArray(rows) ? rows.length : 1)
}

/**
 * 清理本脚本产生的演示数据(可安全重复执行):
 *  1. 删除「护理演示」前缀客户创建的入院,并释放其占用笼位
 *  2. 删除「护理演示」客户(宠物随 customer_id 级联删除)
 *  3. 清空该租户全部护理计划/任务(演示数据,脚本会为全部在院患者重建)
 */
async function cleanup() {
  console.log('\n=== 清理前次护理演示数据 ===')

  // 1. 找到「护理演示」入院并删除,释放笼位
  const demoCustomers = await api('customers', {
    filter: `select=id&tenant_id=eq.${ctx.tenantId}&name=ilike.*${encodeURIComponent(DEMO_MARK)}*`,
  })
  const demoCustIds = demoCustomers.map(c => c.id)
  if (demoCustIds.length) {
    const demoAdms = await api('admissions', {
      filter: `select=id,cage_id&tenant_id=eq.${ctx.tenantId}&customer_id=in.(${demoCustIds.join(',')})`,
    })
    for (const adm of demoAdms) {
      if (adm.cage_id) {
        await api('cages', {
          method: 'PATCH',
          filter: `id=eq.${adm.cage_id}`,
          body: { status: 'available', current_admission_id: null },
        })
      }
    }
    if (demoAdms.length) {
      await api('admissions', {
        method: 'DELETE',
        filter: `id=in.(${demoAdms.map(a => a.id).join(',')})`,
      })
      console.log(`  ✓ admissions(护理演示,${demoAdms.length} 条,笼位已释放)`)
    }
    // 2. 删除演示客户(pets 级联)
    await api('customers', {
      method: 'DELETE',
      filter: `id=in.(${demoCustIds.join(',')})`,
    })
    console.log(`  ✓ customers(护理演示,${demoCustIds.length} 条)`)
  }

  // 3. 清空护理计划/任务(先任务后计划;无 FK 依赖,顺序仅为语义清晰)
  for (const t of ['nursing_tasks', 'nursing_plans']) {
    try {
      await api(t, { method: 'DELETE', filter: `tenant_id=eq.${ctx.tenantId}` })
      console.log(`  ✓ ${t}(已清空,待重建)`)
    }
    catch (e) {
      console.warn(`  [跳过] ${t}: ${e.message}`)
    }
  }
}

/* ============ 5. 在院患者保障 ============ */

/**
 * 查询当前门店全部在院患者;不足目标数时,创建「护理演示」客户/宠物并办理入院
 * (直接 REST 插入 admissions + 更新笼位占用,参考 seed-inpatient-data 的入院写法)
 * @returns {Array<{id: string, pet_id: string}>} 全部在院患者列表
 */
async function ensureAdmittedPatients() {
  let admitted = await api('admissions', {
    filter: `select=id,pet_id,customer_id&store_id=eq.${ctx.storeId}&status=eq.admitted`,
  })
  console.log(`\n=== 在院患者:当前 ${admitted.length} 条,目标 ${TARGET_INPATIENT} 条 ===`)

  if (admitted.length >= TARGET_INPATIENT) {
    return admitted
  }

  const need = TARGET_INPATIENT - admitted.length
  const cages = await api('cages', {
    filter: `select=id,code,name&store_id=eq.${ctx.storeId}&status=eq.available&order=code.asc&limit=${need}`,
  })
  if (!cages.length) {
    console.warn('  [提示] 无可用笼位,跳过新增入院(以现有在院患者为准)')
    return admitted
  }

  console.log(`=== 补充 ${cages.length} 个在院患者 ===`)
  const custDefs = [
    { key: '大黄爸', name: '演示客户-张先生', gender: 'male', phone: '13800002001', pet: { key: '大黄', name: '大黄', species: '犬', breed: '金毛寻回犬', gender: 'male' } },
    { key: '咪咪妈', name: '演示客户-李女士', gender: 'female', phone: '13800002002', pet: { key: '咪咪', name: '咪咪', species: '猫', breed: '英短', gender: 'female' } },
    { key: '虎子爸', name: '演示客户-王先生', gender: 'male', phone: '13800002003', pet: { key: '虎子', name: '虎子', species: '猫', breed: '狸花', gender: 'male' } },
    { key: '大圣爸', name: '演示客户-孙先生', gender: 'male', phone: '13800002004', pet: { key: '大圣', name: '大圣', species: '犬', breed: '边境牧羊犬', gender: 'male' } },
  ]

  const customers = await ins('customers', custDefs.slice(0, cages.length).map((c, i) => ({
    tenant_id: ctx.tenantId,
    store_id: ctx.storeId,
    customer_no: `NURSE-CUST-${RUN_ID}-${pad(i + 1)}`,
    name: `${DEMO_MARK}${c.name}`,
    gender: c.gender,
    phone: c.phone,
    source: 'walk_in',
    member_level: 'normal',
    remark: `护理演示数据-${RUN_ID}`,
    created_by: ctx.userId,
  })))
  track('customers', customers)
  const custId = Object.fromEntries(custDefs.map((c, i) => [c.key, customers[i]?.id]))

  const pets = await ins('pets', custDefs.slice(0, cages.length).map((c, i) => ({
    tenant_id: ctx.tenantId,
    customer_id: custId[c.key],
    name: `${DEMO_MARK}${c.pet.name}`,
    species: c.pet.species,
    breed: c.pet.breed,
    gender: c.pet.gender,
    birth_date: `${2021 - i % 3}-0${(i % 9) + 1}-1${i % 9}`,
    weight: 3 + i * 1.5,
    is_neutered: i % 2 === 0,
    medical_notes: '护理演示宠物',
  })))
  track('pets', pets)
  const petId = Object.fromEntries(custDefs.map((c, i) => [c.pet.key, pets[i]?.id]))

  const admissions = await ins('admissions', cages.map((cage, i) => ({
    tenant_id: ctx.tenantId,
    store_id: ctx.storeId,
    customer_id: custId[custDefs[i].key],
    pet_id: petId[custDefs[i].pet.key],
    cage_id: cage.id,
    doctor_id: ctx.userId,
    admission_reason: `${DEMO_PREFIX}-${custDefs[i].pet.name}住院观察`,
    admitted_at: atUtc(-1, 2),
    status: 'admitted',
    total_charge: 0,
    settlement_status: 'unsettled',
    receivable_amount: 0,
    paid_amount: 0,
  })))
  track('admissions', admissions)

  // 同步笼位占用
  for (let i = 0; i < cages.length; i++) {
    await api('cages', {
      method: 'PATCH',
      filter: `id=eq.${cages[i].id}`,
      body: { status: 'occupied', current_admission_id: admissions[i].id },
    })
  }
  console.log(`  ✓ 新增 ${admissions.length} 条入院并占用笼位`)

  admitted = await api('admissions', {
    filter: `select=id,pet_id,customer_id&store_id=eq.${ctx.storeId}&status=eq.admitted`,
  })
  return admitted
}

/* ============ 6. 护理计划与任务批量插入 ============ */

/**
 * 护理任务模板:覆盖全部 task_type 与全部 status,时间分布在昨天/今天/明天
 * hour 为 UTC 小时(0/1/2/4/6/8/10 对应 UTC+8 的 08/09/10/12/14/16/18 点),
 * 前端 listNursingTasks 按 UTC 当天日期过滤,故「今天」任务必须落在 UTC 当天
 */
const TASK_TEMPLATE = [
  // 今天:已完成(早上)
  { offset: 0, hour: 0, type: 'medication', desc: '喂服抗生素', status: 'done' },
  { offset: 0, hour: 1, type: 'observation', desc: '监测体温', status: 'done' },
  // 今天:已跳过
  { offset: 0, hour: 2, type: 'other', desc: '病房巡查(宠物抗拒)', status: 'skipped' },
  // 今天:执行中(中午)
  { offset: 0, hour: 4, type: 'fluid', desc: '静脉输液', status: 'in_progress' },
  // 今天:待执行(下午/傍晚)
  { offset: 0, hour: 6, type: 'feeding', desc: '饲喂处方粮', status: 'pending' },
  { offset: 0, hour: 8, type: 'wound_care', desc: '伤口换药', status: 'pending' },
  { offset: 0, hour: 10, type: 'walking', desc: '外出遛弯', status: 'pending' },
  // 昨天:历史已完成
  { offset: -1, hour: 1, type: 'medication', desc: '喂服抗生素', status: 'done' },
  { offset: -1, hour: 7, type: 'observation', desc: '监测体温', status: 'done' },
  // 明天:预约任务
  { offset: 1, hour: 1, type: 'feeding', desc: '饲喂', status: 'pending' },
  { offset: 1, hour: 6, type: 'medication', desc: '喂药', status: 'pending' },
]

/**
 * 为全部在院患者批量插入护理计划与护理任务
 * @param {Array<{id: string, pet_id: string}>} admitted 在院患者列表
 */
async function seedNursing(admitted) {
  console.log(`\n=== 批量插入护理计划/任务(覆盖 ${admitted.length} 个在院患者) ===`)

  const plans = []
  const tasks = []
  for (const [i, adm] of admitted.entries()) {
    // 每个患者 2 个护理计划(不同频率,第二个含结束日期便于展示)
    plans.push(
      { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: adm.id, pet_id: adm.pet_id, plan_name: `${DEMO_PREFIX}-基础护理`, frequency: 'daily', start_date: bizDate(-1), is_active: true, created_by: ctx.userId },
      { tenant_id: ctx.tenantId, store_id: ctx.storeId, admission_id: adm.id, pet_id: adm.pet_id, plan_name: `${DEMO_PREFIX}-术后观察`, frequency: 'q8h', start_date: bizDate(-1), end_date: bizDate(3), is_active: true, created_by: ctx.userId },
    )
    // 每个患者 11 个任务(轮换任务类型起始,保证不同患者覆盖顺序不同)
    for (const [j, t] of TASK_TEMPLATE.entries()) {
      const taskType = t.type
      tasks.push({
        tenant_id: ctx.tenantId,
        store_id: ctx.storeId,
        admission_id: adm.id,
        pet_id: adm.pet_id,
        plan_id: j % 2 === 0 ? null : plans[plans.length - 1].id, // 半数任务挂靠计划
        task_type: taskType,
        description: `${t.desc}-${i + 1}号床`,
        scheduled_at: atUtc(t.offset, t.hour),
        assigned_to: ctx.userId,
        status: t.status,
        completed_at: t.status === 'done' ? atUtc(t.offset, t.hour, 30) : null,
        completed_by: t.status === 'done' ? ctx.userId : null,
        note: t.status === 'skipped' ? '演示-宠物不配合,已登记跳过' : null,
      })
    }
  }

  const insertedPlans = await ins('nursing_plans', plans)
  track('nursing_plans', insertedPlans)
  const insertedTasks = await ins('nursing_tasks', tasks)
  track('nursing_tasks', insertedTasks)
  console.log(`  ✓ 护理计划 ${insertedPlans.length} 条,护理任务 ${insertedTasks.length} 条`)
}

/* ============ 7. 主流程 ============ */

async function main() {
  console.log('=== 护理管理批量测试数据种子 ===')
  await resolveContext()
  await cleanup()

  const admitted = await ensureAdmittedPatients()
  if (!admitted.length) {
    throw new Error('当前门店无在院患者,无法插入护理数据')
  }
  await seedNursing(admitted)

  console.log('\n=== 插入统计 ===')
  for (const [table, n] of Object.entries(stats)) {
    console.log(`  ${table}: ${n}`)
  }
  console.log(`\n完成:租户=${ctx.tenantName} 门店=${ctx.storeName} 在院患者=${admitted.length} runId=${RUN_ID}`)
  console.log('前端登录后进入「住院管理 → 护理管理」即可查看批量测试数据。')
}

main().catch((e) => {
  console.error('脚本执行失败:', e.message)
  process.exit(1)
})
