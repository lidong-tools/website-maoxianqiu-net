/**
 * 本地启动 Hono API(生产跑 Vercel,本地 E2E/联调用 node-server 起)
 *
 * 用法: pnpm dev:api   (读取 api/.env.local 的 SUPABASE_URL / SERVICE_ROLE / ANON)
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { app } from '../api/[...route]'

const dir = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.resolve(dir, '../api/.env.local')

// 加载 api/.env.local(与 backend-smoke.ts 一致)
try {
  const content = readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const t = line.trimStart()
    if (!t || t.startsWith('#')) {
      continue
    }
    const eq = t.indexOf('=')
    if (eq > 0) {
      const key = t.slice(0, eq).trim()
      const value = t.slice(eq + 1).trim()
      if (process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  }
}
catch {
  // 无 .env.local 时忽略;缺失 env 时 createServiceClient 会抛错
}

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port })
// eslint-disable-next-line no-console
console.log(`[serve-api] Hono API 已启动: http://localhost:${port}/api/health`)
