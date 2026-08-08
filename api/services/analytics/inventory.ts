/**
 * S32-B 库存分析(inventory)
 *
 * 口径(S32-B 规格 §8 + KPI-DEFINITIONS.md + 审计 #25):
 *   - 库存 SKU   = 有在库(quantity_on_hand > 0)的目录项数;
 *   - 库存价值   = Σ(quantity_on_hand × catalog_items.cost_price);
 *   - 缺货 SKU   = 可用数量(quantity_on_hand − quantity_reserved) ≤ 0 的 SKU 数
 *               (系统暂无每 SKU 低库存阈值,第一版以"断货/不可售"为口径,
 *                避免给管理层不存在的"低库存阈值"概念);
 *   - 近效期     = 30 天内到期且仍有剩余库存的活跃批次(inventory_batches)数;
 *   - 报损       = movement_type='adjust' 且数量为负、reference_type 含
 *               报损/waste/damage/报废/expire 的负向调整合计(按 catalog cost_price 计价);
 *   - 采购金额   = 周期内创建、状态非 draft/cancelled 的采购订单 total_cost 合计;
 *   - 库存异动   = 周期内 inventory_movements 记录数。
 *
 * 不做(规格 §8):库存周转率(当前无法可靠计算,不显示假数字)。
 */
import type { ServiceClient } from './common'
import { fetchAll, toNum } from './common'
import type { ExpiringRow, InventoryReport, LowStockRow, RevenueFilters } from './types'

/** 缺货口径:可用数量阈值(含),available ≤ 0 即断货/不可售(审计 #25) */
const STOCKOUT_MAX_AVAILABLE = 0
/** 近效期窗口(天) */
const EXPIRING_DAYS = 30

const WASTAGE_RE = /waste|damage|报损|报废|损耗|expire/i

interface BalanceRow {
  warehouse_id: string
  catalog_item_id: string
  quantity_on_hand: number
  quantity_reserved: number
}

interface BatchRow {
  id: string
  warehouse_id: string
  catalog_item_id: string
  batch_no: string | null
  quantity_remaining: number
  unit_cost: number
  expiry_date: string | null
  status: string
}

interface CatalogInfo {
  id: string
  code: string
  name: string
  unit: string | null
  cost_price: number
}

