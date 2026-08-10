#!/usr/bin/env tsx
/**
 * 毛线球 Stage-04 — Agent-01 Runtime RPC ACL Gate
 *
 * 目标:直接查询 PostgreSQL(pg_proc + has_function_privilege),对
 * `api/lib/service-rpc-manifest.ts` 中全部 SERVICE_ROLE_ONLY_RPC 验证运行时 ACL:
 *
 *   PUBLIC         → 必须不可执行(false)
 *   anon           → 必须不可执行(false)
 *   authenticated  → 必须不可执行(false)
 *   service_role   → 必须可执行(true)
 *
 * 本脚本从 manifest 动态读取函数清单,Agent-03~08 新增高危 RPC 后无需改脚本即可覆盖。
 * 静态 `check:rpc-manifest` 只是开发 Gate,本脚本是真实数据库 Runtime ACL 验证。
 *
 * 用法:
 *   pnpm exec tsx scripts/runtime-rpc-acl-check.ts            # 需要 psql + DATABASE_URL
 *   pnpm exec tsx scripts/runtime-rpc-acl-check.ts --emit-sql # 无 psql 环境,输出 SQL 供 SQL Editor 执行
 *
 * 环境变量:
 *   DATABASE_URL : PostgreSQL 连接串(需可读 pg_catalog 的 postgres 权限)
 *
 * 退出码:0 = 全部 PASS;1 = 任一 FAIL(缺失函数/public/anon/authenticated 可执行/service_role 未授权)
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { SERVICE_ROLE_ONLY_RPC } from '../api/lib/service-rpc-manifest'

/** 单个函数名的 ACL 判定结果 */
interface AclRow {
  /** manifest 中的函数名 */
  fn: string
  /** 数据库中同名重载数(0 = 函数不存在,manifest 与 DB 漂移) */
  overloads: number
  /** public 可执行(期望 false) */
  pub: boolean
  /** anon 可执行(期望 false) */
  anon: boolean
  /** authenticated 可执行(期望 false) */
  auth: boolean
  /** service_role 可执行(期望 true) */
  svc: boolean
  /** 判定结果:PASS / FAIL / MISSING */
  verdict: 'PASS' | 'FAIL' | 'MISSING'
}

/** 将 manifest 函数清单安全嵌入 SQL 的 VALUES 列表 */
function buildManifestValues(fns: readonly string[]): string {
  return fns.map(fn => `('${fn.replace(/'/g, '\'\'')}')`).join(', ')
}

/** 构造一次查询即可返回全部函数 ACL 矩阵的 SQL */
function buildAclQuerySql(fns: readonly string[]): string {
  const values = buildManifestValues(fns)
  return `
WITH manifest(fn) AS (VALUES ${values}),
acls AS (
  SELECT p.proname AS fn,
         count(*) AS overloads,
         bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) AS pub_ok,
         bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_ok,
         bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_ok,
         bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')) AS svc_ok
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
  GROUP BY p.proname
)
SELECT m.fn,
       coalesce(a.overloads, 0),
       coalesce(a.pub_ok, false),
       coalesce(a.anon_ok, false),
       coalesce(a.auth_ok, false),
       coalesce(a.svc_ok, false)
FROM manifest m
LEFT JOIN acls a ON a.fn = m.fn
ORDER BY m.fn;`
}

/** 通过 psql 执行 SQL 并返回逐行输出(psql -A -t -F'|') */
function runPsql(sql: string): string[] {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    throw new Error('缺少 DATABASE_URL 环境变量,无法连接 PostgreSQL')
  }
  const res = spawnSync('psql', ['-d', dbUrl, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-c', sql], {
    encoding: 'utf-8',
    timeout: 60_000,
  })
  if (res.error) {
    throw new Error(`psql 执行失败: ${res.error.message}(请确认 psql 已安装并在 PATH 中)`)
  }
  if (res.status !== 0) {
    throw new Error(`psql 查询失败(exit=${res.status}): ${res.stderr?.trim() || res.stdout?.trim()}`)
  }
  return res.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

/** 解析 psql 输出行(按 | 分隔,布尔值 t/f) */
function parseRow(line: string): AclRow {
  const [fn, overloads, pub, anon, auth, svc] = line.split('|')
  const ov = Number(overloads)
  const verdict = ov === 0 ? 'MISSING' : (pub === 't' || anon === 't' || auth === 't' || svc !== 't') ? 'FAIL' : 'PASS'
  return {
    fn,
    overloads: ov,
    pub: pub === 't',
    anon: anon === 't',
    auth: auth === 't',
    svc: svc === 't',
    verdict,
  }
}

/** 输出对齐表格并统计结果 */
function renderReport(rows: AclRow[]): void {
  const w = { fn: 34, other: 14 }
  const pad = (s: string, n: number) => s.padEnd(n)
  console.log('')
  console.log('=== Runtime RPC ACL Gate(service_role_only) ===')
  console.log('')
  console.log(`${pad('function', w.fn)}${pad('overloads', 10)}${pad('public', w.other)}${pad('anon', w.other)}${pad('authenticated', w.other)}${pad('service_role', w.other)}verdict`)
  console.log('-'.repeat(w.fn + 10 + w.other * 4 + 6))
  for (const r of rows) {
    console.log(`${pad(r.fn, w.fn)}${pad(String(r.overloads), 10)}${pad(r.pub ? 'GRANTED(BAD)' : 'revoked', w.other)}${pad(r.anon ? 'GRANTED(BAD)' : 'revoked', w.other)}${pad(r.auth ? 'GRANTED(BAD)' : 'revoked', w.other)}${pad(r.svc ? 'granted' : 'REVOKED(BAD)', w.other)}${r.verdict}`)
  }
  const fail = rows.filter(r => r.verdict !== 'PASS')
  const pass = rows.length - fail.length
  console.log('')
  console.log(`summary: ${pass} PASS / ${fail.length} FAIL(含 MISSING)`)
}

function main(): void {
  const emitSqlOnly = process.argv.includes('--emit-sql')
  const sql = buildAclQuerySql(SERVICE_ROLE_ONLY_RPC)

  if (emitSqlOnly) {
    // 无 psql 环境:输出 SQL 供 SQL Editor / supabase db execute 执行后人工回填
    console.log(sql)
    console.log('-- 期望矩阵:overloads>0, public=false, anon=false, authenticated=false, service_role=true')
    return
  }

  const lines = runPsql(sql)
  const rows = lines.map(parseRow)
  renderReport(rows)

  const failed = rows.filter(r => r.verdict !== 'PASS')
  if (failed.length > 0) {
    console.log(`Runtime RPC ACL Gate: FAIL(${failed.length} 个函数 ACL 不符合 service-role-only 预期)`)
    process.exit(1)
  }
  console.log('Runtime RPC ACL Gate: PASS')
}

main()
