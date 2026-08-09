/**
 * ESM 回归检查器(Agent-02 / Stage-04)
 *
 * 目标:防止生产 Node 无法解析的相对导入重新出现。
 *
 * 当前 main 的 ESM 策略(已由 Source13 之后修复):
 *   - 根 package.json: "type": "module"
 *   - api/tsconfig.json: module = moduleResolution = NodeNext(strict)
 *   - 相对导入必须带显式 .js 扩展名(运行时按编译产物解析,禁止 './x' 或 './x.ts')
 *
 * 检查范围:api/**/*.ts(默认);--include-scripts 时追加 scripts/*.ts
 *
 * 用法:
 *   pnpm exec tsx scripts/check-api-esm.ts
 *   pnpm exec tsx scripts/check-api-esm.ts --include-scripts
 *   pnpm exec tsx scripts/check-api-esm.ts --fix   # 对缺少扩展名的相对导入自动补 .js
 *
 * 输出:file / line / specifier / reason;任一失败 exit 1。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(__dirname, '..')
const apiRoot = join(repoRoot, 'api')

// 运行时 Node 能解析的显式扩展名(NodeNext 编译产物)
const LEGAL_EXT_RE = /\.(js|mjs|cjs|json)$/i

/** 递归收集目录下全部 .ts 文件 */
function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...collectTsFiles(full))
    }
    else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/** 判断一行是否处于注释中(行注释 // 或块注释 /* ... */ 单行形态) */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

interface Violation {
  file: string
  line: number
  specifier: string
  reason: string
}

/** 扫描单个文件,返回全部相对导入违规项 */
function scanFile(absPath: string): Violation[] {
  const content = readFileSync(absPath, 'utf-8')
  const violations: Violation[] = []
  const patterns = [
    // import ... from './x' / export ... from './x' / import type {..} from './x'
    /\bfrom\s+['"]([^'"]+)['"]/g,
    // import './x'(副作用导入)
    /\bimport\s+['"]([^'"]+)['"]/g,
    // import('./x')(动态导入)
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  ]

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isCommentLine(line)) {
      continue
    }
    for (const re of patterns) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        const specifier = m[1]
        // 只检查相对导入;node:*/npm 包/框架子路径(hono/vercel 等)由运行时直接解析
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          continue
        }
        if (LEGAL_EXT_RE.test(specifier)) {
          continue
        }
        const reason = /\.ts$/i.test(specifier)
          ? '不允许直接引用 .ts 源文件,NodeNext 下应引用编译产物 .js'
          : '相对导入缺少显式扩展名(NodeNext 要求 .js/.mjs/.cjs/.json)'
        violations.push({
          file: relative(repoRoot, absPath),
          line: i + 1,
          specifier,
          reason,
        })
      }
    }
  }
  return violations
}

/** 对相对导入缺失扩展名做机械修复(仅补 .js,不涉及任何业务逻辑) */
function fixSpecifier(absPath: string, violations: Violation[]): number {
  if (violations.length === 0) {
    return 0
  }
  const content = readFileSync(absPath, 'utf-8')
  const byLine = new Map<number, Set<string>>()
  for (const v of violations) {
    if (v.reason.startsWith('不允许直接引用')) {
      continue // .ts 引用不属于可安全自动修复的范围,交由人工处理
    }
    if (!byLine.has(v.line)) {
      byLine.set(v.line, new Set())
    }
    byLine.get(v.line)!.add(v.specifier)
  }
  let fixed = 0
  const lines = content.split('\n')
  for (const [lineNo, specifiers] of byLine) {
    let line = lines[lineNo - 1]
    for (const spec of specifiers) {
      const patched = `${spec}.js`
      if (line.includes(`'${spec}'`)) {
        line = line.split(`'${spec}'`).join(`'${patched}'`)
      }
      if (line.includes(`"${spec}"`)) {
        line = line.split(`"${spec}"`).join(`"${patched}"`)
      }
      fixed++
    }
    lines[lineNo - 1] = line
  }
  writeFileSync(absPath, lines.join('\n'), 'utf-8')
  return fixed
}

// ---- 参数解析 ----
const args = process.argv.slice(2)
const includeScripts = args.includes('--include-scripts')
const doFix = args.includes('--fix')

// ---- 收集扫描目标 ----
const targets: string[] = collectTsFiles(apiRoot)
if (includeScripts) {
  targets.push(...collectTsFiles(join(repoRoot, 'scripts')))
}

let failed = false
for (const target of targets) {
  const violations = scanFile(target)
  if (violations.length === 0) {
    continue
  }
  failed = true
  for (const v of violations) {
    console.error(
      `[check:api-esm] FAIL ${v.file}:${v.line} specifier='${v.specifier}' reason=${v.reason}`,
    )
  }
  if (doFix) {
    const fixed = fixSpecifier(target, violations)
    console.log(`[check:api-esm] --fix 已机械修复 ${target} 共 ${fixed} 处(补 .js 扩展名)`)
  }
}

if (failed) {
  if (doFix) {
    // 修复后需重新检查以确认是否仍有残留(例如 .ts 引用)
    console.error('[check:api-esm] 已尝试 --fix,请重新运行本脚本确认结果')
  }
  else {
    console.error('[check:api-esm] 结果:FAIL(存在 Node 生产运行时无法解析的相对导入)')
  }
  process.exit(1)
}
console.log(`[check:api-esm] 结果:PASS(共扫描 ${targets.length} 个 .ts 文件,相对导入均带显式扩展名)`)
