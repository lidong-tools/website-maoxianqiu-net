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

/**
 * HTML 转义(插值默认安全化,阻断业务数据注入)
 * @param v 原始文本
 * @returns 转义后的安全文本
 */
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

// ============================================================
// 模板合法性校验(S32-C FIX P0-A)
// 从"黑名单"升级为"白名单"模型:
//   - 标签白名单(允许 div/span/table/p/strong/img 等版式标签);
//   - 属性白名单(仅 class/style/表格属性/alt/title 等);
//   - URL 协议白名单(禁止 javascript:/data:(非图片)/vbscript:/file:,
//     外链 http(s) 一律禁止,img 仅允许 data:image base64 或站内相对路径);
//   - CSS 属性白名单(仅版式属性,禁止 url()/expression/@import 等);
//   - 模板语法白名单(仅 {{path}} 与 {{#each}})。
// 禁止的标签即使出现也会被拒绝保存,从根源阻断 Stored XSS。
// ============================================================

/** 允许的标签白名单 */
const ALLOWED_TAGS = new Set([
  // 文档外壳(仅允许静态包装,无脚本)
  'html', 'head', 'body', 'title',
  // 版式块级
  'div', 'span', 'p', 'br', 'hr', 'section', 'article', 'main', 'aside',
  'header', 'footer', 'figure', 'figcaption', 'blockquote', 'pre',
  // 表格
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'col', 'colgroup',
  // 文本样式
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  // 图片(仅受控 data:image / 相对路径)
  'img',
])

/** 禁用的高风险标签(仅名称出现即拒绝;含 style/meta 需要在内容层单独放行) */
const FORBIDDEN_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'link',
  'base', 'svg', 'math', 'template', 'textarea', 'input',
  'button', 'select', 'option', 'noscript', 'frame', 'frameset',
  'audio', 'video', 'source', 'track', 'canvas',
])

/** 标签 → 允许的属性集合(全局通用属性另计) */
const TAG_ATTRS: Record<string, Set<string>> = {
  meta: new Set(['charset']),
  table: new Set(['border', 'cellpadding', 'cellspacing', 'width', 'align']),
  th: new Set(['colspan', 'rowspan', 'width', 'align', 'scope']),
  td: new Set(['colspan', 'rowspan', 'width', 'align']),
  col: new Set(['width', 'align', 'span']),
  img: new Set(['src', 'alt', 'width', 'height', 'align']),
}

/** 全局通用属性(所有标签都允许) */
const GLOBAL_ATTRS = new Set([
  'class', 'style', 'id', 'title',
])

/** 允许的 CSS 属性白名单(版式) */
const ALLOWED_CSS_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-family',
  'font-style', 'text-align', 'text-decoration', 'line-height', 'letter-spacing',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-collapse',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'display', 'vertical-align', 'white-space', 'word-break', 'word-wrap',
  'border-radius', 'box-sizing', 'position', 'top', 'right', 'bottom', 'left',
])

