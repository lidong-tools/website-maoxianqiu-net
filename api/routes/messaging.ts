import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import {
  requireScopedPermission,
  type AccessScope,
} from '../lib/permission.js'
import { getContext, loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'
import {
  loadDelivery,
  retryDelivery,
  sendMessage,
  type SendRequest,
} from '../services/messaging/engine.js'
import { getProviderSummary } from '../providers/registry.js'
import { listWhitelistVariables, validateTemplatePlaceholders } from '../services/messaging/template-engine.js'

/**
 * Messaging 领域路由(S32-D 消息通知真实 Provider)
 *
 * 路由清单:
 *   GET  /messaging/provider         (Provider 配置摘要,不含 Secret)
 *   GET  /messaging/variables        (变量白名单,供模板编辑器插入)
 *   GET  /messaging/templates        (模板列表)
 *   POST /messaging/templates        (新建模板)
 *   PATCH /messaging/templates/:id   (更新模板)
 *   POST /messaging/send             (发送消息:建 delivery + 立即发送)
 *   GET  /messaging/deliveries       (投递记录列表)
 *   GET  /messaging/deliveries/:id   (投递详情 + 尝试历史)
 *   POST /messaging/deliveries/:id/retry  (人工重试,最多 3 次)
 *
 * 授权(Agent-08 细粒度拆分,migration 267):
 *   - GET /provider、/variables    任意已登录成员
 *   - GET /templates、/deliveries  messaging.view(或兼容 message.manage)
 *   - POST/PATCH /templates        messaging.template.manage(或兼容 message.manage)
 *   - POST /send                   messaging.send(或兼容 message.manage)
 *   - POST /deliveries/:id/retry   messaging.retry(或兼容 message.manage)
 * 任一命中即放行;细粒度权限码已按 migration 267 自动授予原持有 message.manage 的角色。
 * 本文件不修改任何既有模块(permission/settings/billing 等),路由挂载由 S3.2 Integrator 在 api/index.ts 接入。
 */
const messagingRoutes = new Hono<AppEnv>()

messagingRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/**
 * 任一权限码通过即放行(Agent-08 细粒度拆分 + 兼容 message.manage)。
 * 细粒度 messaging.* 与既有 message.manage 并存:只要命中其一即可,
 * 全部未命中时抛最后一个(403 FORBIDDEN)。返回首个命中的授权作用域。
 */
async function requireAnyScopedPermission(
  c: Parameters<typeof requireScopedPermission>[0],
  codes: string[],
  requirement: Omit<Parameters<typeof requireScopedPermission>[1], 'code'>,
): Promise<AccessScope> {
  let lastError: unknown
  for (const code of codes) {
    try {
      return await requireScopedPermission(c, { ...requirement, code })
    }
    catch (e) {
      lastError = e
    }
  }
  throw lastError
}

/** Messaging 路由权限组(任一命中即放行,兼容旧 message.manage) */
const PERM_VIEW = ['messaging.view', 'message.manage']
const PERM_TEMPLATE = ['messaging.template.manage', 'message.manage']
const PERM_SEND = ['messaging.send', 'message.manage']
const PERM_RETRY = ['messaging.retry', 'message.manage']

const CHANNELS = ['sms', 'email', 'wechat', 'work_wechat'] as const
type Channel = (typeof CHANNELS)[number]

const templateSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().trim().min(1, '模板编码不能为空').max(64),
  name: z.string().trim().min(1, '模板名称不能为空').max(64),
  channel: z.enum(CHANNELS, { message: '渠道非法' }),
  subject: z.string().trim().max(200).nullish(),
  body: z.string().trim().min(1, '模板内容不能为空'),
  isActive: z.boolean().default(true),
})

const sendSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().nullish(),
  scene: z.string().trim().max(64).nullish(),
  templateId: z.string().uuid().optional(),
  templateCode: z.string().trim().optional(),
  channel: z.enum(CHANNELS).optional(),
  recipient: z.string().trim().min(1, '接收人不能为空'),
  variables: z.record(z.string(), z.unknown()).optional(),
  /** 幂等键(可选;相同键的重复发送直接返回既有投递,防止外部重复发送) */
  idempotencyKey: z.string().trim().max(64).optional(),
})

const listSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  status: z.string().optional(),
  scene: z.string().optional(),
  channel: z.enum(CHANNELS).optional(),
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

// ===== GET /messaging/provider =====
messagingRoutes.get('/provider', async (c) => {
  const context = getContext(c)
  // 任意已登录成员可查看模式摘要;不暴露 Secret
  if (!context.userId) {
    throw err.unauthorized()
  }
  return ok(c, getProviderSummary())
})

