import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * Wallet / Stored Value 领域 Command 路由(Agent-03 Stage-04)
 *
 * 领域边界:
 *   - stored_value_accounts 为储值余额真源(Account = 快照,Ledger = 审计真相);
 *   - 所有余额变更只允许经 service-role-only RPC 完成(SELECT FOR UPDATE + 幂等),
 *     本路由不直接 INSERT/UPDATE stored_value_accounts / stored_value_ledger;
 *   - 收银储值扣款/退款由 Billing Domain(process_payment/process_refund)在同一
 *     数据库事务内完成,不在本路由提供 /wallet/debit 手工入口(防止两事务不一致);
 *   - 权限:wallet.view 查看、wallet.recharge 开户/充值、wallet.adjust 人工调整、
 *     wallet.freeze 冻结/解冻/销户。
 */
const walletRoutes = new Hono<AppEnv>()

walletRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/** 将 Wallet RPC 抛出的业务错误码映射为 HTTP 错误 */
function mapWalletRpcError(error: { message: string }) {
  const msg = error.message
  if (msg.includes('WALLET_ACCOUNT_NOT_FOUND') || msg.includes('CUSTOMER_NOT_FOUND') || msg.includes('STORE_NOT_FOUND')) {
    return err.notFound('资源不存在')
  }
  if (msg.includes('WALLET_ACCOUNT_FROZEN')) {
    return err.conflict('储值账户已冻结,无法执行该操作')
  }
  if (msg.includes('WALLET_ACCOUNT_CLOSED')) {
    return err.conflict('储值账户已销户,无法执行该操作')
  }
  if (msg.includes('INSUFFICIENT_WALLET_BALANCE')) {
    return err.conflict('储值余额不足')
  }
  if (msg.includes('CLOSING_BALANCE_NOT_ZERO')) {
    return err.conflict('销户前需先将余额清零')
  }
  if (msg.includes('INVALID_AMOUNT') || msg.includes('INVALID_DELTA') || msg.includes('INVALID_STATUS')
    || msg.includes('UNSUPPORTED_CURRENCY') || msg.includes('RECHARGE_SOURCE_REQUIRED')
    || msg.includes('ADJUST_REASON_REQUIRED') || msg.includes('STATUS_REASON_REQUIRED')) {
    return err.badRequest(msg.replace(/^ERROR:\s*/, ''))
  }
  return err.internal(`储值操作失败: ${msg}`)
}

/** 通用查询参数(租户 + 门店作用域) */
const scopeQuerySchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误').optional(),
})

/** 分页参数 */
const pageQuerySchema = scopeQuerySchema.extend({
  from: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
})

const listAccountsQuerySchema = pageQuerySchema.extend({
  keyword: z.string().max(100).optional(),
  status: z.enum(['active', 'frozen', 'closed']).optional(),
})

/**
 * 储值账户列表(GET /wallet/accounts)
 * - 权限:wallet.view
 * - 行为:租户范围查询账户,联 customers 返回客户姓名/手机号
 */
