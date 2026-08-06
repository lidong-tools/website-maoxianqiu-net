import type { AppEnv } from './lib/types'
import process from 'node:process'
import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { fail, failError, ok } from './lib/result'
import { requestIdMiddleware } from './middlewares/request-id'
import fileRoutes from './routes/files'
import uploadRoutes from './routes/upload'
import userRoutes from './routes/user'

export const runtime = 'nodejs'

export const app = new Hono<AppEnv>().basePath('/api')

// API Foundation 全局中间件
app.use('*', requestIdMiddleware())

app.get('/health', (c) => {
  return ok(c, { ok: true, uptime: process.uptime() })
})

// 仅保留无法浏览器直连的服务端操作
app.route('/upload', uploadRoutes)
app.route('/files', fileRoutes)
app.route('/user', userRoutes)

// 统一错误处理(MXQ-2001):业务错误带明确 HTTP 状态与错误码
app.notFound((c) => {
  return fail(c, 404, { code: 'NOT_FOUND', message: '接口不存在' })
})
app.onError((e, c) => {
  return failError(c, e)
})

export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const PATCH = handle(app)
export const DELETE = handle(app)
export const OPTIONS = handle(app)
