import process from 'node:process'
import { createHash } from 'node:crypto'
import type { PdfProvider, PdfRenderOptions, PdfRenderResult } from './types.js'

/**
 * External PDF 渲染 Worker Provider(Stage-04 Agent-06)
 *
 * 生产推荐:把 HTML→PDF 渲染放到独立环境(Cloudflare Worker + Playwright /
 * 自建渲染服务),本 Provider 通过 HTTPS POST 透传 HTML 并接收 application/pdf。
 *
 * 环境变量:
 *   PDF_RENDER_WORKER_URL  渲染 Worker 地址(必须 HTTPS,白名单/非内网校验)
 *   PDF_RENDER_TIMEOUT_MS  超时(默认 30000)
 *
 * SSRF 防护(硬约束):
 *   - 仅接受 https:// URL;
 *   - 主机名禁止 localhost、IPv4 回环、云元数据地址及 RFC 1918 私网地址;
 *   - 可配置 PDF_WORKER_HOST_ALLOWLIST(逗号分隔的精确主机名白名单),配置后仅允许命中白名单;
 *   - 输出侧:输入 HTML 由上层服务净化且不含外部资源(见 services/insurance/render.ts)。
 */

const DEFAULT_TIMEOUT_MS = 30_000

/** 是否为回环/私网/云元数据地址(SSRF 黑名单) */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return true
  }
  // IPv6 回环
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') {
    return true
  }
  // IPv4 段
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number)
    if (a === 127 || a === 10) {
      return true
    }
    if (a === 169 && b === 254) {
      return true // 含 169.254.169.254 云元数据
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true
    }
    if (a === 192 && b === 168) {
      return true
    }
    if (a === 0 || d === 0) {
      return true // 0.0.0.0 / 广播
    }
  }
  return false
}

/** 解析并校验外部渲染地址,不通过抛错(SSRF 防护) */
function validateWorkerUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  }
  catch {
    throw new Error('PDF_RENDER_WORKER_URL 不是合法 URL')
  }
  if (url.protocol !== 'https:') {
    throw new Error('PDF_RENDER_WORKER_URL 仅允许 HTTPS')
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error('PDF_RENDER_WORKER_URL 指向内网/元数据地址,已拒绝')
  }
  // 可选白名单:配置后仅允许精确主机名命中
  const allowlist = (process.env.PDF_WORKER_HOST_ALLOWLIST ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (allowlist.length > 0 && !allowlist.includes(url.hostname)) {
    throw new Error('PDF_RENDER_WORKER_URL 不在白名单内,已拒绝')
  }
  return url
}

export const externalPdfProvider: PdfProvider = {
  name: 'external',

  async renderHtml(html: string, opts?: PdfRenderOptions): Promise<PdfRenderResult> {
    const rawUrl = process.env.PDF_RENDER_WORKER_URL
    if (!rawUrl) {
      throw new Error('PDF_PROVIDER=external 但未配置 PDF_RENDER_WORKER_URL')
    }
    const url = validateWorkerUrl(rawUrl)
    const timeoutMs = opts?.timeoutMs ?? Number(process.env.PDF_RENDER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: html,
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`PDF 渲染 Worker 返回 ${res.status}`)
      }
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('application/pdf')) {
        throw new Error('PDF 渲染 Worker 返回内容不是 application/pdf')
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      return { bytes, mimeType: 'application/pdf', sha256, provider: this.name }
    }
    finally {
      clearTimeout(timer)
    }
  },
}
