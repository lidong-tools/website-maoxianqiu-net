/**
 * Wallet / Stored Value 领域类型定义(Agent-03 Stage-04)
 * 与 supabase/migrations/20260810000200~203 对齐
 */

/** 储值账户状态 */
export type StoredValueAccountStatus = 'active' | 'frozen' | 'closed'

/** 流水方向 */
export type StoredValueLedgerDirection = 'credit' | 'debit'

/** 流水业务类型 */
export type StoredValueLedgerType
  = | 'recharge' // 充值本金
    | 'bonus' // 充值赠送金
    | 'payment' // 收银消费扣款
    | 'refund' // 退款返还
    | 'adjustment' // 人工调整
    | 'reversal' // 冲正(预留)

/** 储值账户(联客户后的展示模型) */
export interface StoredValueAccount {
  id: string
  tenant_id: string
  customer_id: string
  currency: string
  balance: number
  status: StoredValueAccountStatus
  version: number
  opened_at: string
  closed_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  customer?: {
    id: string
    name: string | null
    phone: string | null
  } | null
}

/** 储值流水(不可变,审计真相) */
export interface StoredValueLedgerEntry {
  id: string
  tenant_id: string
  account_id: string
  customer_id: string
  direction: StoredValueLedgerDirection
  type: StoredValueLedgerType
  amount: number
  balance_before: number
  balance_after: number
  reference_type: string | null
  reference_id: string | null
  idempotency_key: string | null
  operator_id: string | null
  reason: string | null
  metadata: Record<string, unknown>
  created_at: string
}

/** 开户输入 */
export interface OpenStoredValueAccountInput {
  tenantId: string
  storeId?: string
  customerId: string
  currency?: string
}

/** 充值输入(本金 + 赠送金,记账区分) */
export interface RechargeStoredValueInput {
  tenantId: string
  storeId?: string
  amount: number
  bonusAmount?: number
  source: string
  externalMethod?: string
  externalTxnNo?: string
  reason?: string
}

/** 人工调整输入(±,reason 必填) */
export interface AdjustStoredValueInput {
  tenantId: string
  storeId?: string
  delta: number
  reason: string
}

/** 冻结/解冻/销户输入 */
export interface SetStoredValueStatusInput {
  tenantId: string
  storeId?: string
  status: StoredValueAccountStatus
  reason?: string
}

/** 流水类型标签映射(UI 显示用) */
export const LEDGER_TYPE_LABELS: Record<StoredValueLedgerType, string> = {
  recharge: '充值',
  bonus: '赠送',
  payment: '消费',
  refund: '退款返还',
  adjustment: '人工调整',
  reversal: '冲正',
}

/** 账户状态标签映射(UI 显示用) */
export const ACCOUNT_STATUS_LABELS: Record<StoredValueAccountStatus, string> = {
  active: '正常',
  frozen: '已冻结',
  closed: '已销户',
}

/** 权限码常量(与 migration 200 seed 对齐) */
export const WALLET_PERMISSIONS = {
  view: 'wallet.view',
  recharge: 'wallet.recharge',
  adjust: 'wallet.adjust',
  freeze: 'wallet.freeze',
} as const
