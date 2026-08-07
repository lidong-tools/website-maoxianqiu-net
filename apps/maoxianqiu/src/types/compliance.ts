/**
 * Compliance 合规域类型定义(S3.1-1)
 * 与新增表 medical_record_amendments / veterinarian_registrations 及
 * encounters/admissions/prescriptions 新增合规列对齐
 */
import type { ArchiveStatus } from './clinical'

// ===== 病历归档与修订 =====

/** 病历类型:就诊病历 / 住院病历 */
export type MedicalRecordType = 'encounter' | 'admission'

/** 修订状态机:pending→approved→applied;pending→rejected */
export type AmendmentStatus = 'pending' | 'approved' | 'rejected' | 'applied'

/** medical_record_amendments 表记录 */
export interface MedicalRecordAmendmentRecord {
  id: string
  tenant_id: string
  store_id: string | null
  medical_record_type: MedicalRecordType
  medical_record_id: string
  requested_by: string | null
  requested_at: string
  reason: string
  status: AmendmentStatus
  reviewed_by: string | null
  reviewed_at: string | null
  rejected_reason: string | null
  applied_by: string | null
  applied_at: string | null
  before_snapshot: Record<string, unknown> | null
  after_snapshot: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/** 病历归档入参 */
export interface ComplianceArchiveInput {
  recordType: MedicalRecordType
  recordId: string
  operatorEmployeeId: string
}

/** 修订申请入参 */
export interface AmendmentRequestInput {
  recordType: MedicalRecordType
  recordId: string
  reason: string
  requestedByEmployeeId: string
}

/** 修订审批入参 */
export interface AmendmentReviewInput {
  decision: 'approved' | 'rejected'
  reason?: string
  reviewerEmployeeId: string
}

/** 修订应用入参 */
export interface AmendmentApplyInput {
  payload: Record<string, unknown>
  appliedByEmployeeId: string
}

// ===== 执业兽医备案 =====

/** 兽医备案状态:active 有效 / inactive 停用 / expired 过期 */
export type VeterinarianRegistrationStatus = 'active' | 'inactive' | 'expired'

/** veterinarian_registrations 表记录 */
export interface VeterinarianRegistrationRecord {
  id: string
  tenant_id: string
  employee_id: string
  license_no: string
  registration_no: string | null
  registration_authority: string | null
  registration_region: string | null
  valid_from: string | null
  valid_until: string | null
  status: VeterinarianRegistrationStatus
  signature_specimen_file_id: string | null
  electronic_signature_provider: string | null
  electronic_signature_subject_id: string | null
  created_at: string
  updated_at: string
}

/** 兽医备案列表行(直连 join 员工信息) */
export interface VeterinarianRegistrationListItem extends VeterinarianRegistrationRecord {
  employees?: {
    name: string | null
    employee_no: string | null
    title: string | null
  } | null
}

/** 兽医备案 upsert 入参 */
export interface VeterinarianRegistrationUpsertInput {
  tenantId: string
  employeeId: string
  licenseNo: string
  registrationNo?: string
  registrationAuthority?: string
  registrationRegion?: string
  validFrom?: string
  validUntil?: string
  status?: VeterinarianRegistrationStatus
  signatureSpecimenFileId?: string
  electronicSignatureProvider?: string
  electronicSignatureSubjectId?: string
  operatorEmployeeId?: string
}

// ===== 处方合规 =====

/** 开具处方入参 */
export interface PrescriptionIssueInput {
  prescriberEmployeeId: string
  validUntil?: string
}

/** 延长处方有效期入参 */
export interface PrescriptionExtendValidityInput {
  newValidUntil: string
  operatorEmployeeId: string
}

// ===== UI 显示映射 =====

/** 修订状态标签映射 */
export const AMENDMENT_STATUS_LABELS: Record<AmendmentStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  applied: '已应用',
}

/** 兽医备案状态标签映射 */
export const VET_REG_STATUS_LABELS: Record<VeterinarianRegistrationStatus, string> = {
  active: '有效',
  inactive: '停用',
  expired: '过期',
}

/** 归档状态标签映射(超时由 archive_due_at 派生展示"已超时") */
export const ARCHIVE_STATUS_LABELS: Record<ArchiveStatus, string> = {
  draft: '草稿',
  signed: '已签署',
  archived: '已归档',
}
