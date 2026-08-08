import process from 'node:process'
import { err } from '../../lib/errors.js'
import { createServiceClient } from '../../lib/supabase.js'
import { getProvider } from '../../providers/registry.js'
import { ProviderError, type ProviderSendResult } from '../../providers/types.js'
import { isRealProviderConfigured } from './config.js'
import {
  normalizeVariables,
  renderTemplateText,
  validateTemplatePlaceholders,
} from './template-engine.js'

/**
 * 消息发送引擎(S32-D)
 *
 * 职责:
 *   - 加载模板(按 id 或 code+channel)
 *   - 白名单校验变量 + 渲染内容快照
 *   - 写 message_deliveries + message_delivery_attempts
 *   - 调用真实 Provider 发送,并把 Provider 返回/失败原因落库
 *
 * 安全边界:
 *   - Provider Secret 只在服务端,不出现在任何入参/落库明文字段
 *   - 生产环境未配置真实 Provider 时拒绝发送(不允许 Mock 冒充)
 */

const MAX_ATTEMPTS = 3

/**
 * sending 陈旧时间窗(审计 v3 §19):claim 后 Provider 副作用执行中,
 * 若进程在副作用前后崩溃,delivery 会长期停在 sending。超过该时长视为
 * 原执行者失联,允许人工重试回收(在无法确定 Provider 是否已收到请求时,
 * 仍以 Provider 幂等/消息键为准,本时间窗只是避免永久卡死的最小兜底)。
 */
const STALE_SENDING_MS = 10 * 60 * 1000

/** 判断 sending 是否为"陈旧"(claim 已超过时间窗,可被回收重试) */
function isStaleSending(delivery: DeliveryRow): boolean {
  // 优先 sending_claimed_at(migration 121,claim 成功时刻);存量行回退 updated_at
  const claimAt = delivery.sending_claimed_at ?? delivery.updated_at
  return delivery.status === 'sending'
    && Date.now() - new Date(claimAt).getTime() > STALE_SENDING_MS
}

/**
 * 幂等 replay 结果映射(审计 v3 §17):按投递真实状态返回,
 * 绝不把"非 failed"等价于 sent。
 *   queued/retry → queued;sending → queued(尚未确认成功);
 *   sent → sent;delivered → delivered;failed → failed。
 */
function replayResult(delivery: DeliveryRow): ProviderSendResult {
  switch (delivery.status) {
    case 'delivered':
      return { status: 'delivered', providerMessageId: delivery.provider_message_id ?? undefined, raw: { idempotent: true } }
    case 'sent':
      return { status: 'sent', providerMessageId: delivery.provider_message_id ?? undefined, raw: { idempotent: true } }
    case 'failed':
      return { status: 'failed', raw: { code: 'IDEMPOTENT_REPLAY', message: delivery.error ?? '复用既有失败投递' } }
    case 'sending':
    case 'queued':
    case 'retry':
    default:
      return { status: 'queued', raw: { idempotent: true } }
  }
}

type MessageChannel = 'sms' | 'email' | 'wechat' | 'work_wechat'
type DeliveryStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'retry'

export interface SendRequest {
  tenantId: string
  storeId?: string | null
  /** 业务场景(scene):预约提醒/疫苗提醒/回访提醒/检验报告通知 等 */
  scene?: string
  templateId?: string
  templateCode?: string
  channel?: MessageChannel
  recipient: string
  variables?: Record<string, unknown>
  /** 幂等键:相同键的重复发送直接返回既有投递,避免外部重复发送 */
  idempotencyKey?: string
}

interface TemplateRow {
  id: string
  code: string
  name: string
  channel: MessageChannel
  subject: string | null
  body: string
  is_active: boolean
}

