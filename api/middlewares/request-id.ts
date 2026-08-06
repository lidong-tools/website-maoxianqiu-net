import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../lib/types'
import { randomUUID } from 'node:crypto'

const HEADER = 'x-request-id'
const SAFE_RE = /^[\w-]{1,64}$/

/**
 * 请求 ID 中间件(MXQ-2002)
 * 读取入站 x-request-id(仅安全字符),否则生成 req_<hex>;响应头回写同一 ID。
 */
export function requestIdMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header(HEADER)
    const requestId = incoming && SAFE_RE.test(incoming)
      ? incoming
      : `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    c.set('requestId', requestId)
    c.header(HEADER, requestId)
    await next()
  }
}
