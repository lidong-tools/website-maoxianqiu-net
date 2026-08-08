// 临时脚本:用 service role 检查 E2E 账号在数据库中的授权记录是否完整
// 用途:排查 closed-loop-a 中"客户详情页 0 只宠物"(浏览器直连 Supabase 被 RLS 拦截)
import process from 'node:process'

const URL = 'https://bxhvtbhwuktrpxxygikj.supabase.co'
const KEY = process.env.SB_SR || ''

if (!KEY) {
  console.error('缺少 SB_SR 环境变量(SUPABASE_SERVICE_ROLE_KEY)')
  process.exit(1)
}

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
    },
  })
  if (!r.ok) {
    throw new Error(`${path} -> ${r.status} ${await r.text()}`)
  }
  return r.json()
}

const rows = (await q('platform_user_roles?select=user_id,role&user_id=not.is.null&limit=100'))
console.log('platform_user_roles:', JSON.stringify(rows))

const sm = (await q('store_members?select=user_id,store_id,role_id,status&limit=100'))
console.log('store_members:', JSON.stringify(sm))

const tm = (await q('tenant_memberships?select=user_id,tenant_id,status&limit=100'))
console.log('tenant_memberships:', JSON.stringify(tm))

const emps = (await q('employees?select=id,user_id,tenant_id,status&limit=100'))
console.log('employees:', JSON.stringify(emps))

const era = (await q('employee_role_assignments?select=employee_id,tenant_id,store_id,role_id&limit=100'))
console.log('employee_role_assignments:', JSON.stringify(era))

const esa = (await q('employee_store_assignments?select=employee_id,tenant_id,store_id,ends_at&limit=100'))
console.log('employee_store_assignments:', JSON.stringify(esa))

const roles = (await q('roles?select=id,code,scope,is_system&limit=100'))
console.log('roles:', JSON.stringify(roles))

const tenants = (await q('tenants?select=id,name,status&limit=20'))
console.log('tenants:', JSON.stringify(tenants))