interface DeliveryRow {
  id: string
  tenant_id: string
  store_id: string | null
  scene: string | null
  template_id: string | null
  channel: MessageChannel
  recipient: string
  content_snapshot: string
  subject_snapshot: string | null
  variables_snapshot: Record<string, unknown> | null
  provider_message_id: string | null
  status: DeliveryStatus
  error: string | null
  attempts: number
  sent_at: string | null
  idempotency_key: string | null
  created_at: string
  updated_at: string
  /** claim sending 成功时刻(migration 121);stale sending 判断优先使用 */
  sending_claimed_at: string | null
}

export interface DeliveryWithAttempt {
  delivery: DeliveryRow
  attempt: Record<string, unknown> | null
  provider: string
  result: ProviderSendResult
}

function isProductionEnv(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
}

/** 生产环境发送守卫:未配置真实 Provider 直接拒绝(与 operations.ts 语义一致) */
export function assertSendAllowed(): void {
  if (isProductionEnv() && !isRealProviderConfigured()) {
    throw new ProviderError(
      'PROVIDER_NOT_CONFIGURED',
      '生产环境未配置消息供应商,消息发送不可用',
    )
  }
}

function validateRecipient(channel: MessageChannel, recipient: string): void {
  if (!recipient || !recipient.trim()) {
    throw err.badRequest('接收人不能为空')
  }
  if (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim())) {
    throw err.badRequest('邮件渠道的接收人必须是有效邮箱')
  }
  if ((channel === 'sms') && !/^[0-9+\-\s]{5,20}$/.test(recipient.trim())) {
    throw err.badRequest('短信渠道的接收人必须是有效手机号')
  }
}