walletRoutes.get('/accounts', async (c) => {
  const query = await scopeQuerySchema.safeParseAsync(c.req.query())
  if (!query.success) {
    throw err.badRequest('查询参数错误')
  }
  const { tenantId, storeId } = query.data
  const scope = await requireScopedPermission(c, { code: 'wallet.view', tenantId, storeId, dataScope: true })

  const keyword = (c.req.query('keyword') ?? '').trim()
  const status = c.req.query('status') ?? undefined
  const from = Number(c.req.query('from') ?? 0)
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)

  const service = createServiceClient()
  let base = service
    .from('stored_value_accounts')
    .select('*, customer:customers(id, name, phone)', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
  if (status) {
    base = base.eq('status', status)
  }
  if (keyword) {
    // 关键词优先匹配客户姓名/手机号,再兜底账户 id(通过二次查询客户 id 集合)
    const { data: matchedCustomers } = await service
      .from('customers')
      .select('id')
      .eq('tenant_id', scope.tenantId)
      .or(`name.ilike.%${keyword}%,phone.ilike.%${keyword}%`)
      .limit(100)
    const customerIds = (matchedCustomers ?? []).map(r => r.id as string)
    if (customerIds.length === 0) {
      return ok(c, { list: [], total: 0, from, limit })
    }
    base = base.in('customer_id', customerIds)
  }
  const { data, error, count } = await base
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1)
  if (error) {
    throw err.internal(`查询储值账户失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0, from, limit })
})

/**
 * 储值账户详情(GET /wallet/accounts/:id)
 * - 权限:wallet.view
 */
walletRoutes.get('/accounts/:id', async (c) => {
  const accountId = c.req.param('id')
  const query = await scopeQuerySchema.safeParseAsync(c.req.query())
  if (!query.success) {
    throw err.badRequest('查询参数错误')
  }
  const { tenantId, storeId } = query.data
  const service = createServiceClient()
  const { data: account, error } = await service
    .from('stored_value_accounts')
    .select('*, customer:customers(id, name, phone)')
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (error || !account) {
    throw err.notFound('储值账户不存在')
  }
  await requireScopedPermission(c, { code: 'wallet.view', tenantId, storeId, dataScope: true })
  return ok(c, account)
})

/**
 * 储值账户流水(GET /wallet/accounts/:id/ledger)
 * - 权限:wallet.view
 * - 流水为只追加不可变记录,仅返回(无编辑/删除)
 */
walletRoutes.get('/accounts/:id/ledger', async (c) => {
  const accountId = c.req.param('id')
  const query = await pageQuerySchema.safeParseAsync(c.req.query())
  if (!query.success) {
    throw err.badRequest('查询参数错误')
  }
  const { tenantId, storeId, from, limit } = query.data
  const service = createServiceClient()

  // 校验账户归属,并取其租户用于授权
  const { data: account } = await service
    .from('stored_value_accounts')
    .select('id, tenant_id')
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (!account) {
    throw err.notFound('储值账户不存在')
  }
  await requireScopedPermission(c, { code: 'wallet.view', tenantId: account.tenant_id, storeId, dataScope: true })

  const { data, error, count } = await service
    .from('stored_value_ledger')
    .select('*', { count: 'exact' })
    .eq('account_id', accountId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1)
  if (error) {
    throw err.internal(`查询储值流水失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0, from, limit })
})

const openAccountSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误').optional(),
  customerId: z.string().uuid('客户 id 格式错误'),
  currency: z.string().max(10).optional().default('CNY'),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 开户(POST /wallet/accounts)
 * - 权限:wallet.recharge
 * - 行为:调 open_stored_value_account RPC,同客户同币种唯一账户,幂等
 */
