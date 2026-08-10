import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { err } from './errors.js'

/**
 * C 端 Portal 会话 token(Agent-08)
 *
 * 与员工 IAM(auth.users + JWT)完全分离:Portal 身份基于 customer_identities,
 * 会话 token 由服务端 HMAC-SHA256 自签发(JWT-like,避免引入额外依赖)。
 *
 * 结构:base64url(payload) + '.' + hex(hmac)
 * payload:{ sub: identityId, tenantId, customerId, exp, iat }
 *
 * 安全:
 *   - secret 仅服务端环境变量 PORTAL_SESSION_SECRET;生产未配置时拒绝签发
 *   - 开发环境未配置时使用固定 fallback(仅开发,不允许生产)
 *   - 验签使用 timingSafeEqual 防时序攻击
 */

const SECRET_ENV = 'PORTAL_SESSION_SECRET'
const TOKEN_TTL_MS = 30 * 60 * 1000
const DEV_FALLBACK = 'maoxianqiu-portal-dev-secret-not-for-production'

export interface PortalSessionPayload {
  /** customer_identities.id */
  sub: string
  tenantId: string
  customerId: string | null
  exp: number
  iat: number
}

function isProductionEnv(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
}

/** 读取会话签名密钥(生产未配置直接抛错,禁止弱密钥上线) */
export function getPortalSessionSecret(): string {
  const secret = process.env[SECRET_ENV]?.trim()
  if (!secret) {
    if (isProductionEnv()) {
      throw err.internal('PORTAL_SESSION_SECRET 未配置,Portal 会话不可用')
    }
    return DEV_FALLBACK
  }
  return secret
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64url')
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf-8')
}

/** 签发 Portal 会话 token */
export function signPortalSession(input: {
  identityId: string
  tenantId: string
  customerId: string | null
}): string {
  const secret = getPortalSessionSecret()
  const iat = Date.now()
  const payload: PortalSessionPayload = {
    sub: input.identityId,
    tenantId: input.tenantId,
    customerId: input.customerId,
    exp: iat + TOKEN_TTL_MS,
    iat,
  }
  const encoded = base64UrlEncode(JSON.stringify(payload))
  const signature = createHmac('sha256', secret).update(encoded).digest('hex')
  return `${encoded}.${signature}`
}

/** 校验并解析 Portal 会话 token(过期/篡改均拒绝) */
export function verifyPortalSession(token: string): PortalSessionPayload {
  const secret = getPortalSessionSecret()
  const dot = token.lastIndexOf('.')
  if (dot <= 0) {
    throw err.unauthorized('Portal 会话无效')
  }
  const encoded = token.slice(0, dot)
  const signature = token.slice(dot + 1)

  // 验签(timingSafeEqual 防时序)
  const expected = createHmac('sha256', secret).update(encoded).digest()
  let given: Buffer
  try {
    given = Buffer.from(signature, 'hex')
  }
  catch {
    throw err.unauthorized('Portal 会话无效')
  }
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw err.unauthorized('Portal 会话无效')
  }

  let payload: PortalSessionPayload
  try {
    payload = JSON.parse(base64UrlDecode(encoded)) as PortalSessionPayload
  }
  catch {
    throw err.unauthorized('Portal 会话无效')
  }
  if (!payload.sub || !payload.tenantId || typeof payload.exp !== 'number') {
    throw err.unauthorized('Portal 会话无效')
  }
  if (payload.exp < Date.now()) {
    throw err.unauthorized('Portal 会话已过期')
  }
  return payload
}

/** 生成随机盐(Node 侧,供 OTP 挑战 hash) */
export function randomSalt(): string {
  return randomBytes(16).toString('hex')
}

/**
 * 计算 OTP code 哈希 sha256(salt || code)。
 * 与 portal_verify_otp RPC 内 digest(v_challenge.code_salt || p_code, 'sha256') 完全一致,
 * 否则验证码永远无法比对通过。
 */
export function hashOtpCode(code: string, salt: string): string {
  return createHash('sha256').update(salt + code).digest('hex')
}

/** 生成 6 位数字验证码(密码学随机) */
export function generateOtpCode(): string {
  // 100000 ~ 999999,避免前导零歧义
  const n = randomBytes(4).readUInt32BE(0) % 900000 + 100000
  return String(n)
}

/** 掩码手机号:138****1234 */
export function maskPhone(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, '')
  if (cleaned.length < 7) {
    return '****'
  }
  return `${cleaned.slice(0, 3)}****${cleaned.slice(-4)}`
}

/** 掩码邮箱:a***@example.com */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 1) {
    return `***${email.slice(at)}`
  }
  return `${email[0]}***${email.slice(at)}`
}