async function loadTemplate(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  req: SendRequest,
): Promise<TemplateRow> {
  let query = service
    .from('message_templates')
    .select('id, code, name, channel, subject, body, is_active')
    .eq('tenant_id', tenantId)
  if (req.templateId) {
    query = query.eq('id', req.templateId)
  }
  else if (req.templateCode) {
    query = query.eq('code', req.templateCode)
    if (req.channel) {
      query = query.eq('channel', req.channel)
    }
  }
  else {
    throw err.badRequest('必须提供 templateId 或 templateCode')
  }
  const { data, error } = await query.maybeSingle()
  if (error) {
    throw err.internal(`查询消息模板失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('消息模板不存在')
  }
  const template = data as TemplateRow
  if (!template.is_active) {
    throw err.unprocessable(`模板 ${template.code} 已停用,无法发送`)
  }
  return template
}

/**
 * 创建投递记录(不发送)
 * 返回 { delivery, created }:
 *   - created=true  → 本请求新建成,是唯一允许执行 Provider 副作用的执行者;
 *   - created=false → 幂等键冲突,另一并发请求已建投递,本请求只能返回既有状态,
 *                     禁止再次调用 Provider(审计 v2 §21/§23)。
 */
export async function createDeliveryRecord(
  service: ReturnType<typeof createServiceClient>,
  params: {
    tenantId: string
    storeId?: string | null
    scene?: string
    template: TemplateRow
    channel: MessageChannel
    recipient: string
    contentSnapshot: string
    subjectSnapshot: string | null
    variables: Record<string, unknown>
    idempotencyKey?: string
  },
): Promise<{ delivery: DeliveryRow, created: boolean }> {
  const { data, error } = await service
    .from('message_deliveries')
    .insert({
      tenant_id: params.tenantId,
      store_id: params.storeId ?? null,
      scene: params.scene || null,
      template_id: params.template.id,
      channel: params.channel,
      recipient: params.recipient,
      content_snapshot: params.contentSnapshot,
      subject_snapshot: params.subjectSnapshot,
      variables_snapshot: params.variables,
      idempotency_key: params.idempotencyKey ?? null,
      status: 'queued',
      attempts: 0,
    })
    .select('*')
    .single()
  if (error) {
    // 幂等键冲突:并发同键请求,另一请求已建投递 → 读取并复用(created=false,不得再发送)
    if (params.idempotencyKey && (error.message.includes('duplicate key') || error.message.includes('idx_message_deliveries_tenant_idem'))) {
      const { data: existing } = await service
        .from('message_deliveries')
        .select('*')
        .eq('tenant_id', params.tenantId)
        .eq('idempotency_key', params.idempotencyKey)
        .maybeSingle()
      if (existing) {
        return { delivery: existing as DeliveryRow, created: false }
      }
    }
    throw err.internal(`创建投递记录失败: ${error.message}`)
  }
  return { delivery: data as DeliveryRow, created: true }
}

/**
 * Initial Send 的 CAS claim(审计 Full12 §6/§7):
 * 刚创建的 delivery(queued/0)在 Provider 副作用执行前必须先原子 claim 为
 * sending/1,只有 claim 成功的请求才允许调用 Provider,防止
 * "Initial Send 进行中 ↔ 另一请求 Retry claim queued" 产生重复外部发送。
 * claim 成功同时写入 sending_claimed_at(migration 121),供 stale 判断。
 */
async function claimInitialSend(
  service: ReturnType<typeof createServiceClient>,
  deliveryId: string,
): Promise<DeliveryRow> {
  const { data, error } = await service
    .from('message_deliveries')
    .update({ status: 'sending', attempts: 1, sending_claimed_at: new Date().toISOString() })
    .eq('id', deliveryId)
    .eq('status', 'queued')
    .eq('attempts', 0)
    .select('*')
    .maybeSingle()
  if (error) {
    throw err.internal(`抢占初始发送失败: ${error.message}`)
  }
  if (!data) {
    // 并发者(如 Retry)已接管该 delivery,禁止本请求再执行 Provider 副作用
    throw err.conflict('该投递正在发送中,请勿重复操作')
  }
  return data as DeliveryRow
}

/** 落一条 attempt + 更新 delivery 状态 */
async function recordAttempt(
  service: ReturnType<typeof createServiceClient>,
  delivery: DeliveryRow,
  attemptNo: number,
  providerName: string,
  result: ProviderSendResult,
  requestSnapshot: Record<string, unknown>,
): Promise<void> {
  const ok = result.status === 'sent' || result.status === 'delivered'
  const raw = result.raw && typeof result.raw === 'object'
    ? result.raw as Record<string, unknown>
    : {}
  const errorInfo = result.status === 'failed' ? {
    error_code: typeof raw.code === 'string' ? raw.code : 'PROVIDER_ERROR',
    error_message: typeof raw.message === 'string' ? raw.message : 'Provider 发送失败',
  } : { error_code: null, error_message: null }

  const { error: attemptError } = await service.from('message_delivery_attempts').insert({
    delivery_id: delivery.id,
    provider: providerName,
    attempt_no: attemptNo,
    request_snapshot: requestSnapshot,
    response_snapshot: result.raw ?? null,
    status: result.status,
    error_code: errorInfo.error_code,
    error_message: errorInfo.error_message,
  })
  if (attemptError) {
    throw err.internal(`记录发送尝试失败: ${attemptError.message}`)
  }

  const patch: Record<string, unknown> = {
    status: result.status === 'failed' ? 'failed' : 'sent',
    attempts: attemptNo,
  }
  if (ok) {
    patch.provider_message_id = result.providerMessageId ?? null
    patch.sent_at = new Date().toISOString()
    patch.error = null
  }
  else {
    patch.error = errorInfo.error_message
  }
  // 防晚到覆盖(审计 Full12 §9):仅当 delivery 仍处于本次 claim 的
  // sending/attempts 状态时才允许写结果;若已被后续重试接管(0 行),
  // 说明本次结果已过期,静默丢弃避免旧结果覆盖新状态。
  const { data: updated, error: updateError } = await service
    .from('message_deliveries')
    .update(patch)
    .eq('id', delivery.id)
    .eq('attempts', attemptNo)
    .eq('status', 'sending')
    .select('id')
    .maybeSingle()
  if (updateError) {
    throw err.internal(`更新投递状态失败: ${updateError.message}`)
  }
  if (!updated) {
    console.warn(`[messaging] 晚到 attempt #${attemptNo} 已被更新接管,丢弃旧结果: delivery=${delivery.id}`)
  }
}

async function dispatchAndRecord(
  service: ReturnType<typeof createServiceClient>,
  delivery: DeliveryRow,
  attemptNo: number,
  subject: string | null,
  body: string,
  requestSnapshot: Record<string, unknown>,
): Promise<{ result: ProviderSendResult, provider: string }> {
  const provider = getProvider()
  let result: ProviderSendResult
  try {
    result = await provider.send({
      channel: delivery.channel,
      recipient: delivery.recipient,
      subject,
      text: body,
      meta: { scene: delivery.scene },
    })
  }
  catch (e) {
    result = e instanceof ProviderError
      ? { status: 'failed', raw: { code: e.code, message: e.message } }
      : { status: 'failed', raw: { code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) } }
  }
  await recordAttempt(service, delivery, attemptNo, provider.name, result, requestSnapshot)
  return { result, provider: provider.name }
}

