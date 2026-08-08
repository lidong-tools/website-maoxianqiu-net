import type { Context } from 'hono'
import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { err } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * Daily Closing + Reconciliation 领域 Command 路由(S31-并发任务B 日结与对账)
 *
 * 覆盖:
 *   - 日结 close_daily_business(幂等 + 并发安全,固化快照)
 *   - 日结调整 adjust_daily_closing(追加流水 + 审计)
 *   - 支付渠道汇总 get_payment_channel_summary(服务端聚合,前端只渲染)
 *   - 对账录入 save_reconciliation_actual(实际金额,系统期望由日结快照推导)
 *   - 差异确认 confirm_reconciliation(差异必须带原因 + request_id 审计)
 *
 * 安全:
 *   - 全部走 Hono Command + PostgreSQL RPC(service-role-only),
 *     禁止前端直连改状态/金额;查询走 Supabase + RLS;
 *   - requireScopedPermission 返回的 scope 是唯一可信 tenantId/storeId 来源,
 *     涉及 :id 的实体先按 id 查库取归属再做作用域授权;
 *   - 操作人由服务端按登录用户反查在职员工档案推导(resolveCurrentEmployee),
 *     禁止客户端传 operatorEmployeeId;
 *   - 关键状态流转 RPC 内事务写 audit_logs。
 */
const closingRoutes = new Hono<AppEnv>()

closingRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/** 从 Header 或 body 解析幂等键,缺失时生成 uuid 保证 RPC 总有 key */
function resolveIdempotencyKey(c: Context<AppEnv>, bodyKey?: string): string {
  return getRequestIdempotencyKey(c) || bodyKey || crypto.randomUUID()
}

/**
 * 将 RPC 抛出的日结/对账业务错误码映射为 HTTP 错误
 * - 资源不存在类 → 404
 * - 状态/业务规则类 → 422
 * - 其余 → 500
 */
function mapRpcError(error: { message: string }) {
  const msg = error.message
  // 资源不存在
  if ([
    'STORE_NOT_FOUND',
    'OPERATOR_NOT_FOUND',
    'CLOSING_NOT_FOUND',
    'RECONCILIATION_NOT_FOUND',
  ].some(k => msg.includes(k))) {
    return err.notFound(msg.replace(/^ERROR:\s*/, ''))
  }
  // 状态/业务规则类(日结状态机、对账状态机、参数校验)
  if ([
    'CLOSING_REQUIRED',
    'CLOSING_MISMATCH',
    'CLOSING_NOT_CLOSED',
    'CLOSING_LOCK_FAILED',
    'RECONCILIATION_LOCKED',
    'RECONCILIATION_LOCK_FAILED',
    'RECONCILIATION_ALREADY_CONFIRMED',
    'DIFFERENCE_REASON_REQUIRED',
    'INVALID_ADJUSTMENT_TYPE',
    'INVALID_ADJUSTMENT_AMOUNT',
    'ADJUSTMENT_REASON_REQUIRED',
    'INVALID_RECONCILIATION_CHANNEL',
    'INVALID_ACTUAL_AMOUNT',
  ].some(k => msg.includes(k))) {
    return err.unprocessable(msg.replace(/^ERROR:\s*/, ''))
  }
  return err.internal(`日结/对账操作失败: ${msg}`)
}

/**
 * 按门店 id 查归属租户,作为 requireScopedPermission 的作用域来源
 * @param service supabase service client
 * @param storeId 门店 id
 * @returns 门店所属租户 id
 */
async function fetchStoreTenant(
  service: ReturnType<typeof createServiceClient>,
  storeId: string,
): Promise<string> {
  const { data, error } = await service
    .from('stores')
    .select('tenant_id')
    .eq('id', storeId)
    .maybeSingle()
  if (error || !data) {
    throw err.notFound('门店不存在')
  }
  return data.tenant_id
}

/**
 * 服务端推导当前操作人在【指定租户】下的在职员工档案
 * 禁止对 user_id 做全局 maybeSingle,必须显式限定目标租户解析。
 * @param service supabase service client
 * @param c hono context
 * @param tenantId 目标租户 id(由实体归属/门店归属确定的可信租户)
 * @returns 当前操作人在该租户下的员工档案 id
 */
