/**
 * Stage-04 Agent-06 — 保险理赔 / 文档归档 / 电子签名 前端类型
 * 与 api/services/insurance/types.ts、supabase migration 235 对齐
 */

/** 理赔包材料来源类型 */
export type InsuranceSourceType
  = | 'encounter'
    | 'prescription'
    | 'invoice'
    | 'lab_report'
    | 'imaging_report'
    | 'discharge_summary'
    | 'medical_record_summary'
    | 'vaccination_certificate'

/** 理赔包状态 */
export type InsurancePackStatus = 'draft' | 'generated' | 'archived' | 'cancelled'

/** 材料来源中文名 */
export const INSURANCE_SOURCE_LABELS: Record<InsuranceSourceType, string> = {
  encounter: '就诊病历',
  prescription: '处方',
  invoice: '收费发票',
  lab_report: '检验报告',
  imaging_report: '影像报告',
  discharge_summary: '出院记录',
  medical_record_summary: '病历摘要',
  vaccination_certificate: '疫苗证明',
}

/** 理赔包状态中文名 */
export const INSURANCE_PACK_STATUS_LABELS: Record<InsurancePackStatus, string> = {
  draft: '草稿',
  generated: '已生成',
  archived: '已归档',
  cancelled: '已取消',
}

/** 理赔包材料清单项 */
export interface InsurancePackItem {
  id?: string
  source_type: InsuranceSourceType
  source_id: string
  display_order: number
  required: boolean
  included: boolean
  summary?: string
}

/** 理赔包头 */
export interface InsurancePack {
  id: string
  tenant_id: string
  store_id: string | null
  customer_id: string
  pet_id: string
  encounter_id: string | null
  admission_id: string | null
  pack_no: string
  status: InsurancePackStatus
  version: number
  remark: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** 理赔包 + 材料清单 */
export interface InsurancePackWithItems {
  pack: InsurancePack
  items: InsurancePackItem[]
}

/** 创建理赔包输入 */
export interface CreateInsurancePackInput {
  tenantId?: string
  storeId?: string
  customerId: string
  petId: string
  encounterId?: string
  admissionId?: string
}

/** 生成理赔包结果 */
export interface GeneratePackResult {
  export: Record<string, unknown>
  archive: Record<string, unknown>
  pack: InsurancePack
  pdf: { fileId: string, sha256: string, sizeBytes: number, provider: string }
}

/** 文档归档记录 */
export interface DocumentArchive {
  id: string
  tenant_id: string
  store_id: string | null
  document_type: string
  entity_type: string
  entity_id: string
  file_id: string
  sha256: string
  mime_type: string
  size_bytes: number
  status: 'active' | 'superseded' | 'archived'
  customer_visible: boolean
  published: boolean
  created_by: string | null
  created_at: string
  files?: {
    original_name: string
    mime_type: string
    size_bytes: number
  } | null
}

/** 签名请求 */
export interface SignatureRequest {
  id: string
  tenant_id: string
  store_id: string | null
  archive_id: string
  signer_type: 'customer' | 'guardian' | 'other'
  signer_name: string | null
  signer_email: string | null
  provider: string
  provider_request_id: string | null
  status: 'created' | 'sent' | 'completed' | 'failed' | 'cancelled'
  reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** 签名状态中文名 */
export const SIGNATURE_STATUS_LABELS: Record<SignatureRequest['status'], string> = {
  created: '已创建',
  sent: '已发送',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 归档状态中文名 */
export const ARCHIVE_STATUS_LABELS: Record<DocumentArchive['status'], string> = {
  active: '生效中',
  superseded: '已取代',
  archived: '已归档',
}
