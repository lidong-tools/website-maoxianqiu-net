/**
 * CI 静态规则:service-role-only RPC manifest 一致性校验(S30-F02)
 *
 * 校验规则(默认拒绝):
 *   1) api/routes 中 service.rpc('<fn>') 的每一个函数名必须属于
 *      api/lib/service-rpc-manifest.ts 的 SERVICE_ROLE_ONLY_RPC;
 *      → 新增"浏览器可直连"的 RPC 调用将直接 CI 失败。
 *   2) manifest 的每一个函数名必须出现在 supabase/migrations/ 目录
 *      全部 .sql 文件的 revoke 清单中(聚合所有单引号字符串存在性校验);
 *      → 防止"手工维护高危 RPC 名单"与数据库真实授权漂移。
 *      S3.1-1:规则 2 升级为目录扫描(S3.1 禁止修改已交付 migration 01~27,
 *      新 RPC 的 revoke 在 migration 29)。
 *
 * 用法:
 *   pnpm check:rpc-manifest
 *   (或 node --experimental-strip-types api/scripts/check-rpc-manifest.ts)
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { SERVICE_ROLE_ONLY_RPC_SET } from '../lib/service-rpc-manifest.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const apiRoot = join(__dirname, '..')
const routesDir = join(apiRoot, 'routes')
const migrationsDir = join(
  apiRoot,
  '..',
  'supabase',
  'migrations',
)

/** 提取 .rpc('<name>') / .rpc("<name>") / .rpc(`<name>`) 的函数名集合 */
function collectRpcNames(dir: string): { file: string, fn: string }[] {
  const hits: { file: string, fn: string }[] = []
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const content = readFileSync(join(dir, file), 'utf8')
    const re = /\.rpc\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/g
    let m: RegExpExecArray | null = re.exec(content)
    while (m !== null) {
      hits.push({ file, fn: m[1] })
      m = re.exec(content)
    }
  }
  return hits
}

/** 从 migrations 目录全部 .sql 文件聚合函数名清单(按 'xxx' 字符串解析) */
function collectMigrationRevokeNames(migrationsDir: string): string[] {
  const names = new Set<string>()
  const re = /'([a-z_][a-z0-9_]*)'/g
  for (const file of readdirSync(migrationsDir).filter(f => f.endsWith('.sql'))) {
    const content = readFileSync(join(migrationsDir, file), 'utf8')
    let m: RegExpExecArray | null = re.exec(content)
    while (m !== null) {
      names.add(m[1])
      m = re.exec(content)
    }
  }
  return [...names]
}

let failed = false

// ---- 规则 1:routes 中的 service.rpc() 必须 ∈ manifest ----
const routeHits = collectRpcNames(routesDir)
const routeMissing = routeHits.filter(h => !SERVICE_ROLE_ONLY_RPC_SET.has(h.fn))
if (routeMissing.length > 0) {
  failed = true
  console.error('[check:rpc-manifest] FAIL: 以下 service.rpc() 调用不在 service-role-only manifest 中:')
  for (const h of routeMissing) {
    console.error(`  - ${h.file}: rpc('${h.fn}') → 请加入 api/lib/service-rpc-manifest.ts`)
  }
}
else {
  console.log(`[check:rpc-manifest] OK: api/routes 中 ${routeHits.length} 处 service.rpc() 调用全部属于 manifest(${SERVICE_ROLE_ONLY_RPC_SET.size} 个函数)`)
}

// ---- 规则 2:manifest 必须 ⊆ migrations 目录全部 .sql 的 revoke 清单 ----
const revokeNames = new Set(collectMigrationRevokeNames(migrationsDir))
const manifestMissing = [...SERVICE_ROLE_ONLY_RPC_SET].filter(n => !revokeNames.has(n))
if (manifestMissing.length > 0) {
  failed = true
  console.error('[check:rpc-manifest] FAIL: 以下 manifest 函数未出现在 migrations 目录 revoke 清单:')
  for (const n of manifestMissing) {
    console.error(`  - ${n} → 请加入对应 migration 的 revoke DO 块`)
  }
}
else {
  console.log(`[check:rpc-manifest] OK: manifest 全部 ${SERVICE_ROLE_ONLY_RPC_SET.size} 个函数均已纳入 migrations revoke(public/anon/authenticated) + grant service_role`)
}

if (failed) {
  console.error('[check:rpc-manifest] 结果:FAIL(存在未纳入 service-role-only 管控的 RPC)')
  process.exit(1)
}
console.log('[check:rpc-manifest] 结果:PASS')
