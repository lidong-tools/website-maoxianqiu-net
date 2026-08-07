import type {
  AdjustDailyClosingInput,
  AdjustDailyClosingResult,
  CloseDailyBusinessInput,
  CloseDailyBusinessResult,
  ConfirmReconciliationInput,
  ConfirmReconciliationResult,
  DailyClosingRecord,
  PaymentChannelSummary,
  ReconciliationRecord,
  SaveReconciliationActualInput,
  SaveReconciliationActualResult,
} from '@/types/closing'
import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * Daily Closing + Reconciliation 领域 API 模块(S31-并发任务B 日结与对账)
 *
 * 分层策略:
 *   - Query(list/detail):浏览器直连 Supabase,RLS 兜底(tenant + store 收敛);
 *   - Command(close/adjust/save-actual/confirm):走 Hono Command
 *     (api/routes/closing.ts),服务端做权限/归属/状态机校验,禁止前端直连写;
 *   - 操作人:一律由服务端根据登录用户反查在职员工档案推导,客户端不传 employee id;
 *   - 幂等:执行日结命令携带幂等键(Header 或 body.idempotencyKey),
 *     同一 key 重复请求返回原结果;
 *   - 金额一律 numeric(12,2),前端展示按元格式化,禁止浮点参与业务计算。
 */
export default {
  /**
   * 日结列表(浏览器直连,RLS 兜底,按租户 + 门店筛选)
   * @param tenantId 租户 id
   * @param storeId 门店 id(可为空=全部授权门店)
   */
  async listDailyClosings(tenantId: string, storeId?: string) {
    let query = supabase
      .from('daily_closings')
      .select('*, stores(name, code)')
      .eq('tenant_id', tenantId)
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    const { data, error } = await query.order('business_date', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as DailyClosingRecord[] },
    }
  },

  /**
   * 日结调整流水(浏览器直连,RLS 兜底)
   * @param closingId 日结 id
   */
  async listClosingAdjustments(closingId: string) {
    const { data, error } = await supabase
      .from('closing_adjustments')
      .select('*')
      .eq('closing_id', closingId)
      .order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as unknown[] },
    }
  },

  /**
   * 对账记录列表(浏览器直连,RLS 兜底,按租户 + 门店 + 业务日期筛选)
   * @param tenantId 租户 id
   * @param storeId 门店 id(可为空=全部授权门店)
   * @param businessDate 业务日期(可选)
   */
  async listReconciliationRecords(tenantId: string, storeId?: string, businessDate?: string) {
    let query = supabase
      .from('reconciliation_records')
      .select('*, stores(name, code)')
      .eq('tenant_id', tenantId)
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    if (businessDate) {
      query = query.eq('business_date', businessDate)
    }
    const { data, error } = await query.order('business_date', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as ReconciliationRecord[] },
    }
  },

  /**
   * 执行日结(走 Hono Command,权限 daily_closing.close)
   * 按 Asia/Shanghai 业务日期实时计算并固化快照,同一门店日期唯一;
   * 重复执行(同幂等键)返回现有快照,不重算不覆盖历史。
   */
  closeDailyBusiness(input: CloseDailyBusinessInput) {
    return api.post('closing/close', input) as Promise<{ data: CloseDailyBusinessResult }>
  },

  /**
   * 调整日结(走 Hono Command,权限 daily_closing.adjust)
   * 追加调整流水 + adjustment_summary,状态流转 closed -> adjusted。
   */
  adjustDailyClosing(input: AdjustDailyClosingInput) {
    return api.post('closing/adjust', input) as Promise<{ data: AdjustDailyClosingResult }>
  },

  /**
   * 支付渠道汇总(走 Hono Command,权限 reconciliation.read)
   * 服务端从真实 payments/refunds 聚合各渠道实收/退款/净额,
   * 附日结快照期望值,前端只渲染。
   */
  getChannelSummary(storeId: string, businessDate: string) {
    return api.get('closing/channel-summary', {
      params: { storeId, businessDate },
    }) as Promise<{ data: PaymentChannelSummary }>
  },

  /**
   * 对账录入实际金额(走 Hono Command,权限 reconciliation.edit)
   * system_expected 由日结快照推导,difference = actual - expected;
   * 0 -> matched,否则 pending。
   */
  saveReconciliationActual(input: SaveReconciliationActualInput) {
    return api.post('closing/reconciliation/save-actual', input) as Promise<{ data: SaveReconciliationActualResult }>
  },

  /**
   * 差异确认(走 Hono Command,权限 reconciliation.confirm)
   * 差异=0 -> confirmed,否则 difference_confirmed(必须填差异原因);
   * 审计含 reason/actor/timestamp/request_id。
   */
  confirmReconciliation(id: string, input: ConfirmReconciliationInput) {
    return api.post(`closing/reconciliation/${id}/confirm`, input) as Promise<{ data: ConfirmReconciliationResult }>
  },
}
