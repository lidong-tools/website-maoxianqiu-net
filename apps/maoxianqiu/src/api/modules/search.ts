import { supabase } from '@/lib/supabase'

/**
 * 业务全局搜索 API 模块(CORE-03)
 * 浏览器直连 Supabase,租户/门店边界由 RLS 兜底;每类限制返回条数。
 */

const LIMIT = 8

export interface SearchCustomer {
  id: string
  name: string
  phone: string | null
  customerNo: string | null
}

export interface SearchPet {
  id: string
  name: string
  species: string | null
  microchip: string | null
  ownerName: string | null
}

export interface SearchEncounter {
  id: string
  status: string
  startedAt: string | null
  petName: string | null
  customerName: string | null
}

export interface SearchInvoice {
  id: string
  invoiceNo: string
  total: number
  status: string
}

export interface SearchCatalogItem {
  id: string
  name: string
  code: string | null
  billingType: string | null
}

export interface GlobalSearchResult {
  customers: SearchCustomer[]
  pets: SearchPet[]
  encounters: SearchEncounter[]
  invoices: SearchInvoice[]
  catalogItems: SearchCatalogItem[]
}

async function searchCustomers(q: string): Promise<SearchCustomer[]> {
  const { data } = await supabase
    .from('customers')
    .select('id, name, phone, customer_no')
    .or(`name.ilike.%${q}%,phone.ilike.%${q}%,customer_no.ilike.%${q}%`)
    .neq('status', 'archived')
    .order('created_at', { ascending: false })
    .limit(LIMIT)
  return (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    customerNo: row.customer_no ?? null,
  }))
}

async function searchPets(q: string): Promise<SearchPet[]> {
  const { data } = await supabase
    .from('pets')
    .select('id, name, species, microchip, customer_id')
    .or(`name.ilike.%${q}%,microchip.ilike.%${q}%`)
    .neq('status', 'archived')
    .order('created_at', { ascending: false })
    .limit(LIMIT)
  const rows = (data ?? []) as Array<{ id: string, name: string, species: string | null, microchip: string | null, customer_id: string | null }>
  const ownerIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))] as string[]
  const ownerMap: Record<string, string> = {}
  if (ownerIds.length > 0) {
    const { data: owners } = await supabase
      .from('customers')
      .select('id, name')
      .in('id', ownerIds)
    for (const o of (owners ?? []) as Array<{ id: string, name: string }>) {
      ownerMap[o.id] = o.name
    }
  }
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    species: r.species ?? null,
    microchip: r.microchip ?? null,
    ownerName: r.customer_id ? ownerMap[r.customer_id] ?? null : null,
  }))
}

async function searchEncounters(q: string): Promise<SearchEncounter[]> {
  // 就诊无独立就诊号:按 主诉/诊断文本 ILIKE + 关联宠物名匹配
  const { data: textMatches } = await supabase
    .from('encounters')
    .select('id, status, started_at, pet_id, customer_id')
    .or(`chief_complaint.ilike.%${q}%,diagnosis_text.ilike.%${q}%`)
    .order('started_at', { ascending: false })
    .limit(LIMIT)

  const byText = (textMatches ?? []) as Array<{ id: string, status: string, started_at: string | null, pet_id: string | null, customer_id: string | null }>

  // 关联宠物名匹配
  const { data: petMatches } = await supabase
    .from('pets')
    .select('id')
    .ilike('name', `%${q}%`)
    .limit(LIMIT)
  let byPet: Array<{ id: string, status: string, started_at: string | null, pet_id: string | null, customer_id: string | null }> = []
  const petIds = (petMatches ?? []).map((p: any) => p.id) as string[]
  if (petIds.length > 0) {
    const { data: encs } = await supabase
      .from('encounters')
      .select('id, status, started_at, pet_id, customer_id')
      .in('pet_id', petIds)
      .order('started_at', { ascending: false })
      .limit(LIMIT)
    byPet = (encs ?? []) as typeof byText
  }

  const merged = new Map<string, typeof byText[number]>()
  for (const row of [...byText, ...byPet]) {
    if (!merged.has(row.id)) {
      merged.set(row.id, row)
    }
  }
  const rows = [...merged.values()].slice(0, LIMIT)

  // 批量加载宠物/客户名
  const petIdList = [...new Set(rows.map(r => r.pet_id).filter(Boolean))] as string[]
  const customerIdList = [...new Set(rows.map(r => r.customer_id).filter(Boolean))] as string[]
  const petMap: Record<string, string> = {}
  const customerMap: Record<string, string> = {}
  if (petIdList.length > 0) {
    const { data: pets } = await supabase.from('pets').select('id, name').in('id', petIdList)
    for (const p of (pets ?? []) as Array<{ id: string, name: string }>) {
      petMap[p.id] = p.name
    }
  }
  if (customerIdList.length > 0) {
    const { data: customers } = await supabase.from('customers').select('id, name').in('id', customerIdList)
    for (const c of (customers ?? []) as Array<{ id: string, name: string }>) {
      customerMap[c.id] = c.name
    }
  }

  return rows.map(r => ({
    id: r.id,
    status: r.status,
    startedAt: r.started_at ?? null,
    petName: r.pet_id ? petMap[r.pet_id] ?? null : null,
    customerName: r.customer_id ? customerMap[r.customer_id] ?? null : null,
  }))
}

async function searchInvoices(q: string): Promise<SearchInvoice[]> {
  const { data } = await supabase
    .from('invoices')
    .select('id, invoice_no, total, status')
    .ilike('invoice_no', `%${q}%`)
    .order('created_at', { ascending: false })
    .limit(LIMIT)
  return (data ?? []).map((row: any) => ({
    id: row.id,
    invoiceNo: row.invoice_no,
    total: Number(row.total ?? 0),
    status: row.status,
  }))
}

async function searchCatalog(q: string): Promise<SearchCatalogItem[]> {
  const { data } = await supabase
    .from('catalog_items')
    .select('id, name, code, billing_type')
    .or(`name.ilike.%${q}%,code.ilike.%${q}%`)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(LIMIT)
  return (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    code: row.code ?? null,
    billingType: row.billing_type ?? null,
  }))
}

/** 统一入口:并发搜索五类业务对象,返回分组结果 */
export async function globalSearch(q: string): Promise<GlobalSearchResult> {
  const keyword = q.trim()
  if (!keyword) {
    return { customers: [], pets: [], encounters: [], invoices: [], catalogItems: [] }
  }
  const [customers, pets, encounters, invoices, catalogItems] = await Promise.all([
    searchCustomers(keyword),
    searchPets(keyword),
    searchEncounters(keyword),
    searchInvoices(keyword),
    searchCatalog(keyword),
  ])
  return { customers, pets, encounters, invoices, catalogItems }
}