/** 禁止的 CSS 值片段(URL/表达式/导入/行为) */
const FORBIDDEN_CSS_FRAGMENTS = /url\s*\(|expression\s*\(|@import|behavior\s*:|javascript:|vbscript:|-moz-binding/i

/** 属性名是否命中禁止内联事件(on*=) */
function isEventAttr(name: string): boolean {
  return /^on/i.test(name)
}

/** 属性名是否属于 URL 承载属性 */
const URL_ATTRS = new Set([
  'src', 'href', 'action', 'background', 'cite', 'poster',
  'formaction', 'longdesc', 'xlink:href',
])

/** URL 值安全校验(协议白名单 + 外链禁止) */
function isSafeUrlValue(attrName: string, value: string): string | null {
  const v = value.trim().toLowerCase()
  if (!v) {
    return null
  }
  // 协议化前缀检测:javascript:/vbscript:/file:/data:(除图片)/blob: 一律禁止
  if (/^(javascript|vbscript|file|blob|about)\s*:/i.test(v)) {
    return `属性 ${attrName} 使用了禁止的 URL 协议`
  }
  if (/^data\s*:/i.test(v)) {
    // img 仅允许 base64 图片数据;其余 data: 一律拒绝
    if (attrName === 'src' && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v)) {
      return null
    }
    return `属性 ${attrName} 不允许 data: 数据`
  }
  // 外链(http/https///)禁止:模板内容不得向第三方发起任何资源请求
  if (/^https?:/i.test(v) || /^\/\//.test(v)) {
    return `属性 ${attrName} 不允许外部 URL`
  }
  // 其余视为站内相对路径/锚点
  return null
}

/** 校验单个 style 属性值(仅允许白名单属性,值内禁止可执行片段) */
function validateStyle(value: string): string | null {
  const decls = value.split(';')
  for (const decl of decls) {
    const idx = decl.indexOf(':')
    if (idx === -1) {
      continue
    }
    const prop = decl.slice(0, idx).trim().toLowerCase()
    const val = decl.slice(idx + 1).trim()
    if (!prop) {
      continue
    }
    if (!ALLOWED_CSS_PROPS.has(prop)) {
      return `style 属性 ${prop} 不在白名单内`
    }
    if (FORBIDDEN_CSS_FRAGMENTS.test(val)) {
      return `style 属性 ${prop} 包含被禁止的表达式或资源引用`
    }
  }
  return null
}

/**
 * 模板合法性校验(保存模板时调用,防御内嵌脚本与外部资源窃取)
 * 返回错误信息;返回 null 表示通过。
 */
export function validateTemplateHtml(templateHtml: string): string | null {
  // 1) 模板语法白名单
  if (/\{\{\{/.test(templateHtml)) {
    return '模板禁止使用 {{{ 三花括号(原样输出)'
  }
  if (/\{\{#(if|unless|for|with)\b/.test(templateHtml)) {
    return '模板仅支持 {{path}} 与 {{#each}},不支持 #if/#unless/#for'
  }
  // style 标签内容单独校验(白名单 CSS 属性 + 禁止 url()/@import 等),校验后视为普通内容跳过
  // 注意:校验失败必须通过外部变量上报并提前 return,禁止用 replace callback 返回值
  // 作为"失败标记"(那只是把错误串塞回模板,后续仍可能通过校验导致恶意样式被保存,审计 v2 §4~§6)。
  const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi
  let styleProblem: string | null = null
  const styleContent: string[] = []
  templateHtml = templateHtml.replace(STYLE_BLOCK_RE, (_full, inner: string) => {
    const problem = validateStyleBlock(inner)
    if (problem) {
      styleProblem = problem
    }
    styleContent.push(inner)
    return ''
  })
  if (styleProblem) {
    return styleProblem
  }
  if (styleContent.some(s => s.includes('\u0000'))) {
    return '模板包含非法字符'
  }

  // 2) 标签级校验:先粗筛必须禁止的标签,再逐标签校验属性
  const TAG_RE = /<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)\s*\/?>/g
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(templateHtml)) !== null) {
    const tagName = m[1].toLowerCase()
    if (tagName === '!doctype' || tagName === '!--') {
      continue
    }
    if (FORBIDDEN_TAGS.has(tagName)) {
      return `模板禁止使用 <${tagName}> 标签`
    }
    if (!ALLOWED_TAGS.has(tagName)) {
      return `模板包含未授权的标签 <${tagName}>`
    }

    // 属性解析(容忍标签内任意引号)
    const attrStr = m[2]
    const ATTR_RE = /([a-zA-Z-_:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
    let am: RegExpExecArray | null
    while ((am = ATTR_RE.exec(attrStr)) !== null) {
      const attrName = am[1].toLowerCase()
      const attrValue = am[2] ?? am[3] ?? am[4] ?? ''
      if (isEventAttr(attrName)) {
        return `模板禁止使用内联事件属性 ${attrName}`
      }
      if (attrName.startsWith('data-') || attrName.startsWith('aria-')) {
        return `模板禁止使用 ${attrName} 自定义属性`
      }
      const allowedSet = TAG_ATTRS[tagName] ?? new Set<string>()
      if (!GLOBAL_ATTRS.has(attrName) && !allowedSet.has(attrName)) {
        return `<${tagName}> 标签包含未授权的属性 ${attrName}`
      }
      // URL 承载属性统一协议校验
      if (URL_ATTRS.has(attrName)) {
        const problem = isSafeUrlValue(attrName, attrValue)
        if (problem) {
          return problem
        }
      }
      // style 属性值白名单校验
      if (attrName === 'style') {
        const problem = validateStyle(attrValue)
        if (problem) {
          return problem
        }
      }
    }
  }

  // 3) 深度防御:残留的协议/事件模式(规避正则解析遗漏)
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
  return null
}

/**
 * 校验 <style> 块内容:仅允许白名单 CSS 属性,禁止 url()/@import/expression 等。
 * 静态样式不会执行 JS,配合 iframe sandbox 形成纵深防御。
 */
function validateStyleBlock(content: string): string | null {
  if (/@(import|charset|font-face|keyframes|supports|media\b)/i.test(content)) {
    return '模板 style 禁止使用 @ 规则(@import/@media 等)'
  }
  // 提取每个 {} 声明块,逐条校验属性
  const BLOCK_RE = /[^{}]+\{([^{}]*)\}/g
  let bm: RegExpExecArray | null
  let found = false
  while ((bm = BLOCK_RE.exec(content)) !== null) {
    found = true
    const problem = validateStyle(bm[1])
    if (problem) {
      return `模板 style 块校验失败: ${problem}`
    }
  }
  if (!found && content.trim()) {
    // 无 {} 块但有内容(裸声明或异常片段),仍逐条校验
    const problem = validateStyle(content)
    if (problem) {
      return `模板 style 内容校验失败: ${problem}`
    }
  }
  return null
}
