import type { PdfProvider, PdfRenderOptions, PdfRenderResult } from './types.js'
import { createHash } from 'node:crypto'

/**
 * Mock PDF Provider(Stage-04 Agent-06)
 *
 * 纯 JS 生成最小合法单页 PDF(Helvetica + 文本),零外部依赖。
 * 用途:开发/CI 环境下让"渲染 → bytes → sha256 → R2 → document_archives"
 * 完整链路可运行、可断言;非生产渲染方案。
 *
 * 注意:Mock 仅支持 ASCII 文本(中文会替换为 '?'),生产必须切换
 * PDF_PROVIDER=external(见 types.ts 顶部说明)。
 */

/** 从 HTML 中提取纯文本(仅用于 Mock 占位 PDF;真实 PDF 由 external Provider 渲染) */
function extractPlainText(html: string): string {
  // 去掉 script/style 块
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  // 去掉标签,保留文本
  const text = noScript
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, '\'')
    .replace(/\s+/g, ' ')
    .trim()
  // 仅保留 ASCII(标准 Helvetica 不支持中文)

  return text.replace(/[^\x20-\x7E]/g, '?').slice(0, 2000)
}

/** 对 PDF 字符串文本转义(括号/反斜杠) */
function escapePdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** 将文本折行(按 ASCII 宽度近似,超过 90 字符换行) */
function wrapText(text: string, maxLen = 90): string[] {
  const lines: string[] = []
  let rest = text
  while (rest.length > maxLen) {
    lines.push(rest.slice(0, maxLen))
    rest = rest.slice(maxLen)
  }
  if (rest) {
    lines.push(rest)
  }
  return lines.length > 0 ? lines : ['']
}

/**
 * 构造最小合法 PDF(单页 Helvetica 文本)
 * @param title 文档标题(ASCII)
 * @param body  正文文本行(ASCII)
 * @returns PDF bytes
 */
export function buildMinimalPdf(title: string, body: string[]): Uint8Array {
  const header = [
    `BT /F1 16 Tf 50 800 Td (${escapePdfText(title)}) Tj ET`,
    `BT /F1 11 Tf 50 770 Td (${escapePdfText('Mock PDF renderer (dev only). Switch PDF_PROVIDER=external in production.')}) Tj ET`,
  ]
  const bodyLines: string[] = []
  let y = 740
  for (const line of body.slice(0, 40)) {
    bodyLines.push(`BT /F1 11 Tf 50 ${y} Td (${escapePdfText(line)}) Tj ET`)
    y -= 16
  }
  const contentStream = `${header.join('\n')}\n${bodyLines.join('\n')}\n`

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'))
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefStart = Buffer.byteLength(pdf, 'utf8')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  return new TextEncoder().encode(pdf)
}

export const mockPdfProvider: PdfProvider = {
  name: 'mock',

  async renderHtml(html: string, opts?: PdfRenderOptions): Promise<PdfRenderResult> {
    const title = (opts?.title ?? 'Insurance Claim Document').slice(0, 120)
    const body = wrapText(extractPlainText(html))
    const bytes = buildMinimalPdf(title, body)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return {
      bytes,
      mimeType: 'application/pdf',
      sha256,
      provider: this.name,
    }
  },
}
