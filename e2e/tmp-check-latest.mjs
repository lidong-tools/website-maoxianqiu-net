// 临时脚本:检查最近一次失败运行(1786184479029)创建的客户/宠物在库中的实际归属
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

const custs = await q('customers?select=id,name,tenant_id,store_id,status&name=like.*1786184479029*')
console.log('本次客户:', JSON.stringify(custs, null, 1))
const pets = await q('pets?select=id,name,tenant_id,customer_id,status&name=like.*1786184479029*')
console.log('本次宠物:', JSON.stringify(pets, null, 1))
// 全库最近 pets
const recentPets = await q('pets?select=id,name,tenant_id,customer_id,status&order=created_at.desc&limit=5')
console.log('最近5条宠物:', JSON.stringify(recentPets, null, 1))