async function resolveCurrentEmployee(
  service: ReturnType<typeof createServiceClient>,
  c: { get: (k: string) => unknown },
  tenantId: string,
): Promise<string> {
  const user = c.get('user') as { id: string } | undefined
  if (!user?.id) {
    throw err.unauthorized('未登录')
  }
  const { data, error } = await service
    .from('employees')
    .select('id')
    .eq('user_id', user.id)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .maybeSingle()
  if (error || !data) {
    throw err.forbidden('当前账号在目标租户下未关联在职员工档案,无法执行操作')
  }
  return data.id
}

// ============================================================
// 1. 执行日结(close_daily_business)
// ============================================================

const closeSchema = z.object({
  storeId: z.string().uuid('门店 id 格式错误'),
  businessDate: z.string().date('业务日期格式错误(YYYY-MM-DD)'),
  idempotencyKey: z.string().max(200).optional(),
})

/**
 * 执行日结(S31-B-CLOSE)
 * - 权限:daily_closing.close
 * - 行为:storeId 由 StorePicker 提供,租户由服务端按门店推导;
 *   调 close_daily_business RPC,按 Asia/Shanghai 业务日期实时计算并固化快照,
 *   同一 tenant+store+business_date 唯一,重复执行返回现有快照(不重算)。
 */
