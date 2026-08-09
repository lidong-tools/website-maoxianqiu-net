import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { app } from '../api/index.js'

// 加载本地密钥 api/.env.local(未配置时跳过,仅测试无需密钥的端点)
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../api/.env.local')
try {
  const content = readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
  }
}
catch {
  // 无 .env.local,忽略
}

async function main() {
  // 健康检查
  const health = await app.request('/api/health')
  console.log(`[health] HTTP ${health.status}`, await health.json())

  // 无 token 访问受保护接口 → 应返回 { status: 0 }
  const create = await app.request('/api/user/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  console.log(`[user/create 无 token] HTTP ${create.status}`, await create.json())

  const reset = await app.request('/api/user/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  console.log(`[user/reset-password 无 token] HTTP ${reset.status}`, await reset.json())

  const upload = await app.request('/api/upload', { method: 'POST' })
  console.log(`[upload 无 token] HTTP ${upload.status}`, await upload.json())

  const del = await app.request('/api/files/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  console.log(`[files/delete 无 token] HTTP ${del.status}`, await del.json())

  // MXQ-4003~4006:文件 Command 路由无 token 应返回 401
  const intent = await app.request('/api/files/upload-intents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  console.log(`[files/upload-intents 无 token] HTTP ${intent.status}`, await intent.json())

  const complete = await app.request('/api/files/00000000-0000-0000-0000-000000000000/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  console.log(`[files/:id/complete 无 token] HTTP ${complete.status}`, await complete.json())

  const download = await app.request('/api/files/00000000-0000-0000-0000-000000000000/download-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  console.log(`[files/:id/download-url 无 token] HTTP ${download.status}`, await download.json())

  const archive = await app.request('/api/files/00000000-0000-0000-0000-000000000000/archive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  console.log(`[files/:id/archive 无 token] HTTP ${archive.status}`, await archive.json())
}

main().catch((error) => {
  console.error('[smoke] 失败:', error)
  process.exit(1)
})
