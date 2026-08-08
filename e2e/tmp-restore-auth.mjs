// 临时脚本:恢复 E2E 账号被删除的租户/员工/角色/门店分配记录(新模型)
// 依据:scripts/e2e-setup.sh 只重建了 platform_admin + store_members,
//       tenant_memberships / employees / employee_role_assignments / employee_store_assignments 全部为空
// 运行:node e2e/tmp-restore-auth.mjs
import process from 'node:process'

const URL = 'https://bxhvtbhwuktrpxxygikj.supabase.co'
const KEY = process.env.SB_SR || ''

const USER_ID = '3ca950a6-3892-4108-82d0-50b3220ff62a' // support@maoxianqiu.app
const TENANT_ID = 'aa63ce30-1d4f-48af-82e4-51e70c772d1a' // 默认租户
const STORE_ID = 'cd542d79-28ad-431c-94e5-0fca08d2857b' // 系统管理门店 SYS
const TENANT_OWNER_ROLE = 'e621ff92-db0c-48ed-8e13-8d6a342b2a21' // roles.code=tenant_owner scope=tenant

async function q(path, opts) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(opts?.prefer ? { Prefer: opts.prefer } : {}),
    },
    method: opts?.method ?? 'GET',
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await r.text()
  if (!r.ok && r.status !== 409) {
    throw new Error(`${opts?.method ?? 'GET'} ${path} -> ${r.status} ${text}`)
  }
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

// 0. 前置校验:门店属于租户?system_admin 角色权限是否完整?
const stores = await q(`stores?select=id,code,name,tenant_id&id=eq.${STORE_ID}`)
console.log('SYS store:', JSON.stringify(stores))
const roles = await q(`roles?select=id,code,scope,is_system&id=eq.${TENANT_OWNER_ROLE}`)
console.log('tenant_owner role:', JSON.stringify(roles))
const rp = await q('role_permissions?select=role_id,permissions(code)&role_id=in.(6de97453-ae4d-46fc-acce-7c030bf3ef29)&limit=5')
console.log('system_admin role_permissions(样例):', JSON.stringify(rp).slice(0, 300))

// 1. tenant_memberships
try {
  const r = await q('tenant_memberships', {
    method: 'POST',
    prefer: 'return=representation',
    body: { tenant_id: TENANT_ID, user_id: USER_ID, status: 'active' },
  })
  console.log('insert tenant_memberships:', JSON.stringify(r))
}
catch (e) {
  console.log('tenant_memberships 已存在或失败:', e.message)
}

// 2. employees(employee_no 租户内唯一)
let empId = ''
try {
  const r = await q('employees', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      employee_no: 'E2E-ADMIN',
      name: 'E2E管理员',
      status: 'active',
    },
  })
  console.log('insert employees:', JSON.stringify(r))
  empId = (r[0] ?? r)?.id ?? ''
}
catch (e) {
  console.log('employees 插入失败:', e.message)
  // 若已存在则读取
  const ex = await q(`employees?select=id&tenant_id=eq.${TENANT_ID}&user_id=eq.${USER_ID}&limit=1`)
  empId = ex[0]?.id ?? ''
  console.log('已有 employee id:', empId)
}

if (empId) {
  // 3. employee_role_assignments(tenant-wide:tenant_owner,store_id 为空)
  try {
    const r = await q('employee_role_assignments', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        tenant_id: TENANT_ID,
        employee_id: empId,
        role_id: TENANT_OWNER_ROLE,
      },
    })
    console.log('insert employee_role_assignments:', JSON.stringify(r))
  }
  catch (e) {
    console.log('employee_role_assignments 插入失败:', e.message)
  }

  // 4. employee_store_assignments(主门店 SYS)
  try {
    const r = await q('employee_store_assignments', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        tenant_id: TENANT_ID,
        employee_id: empId,
        store_id: STORE_ID,
        is_primary: true,
      },
    })
    console.log('insert employee_store_assignments:', JSON.stringify(r))
  }
  catch (e) {
    console.log('employee_store_assignments 插入失败:', e.message)
  }
}

// 5. 复查
console.log('\n=== 复查 ===')
for (const t of ['tenant_memberships', 'employees', 'employee_role_assignments', 'employee_store_assignments']) {
  const rows = await q(`${t}?select=*&user_id=eq.${USER_ID}`).catch(async () => {
    // 无 user_id 列的表按 employee 关联查
    if (t === 'employee_role_assignments' || t === 'employee_store_assignments') {
      const emps = await q(`employees?select=id&user_id=eq.${USER_ID}`)
      return emps.length
        ? await q(`${t}?select=*&employee_id=eq.${emps[0].id}`)
        : []
    }
    return []
  })
  console.log(`${t}:`, JSON.stringify(rows))
}