// ===== GET /messaging/variables =====
messagingRoutes.get('/variables', async (c) => {
  const context = getContext(c)
  if (!context.userId) {
    throw err.unauthorized()
  }
  return ok(c, listWhitelistVariables())
})

// ===== GET /messaging/templates =====
messagingRoutes.get('/templates', async (c) => {
  const parsed = z.object({
    tenantId: z.string().uuid(),
    channel: z.enum(CHANNELS).optional(),
    onlyActive: z.coerce.boolean().optional(),
  }).safeParse({ ...c.req.query(), tenantId: c.req.query('tenantId') ?? '' })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { tenantId: parsed.error.issues.map(i => i.message) })
  }
  await requireAnyScopedPermission(c, PERM_VIEW, {
    tenantId: parsed.data.tenantId,
    dataScope: true,
  })
  const service = createServiceClient()
  let query = service
    .from('message_templates')
    .select('*', { count: 'exact' })
    .eq('tenant_id', parsed.data.tenantId)
  if (parsed.data.channel) {
    query = query.eq('channel', parsed.data.channel)
  }
  if (parsed.data.onlyActive) {
    query = query.eq('is_active', true)
  }
  const { data, error, count } = await query.order('updated_at', { ascending: false })
  if (error) {
    throw err.internal(`查询模板列表失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ===== POST /messaging/templates =====
messagingRoutes.post('/templates', async (c) => {
  const input = await parseJsonBody(c, templateSchema)
  await requireAnyScopedPermission(c, PERM_TEMPLATE, { tenantId: input.tenantId })

  // 白名单校验:body 与 subject 中的占位符必须命中白名单
  const used = new Set(validateTemplatePlaceholders(input.body))
  if (input.subject) {
    validateTemplatePlaceholders(input.subject)
  }

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error } = await service
    .from('message_templates')
    .insert({
      tenant_id: input.tenantId,
      code: input.code,
      name: input.name,
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      // 只保存本模板实际使用的白名单变量,业务人员无需手写 JSON
      variables: [...used].reduce<Record<string, string>>((acc, key) => {
        acc[key] = key
        return acc
      }, {}),
      is_active: input.isActive,
      version: 1,
    })
    .select('*')
    .single()
  if (error) {
    if (error.message.includes('duplicate key') || error.message.includes('idx_message_templates_tenant_code')) {
      throw err.conflict('该租户下已存在同名模板编码')
    }
    throw err.internal(`创建模板失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'messaging.template.create',
    entityType: 'message_template',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { code: input.code, channel: input.channel, operatorId: user.id },
  })
  return ok(c, data)
})

