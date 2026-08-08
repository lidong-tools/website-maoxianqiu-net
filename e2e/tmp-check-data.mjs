// 临时脚本:对比 E2E 测试数据的 customer / pet 归属(tenant_id / store_id)
import process from 'node:process'

const URL = 'https://bxhvtbhwuktrpxxygikj.supabase.co'
const KEY = process.env.SB_SR || ''

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`)
  return r.json()
}

const custs = await q('customers?select=id,name,tenant_id,store_id,status&name=like.*E2E*&order=created_at.desc&limit=10')
console.log('customers:', JSON.stringify(custs, null, 1))

const pets = await q('pets?select=id,name,tenant_id,customer_id,status&name=like.*E2E*&order=created_at.desc&limit=20')
console.log('pets:', JSON.stringify(pets, null, 1))
