/**
 * 发布前环境变量预检(Agent-02 / Stage-04)
 *
 * 只检查"是否已配置",绝不打印/导出任何值(防止 Secret 落盘与日志泄漏)。
 * 清单来源:当前 main 源码实际读取的 process.env
 *   - api/lib/supabase.ts: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY
 *   - api/lib/r2.ts: R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_PUBLIC_URL / R2_KEY_ENV
 *   - api/services/messaging/config.ts: MESSAGING_PROVIDER / MESSAGING_API_KEY / MESSAGING_SENDER / MESSAGING_API_URL
 *   - api/index.ts: VERCEL_ENV / VERCEL_GIT_COMMIT_SHA / NODE_ENV
 *
 * 用法:
 *   pnpm exec tsx scripts/release-preflight.ts               # 宽松:缺失仅警告
 *   pnpm exec tsx scripts/release-preflight.ts --strict      # 生产:required 缺失即 exit 1
 *   pnpm exec tsx scripts/release-preflight.ts --env-file api/.env.local   # 加载本地 env
 *   pnpm exec tsx scripts/release-preflight.ts --require EXTRA_KEY          # 追加必填项
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'

interface EnvRule {
  key: string
  required: boolean
  category: string
  note: string
}

// Stage04 各业务 Agent 尚未声明的 Provider 类占位(Agent-03~08 Handoff 确认后应提升为 required)
const STAGE04_PENDING = [
  { key: 'PDF_RENDERER_*', note: 'Agent-06 PDF 渲染(待 Handoff 声明具体变量)' },
  { key: 'SIGNATURE_PROVIDER_*', note: 'Agent-06 电子签名(待 Handoff 声明)' },
  { key: 'SMS_*', note: 'Agent-08 短信渠道(待 Handoff 声明)' },
  { key: 'WECHAT_*', note: 'Agent-08 微信渠道(待 Handoff 声明)' },
]

const API_CORE: EnvRule[] = [
  { key: 'SUPABASE_URL', required: true, category: 'API Core', note: 'api/lib/supabase.ts createClient' },
  { key: 'SUPABASE_ANON_KEY', required: true, category: 'API Core', note: 'api/lib/supabase.ts createUserClient' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', required: true, category: 'API Core', note: '服务端 service role,禁止 VITE_* 暴露' },
]

const R2: EnvRule[] = [
  { key: 'R2_ACCOUNT_ID', required: true, category: 'R2', note: 'api/lib/r2.ts createR2Client' },
  { key: 'R2_ACCESS_KEY_ID', required: true, category: 'R2', note: 'api/lib/r2.ts' },
  { key: 'R2_SECRET_ACCESS_KEY', required: true, category: 'R2', note: 'api/lib/r2.ts,禁止 VITE_* 暴露' },
  { key: 'R2_BUCKET_NAME', required: true, category: 'R2', note: 'api/lib/r2.ts 上传/下载/归档' },
  { key: 'R2_PUBLIC_URL', required: false, category: 'R2', note: '可选:R2 公开访问前缀' },
  { key: 'R2_KEY_ENV', required: false, category: 'R2', note: '可选:object key 环境段,默认 prod' },
]

const MESSAGING: EnvRule[] = [
  { key: 'MESSAGING_PROVIDER', required: false, category: 'Messaging', note: 'email | mock,未配置时回退 mock' },
  { key: 'MESSAGING_API_KEY', required: false, category: 'Messaging', note: 'Email Provider API Key,仅服务端' },
  { key: 'MESSAGING_SENDER', required: false, category: 'Messaging', note: 'Email 发件人' },
  { key: 'MESSAGING_API_URL', required: false, category: 'Messaging', note: '默认 SendGrid v3' },
]

const DEPLOY: EnvRule[] = [
  { key: 'VERCEL_ENV', required: false, category: 'Deploy', note: 'Vercel 自动注入:preview/production' },
  { key: 'VERCEL_GIT_COMMIT_SHA', required: false, category: 'Deploy', note: 'Vercel 自动注入,用于 /api/health commitSha' },
  { key: 'NODE_ENV', required: false, category: 'Deploy', note: '本地运行时兜底环境标识' },
]

// ---- 参数解析 ----
const args = process.argv.slice(2)
const strict = args.includes('--strict')
const envFile = (() => {
  const idx = args.indexOf('--env-file')
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined
})()
const extraRequired = args
  .filter((a, i) => args[i - 1] === '--require')
  .filter(Boolean)

/** 从 .env 风格文件加载到 process.env(仅当当前未设置时) */
function loadEnvFile(file: string) {
  try {
    const content = readFileSync(file, 'utf-8')
    for (const line of content.split('\n')) {
      const t = line.trimStart()
      if (!t || t.startsWith('#')) {
        continue
      }
      const eq = t.indexOf('=')
      if (eq <= 0) {
        continue
      }
      const key = t.slice(0, eq).trim()
      const value = t.slice(eq + 1).trim()
      if (process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  }
  catch {
    // 文件不存在时忽略;strict 模式下后续 required 检查会兜底
  }
}

/** 汇总环境规则清单(含 --require 追加项) */
function buildRules(): EnvRule[] {
  const rules = [...API_CORE, ...R2, ...MESSAGING, ...DEPLOY]
  for (const key of extraRequired) {
    rules.push({ key, required: true, category: 'EXTRA', note: '--require 显式追加' })
  }
  return rules
}

// ---- 执行 ----
if (envFile) {
  loadEnvFile(envFile)
}

const rules = buildRules()
const missingRequired: EnvRule[] = []
const missingOptional: EnvRule[] = []

for (const rule of rules) {
  const configured = Boolean(process.env[rule.key])
  if (configured) {
    console.log(`[preflight] OK   [${rule.category}] ${rule.key} 已配置`)
  }
  else if (rule.required) {
    missingRequired.push(rule)
    console.error(`[preflight] MISS [${rule.category}] ${rule.key} 必填缺失(${rule.note})`)
  }
  else {
    missingOptional.push(rule)
    console.warn(`[preflight] WARN [${rule.category}] ${rule.key} 未配置(可选:${rule.note})`)
  }
}

console.log('--- Stage04 待声明 Provider(由 Agent-03~08 Handoff 确认后纳入必填) ---')
for (const p of STAGE04_PENDING) {
  console.warn(`[preflight] PENDING ${p.key}: ${p.note}`)
}

if (missingRequired.length > 0 && strict) {
  console.error(`[preflight] 结果:FAIL(生产 strict 模式下 ${missingRequired.length} 项必填缺失)`)
  process.exit(1)
}
if (missingRequired.length > 0) {
  console.warn(`[preflight] 结果:WARN(${missingRequired.length} 项必填缺失;--strict 将使其失败)`)
}
else {
  console.log('[preflight] 结果:PASS(required 环境变量全部就绪)')
}
