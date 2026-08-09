import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err, type ApiError } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import {
  generateOtpCode,
  hashOtpCode,
  maskEmail,
  maskPhone,
  randomSalt,
  signPortalSession,
  verifyPortalSession,
  type PortalSessionPayload,
} from '../lib/portal-session.js'
import { requireScopedPermission } from '../lib/permission.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import type { AppEnv } from '../lib/types.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'
import { getProviderChannelStatus, getProviderForChannel } from '../providers/registry.js'
import { ProviderError } from '../providers/types.js'

/**
 * 客户门户路由(Agent-08)
 *
 * 两条完全分离的授权线:
 *   C 端(/portal/auth、/portal/me、/portal/pets ...):
 *     - 身份 = customer_identities(OTP 验证码 + HMAC 会话 token)
 *     - 与员工 IAM(auth.users/roles)无任何关联
 *     - 不接收客户端任意 customerId 作为权威身份,一律从会话推导
 *   Admin(/portal/admin/*):
 *     - 员工 IAM(authMiddleware + requireScopedPermission + portal.* 权限码)
 *
 * 安全要点:
 *   - OTP 只存 hash,生产未配置 Provider 时拒绝发送(PROVIDER_NOT_CONFIGURED)
 *   - 报告只暴露 customer_visible=true 且 published=true 的归档
 *   - 预约创建走 create_portal_appointment RPC,禁止直接 insert appointments
 *   - 全部 C 端/Admin 关键操作写审计
 */
const portalRoutes = new Hono<AppEnv>()

// ============================================================
// C 端会话中间件:解析 Bearer token → portalIdentity
// ============================================================
function portalSessionAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization')
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!token) {
      throw err.unauthorized('请先登录客户门户')
    }
    const payload = verifyPortalSession(token)
    c.set('portalIdentity', payload)
    await next()
  }
}

/** 读取当前 Portal 会话(未初始化时抛错) */
function requirePortalSession(c: Context<AppEnv>): PortalSessionPayload {
  const identity = c.get('portalIdentity')
  if (!identity) {
    throw err.unauthorized('请先登录客户门户')
  }
  return identity
}

/** C 端审计(无 employee context,手动写 audit_logs,actor 记录在 metadata) */
async function writePortalAudit(
  c: Context<AppEnv>,
  entry: {
    action: string
    entityType?: string
    entityId?: string
    tenantId: string
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  try {
    const service = createServiceClient()
    await service.from('audit_logs').insert({
      tenant_id: entry.tenantId,
      store_id: null,
      user_id: null,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      metadata: { ...(entry.metadata ?? {}), actorType: 'portal' },
      request_id: c.get('requestId') ?? null,
    })
  }
  catch (e) {
    console.error('[portal][audit] C 端审计写入失败', e)
  }
}

/** 将 service.rpc 的 P000x 业务异常码归一为 ApiError */
function rpcBusinessError(rpcError: { message?: string }): never {
  const m = rpcError.message ?? ''
  const map: Record<string, () => ApiError> = {
    OTP_RATE_LIMITED: () => err.conflict('验证码发送过于频繁,请 60 秒后再试'),
    OTP_EXPIRED: () => err.unprocessable('验证码已过期,请重新获取'),
    OTP_ALREADY_USED: () => err.unprocessable('验证码已被使用,请重新获取'),
    OTP_TOO_MANY_ATTEMPTS: () => err.unprocessable('验证码错误次数过多,请重新获取'),
    OTP_INVALID_CODE: () => err.unprocessable('验证码错误'),
    OTP_NOT_FOUND: () => err.notFound('验证码请求不存在'),
    IDENTITY_REVOKED: () => err.forbidden('该身份已被停用,请联系医院'),
    IDENTITY_INVALID: () => err.forbidden('身份无效或已停用'),
    IDENTITY_NOT_BOUND: () => err.unprocessable('身份尚未绑定客户档案,请联系医院'),
    PET_NOT_FOUND: () => err.notFound('宠物不存在'),
    PET_ACCESS_DENIED: () => err.forbidden('无权操作该宠物'),
    STORE_TENANT_MISMATCH: () => err.badRequest('门店不属于当前租户'),
    TENANT_NO_STORE: () => err.unprocessable('该租户未配置门店'),
    APPOINTMENT_MISSING_IDENTITY: () => err.badRequest('缺少身份标识'),
    APPOINTMENT_MISSING_PET: () => err.badRequest('缺少宠物'),
    APPOINTMENT_MISSING_IDEMPOTENCY: () => err.badRequest('缺少幂等键'),
    APPOINTMENT_INVALID_TIME: () => err.badRequest('预约时间不合法'),
    APPOINTMENT_PREVIOUS_FAILED: () => err.conflict('该请求此前处理失败,请重新发起'),
  }
  for (const [code, fn] of Object.entries(map)) {
    if (m.includes(code)) {
      throw fn()
    }
  }
  throw err.internal(`服务端处理失败: ${m}`)
}

/** 校验 C 端可见宠物:owner 或显式授权 */
async function assertPortalPetAccess(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  customerId: string,
  petId: string,
  needPermission = 'view',
): Promise<void> {
  const { data: pet } = await service
    .from('pets')
    .select('id, customer_id')
    .eq('id', petId)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .maybeSingle()
  if (!pet) {
    throw err.notFound('宠物不存在')
  }
  if (pet.customer_id === customerId) {
    return
  }
  const { data: access } = await service
    .from('customer_pet_access')
    .select('id, permissions')
    .eq('tenant_id', tenantId)
    .eq('pet_id', petId)
    .eq('customer_id', customerId)
    .eq('status', 'active')
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .maybeSingle()
  if (!access || !(access.permissions ?? []).includes(needPermission)) {
    throw err.forbidden('无权访问该宠物')
  }
}

// ============================================================
// C 端认证(无鉴权)
// ============================================================
const requestOtpSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  provider: z.enum(['phone', 'email'], { message: '验证渠道非法' }),
  recipient: z.string().trim().min(1, '接收人不能为空').max(128),
  purpose: z.enum(['login', 'bind']).default('login'),
})