// ===== PATCH /messaging/templates/:id =====
messagingRoutes.patch('/templates/:id', async (c) => {
  const templateId = c.req.param('id')
  const input = await parseJsonBody(c, templateSchema.partial().extend({
    tenantId: z.string().uuid('租户 id 格式错误'),
  }))
  await requireAnyScopedPermission(c, PERM_TEMPLATE, { tenantId: input.tenantId })

  const service = createServiceClient()
  // 先确认模板属于该租户(防止跨租户更新)
  const { data: existing, error: existingError } = await service
    .from('message_templates')
    .select('id, tenant_id, version')
    .eq('id', templateId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (existingError) {
    throw err.internal(`查询模板失败: ${existingError.message}`)
  }
  if (!existing) {
    throw err.notFound('模板不存在')
  }

  const patch: Record<string, unknown> = { version: (existing.version ?? 1) + 1 }
  if (input.name !== undefined) patch.name = input.name
  if (input.channel !== undefined) patch.channel = input.channel
  if (input.subject !== undefined) patch.subject = input.subject ?? null
  if (input.isActive !== undefined) patch.is_active = input.isActive
  if (input.body !== undefined) {
    const used = validateTemplatePlaceholders(input.body)
    patch.body = input.body
    patch.variables = used.reduce<Record<string, string>>((acc, key) => {
      acc[key] = key
      return acc
    }, {})
  }

  const { data, error } = await service
    .from('message_templates')
    .update(patch)
    .eq('id', templateId)
    .select('*')
    .single()
  if (error) {
    throw err.internal(`更新模板失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'messaging.template.update',
    entityType: 'message_template',
    entityId: templateId,
    tenantId: input.tenantId,
    metadata: { version: patch.version },
  })
  return ok(c, data)
})

// ===== POST /messaging/send =====
messagingRoutes.post('/send', async (c) => {
  const input = await parseJsonBody(c, sendSchema)
  const scope = await requireAnyScopedPermission(c, PERM_SEND, {
    tenantId: input.tenantId,
    storeId: input.storeId ?? undefined,
  })

  const req: SendRequest = {
    tenantId: input.tenantId,
    storeId: input.storeId ?? null,
    scene: input.scene ?? undefined,
    templateId: input.templateId,
    templateCode: input.templateCode,
    channel: input.channel,
    recipient: input.recipient,
    variables: input.variables,
    // 幂等键:优先 Idempotency-Key 请求头,兼容 body 传入
    idempotencyKey: input.idempotencyKey ?? (getRequestIdempotencyKey(c) || undefined),
  }
  const { delivery, attempt, provider, result } = await sendMessage(req)

  await writeAudit(c, {
    action: 'messaging.send',
    entityType: 'message_delivery',
    entityId: delivery.id,
    tenantId: input.tenantId,
    storeId: input.storeId ?? undefined,
    metadata: {
      scene: input.scene ?? null,
      channel: delivery.channel,
      provider,
      status: result.status,
      providerMessageId: result.providerMessageId,
      idempotent: provider === 'idempotent-replay',
    },
  })
  return ok(c, { delivery, attempt, result })
})

// ===== GET /messaging/deliveries =====
messagingRoutes.get('/deliveries', async (c) => {
  const parsed = listSchema.safeParse({ ...c.req.query(), tenantId: c.req.query('tenantId') ?? '' })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', {
      _root: parsed.error.issues.map(i => i.message),
    })
  }
  const input = parsed.data
  const scope = await requireAnyScopedPermission(c, PERM_VIEW, {
    tenantId: input.tenantId,
    storeId: input.storeId,
    dataScope: true,
  })

  const service = createServiceClient()
  let query = service
    .from('message_deliveries')
    .select('*', { count: 'exact' })
    .eq('tenant_id', input.tenantId)
  // 数据范围收敛:storeId 过滤仅限被授权门店;未指定时按 allowedStoreIds 收敛
  if (input.storeId) {
    if (!scope.allowedStoreIds.includes(input.storeId)) {
      throw err.forbidden('无权查看该门店的投递记录')
    }
    query = query.eq('store_id', input.storeId)
  }
  else if (scope.allowedStoreIds.length > 0 && !scope.isPlatformAdmin) {
    query = query.in('store_id', scope.allowedStoreIds)
  }
  if (input.status) query = query.eq('status', input.status)
  if (input.scene) query = query.eq('scene', input.scene)
  if (input.channel) query = query.eq('channel', input.channel)

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(input.from, input.from + input.limit - 1)
  if (error) {
    throw err.internal(`查询投递记录失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ===== GET /messaging/deliveries/:id =====
messagingRoutes.get('/deliveries/:id', async (c) => {
  const deliveryId = c.req.param('id')
  const service = createServiceClient()
  const delivery = await loadDelivery(service, deliveryId)
  // 以投递自身 tenant/store 做作用域校验(防止跨租户读取)
  await requireAnyScopedPermission(c, PERM_VIEW, {
    tenantId: delivery.tenant_id,
    storeId: delivery.store_id ?? undefined,
    dataScope: true,
  })

  const { data: attempts, error: attemptsError } = await service
    .from('message_delivery_attempts')
    .select('*')
    .eq('delivery_id', deliveryId)
    .order('attempt_no', { ascending: true })
  if (attemptsError) {
    throw err.internal(`查询发送尝试失败: ${attemptsError.message}`)
  }
  return ok(c, { delivery, attempts: attempts ?? [] })
})

// ===== POST /messaging/deliveries/:id/retry =====
messagingRoutes.post('/deliveries/:id/retry', async (c) => {
  const deliveryId = c.req.param('id')
  const service = createServiceClient()
  const existing = await loadDelivery(service, deliveryId)
  await requireAnyScopedPermission(c, PERM_RETRY, {
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
  })

  const { delivery, attempt, provider, result } = await retryDelivery(deliveryId)
  await writeAudit(c, {
    action: 'messaging.retry',
    entityType: 'message_delivery',
    entityId: delivery.id,
    tenantId: delivery.tenant_id,
    storeId: delivery.store_id ?? undefined,
    metadata: {
      attempts: delivery.attempts,
      provider,
      status: result.status,
      providerMessageId: result.providerMessageId,
    },
  })
  return ok(c, { delivery, attempt, result })
})

export default messagingRoutes
