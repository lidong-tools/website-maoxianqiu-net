import process from 'node:process'
import { Hono } from 'hono'
import { handle } from 'hono/vercel'

export const runtime = 'nodejs'

const buildTime = new Date().toISOString()
const app = new Hono().basePath('/api')

/**
 * 独立健康检查不加载数据库、存储或业务路由，确保部署探针能准确反映 API 运行时状态。
 */
app.get('/health', (c) => {
  return c.json({
    ok: true,
    data: {
      ok: true,
      uptime: process.uptime(),
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA || 'unknown',
      buildTime,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    },
    requestId: c.req.header('x-request-id') || '',
  })
})

export const GET = handle(app)
