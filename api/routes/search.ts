import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * 全局业务搜索(P0-29)
 * 服务端聚合 + 作用域过滤,浏览器不再多表直连:
 * - 租户 + allowedStoreIds 收敛数据边界(门店级角色只搜授权门店)
 * - 多列 ILIKE 合并,避免 q 直入 .or() 的 PostgREST 注入/语法问题
 * - 返回统一 DTO,前端直接深链
 */
const searchRoutes = new Hono<AppEnv>()

searchRoutes.use('*', authMiddleware(), loadCaller())

const LIMIT = 8

const EMPTY_RESULT = {
  customers: [],
  pets: [],
  encounters: [],
  invoices: [],
  catalogItems: [],
}

/** 转义 ILIKE 通配符,使输入按字面匹配 */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, m => `\\${m}`)
}

/**
 * 多列 ILIKE 安全搜索并去重
 * @param applyScope 在查询上叠加租户/门店作用域过滤
 */
async function ilikeSearch(
  service: ReturnType<typeof createServiceClient>,
  table: string,
  columns: string[],
  q: string,
  applyScope: (query: any) => any,
  select: string,
): Promise<any[]> {
  const pattern = `%${escapeLike(q)}%`
  const seen = new Map<string, any>()
  for (const col of columns) {
    let query = service.from(table).select(select)
    query = applyScope(query)
    const { data, error } = await query.ilike(col, pattern).limit(LIMIT)
    if (error) {
      throw err.internal(`搜索失败: ${error.message}`)
    }
    for (const row of ((data ?? []) as Array<Record<string, any>>)) {
      if (!seen.has(row.id)) {
        seen.set(row.id, row)
      }
    }
  }
  return [...seen.values()].slice(0, LIMIT)
}

searchRoutes.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId') || undefined
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  if (!q) {
    return ok(c, EMPTY_RESULT)
  }

  const scope = await requireScopedPermission(c, {
    code: 'search.global',
    tenantId,
    storeId,
    dataScope: true,
  })
  const service = createServiceClient()
  const allowed = scope.allowedStoreIds
  // 审计 §78:优先按"当前工作门店"(query storeId 或 x-store-id 头)收敛;
  // 未指定门店时才是授权范围(全院搜索)。请求门店已在 requireScopedPermission 校验为可访问。
  const requestedStore = c.req.query('storeId') || c.req.header('x-store-id') || undefined
  const scopeIds = requestedStore ? [requestedStore] : allowed

  // 门店级实体:工作门店 或 租户级(null store)数据;未指定门店时用授权门店集合
  const scopeStore = (query: any) => {
    if (scopeIds.length === 0) {
      return query
    }
    return query.or(`store_id.in.(${scopeIds.join(',')}),store_id.is.null`)
  }
  const scopeTenant = (query: any) => query.eq('tenant_id', scope.tenantId)

  const [customers, pets, encounters, invoices, catalogItems] = await Promise.all([
    ilikeSearch(
      service, 'customers', ['name', 'phone', 'customer_no'], q,
      (query) => { let x = scopeTenant(query); x = scopeStore(x); return x.neq('status', 'archived') },
      'id, name, phone, customer_no',
    ),
    ilikeSearch(
      service, 'pets', ['name', 'microchip'], q,
      (query) => scopeTenant(query).neq('status', 'archived'),
      'id, name, species, microchip, customer_id',
    ),
    ilikeSearch(
      service, 'encounters', ['chief_complaint', 'diagnosis_text'], q,
      (query) => scopeStore(scopeTenant(query)),
      'id, status, started_at, pet_id, customer_id',
    ),
    ilikeSearch(
      service, 'invoices', ['invoice_no'], q,
      (query) => scopeStore(scopeTenant(query)),
      'id, invoice_no, total, status',
    ),
    ilikeSearch(
      service, 'catalog_items', ['name', 'code'], q,
      (query) => scopeTenant(query).eq('is_active', true),
      'id, name, code, billing_type',
    ),
  ])

  // 富化宠物主名 / 就诊宠物与客户名
  const ownerIds = [...new Set(pets.map(p => p.customer_id).filter(Boolean))]
  const ownerMap: Record<string, string> = {}
  if (ownerIds.length > 0) {
    const { data: owners } = await service.from('customers').select('id, name').in('id', ownerIds)
    for (const o of (owners ?? [])) {
      ownerMap[o.id as string] = (o as any).name
    }
  }
  const petIds = [...new Set(encounters.map(e => e.pet_id).filter(Boolean))]
  const customerIds = [...new Set(encounters.map(e => e.customer_id).filter(Boolean))]
  const petMap: Record<string, string> = {}
  const customerMap: Record<string, string> = {}
  if (petIds.length > 0) {
    const { data: petsRows } = await service.from('pets').select('id, name').in('id', petIds)
    for (const p of (petsRows ?? [])) {
      petMap[p.id as string] = (p as any).name
    }
  }
  if (customerIds.length > 0) {
    const { data: custRows } = await service.from('customers').select('id, name').in('id', customerIds)
    for (const x of (custRows ?? [])) {
      customerMap[x.id as string] = (x as any).name
    }
  }

  return ok(c, {
    customers: customers.map(r => ({
      id: r.id, name: r.name, phone: r.phone ?? null, customerNo: r.customer_no ?? null,
    })),
    pets: pets.map(r => ({
      id: r.id, name: r.name, species: r.species ?? null, microchip: r.microchip ?? null,
      ownerName: r.customer_id ? ownerMap[r.customer_id] ?? null : null,
    })),
    encounters: encounters.map(r => ({
      id: r.id, status: r.status, startedAt: r.started_at ?? null,
      petName: r.pet_id ? petMap[r.pet_id] ?? null : null,
      customerName: r.customer_id ? customerMap[r.customer_id] ?? null : null,
    })),
    invoices: invoices.map(r => ({
      id: r.id, invoiceNo: r.invoice_no, total: Number(r.total ?? 0), status: r.status,
    })),
    catalogItems: catalogItems.map(r => ({
      id: r.id, name: r.name, code: r.code ?? null, billingType: r.billing_type ?? null,
    })),
  })
})

export default searchRoutes
