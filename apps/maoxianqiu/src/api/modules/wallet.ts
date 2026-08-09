import type {
  AdjustStoredValueInput,
  OpenStoredValueAccountInput,
  RechargeStoredValueInput,
  SetStoredValueStatusInput,
  StoredValueAccount,
  StoredValueLedgerEntry,
} from '@/types/wallet'
import api from '../index'

/**
 * Wallet / Stored Value 领域 API 模块(Agent-03 Stage-04)
 *
 * 设计原则:
 *   - 所有余额变更走 Hono Command + service-role-only RPC(行锁 + 幂等),
 *     禁止前端直连 supabase 修改 stored_value_accounts / stored_value_ledger;
 *   - 查询类(账户/流水)走 Hono 只读路由(租户/门店作用域授权);
 *   - 收银储值扣款/退款由 Billing Domain(process_payment/process_refund)
 *     在同一数据库事务内完成,本模块不提供手工扣款入口;
 *   - 充值/调整命令由调用方携带 idempotency-key,同一 key 重复请求返回原结果。
 */

/**
 * 生成幂等键(浏览器原生 crypto.randomUUID)
 * 用于充值/调整/开户等命令,同一 key 重复请求返回原结果,防止重复入账
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID()
}

export default {
  /**
   * 储值账户列表
   * 走 Hono 只读路由(联客户姓名/手机号,支持关键词/状态/分页)
   * @param params 查询参数
   * @param params.tenantId 租户 id
   * @param params.storeId 门店 id(授权作用域)
   * @param params.keyword 客户姓名/手机号关键词(可选)
   * @param params.status 账户状态(可选)
   * @param params.from 起始行(可选)
   * @param params.limit 行数(可选)
   */
  async listAccounts(params: {
    tenantId: string
    storeId?: string
    keyword?: string
    status?: string
    from?: number
    limit?: number
  }) {
    const { data } = await api.get('wallet/accounts', { params })
    return data as { list: StoredValueAccount[], total: number, from: number, limit: number }
  },

  /**
   * 储值账户详情
   * @param id 账户 id
   * @param tenantId 租户 id
   * @param storeId 门店 id(授权作用域)
   */
  async getAccount(id: string, params: { tenantId: string, storeId?: string }) {
    const { data } = await api.get(`wallet/accounts/${id}`, { params })
    return data as StoredValueAccount
  },

  /**
   * 储值账户流水(不可变,只读)
   * @param accountId 账户 id
   * @param params 查询参数(租户/门店/分页)
   */
  async listLedger(accountId: string, params: {
    tenantId: string
    storeId?: string
    from?: number
    limit?: number
  }) {
    const { data } = await api.get(`wallet/accounts/${accountId}/ledger`, { params })
    return data as { list: StoredValueLedgerEntry[], total: number, from: number, limit: number }
  },

  /**
   * 开户(幂等:同客户同币种唯一账户)
   * @param data 开户参数
   */
  openAccount(data: OpenStoredValueAccountInput) {
    return api.post('wallet/accounts', data, {
      headers: { 'idempotency-key': generateIdempotencyKey() },
    })
  },

  /**
   * 充值(本金 + 赠送金记账区分,幂等)
   * @param accountId 账户 id
   * @param data 充值参数
   */
  recharge(accountId: string, data: RechargeStoredValueInput) {
    return api.post(`wallet/accounts/${accountId}/recharge`, data, {
      headers: { 'idempotency-key': generateIdempotencyKey() },
    })
  },

  /**
   * 人工调整(±,reason 必填,幂等;仅管理角色有 wallet.adjust 权限)
   * @param accountId 账户 id
   * @param data 调整参数
   */
  adjust(accountId: string, data: AdjustStoredValueInput) {
    return api.post(`wallet/accounts/${accountId}/adjust`, data, {
      headers: { 'idempotency-key': generateIdempotencyKey() },
    })
  },

  /**
   * 冻结/解冻/销户
   * @param accountId 账户 id
   * @param data 状态参数(冻结/销户须填 reason)
   */
  setStatus(accountId: string, data: SetStoredValueStatusInput) {
    return api.post(`wallet/accounts/${accountId}/status`, data)
  },

  /**
   * 启用/停用门店储值支付方式(幂等 upsert)
   * 供新租户初始化完成后按需启用储值收款方式
   * @param data 参数(租户/门店/是否启用)
   */
  ensurePaymentContext(data: { tenantId: string, storeId: string, isActive?: boolean }) {
    return api.post('wallet/payment-contexts/ensure', data)
  },
}
