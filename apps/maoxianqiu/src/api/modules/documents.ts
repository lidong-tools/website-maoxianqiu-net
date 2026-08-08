import type {
  DocumentHistoryResult,
  DocumentRenderResult,
  DocumentTemplate,
  DocumentTemplateListResult,
  DocumentType,
  PaperSize,
} from '@/types/documents'
import api from '../index'

/**
 * S32-C 业务文档与打印中心 V2 API 模块
 * 所有文档模板/预览/渲染/打印/历史均走 Hono 路由(service_role 聚合 + scoped 授权 + 审计)
 */

export interface CreateDocumentTemplateInput {
  tenantId: string
  storeId?: string | null
  documentType: DocumentType
  name: string
  templateHtml: string
  templateJson?: Record<string, unknown>
  paperSize?: PaperSize
  isDefault?: boolean
  isActive?: boolean
}

export interface UpdateDocumentTemplateInput {
  name?: string
  templateHtml?: string
  templateJson?: Record<string, unknown>
  paperSize?: PaperSize
  isDefault?: boolean
  isActive?: boolean
}

export interface RenderDocumentInput {
  documentType: DocumentType
  entityId: string
  templateId?: string
  paperSize?: PaperSize
}

export default {
  /**
   * 模板列表(系统 + 租户 + 门店覆盖)
   */
  listTemplates(params: { tenantId: string, storeId?: string, documentType?: DocumentType, onlyActive?: boolean }) {
    return api.get<DocumentTemplateListResult>('documents/templates', { params })
  },

  /**
   * 创建模板
   */
  createTemplate(data: CreateDocumentTemplateInput) {
    return api.post<DocumentTemplate>('documents/templates', data)
  },

  /**
   * 更新模板(升版本)
   */
  updateTemplate(id: string, data: UpdateDocumentTemplateInput) {
    return api.patch<DocumentTemplate>(`documents/templates/${id}`, data)
  },

  /**
   * 预览文档(渲染 HTML,不落历史)
   */
  previewDocument(data: RenderDocumentInput) {
    return api.post<DocumentRenderResult>('documents/preview', data)
  },

  /**
   * 渲染文档(渲染 HTML + 落历史 + 审计)
   */
  renderDocument(data: RenderDocumentInput) {
    return api.post<DocumentRenderResult>('documents/render', data)
  },

  /**
   * 打印文档(渲染 HTML + 落历史 + 审计,用于浏览器打印)
   */
  printDocument(data: RenderDocumentInput) {
    return api.post<DocumentRenderResult>('documents/print', data)
  },

  /**
   * 渲染/打印历史
   */
  listHistory(params: { tenantId: string, storeId?: string, documentType?: DocumentType, from?: number, limit?: number }) {
    return api.get<DocumentHistoryResult>('documents/history', { params })
  },
}