portalRoutes.post('/auth/request-otp', async (c) => {
  const input = await parseJsonBody(c, requestOtpSchema)
  const service = createServiceClient()

  // 1) 租户存在性校验(防跨租户枚举发送)
  const { data: tenant } = await service
    .from('tenants')
    .select('id')
    .eq('id', input.tenantId)
    .maybeSingle()
  if (!tenant) {
    throw err.badRequest('租户不存在')
  }

  // 2) 接收人格式校验
  const recipient = input.recipient.trim().toLowerCase()
  if (input.provider === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw err.badRequest('邮箱格式不正确')
  }
  if (input.provider === 'phone' && !/^[0-9+\-\s]{5,20}$/.test(recipient)) {
    throw err.badRequest('手机号格式不正确')
  }

  // 3) 生成验证码 + 哈希(DB 只存 hash;明文仅在本次服务端内存中发送用)
  const code = generateOtpCode()
  const salt = randomSalt()
  const codeHash = hashOtpCode(code, salt)
  const masked = input.provider === 'email' ? maskEmail(recipient) : maskPhone(recipient)

  // 4) 创建挑战(含 60s 速率限制与旧挑战失效,事务内完成)
  const { data: challenge, error: createErr } = await service.rpc('portal_create_otp_challenge', {
    p_tenant_id: input.tenantId,
    p_provider: input.provider,
    p_recipient: recipient,
    p_purpose: input.purpose,
    p_code_hash: codeHash,
    p_code_salt: salt,
    p_masked_recipient: masked,
  })
  if (createErr) {
    if (createErr.message.includes('OTP_RATE_LIMITED')) {
      throw err.conflict('验证码发送过于频繁,请 60 秒后再试')
    }
    throw err.internal(`创建验证码失败: ${createErr.message}`)
  }

  // 5) 通过消息 Provider 发送验证码(未配置真实 Provider 的生产环境拒绝)
  const provider = getProviderForChannel(input.provider === 'email' ? 'email' : 'sms')
  const text = `【毛线球宠物医院】您的验证码是 ${code},10 分钟内有效。请勿泄露给他人。`
  try {
    await provider.send({
      channel: input.provider === 'email' ? 'email' : 'sms',
      recipient,
      subject: input.provider === 'email' ? '毛线球宠物医院登录验证码' : undefined,
      text,
      meta: { scene: 'portal_otp', purpose: input.purpose },
    })
  }
  catch (e) {
    // 发送失败:将挑战置为失败状态,避免留下无法使用的 pending 挑战
    await service.from('verification_challenges')
      .update({ status: 'failed', used_at: new Date().toISOString() })
      .eq('id', challenge.challengeId)
    if (e instanceof ProviderError) {
      if (e.code === 'PROVIDER_NOT_CONFIGURED') {
        throw err.unprocessable('短信/邮件通道未配置,暂时无法发送验证码')
      }
      throw err.internal('验证码发送失败')
    }
    throw err.internal('验证码发送失败')
  }

  await writePortalAudit(c, {
    action: 'portal.otp.request',
    entityType: 'verification_challenge',
    entityId: challenge.challengeId,
    tenantId: input.tenantId,
    metadata: { provider: input.provider, recipient: masked, purpose: input.purpose },
  })

  return ok(c, {
    challengeId: challenge.challengeId,
    maskedRecipient: masked,
    expiresAt: challenge.expiresAt,
    attemptsLeft: challenge.attemptsLeft,
  })
})