/**
 * 发送一条消息(创建 delivery + 立即发送)
 * - 白名单变量校验通过后渲染
 * - 幂等:携带 idempotencyKey 时,命中既有投递直接返回,不重复外部发送
 */
export async function sendMessage(req: SendRequest): Promise<DeliveryWithAttempt> {
  assertSendAllowed()
  const service = createServiceClient()

  // 幂等优先:同键已有投递 → 复用既有结果(终态成功/失败均可安全返回)
  if (req.idempotencyKey) {
    const { data: existing } = await service
      .from('message_deliveries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('idempotency_key', req.idempotencyKey)
      .maybeSingle()
    if (existing) {
      const delivery = existing as DeliveryRow
      const attempt = await loadLatestAttempt(service, delivery.id)
      // 真实状态映射(审计 v4 §9/§10):顶部快速分支与 created=false 分支统一,
      // 避免 queued/sending 中间态被误报为 sent。
      const result = replayResult(delivery)
      return { delivery, attempt, provider: 'idempotent-replay', result }
    }
  }

  const template = await loadTemplate(service, req.tenantId, req)
  const channel = req.channel ?? template.channel
  validateRecipient(channel, req.recipient)
  const recipient = req.recipient.trim()

  // 白名单校验 + 渲染
  validateTemplatePlaceholders(template.body)
  if (template.subject) {
    validateTemplatePlaceholders(template.subject)
  }
  const variables = normalizeVariables(req.variables ?? {})
  const body = renderTemplateText(template.body, variables)
  const subject = template.subject ? renderTemplateText(template.subject, variables) : null

  const { delivery, created } = await createDeliveryRecord(service, {
    tenantId: req.tenantId,
    storeId: req.storeId,
    scene: req.scene,
    template,
    channel,
    recipient,
    contentSnapshot: body,
    subjectSnapshot: subject,
    variables,
    idempotencyKey: req.idempotencyKey,
  })

  // 并发同键:另一请求已建投递(created=false)。仅返回既有状态,
  // 禁止再次调用 Provider,防止同一 Delivery 被发送两次(审计 v2 §21)。
  if (!created) {
    const attempt = await loadLatestAttempt(service, delivery.id)
    // 真实状态映射(审计 v3 §17),不把"非 failed"当作 sent
    const result = replayResult(delivery)
    return { delivery, attempt, provider: 'idempotent-replay', result }
  }

  // Initial Send 先 CAS claim queued/0 → sending/1(审计 Full12 §6/§7),
  // 保证 Provider 副作用期间 delivery 不再处于 queued,Retry 无法并发接管。
  const claimed = await claimInitialSend(service, delivery.id)

  const { result, provider } = await dispatchAndRecord(
    service,
    claimed,
    1,
    subject,
    body,
    {
      scene: req.scene ?? null,
      templateCode: template.code,
      channel,
      recipient,
      variables,
    },
  )

  const fresh = await loadDelivery(service, delivery.id)
  const attempt = await loadLatestAttempt(service, delivery.id)
  return { delivery: fresh, attempt, provider, result }
}

/**
 * 人工重试(最多 MAX_ATTEMPTS 次;终态 sent/delivered 拒绝)
 * 并发安全:Compare-And-Swap 原子 claim(WHERE attempts = 读取值 AND status ∈
 * 可重试态 → SET status='sending', attempts = attempts+1 RETURNING *),
 * 仅成功返回一行的请求才允许执行 Provider 副作用,防止并发重试重复发送
 * (审计 v2 §22/§23;sending 中间态排除"已在发送中"的并发 claim)。
 */
export async function retryDelivery(deliveryId: string): Promise<DeliveryWithAttempt> {
  assertSendAllowed()
  const service = createServiceClient()
  const existing = await loadDelivery(service, deliveryId)
  if (existing.status === 'sent' || existing.status === 'delivered') {
    throw err.unprocessable('该投递已成功,无需重试')
  }
  // 刚 claim 的 sending(时间窗内)拒绝并发重试;陈旧 sending(执行者疑似失联)
  // 允许回收重试,避免 delivery 永久卡死(审计 v3 §19)
  if (existing.status === 'sending' && !isStaleSending(existing)) {
    throw err.conflict('该投递正在发送中,请勿重复操作')
  }

  // CAS claim:attempts 期望值 + 可重试状态集 + 次数上限均作为 UPDATE 条件,
  // attempts = existing.attempts 保证并发下仅一个请求能匹配(SQL 侧比较当前值)。
  // 可重试状态:queued/failed/retry + 超过时间窗的陈旧 sending。
  const staleCutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString()
  const { data: claimed, error: claimErr } = await service
    .from('message_deliveries')
    .update({ status: 'sending', attempts: existing.attempts + 1, sending_claimed_at: new Date().toISOString() })
    .eq('id', deliveryId)
    .eq('attempts', existing.attempts)
    .or(`status.in.(queued,failed,retry),and(status.eq.sending,updated_at.lt.${staleCutoff})`)
    .lt('attempts', MAX_ATTEMPTS)
    .select('*')
    .maybeSingle()
  if (claimErr) {
    throw err.internal(`抢占重试失败: ${claimErr.message}`)
  }
  if (!claimed) {
    const cur = await loadDelivery(service, deliveryId)
    if (cur.attempts >= MAX_ATTEMPTS) {
      throw err.unprocessable(`该投递已达最大重试次数(${MAX_ATTEMPTS})`)
    }
    if (cur.status === 'sending') {
      throw err.conflict('该投递正在发送中,请勿重复操作')
    }
    throw err.conflict('该投递正在被其他请求重试,请稍后再试')
  }

  const delivery = claimed as DeliveryRow
  const attemptNo = delivery.attempts
  const { result, provider } = await dispatchAndRecord(
    service,
    delivery,
    attemptNo,
    delivery.subject_snapshot,
    delivery.content_snapshot,
    { retryOf: deliveryId, fromStatus: existing.status, scene: delivery.scene ?? null },
  )

  const fresh = await loadDelivery(service, delivery.id)
  const attempt = await loadLatestAttempt(service, delivery.id)
  return { delivery: fresh, attempt, provider, result }
}

export async function loadDelivery(
  service: ReturnType<typeof createServiceClient>,
  id: string,
): Promise<DeliveryRow> {
  const { data, error } = await service
    .from('message_deliveries')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    throw err.internal(`查询投递记录失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('投递记录不存在')
  }
  return data as DeliveryRow
}

export async function loadLatestAttempt(
  service: ReturnType<typeof createServiceClient>,
  deliveryId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await service
    .from('message_delivery_attempts')
    .select('*')
    .eq('delivery_id', deliveryId)
    .order('attempt_no', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw err.internal(`查询发送尝试失败: ${error.message}`)
  }
  return (data as Record<string, unknown> | null) ?? null
}

export { MAX_ATTEMPTS }
export type { MessageChannel, DeliveryStatus }
