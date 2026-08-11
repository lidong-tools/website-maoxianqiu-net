/**
 * S32-B 库存分析(inventory)
 *
 * 口径(S32-B 规格 §8 + KPI-DEFINITIONS.md + 审计 #25):
 *   - 库存 SKU   = 有在库(quantity_on_hand > 0)的目录项数;
 *   - 库存价值   = Σ(quantity_on_hand × catalog_items.cost_price);
 *   - 低库存 SKU = 可用数量(quantity_on_hand − quantity_reserved) ≤ 低库存阈值
 *                (catalog_items.low_stock_threshold,R-14;未配置阈值回落 ≤0 断货口径);
 *   - 近效期     = 30 天内到期且仍有剩余库存的活跃批次(inventory_batches)数;
 *   - 报损       = 周期内 movement_type ∈ (write_off / scrap / expired) 的负向流水合计
 *                (按 catalog cost_price 计价;R-15 移除正则 hack,口径与流水类型对齐);
 *   - 采购金额   = 周期内创建、状态非 draft/cancelled 的采购订单 total_cost 合计;
 *   - 库存异动   = 周期内 inventory_movements 记录数。
 *
 * 不做(规格 §8):库存周转率(当前无法可靠计算,不显示假数字)。
 */
import type { ServiceClient } from './common.js'
import type { ExpiringRow, InventoryReport, LowStockRow, RevenueFilters } from './types.js'
import { chunk, fetchAll, toNum, UUID_CHUNK_SIZE } from './common.js'

/** 低库存口径:可用数量阈值下限(含);未配置阈值时回落 0(断货/不可售,审计 #25) */
const STOCKOUT_MAX_AVAILABLE = 0
/** 近效期窗口(天) */
const EXPIRING_DAYS = 30
/** 报损流水类型(R-15:与 post_inventory_writeoff 的 reason_type 对齐) */
const WASTAGE_TYPES = ['write_off', 'scrap', 'expired']

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
  low_stock_threshold: number
}

/** 低库存 SKU 计数(驾驶舱复用;R-14:可用 ≤ 阈值,未配置回落 ≤0 断货口径) */
export async function countLowStock(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<number> {
  const { ids: warehouseIds } = await resolveWarehouseIds(service, f)
  if (warehouseIds.length === 0) {
    return 0
  }
  // 分页拉全后过滤,避免 PostgREST 行数上限静默截断导致少算(审计 v2 §14)
  const rows = await fetchAll<{ catalog_item_id: string, quantity_on_hand: number, quantity_reserved: number }>('库存余额数据', (from, to) => service
    .from('inventory_balances')
    .select('catalog_item_id, quantity_on_hand, quantity_reserved')
    .eq('tenant_id', f.tenantId)
    .in('warehouse_id', warehouseIds)
    .order('id', { ascending: true })
    .range(from, to))
  if (rows.length === 0) {
    return 0
  }
  // 阈值映射(catalog_items.low_stock_threshold,R-14;缺省 0)
  const thresholdMap = new Map<string, number>()
  const catalogIds = [...new Set(rows.map(r => r.catalog_item_id))]
  for (const chunkIds of chunk(catalogIds, UUID_CHUNK_SIZE)) {
    const { data, error } = await service
      .from('catalog_items')
      .select('id, low_stock_threshold')
      .eq('tenant_id', f.tenantId)
      .in('id', chunkIds)
    if (error) {
      throw new Error(`目录项查询失败: ${error.message}`)
    }
    for (const c of (data as Array<{ id: string, low_stock_threshold: number }> | null) ?? []) {
      thresholdMap.set(c.id, toNum(c.low_stock_threshold))
    }
  }
  return rows.filter((b) => {
    const threshold = thresholdMap.get(b.catalog_item_id) ?? STOCKOUT_MAX_AVAILABLE
    return toNum(b.quantity_on_hand) - toNum(b.quantity_reserved) <= threshold
  }).length
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
): Promise<{ ids: string[], nameMap: Map<string, string> }> {
  const { data, error } = await service
    .from('warehouses')
    .select('id, name')
    .eq('tenant_id', f.tenantId)
    .in('store_id', f.storeIds)
  if (error) {
    throw new Error(`仓库查询失败: ${error.message}`)
  }
  const rows = (data as Array<{ id: string, name: string }> | null) ?? []
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
    // 大 IN 分批(审计 v3 §11 + v4 §4):catalogIds 量级可能很大,按 UUID_CHUNK_SIZE 分批
    for (const chunkIds of chunk(catalogIds, UUID_CHUNK_SIZE)) {
      const { data, error } = await service
        .from('catalog_items')
        .select('id, code, name, unit, cost_price, low_stock_threshold')
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

  // 库存 SKU / 价值 / 低库存(R-14:可用 ≤ 阈值,未配置回落 ≤0 断货口径)
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
    const threshold = cat ? toNum(cat.low_stock_threshold) : STOCKOUT_MAX_AVAILABLE
    if (available <= threshold) {
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
        lowStockThreshold: threshold,
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
    // 报损:真实流水类型 write_off/scrap/expired(R-15,移除正则 hack)
    const wasteRows = await fetchAll<{ catalog_item_id: string, quantity: number }>('库存异动数据', (from, to) => service
      .from('inventory_movements')
      .select('catalog_item_id, quantity')
      .eq('tenant_id', f.tenantId)
      .in('warehouse_id', warehouseIds)
      .in('movement_type', WASTAGE_TYPES)
      .lt('quantity', 0)
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO)
      .order('id', { ascending: true })
      .range(from, to))
    for (const w of wasteRows) {
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
        label: '低库存 SKU',
        value: lowStockCount,
        format: 'integer',
        definition: '可用数量(在库−预留) ≤ 低库存阈值 的 SKU 数(未配置阈值回落 ≤0 断货口径;R-14)。',
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
        definition: '周期内 write_off/scrap/expired 负向流水合计,按 catalog cost_price 计价(R-15)。',
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
