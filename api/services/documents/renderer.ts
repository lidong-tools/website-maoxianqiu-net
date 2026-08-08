/**
 * S32-C 业务文档 —— 安全模板渲染器
 *
 * 支持的语法(白名单,绝不执行任意 JS):
 *   {{path.to.value}}              标量插值(HTML 转义)
 *   {{#each path}}...{{/each}}     遍历数组;块内 {{this}} 取标量项,{{field}} 相对当前项
 *
 * 安全策略:
 *   - 不使用 eval / Function / new Function,仅做字符串路径替换;
 *   - 所有插值均 HTML 转义,阻断业务数据注入;
 *   - 含 JS 运算符/块语法(#if/#unless/#for/{{{ 等)的标签一律渲染为空;
 *   - 路径逐段在数据树上安全取值,不解析表达式。
 */

const EACH_OPEN = '{{#each'
const EACH_CLOSE = '{{/each}}'

/** 含 JS 运算符或模板块语法的字符(禁止) */
const FORBIDDEN_INNER = /[(){}[\]+\-*/%<>=!&|^~]/

export function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 在数据树上按白名单路径取值(仅属性访问,不解析表达式) */
function resolvePath(obj: unknown, path: string): unknown {
  if (path === 'this') {
    return obj
  }
  const parts = path.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** 查找与起始位置匹配的 {{/each}},支持嵌套;找不到返回 -1 */
function findEachBlockEnd(text: string, from: number): number {
  let depth = 0
  let i = from
  while (i < text.length) {
    const nextOpen = text.indexOf(EACH_OPEN, i)
    const nextClose = text.indexOf(EACH_CLOSE, i)
    if (nextClose === -1) {
      return -1
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1
      i = nextOpen + EACH_OPEN.length
    }
    else {
      if (depth === 0) {
        return nextClose
      }
      depth -= 1
      i = nextClose + EACH_CLOSE.length
    }
  }
  return -1
}

/**
 * 渲染一个片段
 * @param text  模板片段
 * @param data  当前解析上下文(相对路径从它开始;each 块内为当前项)
 * @param root  完整数据树(绝对路径回退)
 */
function renderSegment(text: string, data: unknown, root: Record<string, unknown>): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{{', i)
    if (open === -1) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, open)
    const close = text.indexOf('}}', open + 2)
    if (close === -1) {
      out += text.slice(open)
      break
    }
    const inner = text.slice(open + 2, close).trim()
    const afterClose = close + 2

    // {{#each path}}...{{/each}}
    if (inner.startsWith('#each')) {
      const eachPath = inner.slice('#each'.length).trim()
      const blockEnd = findEachBlockEnd(text, afterClose)
      if (blockEnd === -1) {
        // 未闭合的 each,原样输出并继续
        out += text.slice(open)
        i = open + 2
        continue
      }
      const blockContent = text.slice(afterClose, blockEnd)
      const arr = resolvePath(data, eachPath) ?? resolvePath(root, eachPath)
      if (Array.isArray(arr)) {
        for (const item of arr) {
          out += renderSegment(blockContent, item, root)
        }
      }
      i = blockEnd + EACH_CLOSE.length
      continue
    }

    // 其余块语法(#if/#unless/#for/{{{)与 JS 运算符一律渲染为空(防御)
    if (inner.startsWith('#') || inner.includes('{') || inner.includes('}')
      || FORBIDDEN_INNER.test(inner)) {
      // 渲染空
    }
    else {
      const val = resolvePath(data, inner) ?? resolvePath(root, inner)
      if (val != null) {
        out += escapeHtml(String(val))
      }
    }
    i = afterClose
  }
  return out
}

/**
 * 渲染完整文档模板
 * @param templateHtml 模板 HTML(系统/租户/门店已解析后的生效模板)
 * @param data         文档数据树(由业务 Adapter 提供,前端只渲染)
 */
export function renderTemplate(templateHtml: string, data: Record<string, unknown>): string {
  return renderSegment(templateHtml, data, data)
}

/**
 * 模板合法性校验(保存模板时调用,防御内嵌脚本)
 * 禁止:<script / javascript: / on\w+= / 表达式块(#if/#unless/#for/{{{) / eval
 */
export function validateTemplateHtml(templateHtml: string): string | null {
  if (/<script/i.test(templateHtml)) {
    return '模板禁止包含 <script> 标签'
  }
  if (/javascript\s*:/i.test(templateHtml)) {
    return '模板禁止包含 javascript: 协议'
  }
  if (/\bon\w+\s*=/i.test(templateHtml)) {
    return '模板禁止包含内联事件(onclick 等)'
  }
  if (/\beval\s*\(/i.test(templateHtml)) {
    return '模板禁止包含 eval'
  }
  if (/\{\{\{/.test(templateHtml)) {
    return '模板禁止使用 {{{ 三花括号(原样输出)'
  }
  if (/\{\{#(if|unless|for|with)\b/.test(templateHtml)) {
    return '模板仅支持 {{path}} 与 {{#each}},不支持 #if/#unless/#for'
  }
  return null
}
