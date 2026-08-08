import type {
  BoardingAddChargeInput,
  BoardingBookInput,
  BoardingCageStatusView,
  BoardingCancelResult,
  BoardingChangeCageInput,
  BoardingChangeCageResult,
  BoardingCheckInInput,
  BoardingCheckoutResult,
  BoardingDailyRecord,
  BoardingPrepareCheckoutResult,
  BoardingRecordDailyInput,
  BoardingServiceCharge,
  BoardingStay,
  BoardingStayStatus,
} from '@/types/inpatient-boarding'
import api from '../index'

/**
 * 寄养(Boarding)API 模块(S3.1 Agent-06)
 *
 * 设计原则:
 *   - 入住/换笼位/离店走 Hono Command + PostgreSQL RPC,SELECT FOR UPDATE 防笼位冲突
 *   - 住院与寄养共用 cages 占用事实来源,禁止双占
 *   - 幂等:check-in / change-cage / checkout 须带 idempotency-key
 *   - 查询走 Hono Command 路由,权限 boarding.*
 */
export default {
  // ==================== 查询 ====================

  /**
   * 寄养记录列表
   * @param storeId 门店 id
   * @param status 寄养状态
   */
  async listBoardingStays(storeId?: string, status?: BoardingStayStatus) {
    const query: Record<string, unknown> = {}
    if (storeId) {
      query.storeId = storeId
    }
    if (status) {
      query.status = status
    }
    const res = await api.get('inpatient/boarding', { params: query })
    return { status: 1, error: '', data: (res as any).data as { list: BoardingStay[] } }
  },

  /**
   * 寄养记录详情
   * @param id 寄养单 id
   */
  async getBoardingStay(id: string) {
    const res = await api.get(`inpatient/boarding/${id}`)
    return { status: 1, error: '', data: (res as any).data as BoardingStay }
  },

  /**
   * 寄养房态看板(boarding_cage_status 视图)
   * @param storeId 门店 id
   */
  async listBoardingCageStatus(storeId?: string): Promise<BoardingCageStatusView[]> {
    const res = await api.get('inpatient/boarding/cages/status', {
      params: storeId ? { storeId } : undefined,
    })
    return ((res as any).data as { list: BoardingCageStatusView[] })?.list ?? []
  },

  /**
   * 每日照护记录
   * @param stayId 寄养单 id
   */
  async listDailyRecords(stayId: string) {
    const res = await api.get(`inpatient/boarding/${stayId}/daily-records`)
    return { status: 1, error: '', data: (res as any).data as { list: BoardingDailyRecord[] } }
  },

  /**
   * 额外服务费
   * @param stayId 寄养单 id
   */
  async listServiceCharges(stayId: string) {
    const res = await api.get(`inpatient/boarding/${stayId}/service-charges`)
    return { status: 1, error: '', data: (res as any).data as { list: BoardingServiceCharge[] } }
  },

  // ==================== 命令 ====================

  /**
   * 预约寄养入住(创建 planned 寄养单,不锁笼位)
   */
  bookStay(data: BoardingBookInput) {
    return api.post('inpatient/boarding/book', data)
  },

  /**
   * 办理入住(锁笼位)
   * 支持:直接入住(传 customerId/petId/cageId)或确认预约(stayId)
   * @param data 入住参数
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  checkInBoarding(data: BoardingCheckInInput, idempotencyKey: string) {
    return api.post('inpatient/boarding/check-in', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },

  /**
   * 取消预约(仅 planned)
   */
  async cancelBoarding(id: string): Promise<BoardingCancelResult> {
    const res = await api.post(`inpatient/boarding/${id}/cancel`, {})
    return (res as any).data as BoardingCancelResult
  },

  /**
   * 换笼位(住院/寄养单占用互斥)
   * @param id 寄养单 id
   * @param data 换笼位参数
   * @param idempotencyKey 幂等键
   */
  async changeCage(id: string, data: BoardingChangeCageInput, idempotencyKey: string): Promise<BoardingChangeCageResult> {
    const res = await api.post(`inpatient/boarding/${id}/change-cage`, data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
    return (res as any).data as BoardingChangeCageResult
  },

  /**
   * 记录每日照护(饮食/遛宠/用药/状态)
   */
  async recordDaily(id: string, data: BoardingRecordDailyInput) {
    const res = await api.post(`inpatient/boarding/${id}/daily-records`, data)
    return { status: 1, error: '', data: (res as any).data }
  },

  /**
   * 追加额外服务费
   */
  async addServiceCharge(id: string, data: BoardingAddChargeInput) {
    const res = await api.post(`inpatient/boarding/${id}/service-charges`, data)
    return { status: 1, error: '', data: (res as any).data }
  },

  /**
   * 准备离店(计算应收,状态 → checkout_pending)
   */
  async prepareCheckout(id: string): Promise<BoardingPrepareCheckoutResult> {
    const res = await api.post(`inpatient/boarding/${id}/checkout/prepare`, {})
    return (res as any).data as BoardingPrepareCheckoutResult
  },

  /**
   * 完成离店(释放笼位)
   * @param id 寄养单 id
   * @param idempotencyKey 幂等键
   */
  async checkoutBoarding(id: string, idempotencyKey: string): Promise<BoardingCheckoutResult> {
    const res = await api.post(`inpatient/boarding/${id}/checkout`, {}, {
      headers: { 'idempotency-key': idempotencyKey },
    })
    return (res as any).data as BoardingCheckoutResult
  },
}

/**
 * 生成幂等键(浏览器原生 crypto.randomUUID)
 * 用于入住/换笼位/离店等命令,防止重复扣房位
 */
export function generateBoardingIdempotencyKey(): string {
  return crypto.randomUUID()
}