closingRoutes.post('/close', async (c) => {
  const input = await parseJsonBody(c, closeSchema)
  const service = createServiceClient()
  const tenantId = await fetchStoreTenant(service, input.storeId)
  const scope = await requireScopedPermission(c, {
    code: 'daily_closing.close',
    tenantId,
    storeId: input.storeId,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, tenantId)
  const idempotencyKey = resolveIdempotencyKey(c, input.idempotencyKey)

  const { data, error } = await service.rpc('close_daily_business', {
    p_tenant_id: scope.tenantId,
    p_store_id: input.storeId,
    p_business_date: input.businessDate,
    p_operator_employee_id: operatorEmployeeId,
    p_idempotency_key: idempotencyKey,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

// ============================================================
// 2. 调整日结(adjust_daily_closing)
// ============================================================

const adjustSchema = z.object({
  closingId: z.string().uuid('日结 id 格式错误'),
  adjustmentType: z.enum(['cash_over', 'cash_short', 'manual_correction', 'other']),
  amount: z.number().refine(v => v !== 0, '调整金额不可为 0'),
  reason: z.string().min(1, '调整原因不能为空').max(500),
})

/**
 * 调整日结(S31-B-ADJUST)
 * - 权限:daily_closing.adjust(仅 system_admin/tenant_owner)
 * - 行为:先按 closingId 查日结归属租户/门店,再做作用域授权;
 *   调 adjust_daily_closing RPC,追加调整流水 + adjustment_summary,
 *   状态流转 closed -> adjusted。
 */
closingRoutes.post('/adjust', async (c) => {
  const input = await parseJsonBody(c, adjustSchema)
  const service = createServiceClient()

  // 按日结 id 取归属做 scoped 授权
  const { data: closing, error: fetchErr } = await service
    .from('daily_closings')
    .select('tenant_id, store_id, status')
    .eq('id', input.closingId)
    .maybeSingle()
  if (fetchErr || !closing) {
    throw err.notFound('日结不存在')
  }
  await requireScopedPermission(c, {
    code: 'daily_closing.adjust',
    tenantId: closing.tenant_id,
    storeId: closing.store_id,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, closing.tenant_id)

  const { data, error } = await service.rpc('adjust_daily_closing', {
    p_closing_id: input.closingId,
    p_adjustment_type: input.adjustmentType,
    p_amount: input.amount,
    p_reason: input.reason,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

// ============================================================
// 3. 支付渠道汇总(get_payment_channel_summary)
// ============================================================

/**
 * 支付渠道汇总(S31-B-SUMMARY)
 * - 权限:reconciliation.read
 * - 行为:服务端从真实 payments/refunds 聚合各渠道实收/退款/净额,
 *   附日结快照期望值;前端只渲染,不做跨表聚合。
 */
const channelSummaryQuerySchema = z.object({
  storeId: z.string().uuid('门店 id 格式错误'),
  businessDate: z.string().date('业务日期格式错误(YYYY-MM-DD)'),
})

closingRoutes.get('/channel-summary', async (c) => {
  const parsed = channelSummaryQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', {
      ...parsed.error.issues.reduce<Record<string, string[]>>((acc, issue) => {
        const key = issue.path.join('.') || '_root'
        ;(acc[key] ??= []).push(issue.message)
        return acc
      }, {}),
    })
  }
  const query = parsed.data
  const service = createServiceClient()
  const tenantId = await fetchStoreTenant(service, query.storeId)
  const scope = await requireScopedPermission(c, {
    code: 'reconciliation.read',
    tenantId,
    storeId: query.storeId,
    dataScope: true,
  })

  const { data, error } = await service.rpc('get_payment_channel_summary', {
    p_tenant_id: scope.tenantId,
    p_store_id: query.storeId,
    p_business_date: query.businessDate,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

// ============================================================
// 4. 对账录入(save_reconciliation_actual)
// ============================================================

const saveActualSchema = z.object({
  storeId: z.string().uuid('门店 id 格式错误'),
  businessDate: z.string().date('业务日期格式错误(YYYY-MM-DD)'),
  channel: z.enum(['cash', 'card', 'wechat', 'alipay', 'stored_value', 'other']),
  actualAmount: z.number().nonnegative('实际金额必须大于等于 0'),
  closingId: z.string().uuid().optional().nullable(),
})

/**
 * 录入对账实际金额(S31-B-SAVE-ACTUAL)
 * - 权限:reconciliation.edit
 * - 行为:storeId 由 StorePicker 提供,租户由服务端按门店推导;
 *   调 save_reconciliation_actual RPC,system_expected 由日结快照推导(不信任客户端),
 *   difference = actual - expected,0 -> matched,否则 pending。
 */
closingRoutes.post('/reconciliation/save-actual', async (c) => {
  const input = await parseJsonBody(c, saveActualSchema)
  const service = createServiceClient()
  const tenantId = await fetchStoreTenant(service, input.storeId)
  const scope = await requireScopedPermission(c, {
    code: 'reconciliation.edit',
    tenantId,
    storeId: input.storeId,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, tenantId)

  const { data, error } = await service.rpc('save_reconciliation_actual', {
    p_tenant_id: scope.tenantId,
    p_store_id: input.storeId,
    p_business_date: input.businessDate,
    p_channel: input.channel,
    p_actual_amount: input.actualAmount,
    p_closing_id: input.closingId ?? null,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

// ============================================================
// 5. 差异确认(confirm_reconciliation)
// ============================================================

const confirmSchema = z.object({
  differenceReason: z.string().max(500).optional().nullable(),
})

/**
 * 确认对账差异(S31-B-CONFIRM)
 * - 权限:reconciliation.confirm
 * - 行为:先按 recordId 查对账记录归属再做作用域授权;
 *   调 confirm_reconciliation RPC,差异=0 -> confirmed,否则 difference_confirmed;
 *   差异非 0 必须填原因;审计含 reason/actor/timestamp/request_id。
 */
closingRoutes.post('/reconciliation/:id/confirm', async (c) => {
  const recordId = c.req.param('id')
  const input = await parseJsonBody(c, confirmSchema)
  const service = createServiceClient()

  // 按对账记录 id 取归属做 scoped 授权
  const { data: record, error: fetchErr } = await service
    .from('reconciliation_records')
    .select('tenant_id, store_id, business_date, channel, difference, status')
    .eq('id', recordId)
    .maybeSingle()
  if (fetchErr || !record) {
    throw err.notFound('对账记录不存在')
  }
  await requireScopedPermission(c, {
    code: 'reconciliation.confirm',
    tenantId: record.tenant_id,
    storeId: record.store_id,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, record.tenant_id)
  const requestId = (c.get('requestId') as string) || ''

  const { data, error } = await service.rpc('confirm_reconciliation', {
    p_record_id: recordId,
    p_difference_reason: input.differenceReason ?? null,
    p_request_id: requestId,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

export default closingRoutes
