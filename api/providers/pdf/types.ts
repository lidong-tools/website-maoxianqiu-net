/**
 * Stage-04 Agent-06 — PDF 渲染 Provider 抽象(api/providers/pdf)
 *
 * 背景:
 *   Vercel Serverless 对 Chromium(包大小/启动/内存/timeout)非常敏感,
 *   "默认假设 Puppeteer 一定适用"是被禁止的。因此本 Agent 通过 PdfProvider
 *   抽象隔离渲染实现,运行时按环境变量选择 Provider:
 *
 *     PDF_PROVIDER=mock     纯 JS 生成最小合法 PDF(开发/测试,零依赖)
 *     PDF_PROVIDER=external 调用外部渲染 Worker(生产推荐,HTTPS + SSRF 防护)
 *
 * 生产建议:
 *   在独立渲染环境(Cloudflare Worker + Playwright / 自建渲染服务)中托管
 *   HTML→PDF 转换,本服务只做 POST 透传。部署约束见 Agent-06 Handoff。
 */

export interface PdfRenderOptions {
  /** 文档标题(用于文件名/元信息) */
  title?: string
  /** 渲染页尺寸,默认 A4 */
  paperSize?: 'A4' | 'A5' | 'Letter'
  /** 渲染超时(毫秒) */
  timeoutMs?: number
}

export interface PdfRenderResult {
  /** PDF 二进制 */
  bytes: Uint8Array
  mimeType: 'application/pdf'
  /** bytes 的 sha256(归档不可变校验) */
  sha256: string
  /** 实际使用的 Provider 名 */
  provider: string
}

export interface PdfProvider {
  readonly name: string
  /**
   * 将"已净化、无外部资源"的 HTML 渲染为 PDF。
   * 实现方必须保证:
   *   - 输入 HTML 不允许加载任何网络资源(SSRF 防护);
   *   - 返回的 bytes 可被重复消费(同一输入 + 同一 Provider → 尽量确定性输出)。
   */
  renderHtml(html: string, opts?: PdfRenderOptions): Promise<PdfRenderResult>
}