const verifyOtpSchema = z.object({
  challengeId: z.string().uuid('验证码请求 id 格式错误'),
  code: z.string().trim().length(6, '验证码为 6 位数字'),
})

portalRoutes.post('/auth/verify-otp', async (c) => {
  const input = await parseJsonBody(c, verifyOtpSchema)
  const service = createServiceClient()

  const { data, error: verifyErr } = await service.rpc('portal_verify_otp', {
    p_challenge_id: input.challengeId,
    p_code: input.code,
  })
  if (verifyErr) {
    rpcBusinessError(verifyErr)
  }

  // 签发 C 端会话 token
  const token = signPortalSession({
    identityId: data.identityId,
    tenantId: data.tenantId,
    customerId: data.customerId ?? null,
  })

  await writePortalAudit(c, {
    action: 'portal.identity.verified',
    entityType: 'customer_identity',
    entityId: data.identityId,
    tenantId: data.tenantId,
    metadata: { provider: data.provider, customerId: data.customerId ?? null },
  })

  return ok(c, { token, identity: data, customer: data.customer ?? null })
})

// ============================================================
// C 端业务 API(portal session 保护)
// ============================================================
portalRoutes.use('/me', portalSessionAuth())
portalRoutes.use('/pets', portalSessionAuth())
portalRoutes.use('/pets/*', portalSessionAuth())
portalRoutes.use('/appointments', portalSessionAuth())
portalRoutes.use('/appointments/*', portalSessionAuth())
portalRoutes.use('/encounters', portalSessionAuth())
portalRoutes.use('/reports', portalSessionAuth())
portalRoutes.use('/membership', portalSessionAuth())
portalRoutes.use('/benefits', portalSessionAuth())
portalRoutes.use('/notification-subscriptions', portalSessionAuth())

// ===== GET /portal/me =====
portalRoutes.get('/me', async (c) => {
  const session = requirePortalSession(c)
  const service = createServiceClient()

  const { data: identity } = await service
    .from('customer_identities')
    .select('id, tenant_id, customer_id, provider, subject, status, verified_at, metadata, created_at')
    .eq('id', session.sub)
    .eq('tenant_id', session.tenantId)
    .maybeSingle()
  if (!identity) {
    throw err.unauthorized('身份不存在')
  }

  let customer: unknown = null
  if (identity.customer_id) {
    const { data: customerRow } = await service
      .from('customers')
      .select('id, customer_no, name, gender, phone, email, status')
      .eq('id', identity.customer_id)
      .maybeSingle()
    customer = customerRow ?? null
  }

  // 当前生效的 consent(每个 type 的最新一条未撤销)
  const { data: consents } = await service
    .from('customer_consents')
    .select('*')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', identity.customer_id)
    .order('accepted_at', { ascending: false })
  const currentConsents = (consents ?? []).reduce<Record<string, unknown>>((acc, row) => {
    if (acc[row.consent_type] === undefined && !row.revoked_at) {
      acc[row.consent_type] = { version: row.version, acceptedAt: row.accepted_at, source: row.source }
    }
    return acc
  }, {})

  const { data: subscriptions } = await service
    .from('notification_subscriptions')
    .select('id, channel, scene, enabled, destination')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', identity.customer_id)

  return ok(c, { identity, customer, consents: currentConsents, subscriptions: subscriptions ?? [] })
})

