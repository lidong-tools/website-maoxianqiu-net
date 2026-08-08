/**
 * S32-A 导入中心 V2 —— 引用数据装载
 *
 * 在执行/校验前一次性装载目标租户下的引用数据，避免 N+1 查询。
 * 所有 Map 值均为实体 id。
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface LookupContext {
  customersByPhone: Map<string, string>
  customersByNo: Map<string, string>
  /** `${customerId}:${nameLower}` → petId */
  petsByOwnerName: Map<string, string>
  petsByChip: Map<string, string>
  catalogByCode: Map<string, string>
  categoriesByCode: Map<string, string>
  /** `${tenantId}:${storeId ?? ''}:${code}` → warehouseId */
  warehousesByCode: Map<string, string>
  employeeEmails: Set<string>
  /** `${tenantId}:${storeId ?? ''}:${catalogId}:${warehouseId}:${batchNo}` → requestId */
  openingPendingKey: Map<string, string>
  /** `${tenantId}:${storeId ?? ''}:${email}` → inviteId */
  employeeInviteByEmail: Map<string, string>
}

function key(tenantId: string, storeId: string | null | undefined, parts: (string | number)[]): string {
  return [tenantId, storeId ?? '', ...parts].join(':')
}

function addIfValue(map: Map<string, string>, k: string, v: string | null | undefined) {
  if (k && v) {
    map.set(k, v)
  }
}

/** 装载引用数据；storeId 为空时按租户级装载 */
export async function loadLookupContext(
  service: SupabaseClient,
  tenantId: string,
  storeId?: string | null,
): Promise<LookupContext> {
  const ctx: LookupContext = {
    customersByPhone: new Map(),
    customersByNo: new Map(),
    petsByOwnerName: new Map(),
    petsByChip: new Map(),
    catalogByCode: new Map(),
    categoriesByCode: new Map(),
    warehousesByCode: new Map(),
    employeeEmails: new Set(),
    openingPendingKey: new Map(),
    employeeInviteByEmail: new Map(),
  }

  const [customers, pets, catalog, categories, warehouses, employees, pendingOpening, pendingInvites] = await Promise.all([
    service.from('customers').select('id, phone, customer_no').eq('tenant_id', tenantId).limit(50000),
    service.from('pets').select('id, customer_id, name, microchip').eq('tenant_id', tenantId).limit(50000),
    service.from('catalog_items').select('id, code').eq('tenant_id', tenantId).limit(50000),
    service.from('catalog_categories').select('id, code').eq('tenant_id', tenantId).limit(10000),
    service.from('warehouses').select('id, store_id, code').eq('tenant_id', tenantId).limit(5000),
    service.from('employees').select('email').eq('tenant_id', tenantId).limit(50000),
    service.from('opening_stock_import_requests').select('id, catalog_item_id, warehouse_id, batch_no').eq('tenant_id', tenantId).eq('status', 'pending').limit(50000),
    service.from('employee_invite_imports').select('id, email').eq('tenant_id', tenantId).eq('status', 'pending').limit(50000),
  ])

  for (const c of (customers.data ?? [])) {
    addIfValue(ctx.customersByPhone, c.phone?.trim(), c.id)
    addIfValue(ctx.customersByNo, c.customer_no?.trim(), c.id)
  }
  for (const p of (pets.data ?? [])) {
    if (p.customer_id && p.name) {
      addIfValue(ctx.petsByOwnerName, `${p.customer_id}:${p.name.trim().toLowerCase()}`, p.id)
    }
    addIfValue(ctx.petsByChip, p.microchip?.trim(), p.id)
  }
  for (const it of (catalog.data ?? [])) {
    addIfValue(ctx.catalogByCode, it.code?.trim(), it.id)
  }
  for (const cat of (categories.data ?? [])) {
    addIfValue(ctx.categoriesByCode, cat.code?.trim(), cat.id)
  }
  for (const w of (warehouses.data ?? [])) {
    const k = key(tenantId, w.store_id, [w.code?.trim() ?? ''])
    addIfValue(ctx.warehousesByCode, k, w.id)
  }
  for (const e of (employees.data ?? [])) {
    if (e.email) {
      ctx.employeeEmails.add(e.email.trim().toLowerCase())
    }
  }
  for (const o of (pendingOpening.data ?? [])) {
    const k = key(tenantId, storeId, [o.catalog_item_id ?? '', o.warehouse_id ?? '', o.batch_no?.trim() ?? ''])
    addIfValue(ctx.openingPendingKey, k, o.id)
  }
  for (const iv of (pendingInvites.data ?? [])) {
    const k = key(tenantId, storeId, [iv.email?.trim().toLowerCase() ?? ''])
    addIfValue(ctx.employeeInviteByEmail, k, iv.id)
  }

  return ctx
}
