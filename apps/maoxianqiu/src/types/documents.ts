/**
 * S32-C 业务文档与打印中心 V2 —— 前端类型
 */

/** 8 类业务文档 */
export type DocumentType =
  | 'prescription'
  | 'invoice'
  | 'medical_record_summary'
  | 'lab_report'
  | 'imaging_report'
  | 'discharge_summary'
  | 'vaccination_certificate'
  | 'boarding_handover'

/** 纸型 */
export type PaperSize = 'A4' | '80mm' | '58mm'

/** 模板层级:门店覆盖 > 租户默认 > 系统默认 */
export type TemplateLevel = 'store' | 'tenant' | 'system'

export const DOCUMENT_TYPE_OPTIONS: Array<{ label: string, value: DocumentType }> = [
  { label: '处方', value: 'prescription' },
  { label: '收费单', value: 'invoice' },
  { label: '病历摘要', value: 'medical_record_summary' },
  { label: '检验报告', value: 'lab_report' },
  { label: '影像报告', value: 'imaging_report' },
  { label: '住院出院记录', value: 'discharge_summary' },
  { label: '疫苗证明', value: 'vaccination_certificate' },
  { label: '寄养交接单', value: 'boarding_handover' },
]

export function getDocumentTypeLabel(type: DocumentType | string): string {
  return DOCUMENT_TYPE_OPTIONS.find(o => o.value === type)?.label ?? type
}

export const PAPER_SIZE_OPTIONS: Array<{ label: string, value: PaperSize }> = [
  { label: 'A4 (210mm × 297mm)', value: 'A4' },
  { label: '小票 80mm', value: '80mm' },
  { label: '小票 58mm', value: '58mm' },
]

/** document_templates 行(来自 GET /documents/templates) */
export interface DocumentTemplate {
  id: string
  tenant_id: string | null
  store_id: string | null
  document_type: DocumentType
  name: string
  version: number
  template_html: string
  template_json: Record<string, unknown>
  paper_size: PaperSize
  is_default: boolean
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
  /** 服务端标注:门店/租户/系统 */
  level?: TemplateLevel
  documentTypeLabel?: string
}

export interface DocumentTemplateListResult {
  list: DocumentTemplate[]
  total: number
}

/** 渲染/预览/打印结果 */
export interface DocumentRenderResult {
  html: string
  documentType: DocumentType
  entityId: string
  templateId: string
  templateName: string
  templateVersion: number
  templateLevel: TemplateLevel
  paperSize: PaperSize
}

/** document_history 行 */
export interface DocumentHistoryItem {
  id: string
  tenant_id: string
  store_id: string | null
  document_type: DocumentType
  entity_type: string
  entity_id: string
  template_id: string | null
  template_version: number | null
  paper_size: PaperSize | null
  action: 'render' | 'print'
  operator_id: string | null
  created_at: string
}

export interface DocumentHistoryResult {
  list: DocumentHistoryItem[]
  total: number
}