// ===== GET /portal/pets(可见宠物列表) =====
portalRoutes.get('/pets', async (c) => {
  const session = requirePortalSession(c)
  if (!session.customerId) {
    throw err.unprocessable('身份尚未绑定客户档案')
  }
  const service = createServiceClient()

  // owner 宠物
  const { data: owned } = await service
    .from('pets')
    .select('id, name, species, breed, gender, birth_date, weight, risk_tags, status')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
    .eq('status', 'active')

  // 显式授权宠物
  const { data: granted } = await service
    .from('customer_pet_access')
    .select('pet_id, access_type, permissions, expires_at')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
    .eq('status', 'active')
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)

  const grantedPetIds = (granted ?? []).map(g => g.pet_id)
  const grantedPets: unknown[] = []
  if (grantedPetIds.length > 0) {
    const { data: pets } = await service
      .from('pets')
      .select('id, name, species, breed, gender, birth_date, weight, risk_tags, status')
      .in('id', grantedPetIds)
      .eq('tenant_id', session.tenantId)
      .eq('status', 'active')
    const accessByPet = new Map((granted ?? []).map(g => [g.pet_id, g]))
    for (const pet of (pets ?? [])) {
      if (pet.customer_id === session.customerId) {
        continue // owner 集合已含,避免重复
      }
      grantedPets.push({ ...pet, access_type: accessByPet.get(pet.id)?.access_type ?? 'family' })
    }
  }

  return ok(c, {
    owned: owned ?? [],
    granted: grantedPets,
  })
})

// ===== GET /portal/pets/:id =====
portalRoutes.get('/pets/:id', async (c) => {
  const session = requirePortalSession(c)
  if (!session.customerId) {
    throw err.unprocessable('身份尚未绑定客户档案')
  }
  const petId = c.req.param('id')
  const service = createServiceClient()
  await assertPortalPetAccess(service, session.tenantId, session.customerId, petId)

  const { data: pet } = await service
    .from('pets')
    .select('*')
    .eq('id', petId)
    .eq('tenant_id', session.tenantId)
    .maybeSingle()
  if (!pet) {
    throw err.notFound('宠物不存在')
  }

  const { data: weights } = await service
    .from('pet_weights')
    .select('id, weight, recorded_at, note')
    .eq('pet_id', petId)
    .order('recorded_at', { ascending: false })
    .limit(10)

  return ok(c, { pet, weights: weights ?? [] })
})

