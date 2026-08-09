import type { DocumentArchive, SignatureRequest } from '@/types/insurance'
import api from '../index'

/**
 * Stage-04 Agent-06 — 文档归档 / PDF 生成 / 电子签名 API 模块
 * 全部走 Hono 路由(service_role + scoped 授权 + 审计 + 幂等)
 */

/** 可归档的文档类型 */
export type ArchiveDocumentType
  = | 'encounter'
    | 'medical_record_summary'
    | 'prescription'
    | 'invoice'
    | 'lab_report'
    | 'imaging_report'
    | 'discharge_summary'
    | 'vaccination_certificate'

export default {
  /**
   * 生成业务文档 PDF 归档(不可变:sha256 一次性写入)
   */
  generatePdf(documentType: ArchiveDocumentType, entityId: string, customerVisible = false) {
    return api.post<{ archive: DocumentArchive, file: { id: string, sha256: string, sizeBytes: number, provider: string } }>(
      `document-artifacts/${documentType}/${entityId}/pdf`,
      { customerVisible },
    )
  },

  /**
   * 归档列表(租户/门店收敛 + 分页)
   */
  listArchives(params: {
    tenantId: string
    storeId?: string
    documentType?: string
    entityId?: string
    status?: 'active' | 'superseded' | 'archived'
    page?: number
    pageSize?: number
  }) {
    return api.get<{ list: DocumentArchive[], total: number }>('document-artifacts/archives', { params })
  },

  /**
   * 归档预签名下载 URL
   */
  getDownloadUrl(id: string) {
    return api.get<{ archiveId: string, downloadUrl: string, expiresAt: string, originalName: string, sha256: string }>(
      `document-artifacts/archives/${id}/download`,
    )
  },

  /**
   * 归档签名请求列表
   */
  listSignatures(id: string) {
    return api.get<{ list: SignatureRequest[] }>(`document-artifacts/archives/${id}/signatures`)
  },

  /**
   * 发起签名请求(内部 Provider 首版,仅表达内部流程)
   */
  createSignature(
    id: string,
    input: { signerType?: 'customer' | 'guardian' | 'other', signerName?: string, signerEmail?: string },
    idempotencyKey?: string,
  ) {
    return api.post<SignatureRequest>(`document-artifacts/archives/${id}/sign`, input, {
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    })
  },
}
