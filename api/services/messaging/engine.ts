import process from 'node:process'
import { err } from '../../lib/errors'
import { createServiceClient } from '../../lib/supabase'
import { getProvider } from '../../providers/registry'
import { ProviderError, type ProviderSendResult } from '../../providers/types'
import { isRealProviderConfigured } from './config'
import {
  normalizeVariables,
  renderTemplateText,
  validateTemplatePlaceholders,
} from './template-engine'

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

type MessageChannel = 'sms' | 'email' | 'wechat' | 'work_wechat'
type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'retry'

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
  created_at: string
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

/** 创建投递记录(不发送),返回 delivery 行 */
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
  },
): Promise<DeliveryRow> {
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
      status: 'queued',
      attempts: 0,
    })
    .select('*')
    .single()
  if (error) {
    throw err.internal(`创建投递记录失败: ${error.message}`)
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
  const { error: updateError } = await service
    .from('message_deliveries')
    .update(patch)
    .eq('id', delivery.id)
  if (updateError) {
    throw err.internal(`更新投递状态失败: ${updateError.message}`)
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
 */
export async function sendMessage(req: SendRequest): Promise<DeliveryWithAttempt> {
  assertSendAllowed()
  const service = createServiceClient()
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

  const delivery = await createDeliveryRecord(service, {
    tenantId: req.tenantId,
    storeId: req.storeId,
    scene: req.scene,
    template,
    channel,
    recipient,
    contentSnapshot: body,
    subjectSnapshot: subject,
    variables,
  })

  const { result, provider } = await dispatchAndRecord(
    service,
    delivery,
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

/** 人工重试(最多 MAX_ATTEMPTS 次;终态 sent/delivered 拒绝) */
export async function retryDelivery(deliveryId: string): Promise<DeliveryWithAttempt> {
  assertSendAllowed()
  const service = createServiceClient()
  const delivery = await loadDelivery(service, deliveryId)
  if (delivery.status === 'sent' || delivery.status === 'delivered') {
    throw err.unprocessable('该投递已成功,无需重试')
  }
  if (delivery.attempts >= MAX_ATTEMPTS) {
    throw err.unprocessable(`该投递已达最大重试次数(${MAX_ATTEMPTS})`)
  }

  const attemptNo = delivery.attempts + 1
  const { result, provider } = await dispatchAndRecord(
    service,
    delivery,
    attemptNo,
    delivery.subject_snapshot,
    delivery.content_snapshot,
    { retryOf: delivery.id, fromStatus: delivery.status, scene: delivery.scene ?? null },
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
