import type { PdfProvider } from './types.js'
import process from 'node:process'
import { externalPdfProvider } from './external.js'
import { mockPdfProvider } from './mock.js'

/**
 * PDF Provider 工厂(Stage-04 Agent-06)
 *
 * 选择规则:
 *   PDF_PROVIDER=mock(默认)  纯 JS 最小 PDF,开发/测试
 *   PDF_PROVIDER=external    外部渲染 Worker(生产推荐,HTTPS + SSRF 防护)
 *   其余值 → 回退 mock 并告警
 */
let cachedProvider: PdfProvider | null = null

export function getPdfProvider(): PdfProvider {
  if (cachedProvider) {
    return cachedProvider
  }
  const kind = (process.env.PDF_PROVIDER ?? 'mock').trim().toLowerCase()
  if (kind === 'external') {
    cachedProvider = externalPdfProvider
  }
  else {
    if (kind !== 'mock') {
      console.warn(`[pdf] 未知 PDF_PROVIDER=${kind},回退 mock Provider`)
    }
    cachedProvider = mockPdfProvider
  }
  return cachedProvider
}

export type { PdfProvider, PdfRenderOptions, PdfRenderResult } from './types.js'
