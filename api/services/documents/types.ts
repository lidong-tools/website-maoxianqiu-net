import type { createServiceClient } from '../../lib/supabase.js'

/**
 * S32-C 业务文档与打印中心 V2 —— 服务层共享类型
 */

/** 8 类业务文档(与 migration 108 约束一致) */
export const DOCUMENT_TYPES = [
  'prescription',
  'invoice',
  'medical_record_summary',
  'lab_report',
  'imaging_report',
  'discharge_summary',
  'vaccination_certificate',
  'boarding_handover',
] as const

export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/** 纸型:与 migration 108 约束一致 */
export const PAPER_SIZES = ['A4', '80mm', '58mm'] as const
export type PaperSize = (typeof PAPER_SIZES)[number]

/** 模板层级:门店覆盖 > 租户默认 > 系统默认 */
export type TemplateLevel = 'store' | 'tenant' | 'system'

export type Service = ReturnType<typeof createServiceClient>

/** document_templates 行(service role 直查原始列) */
export interface DocumentTemplateRow {
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
}

/** 文档通用信息(医院/门店/客户/宠物/医生/操作员) */
export interface DocumentBase {
  hospital: { name: string, shortName?: string }
  store: { name: string, code?: string, address?: string, phone?: string } | null
  customer: { name: string, phone?: string, gender?: string } | null
  pet: { name: string, species?: string, breed?: string, gender?: string, weight?: number } | null
  doctor: { name: string, title?: string } | null
  operator: { name: string } | null
  createdAt: string
}

/** 文档渲染的完整数据树(渲染器只读此对象,绝不执行模板内 JS) */
export interface DocumentData extends DocumentBase {
  entityType: DocumentType
  entityId: string
  /** 渲染元信息(打印时间等) */
  meta: { printedAt: string }
  [key: string]: unknown
}

/** 单个 Adapter 的产出:通用信息 + 业务区段 */
export interface AdapterResult {
  base: DocumentBase
  section: Record<string, unknown>
}

/**
 * 业务 Adapter 契约
 * - resolveScope:先查实体取得 tenant_id/store_id,供 scoped 授权(防止跨租户/门店读取)
 * - fetch:聚合真实业务 DTO(禁止模板直接查库,统一由 Adapter 提供数据)
 * - businessPermission:医疗类文档的额外业务权限门(imaging.view / inpatient.view / boarding.view),null 表示无
 */
export interface DocumentAdapter {
  documentType: DocumentType
  businessPermission: string | null
  resolveScope: (service: Service, entityId: string) => Promise<{ tenantId: string, storeId: string | null }>
  fetch: (service: Service, entityId: string) => Promise<AdapterResult>
}

/** document_type → 数据树区段 key */
export const DOCUMENT_SECTION_KEY: Record<DocumentType, string> = {
  prescription: 'prescription',
  invoice: 'invoice',
  medical_record_summary: 'medicalRecord',
  lab_report: 'labReport',
  imaging_report: 'imagingReport',
  discharge_summary: 'dischargeSummary',
  vaccination_certificate: 'vaccinationCertificate',
  boarding_handover: 'boardingHandover',
}

/** 文档类型中文名(前端/审计展示) */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  prescription: '处方',
  invoice: '收费单',
  medical_record_summary: '病历摘要',
  lab_report: '检验报告',
  imaging_report: '影像报告',
  discharge_summary: '住院出院记录',
  vaccination_certificate: '疫苗证明',
  boarding_handover: '寄养交接单',
}
