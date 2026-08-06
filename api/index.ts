import type { AppEnv } from './lib/types'
import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import fileRoutes from './routes/files'
import uploadRoutes from './routes/upload'
import userRoutes from './routes/user'

export const runtime = 'nodejs'

export const app = new Hono<AppEnv>().basePath('/api')

app.get('/health', c => c.json({ status: 1, error: '', data: { ok: true } }))

// 仅保留无法浏览器直连的服务端操作
app.route('/upload', uploadRoutes)
app.route('/files', fileRoutes)
app.route('/user', userRoutes)

export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const PATCH = handle(app)
export const DELETE = handle(app)
export const OPTIONS = handle(app)