/** 缺货 SKU 计数(驾驶舱复用,审计 #25:缺货 = 可用 ≤ 0) */
export async function countLowStock(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<number> {
  const { ids: warehouseIds } = await resolveWarehouseIds(service, f)
  if (warehouseIds.length === 0) {
    return 0
  }
  // 分页拉全后过滤,避免 PostgREST 行数上限静默截断导致少算(审计 v2 §14)
  const rows = await fetchAll<{ quantity_on_hand: number; quantity_reserved: number }>('库存余额数据', (from, to) => service
    .from('inventory_balances')
    .select('quantity_on_hand, quantity_reserved')
      .eq('tenant_id', f.tenantId)
      .in('warehouse_id', warehouseIds)
      .order('id', { ascending: true })
      .range(from, to))
  return rows.filter(
    b => toNum(b.quantity_on_hand) - toNum(b.quantity_reserved) <= STOCKOUT_MAX_AVAILABLE,
  ).length
}

/** 近效期批次计数(驾驶舱复用) */
export async function countExpiring(
  service: ServiceClient,
  f: RevenueFilters,
  referenceDate: string,
): Promise<number> {
  const { ids: warehouseIds } = await resolveWarehouseIds(service, f)
  if (warehouseIds.length === 0) {
    return 0
  }
  // 分页拉全后过滤,避免 PostgREST 行数上限静默截断导致少算(审计 v2 §14)
  const rows = await fetchAll<{ expiry_date: string | null }>('库存批次数据', (from, to) => service
    .from('inventory_batches')
    .select('expiry_date')
      .eq('tenant_id', f.tenantId)
      .in('warehouse_id', warehouseIds)
      .eq('status', 'active')
      .gt('quantity_remaining', 0)
      .not('expiry_date', 'is', null)
      .order('id', { ascending: true })
      .range(from, to))
  const ref = new Date(`${referenceDate}T00:00:00`)
  return rows.filter((b) => {
    if (!b.expiry_date) {
      return false
    }
    const days = Math.round((new Date(`${b.expiry_date}T00:00:00`).getTime() - ref.getTime()) / 86_400_000)
    return days <= EXPIRING_DAYS
  }).length
}

/** 经仓库收敛门店范围 */
async function resolveWarehouseIds(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<{ ids: string[]; nameMap: Map<string, string> }> {
  const { data, error } = await service
    .from('warehouses')
    .select('id, name')
    .eq('tenant_id', f.tenantId)
    .in('store_id', f.storeIds)
  if (error) {
    throw new Error(`仓库查询失败: ${error.message}`)
  }
  const rows = (data as Array<{ id: string; name: string }> | null) ?? []
  const nameMap = new Map(rows.map(r => [r.id, r.name || r.id.slice(0, 8)]))
  return { ids: rows.map(r => r.id), nameMap }
}

export async function buildInventoryReport(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<InventoryReport> {
  const { ids: warehouseIds, nameMap: warehouseNameMap } = await resolveWarehouseIds(service, f)

  let balances: BalanceRow[] = []
  let batches: BatchRow[] = []
  if (warehouseIds.length > 0) {
    // 分页拉全,规避 PostgREST 行数上限静默截断导致少算(审计 v2 §14)
    const [balRows, batchRows] = await Promise.all([
      fetchAll<BalanceRow>('库存余额数据', (from, to) => service
        .from('inventory_balances')
        .select('warehouse_id, catalog_item_id, quantity_on_hand, quantity_reserved')
      .eq('tenant_id', f.tenantId)
      .in('warehouse_id', warehouseIds)
      .order('id', { ascending: true })
      .range(from, to)),
      fetchAll<BatchRow>('库存批次数据', (from, to) => service
        .from('inventory_batches')
        .select('id, warehouse_id, catalog_item_id, batch_no, quantity_remaining, unit_cost, expiry_date, status')
      .eq('tenant_id', f.tenantId)
      .in('warehouse_id', warehouseIds)
      .eq('status', 'active')
      .gt('quantity_remaining', 0)
      .order('id', { ascending: true })
      .range(from, to)),
    ])
    balances = balRows
    batches = batchRows
  }

  // 目录信息(编码/名称/单位/成本价)
  const catalogIds = [...new Set([
    ...balances.map(b => b.catalog_item_id),
    ...batches.map(b => b.catalog_item_id),
  ])]
  const catalogMap = new Map<string, CatalogInfo>()
  if (catalogIds.length > 0) {
    // 大 IN 分批(审计 v3 §11):catalogIds 量级可能很大
    for (const chunkIds of chunk(catalogIds, 500)) {
      const { data, error } = await service
        .from('catalog_items')
        .select('id, code, name, unit, cost_price')
        .eq('tenant_id', f.tenantId)
        .in('id', chunkIds)
      if (error) {
        throw new Error(`目录项查询失败: ${error.message}`)
      }
      for (const c of (data as CatalogInfo[] | null) ?? []) {
        catalogMap.set(c.id, c)
      }
    }
  }

  // 库存 SKU / 价值 / 缺货
  const skuSet = new Set<string>()
  let stockValue = 0
  const lowStockRows: LowStockRow[] = []
  for (const b of balances) {
    if (b.quantity_on_hand > 0) {
      skuSet.add(b.catalog_item_id)
    }
    const cat = catalogMap.get(b.catalog_item_id)
    stockValue += toNum(b.quantity_on_hand) * (cat?.cost_price ?? 0)
    const available = toNum(b.quantity_on_hand) - toNum(b.quantity_reserved)
    if (available <= STOCKOUT_MAX_AVAILABLE) {
      lowStockRows.push({
        warehouseId: b.warehouse_id,
        warehouseName: warehouseNameMap.get(b.warehouse_id) ?? b.warehouse_id.slice(0, 8),
        catalogItemId: b.catalog_item_id,
        code: cat?.code ?? '-',
        name: cat?.name ?? '-',
        unit: cat?.unit ?? null,
        quantityOnHand: toNum(b.quantity_on_hand),
        quantityReserved: toNum(b.quantity_reserved),
        available,
        lowStockThreshold: 0,
        stockValue: toNum(b.quantity_on_hand) * (cat?.cost_price ?? 0),
      })
    }
  }
  lowStockRows.sort((a, b) => a.available - b.available || a.name.localeCompare(b.name))

  // 近效期
  const todayKey = f.period.endDate // 以查询周期结束日作为"今天"参考(避免默认月底)
  const today = new Date(`${todayKey}T00:00:00`)
  const expiringRows: ExpiringRow[] = []
  for (const b of batches) {
    if (!b.expiry_date) {
      continue
    }
    const expiry = new Date(`${b.expiry_date}T00:00:00`)
    const daysToExpiry = Math.round((expiry.getTime() - today.getTime()) / 86_400_000)
    if (daysToExpiry > EXPIRING_DAYS) {
      continue
    }
    const cat = catalogMap.get(b.catalog_item_id)
    expiringRows.push({
      warehouseId: b.warehouse_id,
      warehouseName: warehouseNameMap.get(b.warehouse_id) ?? b.warehouse_id.slice(0, 8),
      batchId: b.id,
      batchNo: b.batch_no ?? '-',
      catalogItemId: b.catalog_item_id,
      code: cat?.code ?? '-',
      name: cat?.name ?? '-',
      quantityRemaining: toNum(b.quantity_remaining),
      unitCost: toNum(b.unit_cost),
      value: toNum(b.quantity_remaining) * toNum(b.unit_cost),
      expiryDate: b.expiry_date,
      daysToExpiry,
    })
  }
  expiringRows.sort((a, b) => a.daysToExpiry - b.daysToExpiry || a.name.localeCompare(b.name))

  // 库存异动数 + 报损(周期内,经仓库收敛)
  let movementCount = 0
  let wastageAmount = 0
  if (warehouseIds.length > 0) {
    const countRes = await service.from('inventory_movements')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', f.tenantId)
      .in('warehouse_id', warehouseIds)
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO)
    if (!countRes.error) {
      movementCount = countRes.count ?? 0
    }
    // 报损:负向 adjust 且 reference_type 匹配(分页拉全,替代原 limit(2000),审计 v2 §14)
    const wasteRows = await fetchAll<{ catalog_item_id: string; quantity: number; reference_type: string | null }>('库存异动数据', (from, to) => service
      .from('inventory_movements')
      .select('catalog_item_id, quantity, reference_type')
      .eq('tenant_id', f.tenantId)
      .in('warehouse_id', warehouseIds)
      .eq('movement_type', 'adjust')
      .lt('quantity', 0)
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO)
      .order('id', { ascending: true })
      .range(from, to))
    for (const w of wasteRows) {
      if (!WASTAGE_RE.test(w.reference_type ?? '')) {
        continue
      }
      const cat = catalogMap.get(w.catalog_item_id)
      wastageAmount += Math.abs(toNum(w.quantity)) * (cat?.cost_price ?? 0)
    }
  }

  // 采购金额(分页拉全,审计 v2 §14)
  let purchaseAmount = 0
  const poRows = await fetchAll<{ total_cost: number }>('采购订单数据', (from, to) => service
    .from('purchase_orders')
    .select('total_cost')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .not('status', 'in', '("draft","cancelled")')
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO)
      .order('id', { ascending: true })
      .range(from, to))
  purchaseAmount = poRows.reduce((s, r) => s + toNum(r.total_cost), 0)

  const skuCount = skuSet.size
  const lowStockCount = lowStockRows.length
  const expiringCount = expiringRows.length

  return {
    period: f.period,
    kpis: [
      {
        key: 'skuCount',
        label: '库存 SKU',
        value: skuCount,
        format: 'integer',
        definition: '有在库(quantity_on_hand > 0)的目录项数。',
      },
      {
        key: 'stockValue',
        label: '库存价值',
        value: Math.round(stockValue * 100) / 100,
        format: 'money',
        definition: 'Σ(quantity_on_hand × catalog_items.cost_price)。',
      },
      {
        key: 'lowStock',
        label: '缺货 SKU',
        value: lowStockCount,
        format: 'integer',
        definition: '可用数量(在库−预留) ≤ 0 的 SKU 数(断货/不可售口径;暂无低库存阈值配置,审计 #25)。',
      },
      {
        key: 'expiring',
        label: '近效期',
        value: expiringCount,
        format: 'integer',
        definition: `查询周期结束日起 ${EXPIRING_DAYS} 天内到期且仍有剩余库存的活跃批次数。`,
      },
      {
        key: 'wastage',
        label: '报损',
        value: Math.round(wastageAmount * 100) / 100,
        format: 'money',
        definition: '负向 adjust 且 reference_type 含 报损/waste/damage/报废/expire 的调整,按 catalog cost_price 计价。',
      },
      {
        key: 'purchaseAmount',
        label: '采购金额',
        value: Math.round(purchaseAmount * 100) / 100,
        format: 'money',
        definition: '周期内创建、状态非草稿/取消的采购订单 total_cost 合计。',
      },
      {
        key: 'movements',
        label: '库存异动',
        value: movementCount,
        format: 'integer',
        definition: '周期内 inventory_movements 记录数。',
      },
    ],
    lowStockRows,
    expiringRows,
  }
}