walletRoutes.post('/accounts', async (c) => {
  const input = await parseJsonBody(c, openAccountSchema)
  const scope = await requireScopedPermission(c, {
    code: 'wallet.recharge',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const service = createServiceClient()
  const user = c.get('user')

  const { data, error } = await service.rpc('open_stored_value_account', {
    p_tenant_id: input.tenantId,
    p_customer_id: input.customerId,
    p_currency: input.currency,
    p_operator_id: user.id,
    p_idempotency_key: input.idempotencyKey ?? null,
  })
  if (error) {
    throw mapWalletRpcError(error)
  }

  await writeAudit(c, {
    action: 'wallet.open',
    entityType: 'stored_value_account',
    entityId: (data as { accountId?: string })?.accountId,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { customerId: input.customerId, created: (data as { created?: boolean })?.created },
  })

  return ok(c, data)
})

const rechargeSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误').optional(),
  amount: z.number().nonnegative('本金不能为负'),
  bonusAmount: z.number().nonnegative('赠送金额不能为负').optional().default(0),
  source: z.string().min(1, '充值来源不能为空').max(100),
  externalMethod: z.string().max(50).optional(),
  externalTxnNo: z.string().max(100).optional(),
  reason: z.string().max(500).optional(),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 充值(POST /wallet/accounts/:id/recharge)
 * - 权限:wallet.recharge
 * - 行为:调 recharge_stored_value RPC,本金 + 赠送金记账区分,幂等
 */
walletRoutes.post('/accounts/:id/recharge', async (c) => {
  const accountId = c.req.param('id')
  const input = await parseJsonBody(c, rechargeSchema)
  const service = createServiceClient()

  const { data: account } = await service
    .from('stored_value_accounts')
    .select('id, tenant_id')
    .eq('id', accountId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (!account) {
    throw err.notFound('储值账户不存在')
  }
  await requireScopedPermission(c, {
    code: 'wallet.recharge',
    tenantId: account.tenant_id,
    storeId: input.storeId,
  })

  const user = c.get('user')
  const { data, error } = await service.rpc('recharge_stored_value', {
    p_account_id: accountId,
    p_amount: input.amount,
    p_bonus_amount: input.bonusAmount,
    p_source: input.source,
    p_external_method: input.externalMethod ?? null,
    p_external_txn_no: input.externalTxnNo ?? null,
    p_operator_id: user.id,
    p_idempotency_key: input.idempotencyKey ?? null,
    p_reason: input.reason ?? null,
  })
  if (error) {
    throw mapWalletRpcError(error)
  }

  await writeAudit(c, {
    action: 'wallet.recharge',
    entityType: 'stored_value_account',
    entityId: accountId,
    tenantId: account.tenant_id,
    storeId: input.storeId,
    metadata: {
      amount: input.amount,
      bonusAmount: input.bonusAmount,
      source: input.source,
      externalTxnNo: input.externalTxnNo,
    },
  })

  return ok(c, data)
})

const adjustSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误').optional(),
  delta: z.number().refine(v => v !== 0, '调整金额不能为 0'),
  reason: z.string().min(1, '调整原因不能为空').max(500),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 人工调整(POST /wallet/accounts/:id/adjust)
 * - 权限:wallet.adjust(仅 tenant_owner / finance manager / store_manager,普通收银无此权限)
 * - 行为:调 adjust_stored_value RPC,±调整且 reason 必填,幂等
 */
walletRoutes.post('/accounts/:id/adjust', async (c) => {
  const accountId = c.req.param('id')
  const input = await parseJsonBody(c, adjustSchema)
  const service = createServiceClient()

  const { data: account } = await service
    .from('stored_value_accounts')
    .select('id, tenant_id')
    .eq('id', accountId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (!account) {
    throw err.notFound('储值账户不存在')
  }
  await requireScopedPermission(c, {
    code: 'wallet.adjust',
    tenantId: account.tenant_id,
    storeId: input.storeId,
  })

  const user = c.get('user')
  const { data, error } = await service.rpc('adjust_stored_value', {
    p_account_id: accountId,
    p_delta: input.delta,
    p_reason: input.reason,
    p_operator_id: user.id,
    p_idempotency_key: input.idempotencyKey ?? null,
  })
  if (error) {
    throw mapWalletRpcError(error)
  }

  await writeAudit(c, {
    action: 'wallet.adjust',
    entityType: 'stored_value_account',
    entityId: accountId,
    tenantId: account.tenant_id,
    storeId: input.storeId,
    metadata: { delta: input.delta, reason: input.reason },
  })

  return ok(c, data)
})

const statusSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误').optional(),
  status: z.enum(['active', 'frozen', 'closed']),
  reason: z.string().max(500).optional(),
})

/**
 * 冻结/解冻/销户(POST /wallet/accounts/:id/status)
 * - 权限:wallet.freeze
 * - 行为:调 set_stored_value_account_status RPC;
 *   冻结/销户须填写 reason;销户须余额清零
 */
walletRoutes.post('/accounts/:id/status', async (c) => {
  const accountId = c.req.param('id')
  const input = await parseJsonBody(c, statusSchema)
  const service = createServiceClient()

  const { data: account } = await service
    .from('stored_value_accounts')
    .select('id, tenant_id')
    .eq('id', accountId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (!account) {
    throw err.notFound('储值账户不存在')
  }
  await requireScopedPermission(c, {
    code: 'wallet.freeze',
    tenantId: account.tenant_id,
    storeId: input.storeId,
  })

  const user = c.get('user')
  const { data, error } = await service.rpc('set_stored_value_account_status', {
    p_account_id: accountId,
    p_status: input.status,
    p_reason: input.reason ?? null,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapWalletRpcError(error)
  }

  await writeAudit(c, {
    action: 'wallet.setStatus',
    entityType: 'stored_value_account',
    entityId: accountId,
    tenantId: account.tenant_id,
    storeId: input.storeId,
    metadata: { status: input.status, reason: input.reason },
  })

  return ok(c, data)
})

const ensureContextSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  isActive: z.boolean().optional().default(true),
})

/**
 * 启用/停用门店储值支付方式(POST /wallet/payment-contexts/ensure)
 * - 权限:wallet.recharge
 * - 行为:调 ensure_stored_value_payment_context RPC,幂等 upsert
 *   供新租户初始化完成后按需启用储值收款方式
 */
walletRoutes.post('/payment-contexts/ensure', async (c) => {
  const input = await parseJsonBody(c, ensureContextSchema)
  const scope = await requireScopedPermission(c, {
    code: 'wallet.recharge',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const service = createServiceClient()
  const user = c.get('user')

  const { data, error } = await service.rpc('ensure_stored_value_payment_context', {
    p_tenant_id: scope.tenantId,
    p_store_id: input.storeId,
    p_is_active: input.isActive,
    p_operator_id: user.id,
  })
  if (error) {
    throw mapWalletRpcError(error)
  }

  await writeAudit(c, {
    action: 'wallet.ensurePaymentContext',
    entityType: 'payment_context',
    entityId: undefined,
    tenantId: scope.tenantId,
    storeId: input.storeId,
    metadata: { method: 'stored_value', isActive: input.isActive },
  })

  return ok(c, data)
})

export default walletRoutes
