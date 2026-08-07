import type {
  DispenseInput,
  GoodsReceiptInput,
  InventoryBalance,
  InventoryMovement,
  NearExpiryItem,
  ReservationProcessInput,
  ReserveInput,
  StockCountInput,
  TransferInput,
  Warehouse,
} from '@/types/inventory'
import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * Inventory 领域 API 模块(MXQ-9001~9008)
 *
 * 设计原则:
 *   - 库存过账(入库/发药/盘点/调拨/预留/确认/释放)走 Hono Command + PostgreSQL RPC,禁止前端直连改余额
 *   - 查询类(仓库/余额/流水/近效期)浏览器直连 supabase,RLS 兜底
 *   - 幂等:过账命令须带 idempotency-key(Header),同一 key 重复请求返回原结果
 *   - 流水不可变:inventory_movements 仅 select/insert,前端无 update/delete 入口
 */
export default {
  /**
   * 仓库列表(浏览器直连,RLS 按门店过滤)
   * @param storeId 门店 id(可选,不传则查当前用户有权访问的全部仓库)
   */
  async listWarehouses(storeId?: string) {
    let query = supabase.from('warehouses').select('*')
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    const { data, error } = await query
      .order('is_default', { ascending: false })
      .order('name', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as Warehouse[] } }
  },

  /**
   * 库存余额列表(浏览器直连,RLS 兜底)
   * @param warehouseId 仓库 id
   */
  async listBalances(warehouseId: string) {
    const { data, error } = await supabase
      .from('inventory_balances')
      .select('*')
      .eq('warehouse_id', warehouseId)
      .order('updated_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as InventoryBalance[] } }
  },

  /**
   * 库存流水列表(浏览器直连,RLS 兜底,不可变)
   * @param warehouseId 仓库 id
   * @param limit 返回条数(默认 50)
   */
  async listMovements(warehouseId: string, limit = 50) {
    const { data, error } = await supabase
      .from('inventory_movements')
      .select('*')
      .eq('warehouse_id', warehouseId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as InventoryMovement[] } }
  },

  /**
   * 近效期预警(直连 inventory_near_expiry 视图,RLS 按门店过滤)
   * @param storeId 门店 id(可选)
   */
  async listNearExpiryByView(storeId?: string): Promise<NearExpiryItem[]> {
    let query = supabase.from('inventory_near_expiry').select('*')
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    const { data, error } = await query.order('expiry_date', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return (data ?? []) as NearExpiryItem[]
  },

  /**
   * 入库(MXQ-9003)
   * 走 Hono Command + post_goods_receipt RPC,事务化创建批次/余额/流水
   * @param data 入库参数
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  postGoodsReceipt(data: GoodsReceiptInput, idempotencyKey: string) {
    return api.post('inventory/goods-receipt', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },

  /**
   * 发药(MXQ-9004)
   * 走 Hono Command + dispense_inventory RPC,FEFO 扣减批次
   * @param data 发药参数
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  dispense(data: DispenseInput, idempotencyKey: string) {
    return api.post('inventory/dispense', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },

  /**
   * 盘点(MXQ-9005)
   * 走 Hono Command + post_stock_count RPC,逐项对比余额写 adjust 流水
   * @param data 盘点参数(含批量明细)
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  postStockCount(data: StockCountInput, idempotencyKey: string) {
    return api.post('inventory/stock-count', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },

  /**
   * 调拨(MXQ-9006)
   * 走 Hono Command + transfer_inventory RPC,原子扣源增目标,写两条流水
   * @param data 调拨参数
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  transfer(data: TransferInput, idempotencyKey: string) {
    return api.post('inventory/transfer', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },

  /**
   * 预留库存(MXQ-9008,挂单/下单冻结库存)
   * 走 Hono Command + reserve_inventory RPC,按可用量(on_hand - reserved)校验,写 reserve 流水
   * @param data 预留参数(quantity 为预留数量,referenceType/referenceId 可选,如订单号)
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  reserve(data: ReserveInput, idempotencyKey: string) {
    return api.post('inventory/reserve', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },

  /**
   * 确认预留(MXQ-9008,支付确认转正式扣减)
   * 走 Hono Command + confirm_inventory_reservation RPC,在库量与预留量同步减少
   * @param data reservationId 为 reserve 流水的 movement id(预留凭证)
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  confirmReservation(data: ReservationProcessInput, idempotencyKey: string) {
    return api.post('inventory/reserve/confirm', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },

  /**
   * 释放预留(MXQ-9008,取消释放)
   * 走 Hono Command + release_inventory_reservation RPC,仅减少预留量(不得为负)
   * @param data reservationId 为 reserve 流水的 movement id(预留凭证)
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  releaseReservation(data: ReservationProcessInput, idempotencyKey: string) {
    return api.post('inventory/reserve/release', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },
}

/**
 * 生成幂等键(浏览器原生 crypto.randomUUID)
 * 用于库存过账/发药/盘点/调拨等命令,同一 key 重复请求返回原结果,防止重复扣减
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID()
}
