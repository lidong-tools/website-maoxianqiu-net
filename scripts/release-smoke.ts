/**
 * Preview / 生产发布冒烟(Agent-02 / Stage-04)
 *
 * 验证 Vercel 函数在真实 HTTP 层的启动与错误映射:
 *   1) GET  /api/health             → 200(函数启动、依赖自检存活)
 *   2) GET  /api/me/context(无 token)→ 401 UNAUTHORIZED,而不是 500/函数崩溃
 *   3) OPTIONS /api/me/context      → 非 5xx(预检不导致函数失败)
 *   4) GET  /api/me/context(错误 X-Tenant-Id,无 token)→ 4xx(而非函数启动失败)
 *   5) GET  /api/not-exist          → 404 NOT_FOUND(统一错误映射生效)
 *
 * 记录:HTTP status / x-request-id / body 摘要 / deployment URL / commit SHA,
 * 保存到 document/deployment/smoke-results/<timestamp>.json(默认)。
 *
 * 用法:
 *   pnpm exec tsx scripts/release-smoke.ts --base https://xxx.vercel.app
 *   pnpm exec tsx scripts/release-smoke.ts --base https://xxx.vercel.app --out ./smoke.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(__dirname, '..')

// ---- 参数解析 ----
const args = process.argv.slice(2)
const baseArg = (() => {
  const idx = args.indexOf('--base')
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : process.env.VERIFY_BASE_URL
})()
const outArg = (() => {
  const idx = args.indexOf('--out')
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined
})()

const BASE_URL = baseArg ?? 'http://localhost:8787'

interface SmokeCase {
  name: string
  method: string
  path: string
  headers?: Record<string, string>
  expectStatus: number
  /** 断言类型:exact 精确匹配;non5xx 非 5xx;inRange 区间 */
  expect: 'exact' | 'non5xx' | 'gte'
  expectGte?: number
}

const CASES: SmokeCase[] = [
  {
    name: 'health liveness',
    method: 'GET',
    path: '/api/health',
    expectStatus: 200,
    expect: 'exact',
  },
  {
    name: 'protected route 无 token → 401(而非 500)',
    method: 'GET',
    path: '/api/me/context',
    expectStatus: 401,
    expect: 'exact',
  },
  {
    name: 'OPTIONS 预检不导致函数失败',
    method: 'OPTIONS',
    path: '/api/me/context',
    expectStatus: 0,
    expect: 'non5xx',
  },
  {
    name: '错误 tenant + 无 token → 4xx(而非函数启动失败)',
    method: 'GET',
    path: '/api/me/context',
    headers: { 'X-Tenant-Id': '00000000-0000-0000-0000-000000000000' },
    expectStatus: 401,
    expect: 'gte',
    expectGte: 400,
  },
  {
    name: '未知路由 → 404 NOT_FOUND',
    method: 'GET',
    path: '/api/not-exist-route',
    expectStatus: 404,
    expect: 'exact',
  },
]

/** 截断响应体摘要,避免把敏感信息刷进日志 */
function summarizeBody(body: string): string {
  const clean = body.replace(/\s+/g, ' ').trim()
  return clean.length > 200 ? `${clean.slice(0, 200)}…(截断)` : clean
}

async function main() {
  const startedAt = new Date().toISOString()
  const results: Array<Record<string, string | number | boolean>> = []
  let failed = false

  console.log(`[smoke] 目标: ${BASE_URL} (开始 ${startedAt})`)

  for (const c of CASES) {
    try {
      const res = await fetch(`${BASE_URL}${c.path}`, {
        method: c.method,
        headers: {
          ...c.headers,
          // 入站 request id:安全字符集,与 request-id.ts SAFE_RE 对齐
          'x-request-id': `smoke_${Date.now()}`,
        },
      })
      const body = await res.text()
      const requestId = res.headers.get('x-request-id') ?? ''
      let pass: boolean
      if (c.expect === 'exact') {
        pass = res.status === c.expectStatus
      }
      else if (c.expect === 'non5xx') {
        pass = res.status < 500
      }
      else {
        pass = res.status >= (c.expectGte ?? 400) && res.status < 500
      }
      if (!pass) {
        failed = true
      }
      const row = {
        name: c.name,
        method: c.method,
        path: c.path,
        status: res.status,
        pass,
        requestId,
        body: summarizeBody(body),
      }
      results.push(row)
      console.log(`[smoke] ${pass ? 'PASS' : 'FAIL'} ${c.method} ${c.path} → HTTP ${res.status} requestId=${requestId || '-'}`)
    }
    catch (e) {
      failed = true
      const row = {
        name: c.name,
        method: c.method,
        path: c.path,
        status: 'NETWORK_ERROR',
        pass: false,
        requestId: '',
        body: `无法连接:${String(e)}`,
      }
      results.push(row)
      console.error(`[smoke] FAIL ${c.method} ${c.path} → 网络错误:${String(e)}`)
    }
  }

  // 从 health 提取 commit SHA(仅当 health 可用)
  let commitSha = 'unknown'
  try {
    const health = await (await fetch(`${BASE_URL}/api/health`)).json() as {
      data?: { commitSha?: string }
    }
    commitSha = health.data?.commitSha ?? 'unknown'
  }
  catch {
    // health 不可达时保留 unknown
  }

  const report = {
    deploymentUrl: BASE_URL,
    commitSha,
    startedAt,
    finishedAt: new Date().toISOString(),
    total: results.length,
    failed: results.filter(r => r.pass === false).length,
    cases: results,
  }

  if (outArg) {
    writeFileSync(outArg, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    console.log(`[smoke] 结果已保存: ${outArg}`)
  }
  else {
    const dir = join(repoRoot, 'document', 'deployment', 'smoke-results')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${startedAt.replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    console.log(`[smoke] 结果已保存: ${file}`)
  }

  if (failed) {
    console.error(`[smoke] 结果:FAIL(${report.failed}/${report.total} 项未通过)`)
    process.exit(1)
  }
  console.log(`[smoke] 结果:PASS(${report.total} 项全部通过) commitSha=${commitSha}`)
}

main().catch((e) => {
  console.error('[smoke] 执行异常:', e)
  process.exit(1)
})
