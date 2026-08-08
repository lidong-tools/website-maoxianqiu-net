import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { resolveMeContext } from '../lib/me-context'
import { ok } from '../lib/result'
import { authMiddleware } from '../middlewares/auth'

const meRoutes = new Hono<AppEnv>()

// 仅需鉴权;上下文/权限由 resolveMeContext 自行聚合(不依赖 x-tenant-id / x-store-id 请求头)
meRoutes.use('*', authMiddleware())

/** 当前用户工作上下文(P0-01..P0-05 唯一事实来源) */
meRoutes.get('/context', async (c) => {
  const ctx = await resolveMeContext(c)
  return ok(c, ctx)
})

export default meRoutes