// ===== GET /portal/appointments =====
portalRoutes.get('/appointments', async (c) => {
  const session = requirePortalSession(c)
  if (!session.customerId) {
    throw err.unprocessable('身份尚未绑定客户档案')
  }
  const service = createServiceClient()
  const { data, error } = await service
    .from('appointments')
    .select('*')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
    .order('scheduled_start', { ascending: false })
    .limit(50)
  if (error) {
    throw err.internal(`查询预约失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

// ===== POST /portal/appointments(C 端预约,走 Domain RPC) =====
const createAppointmentSchema = z.object({
  petId: z.string().uuid('宠物 id 格式错误'),
  storeId: z.string().uuid().optional(),
  scheduledStart: z.string().datetime({ message: '预约开始时间格式错误' }),
  scheduledEnd: z.string().datetime({ message: '预约结束时间格式错误' }).optional(),
  reason: z.string().trim().max(500).optional(),
})

portalRoutes.post('/appointments', async (c) => {
  const session = requirePortalSession(c)
  if (!session.customerId) {
    throw err.unprocessable('身份尚未绑定客户档案')
  }
  const input = await parseJsonBody(c, createAppointmentSchema)
  const service = createServiceClient()
  const idempotencyKey = getRequestIdempotencyKey(c) ?? crypto.randomUUID()

  const { data, error: rpcErr } = await service.rpc('create_portal_appointment', {
    p_identity_id: session.sub,
    p_pet_id: input.petId,
    p_store_id: input.storeId ?? null,
    p_scheduled_start: input.scheduledStart,
    p_scheduled_end: input.scheduledEnd ?? null,
    p_reason: input.reason ?? null,
    p_idempotency_key: idempotencyKey,
  })
  if (rpcErr) {
    rpcBusinessError(rpcErr)
  }

  await writePortalAudit(c, {
    action: 'portal.appointment.create',
    entityType: 'appointment',
    entityId: data.appointment?.id ?? null,
    tenantId: session.tenantId,
    metadata: { petId: input.petId, idempotent: data.idempotent, idempotencyKey },
  })

  return ok(c, { appointment: data.appointment, idempotent: data.idempotent })
})

// ===== GET /portal/encounters(就诊记录,只读) =====
portalRoutes.get('/encounters', async (c) => {
  const session = requirePortalSession(c)
  if (!session.customerId) {
    throw err.unprocessable('身份尚未绑定客户档案')
  }
  const service = createServiceClient()
  const { data, error } = await service
    .from('encounters')
    .select('id, pet_id, doctor_id, started_at, ended_at, status, chief_complaint')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
    .order('started_at', { ascending: false })
    .limit(50)
  if (error) {
    throw err.internal(`查询就诊记录失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

// ===== GET /portal/reports(客户可见归档,仅 published + customer_visible) =====
portalRoutes.get('/reports', async (c) => {
  const session = requirePortalSession(c)
  if (!session.customerId) {
    throw err.unprocessable('身份尚未绑定客户档案')
  }
  const service = createServiceClient()

  // 收集客户业务实体 id(encounters / prescriptions / invoices),uuid 全局唯一可直接并集
  const entityIds = new Set<string>()
  const { data: encounters } = await service
    .from('encounters')
    .select('id')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
  ;(encounters ?? []).forEach(r => entityIds.add(r.id))
  const { data: prescriptions } = await service
    .from('prescriptions')
    .select('id')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
  ;(prescriptions ?? []).forEach(r => entityIds.add(r.id))
  const { data: invoices } = await service
    .from('invoices')
    .select('id')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
  ;(invoices ?? []).forEach(r => entityIds.add(r.id))

  let archives: unknown[] = []
  if (entityIds.size > 0) {
    const { data, error } = await service
      .from('document_archives')
      .select('id, document_type, entity_type, entity_id, mime_type, size_bytes, status, created_at')
      .eq('tenant_id', session.tenantId)
      .eq('customer_visible', true)
      .eq('published', true)
      .eq('status', 'active')
      .in('entity_id', [...entityIds])
      .order('created_at', { ascending: false })
    if (error) {
      throw err.internal(`查询报告失败: ${error.message}`)
    }
    archives = data ?? []
  }
  return ok(c, { list: archives })
})

// ===== GET /portal/membership(客户自己的会员信息) =====
portalRoutes.get('/membership', async (c) => {
  const session = requirePortalSession(c)
  if (!session.customerId) {
    throw err.unprocessable('身份尚未绑定客户档案')
  }
  const service = createServiceClient()
  const { data: membership } = await service
    .from('customer_memberships')
    .select('id, tier_id, points_balance, joined_at, expires_at')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
    .maybeSingle()

  let tier: unknown = null
  if (membership?.tier_id) {
    const { data: tierRow } = await service
      .from('membership_tiers')
      .select('id, code, name, discount_percent, points_multiplier')
      .eq('id', membership.tier_id)
      .eq('tenant_id', session.tenantId)
      .maybeSingle()
    tier = tierRow ?? null
  }

  const { data: points } = await service
    .from('point_transactions')
    .select('id, delta, reason, balance_after, created_at')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
    .order('created_at', { ascending: false })
    .limit(20)

  return ok(c, { membership, tier, points: points ?? [] })
})

// ===== GET /portal/benefits(权益概览:会员权益 + 积分余额) =====
portalRoutes.get('/benefits', async (c) => {
  const session = requirePortalSession(c)
  if (!session.customerId) {
    throw err.unprocessable('身份尚未绑定客户档案')
  }
  const service = createServiceClient()
  const { data: membership } = await service
    .from('customer_memberships')
    .select('id, tier_id, points_balance, expires_at')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
    .maybeSingle()

  let tier: unknown = null
  if (membership?.tier_id) {
    const { data: tierRow } = await service
      .from('membership_tiers')
      .select('id, code, name, discount_percent, points_multiplier, sort_order')
      .eq('id', membership.tier_id)
      .eq('tenant_id', session.tenantId)
      .maybeSingle()
    tier = tierRow ?? null
  }

  return ok(c, {
    tier,
    pointsBalance: membership?.points_balance ?? 0,
    membershipExpiresAt: membership?.expires_at ?? null,
  })
})

// ===== GET /portal/notification-subscriptions =====
portalRoutes.get('/notification-subscriptions', async (c) => {
  const session = requirePortalSession(c)
  if (!session.customerId) {
    throw err.unprocessable('身份尚未绑定客户档案')
  }
  const service = createServiceClient()
  const { data, error } = await service
    .from('notification_subscriptions')
    .select('id, channel, scene, enabled, destination, updated_at')
    .eq('tenant_id', session.tenantId)
    .eq('customer_id', session.customerId)
    .order('channel', { ascending: true })
    .order('scene', { ascending: true })
  if (error) {
    throw err.internal(`查询订阅失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

// ===== PUT /portal/notification-subscriptions(批量 upsert) =====
const subscriptionItemSchema = z.object({
  channel: z.enum(['sms', 'email', 'wechat']),
  scene: z.enum(['appointment', 'vaccine', 'deworming', 'report_published', 'followup', 'marketing', 'billing']),
  enabled: z.boolean().default(true),
  destination: z.string().trim().max(128).optional(),
})
const updateSubscriptionsSchema = z.object({
  items: z.array(subscriptionItemSchema).min(1).max(50),
})

portalRoutes.put('/notification-subscriptions', async (c) => {
  const session = requirePortalSession(c)
  if (!session.customerId) {
    throw err.unprocessable('身份尚未绑定客户档案')
  }
  const input = await parseJsonBody(c, updateSubscriptionsSchema)
  const service = createServiceClient()

  const upserted: unknown[] = []
  for (const item of input.items) {
    const { data, error } = await service
      .from('notification_subscriptions')
      .upsert({
        tenant_id: session.tenantId,
        customer_id: session.customerId,
        channel: item.channel,
        scene: item.scene,
        enabled: item.enabled,
        destination: item.destination ?? null,
      }, { onConflict: 'tenant_id,customer_id,channel,scene' })
      .select('id, channel, scene, enabled, destination')
      .single()
    if (error) {
      throw err.internal(`保存订阅失败: ${error.message}`)
    }
    upserted.push(data)
  }

  await writePortalAudit(c, {
    action: 'portal.subscription.update',
    entityType: 'customer',
    entityId: session.customerId,
    tenantId: session.tenantId,
    metadata: { items: input.items },
  })

  return ok(c, { list: upserted })
})

// ============================================================
// Portal Admin(员工 IAM:authMiddleware + portal.* 权限码)
// ============================================================
portalRoutes.use('/admin/*', authMiddleware(), loadCaller())

const adminIdentitySchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
  provider: z.enum(['phone', 'email', 'wechat']),
  subject: z.string().trim().min(1).max(128),
})

// ===== GET /portal/admin/identities =====
portalRoutes.get('/admin/identities', async (c) => {
  const input = z.object({ tenantId: z.string().uuid() }).safeParse(c.req.query())
  if (!input.success) {
    throw err.badRequest('租户 id 格式错误')
  }
  await requireScopedPermission(c, { code: 'portal.identity.view', tenantId: input.data.tenantId, dataScope: true })
  const service = createServiceClient()
  const { data, error, count } = await service
    .from('customer_identities')
    .select('*, customers(name, customer_no)', { count: 'exact' })
    .eq('tenant_id', input.data.tenantId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) {
    throw err.internal(`查询身份列表失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ===== POST /portal/admin/identities(手动绑定已核实身份) =====
portalRoutes.post('/admin/identities', async (c) => {
  const input = await parseJsonBody(c, adminIdentitySchema)
  await requireScopedPermission(c, { code: 'portal.identity.manage', tenantId: input.tenantId })
  const service = createServiceClient()

  // 客户必须属于该租户
  const { data: customer } = await service
    .from('customers')
    .select('id, status')
    .eq('id', input.customerId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (!customer) {
    throw err.notFound('客户不存在')
  }
  if (customer.status !== 'active') {
    throw err.unprocessable('客户已归档,无法绑定身份')
  }

  const subject = input.subject.trim().toLowerCase()
  const { data, error } = await service
    .from('customer_identities')
    .insert({
      tenant_id: input.tenantId,
      customer_id: input.customerId,
      provider: input.provider,
      subject,
      status: 'active',
      verified_at: new Date().toISOString(),
      metadata: { source: 'staff_manual' },
    })
    .select('*')
    .single()
  if (error) {
    if (error.message.includes('duplicate key') || error.message.includes('idx_customer_identities_tenant_subject')) {
      throw err.conflict('该身份已绑定其他客户')
    }
    throw err.internal(`绑定身份失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'portal.identity.bind',
    entityType: 'customer_identity',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { customerId: input.customerId, provider: input.provider, subject },
  })
  return ok(c, data)
})

// ===== POST /portal/admin/identities/:id/revoke =====
const revokeIdentitySchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  reason: z.string().trim().max(200).optional(),
})

portalRoutes.post('/admin/identities/:id/revoke', async (c) => {
  const identityId = c.req.param('id')
  const input = await parseJsonBody(c, revokeIdentitySchema)
  await requireScopedPermission(c, { code: 'portal.identity.manage', tenantId: input.tenantId })
  const service = createServiceClient()

  const { data: existing } = await service
    .from('customer_identities')
    .select('id, status')
    .eq('id', identityId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (!existing) {
    throw err.notFound('身份不存在')
  }
  if (existing.status === 'revoked') {
    throw err.conflict('该身份已停用')
  }

  const user = c.get('user')
  const { data, error } = await service
    .from('customer_identities')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: user.id,
      revoked_reason: input.reason ?? null,
    })
    .eq('id', identityId)
    .select('*')
    .single()
  if (error) {
    throw err.internal(`停用身份失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'portal.identity.revoke',
    entityType: 'customer_identity',
    entityId: identityId,
    tenantId: input.tenantId,
    metadata: { reason: input.reason ?? null },
  })
  return ok(c, data)
})

// ===== GET /portal/admin/pet-access =====
portalRoutes.get('/admin/pet-access', async (c) => {
  const input = z.object({
    tenantId: z.string().uuid(),
    customerId: z.string().uuid().optional(),
    petId: z.string().uuid().optional(),
  }).safeParse(c.req.query())
  if (!input.success) {
    throw err.badRequest('参数格式错误')
  }
  await requireScopedPermission(c, { code: 'portal.pet.access.view', tenantId: input.data.tenantId, dataScope: true })
  const service = createServiceClient()

  let query = service
    .from('customer_pet_access')
    .select('*, pets(name, species), customers(name, customer_no)', { count: 'exact' })
    .eq('tenant_id', input.data.tenantId)
  if (input.data.customerId) query = query.eq('customer_id', input.data.customerId)
  if (input.data.petId) query = query.eq('pet_id', input.data.petId)

  const { data, error, count } = await query.order('created_at', { ascending: false }).limit(100)
  if (error) {
    throw err.internal(`查询宠物访问授权失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ===== POST /portal/admin/pet-access(授权/更新,upsert 按 pet+customer) =====
const petAccessSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  petId: z.string().uuid('宠物 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
  accessType: z.enum(['owner', 'family', 'caregiver']).default('family'),
  permissions: z.array(z.enum(['view', 'appointment', 'report'])).min(1).default(['view']),
  expiresAt: z.string().datetime().optional(),
})

portalRoutes.post('/admin/pet-access', async (c) => {
  const input = await parseJsonBody(c, petAccessSchema)
  await requireScopedPermission(c, { code: 'portal.pet.access.manage', tenantId: input.tenantId })
  const service = createServiceClient()

  // 校验宠物与客户同租户
  const { data: pet } = await service
    .from('pets')
    .select('id, customer_id')
    .eq('id', input.petId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (!pet) {
    throw err.notFound('宠物不存在')
  }
  const { data: customer } = await service
    .from('customers')
    .select('id')
    .eq('id', input.customerId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (!customer) {
    throw err.notFound('客户不存在')
  }

  const user = c.get('user')
  const { data, error } = await service
    .from('customer_pet_access')
    .upsert({
      tenant_id: input.tenantId,
      pet_id: input.petId,
      customer_id: input.customerId,
      access_type: input.accessType,
      permissions: input.permissions,
      status: 'active',
      granted_by: user.id,
      expires_at: input.expiresAt ?? null,
      revoked_at: null,
      revoked_by: null,
    }, { onConflict: 'tenant_id,pet_id,customer_id' })
    .select('*')
    .single()
  if (error) {
    throw err.internal(`保存宠物访问授权失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'portal.pet.access.grant',
    entityType: 'customer_pet_access',
    entityId: data.id,
    tenantId: input.tenantId,
    metadata: { petId: input.petId, customerId: input.customerId, accessType: input.accessType },
  })
  return ok(c, data)
})

// ===== POST /portal/admin/pet-access/:id/revoke =====
const revokePetAccessSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
})

portalRoutes.post('/admin/pet-access/:id/revoke', async (c) => {
  const accessId = c.req.param('id')
  const input = await parseJsonBody(c, revokePetAccessSchema)
  await requireScopedPermission(c, { code: 'portal.pet.access.manage', tenantId: input.tenantId })
  const service = createServiceClient()

  const { data: existing } = await service
    .from('customer_pet_access')
    .select('id, status')
    .eq('id', accessId)
    .eq('tenant_id', input.tenantId)
    .maybeSingle()
  if (!existing) {
    throw err.notFound('授权记录不存在')
  }

  const user = c.get('user')
  const { data, error } = await service
    .from('customer_pet_access')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: user.id,
    })
    .eq('id', accessId)
    .select('*')
    .single()
  if (error) {
    throw err.internal(`撤销授权失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'portal.pet.access.revoke',
    entityType: 'customer_pet_access',
    entityId: accessId,
    tenantId: input.tenantId,
  })
  return ok(c, data)
})

// ===== GET /portal/admin/consents =====
portalRoutes.get('/admin/consents', async (c) => {
  const input = z.object({
    tenantId: z.string().uuid(),
    customerId: z.string().uuid().optional(),
    consentType: z.string().optional(),
  }).safeParse(c.req.query())
  if (!input.success) {
    throw err.badRequest('参数格式错误')
  }
  await requireScopedPermission(c, { code: 'portal.consent.view', tenantId: input.data.tenantId, dataScope: true })
  const service = createServiceClient()

  let query = service
    .from('customer_consents')
    .select('*, customers(name, customer_no)', { count: 'exact' })
    .eq('tenant_id', input.data.tenantId)
  if (input.data.customerId) query = query.eq('customer_id', input.data.customerId)
  if (input.data.consentType) query = query.eq('consent_type', input.data.consentType)

  const { data, error, count } = await query.order('accepted_at', { ascending: false }).limit(100)
  if (error) {
    throw err.internal(`查询授权记录失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ===== GET /portal/admin/subscriptions =====
portalRoutes.get('/admin/subscriptions', async (c) => {
  const input = z.object({
    tenantId: z.string().uuid(),
    customerId: z.string().uuid().optional(),
  }).safeParse(c.req.query())
  if (!input.success) {
    throw err.badRequest('参数格式错误')
  }
  await requireScopedPermission(c, { code: 'portal.subscription.view', tenantId: input.data.tenantId, dataScope: true })
  const service = createServiceClient()

  let query = service
    .from('notification_subscriptions')
    .select('*, customers(name, customer_no)', { count: 'exact' })
    .eq('tenant_id', input.data.tenantId)
  if (input.data.customerId) query = query.eq('customer_id', input.data.customerId)

  const { data, error, count } = await query.order('updated_at', { ascending: false }).limit(100)
  if (error) {
    throw err.internal(`查询通知订阅失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ===== GET /portal/admin/provider-status(多渠道 Provider 配置状态,不含 Secret) =====
portalRoutes.get('/admin/provider-status', async (c) => {
  // 任意已登录成员可查看通道状态摘要;敏感配置不入库下发
  if (!c.get('user')) {
    throw err.unauthorized()
  }
  const summary = getProviderChannelStatus()
  return ok(c, summary)
})

// ===== GET /portal/admin/webhook-events =====
portalRoutes.get('/admin/webhook-events', async (c) => {
  const input = z.object({
    tenantId: z.string().uuid(),
    status: z.string().optional(),
    provider: z.string().optional(),
  }).safeParse(c.req.query())
  if (!input.success) {
    throw err.badRequest('参数格式错误')
  }
  await requireScopedPermission(c, { code: 'portal.webhook.view', tenantId: input.data.tenantId, dataScope: true })
  const service = createServiceClient()

  let query = service
    .from('message_provider_events')
    .select('*', { count: 'exact' })
    .eq('tenant_id', input.data.tenantId)
  if (input.data.status) query = query.eq('status', input.data.status)
  if (input.data.provider) query = query.eq('provider', input.data.provider)

  const { data, error, count } = await query.order('received_at', { ascending: false }).limit(100)
  if (error) {
    throw err.internal(`查询回调事件失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

export default portalRoutes
