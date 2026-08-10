import type { Context } from 'hono'
import type { AppEnv } from '../lib/types.js'
import type { MessageChannel, MessagingWebhookProvider, ProviderWebhookEvent } from '../providers/types.js'
import { Hono } from 'hono'
import { err } from '../lib/errors.js'
import { createServiceClient } from '../lib/supabase.js'
import { getProviderForChannel } from '../providers/registry.js'

/**
 * 消息 Provider 回调收件路由(Agent-08 DEEP §12)
 *
 * POST /messaging/webhook/:provider
 *   - provider ∈ email | sms(wechat/work_wechat 未接入真实回调)
 *
 * 处理链路(验签 → 解析 → 幂等落库 → CAS 状态推进,全部在服务端完成):
 *   1. 读取原始 body(必须 raw string,供验签,不可先 JSON.parse)
 *   2. 按 provider 找到实现了 MessagingWebhookProvider 的 Provider
 *   3. verifyWebhook 失败 → 401(宁可不收也不处理未验签事件,P0)
 *   4. parseWebhook → 统一事件数组(与 Provider 无关的 body 返回空数组)
 *   5. 逐事件调用 apply_provider_event RPC(幂等 insert + delivery 状态 CAS 推进)
 *   6. 始终返回 200(除验签失败/非法 provider),避免触发 Provider 重试风暴
 *
 * 安全要点:
 *   - 本路由无员工鉴权,是外部回调入口,防护 = Provider 侧验签
 *   - 未配置的渠道不允许接收回调(返回 503),防止伪造
 *   - payload 原样快照入库(message_provider_events),供排障与审计
 */
const messagingWebhookRoutes = new Hono<AppEnv>()

/** 支持的 Webhook 渠道(真实回调已接入;wechat 等占位渠道一律拒绝) */
const WEBHOOK_CHANNELS: MessageChannel[] = ['email', 'sms']

/** 把 Hono 的 Headers 转成验签所需的普通对象 */
function toHeaderRecord(c: Context<AppEnv>): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value
  })
  return headers
}

/** 将 verifyWebhook 失败 / 非法渠道映射为 HTTP 错误 */
function webhookReject(reason: string): never {
  throw err.unauthorized(reason)
}

/** 判断消息 Provider 是否实现了 webhook 验签与解析能力。 */
function isWebhookProvider(provider: unknown): provider is MessagingWebhookProvider {
  if (!provider || typeof provider !== 'object') {
    return false
  }
  const candidate = provider as Partial<MessagingWebhookProvider>
  return typeof candidate.verifyWebhook === 'function' && typeof candidate.parseWebhook === 'function'
}

/** Webhook 审计(外部回调,无员工 context;手动写 audit_logs,user/tenant 均空) */
async function writeWebhookAudit(c: Context<AppEnv>, entry: {
  action: string
  metadata: Record<string, unknown>
}): Promise<void> {
  try {
    const service = createServiceClient()
    await service.from('audit_logs').insert({
      tenant_id: null,
      store_id: null,
      user_id: null,
      action: entry.action,
      entity_type: 'message_provider_event',
      entity_id: null,
      metadata: { ...entry.metadata, actorType: 'messaging-webhook' },
      request_id: c.get('requestId') ?? null,
    })
  }
  catch (e) {
    console.error('[messaging][webhook] 审计写入失败', e)
  }
}

messagingWebhookRoutes.post('/:provider', async (c) => {
  const providerKey = c.req.param('provider').trim().toLowerCase()
  if (!WEBHOOK_CHANNELS.includes(providerKey as MessageChannel)) {
    throw err.notFound('不支持的 Webhook 渠道')
  }
  const channel = providerKey as MessageChannel

  // 1) 原始 body(必须先于任何解析读取,保证验签完整性)
  const rawBody = await c.req.text()

  // 2) 渠道 Provider(未配置 → 开发回退 Mock;Mock 无验签能力,一律拒绝)
  const provider = getProviderForChannel(channel)
  if (!isWebhookProvider(provider)) {
    throw err.unprocessable('该渠道未配置 Webhook 验签能力')
  }
  const webhookProvider = provider

  // 3) 验签(失败一律 401)
  const headers = toHeaderRecord(c)
  const verified = await webhookProvider.verifyWebhook(rawBody, headers)
  if (!verified) {
    webhookReject('Webhook 验签失败')
  }

  // 4) 解析统一事件
  let events: ProviderWebhookEvent[]
  try {
    events = await webhookProvider.parseWebhook(rawBody, headers)
  }
  catch {
    events = []
  }
  if (events.length === 0) {
    // 与本 Provider 无关的回调(如 SendGrid 校验请求):正常应答,不落库
    return c.json({ ok: true, processed: 0, ignored: 0, duplicate: 0, skipped: 1 }, 200)
  }

  // 5) 逐事件幂等应用(apply_provider_event RPC:insert + CAS 状态推进)
  const service = createServiceClient()
  let processed = 0
  let duplicate = 0
  let ignored = 0
  for (const event of events) {
    const { data, error } = await service.rpc('apply_provider_event', {
      p_provider: event.provider,
      p_provider_event_id: event.providerEventId,
      p_delivery_id: event.deliveryId ?? null,
      p_provider_message_id: event.providerMessageId ?? null,
      p_event_type: event.eventType,
      p_payload: event.payload,
    })
    if (error) {
      // 单个事件失败不阻断其余事件,但记录到审计
      console.error('[messaging][webhook] 应用事件失败', error.message, { provider: event.provider, providerEventId: event.providerEventId })
      ignored += 1
      continue
    }
    const result = (data ?? {}) as { status?: string, processed?: boolean }
    if (result.status === 'duplicate') {
      duplicate += 1
    }
    else if (result.processed) {
      processed += 1
    }
    else {
      ignored += 1
    }
  }

  // 6) 审计(外部回调,无员工 context;关键信息已落在 message_provider_events)
  await writeWebhookAudit(c, {
    action: 'messaging.webhook.received',
    metadata: {
      provider: channel,
      eventCount: events.length,
      processed,
      duplicate,
      ignored,
      requestId: c.get('requestId') ?? null,
    },
  })

  return c.json({ ok: true, provider: channel, processed, duplicate, ignored }, 200)
})

export default messagingWebhookRoutes
