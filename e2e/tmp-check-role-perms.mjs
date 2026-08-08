// 临时脚本:查询 tenant_owner 角色权限码,确认删掉 platform_admin 后 e2e 所需权限是否完整
// 运行:node e2e/tmp-check-role-perms.mjs
import process from 'node:process'

const URL = 'https://bxhvtbhwuktrpxxygikj.supabase.co'
const KEY = process.env.SB_SR || ''

const USER_ID = '3ca950a6-3892-4108-82d0-50b3220ff62a' // support@maoxianqiu.app

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
  if (!r.ok) throw new Error(`${opts?.method ?? 'GET'} ${path} -> ${r.status} ${text}`)
  try { return JSON.parse(text) } catch { return text }
}

// 1. 平台角色现状
const pur = await q(`platform_user_roles?select=*&user_id=eq.${USER_ID}`)
console.log('platform_user_roles:', JSON.stringify(pur))

// 2. 员工及角色分配
const emps = await q(`employees?select=id,tenant_id,user_id,status&user_id=eq.${USER_ID}`)
console.log('employees:', JSON.stringify(emps))
if (emps.length) {
  const era = await q(`employee_role_assignments?select=role_id,role:roles(id,code,scope)&employee_id=eq.${emps[0].id}`)
  console.log('ERA:', JSON.stringify(era, null, 1))
}

// 3. tenant_owner 角色的权限码(role_permissions 关联 permissions)
const rp = await q(`role_permissions?select=permissions(code)&role_id=eq.e621ff92-db0c-48ed-8e13-8d6a342b2a21&limit=500`)
const codes = rp.flatMap(r => {
  const p = r.permissions
  return Array.isArray(p) ? p.map(x => x.code) : (p ? [p.code] : [])
})
console.log('tenant_owner permission codes:', JSON.stringify([...new Set(codes)].sort()))

// 4. 全部权限码总数
const allPerms = await q(`permissions?select=code&limit=1000`)
console.log('total permission codes:', allPerms.length)
