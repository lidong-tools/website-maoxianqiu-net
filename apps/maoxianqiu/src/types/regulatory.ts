/**
 * Regulatory 监管运营域类型定义(S3.1-PARALLEL-01)
 * 与新增表 institution_licenses / annual_regulatory_reports /
 * epidemic_events / medical_waste_records 对齐
 */

// ===== 动物诊疗许可证 =====

/** 许可证状态:draft 草稿 / active 有效 / suspended 暂停 / revoked 注销 / expired 过期 */
export type LicenseStatus = 'draft' | 'active' | 'suspended' | 'revoked' | 'expired'

/** institution_licenses 表记录 */
export interface InstitutionLicenseRecord {
  id: string
  tenant_id: string
  store_id: string
  license_no: string
  issuing_authority: string | null
  diagnosis_scope: string | null
  issued_at: string | null
  valid_from: string | null
  valid_until: string | null
  status: LicenseStatus
  certificate_file_id: string | null
  certificate_qr: string | null
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
  // 直连 join 门店信息(查询附加)
  stores?: { name: string | null, code: string | null } | null
}

/** institution_license_versions 历史版本记录 */
export interface InstitutionLicenseVersionRecord {
  id: string
  license_id: string
  version_no: number
  change_type: 'create' | 'update' | 'status_change'
  snapshot: Record<string, unknown>
  changed_at: string
  changed_by: string | null
}

/** 许可证保存入参(storeId 由 StorePicker 提供,租户/操作人服务端推导) */
export interface SaveLicenseInput {
  storeId: string
  licenseId?: string
  licenseNo: string
  issuingAuthority?: string
  diagnosisScope?: string
  issuedAt?: string
  validFrom?: string
  validUntil?: string
  status?: LicenseStatus
  certificateFileId?: string
  certificateQr?: string
}

/** 许可证状态变更入参 */
export interface ChangeLicenseStatusInput {
  newStatus: LicenseStatus
}

// ===== 年度动物诊疗活动报告 =====

/** 报告状态:draft 草稿 / generated 已生成 / submitted 已提交 / accepted 已受理 / rejected 已驳回 */
export type RegulatoryReportStatus = 'draft' | 'generated' | 'submitted' | 'accepted' | 'rejected'

/** annual_regulatory_reports 表记录 */
export interface AnnualRegulatoryReportRecord {
  id: string
  tenant_id: string
  store_id: string
  report_year: number
  status: RegulatoryReportStatus
  generated_at: string | null
  generated_by: string | null
  submitted_at: string | null
  submitted_by: string | null
  accepted_at: string | null
  rejected_at: string | null
  rejected_reason: string | null
  report_snapshot: Record<string, unknown> | null
  attachment_file_id: string | null
  created_at: string
  updated_at: string
  // 直连 join 门店信息
  stores?: { name: string | null, code: string | null } | null
}

/** 生成报告入参(storeId 由 StorePicker 提供) */
export interface GenerateReportInput {
  storeId: string
  reportYear: number
}

// ===== 疫情事件台账 =====

/** 事件状态:detected 已发现 / reported 已上报 / isolated 已隔离 / resolved 已解除 */
export type EpidemicEventStatus = 'detected' | 'reported' | 'isolated' | 'resolved'

/** epidemic_events 表记录 */
export interface EpidemicEventRecord {
  id: string
  tenant_id: string
  store_id: string
  customer_id: string | null
  pet_id: string | null
  encounter_id: string | null
  suspected_disease: string
  detected_at: string
  detected_by: string | null
  reported_at: string | null
  reported_by: string | null
  isolation_required: boolean
  isolated_at: string | null
  treatment_restricted: boolean
  restriction_reason: string | null
  culling_required: boolean | null
  resolved_at: string | null
  resolved_by: string | null
  notes: string | null
  status: EpidemicEventStatus
  created_at: string
  updated_at: string
  // 直连 join 门店/宠物/客户
  stores?: { name: string | null, code: string | null } | null
  pets?: { name: string | null } | null
  customers?: { name: string | null } | null
}

/** 疫情事件保存入参(storeId 由 StorePicker 提供,关联对象用 Picker) */
export interface SaveEpidemicEventInput {
  storeId: string
  eventId?: string
  customerId?: string
  petId?: string
  encounterId?: string
  suspectedDisease: string
  detectedAt?: string
  isolationRequired?: boolean
  treatmentRestricted?: boolean
  restrictionReason?: string
  cullingRequired?: boolean
  notes?: string
  status?: 'detected' | 'reported'
}

// ===== 医疗废弃物台账 =====

/** 废弃物状态:draft 草稿 / recorded 已记录 / handed_over 已交接 */
export type WasteRecordStatus = 'draft' | 'recorded' | 'handed_over'

/** medical_waste_records 表记录 */
export interface MedicalWasteRecord {
  id: string
  tenant_id: string
  store_id: string
  waste_type: string
  quantity: number
  unit: string | null
  generated_at: string
  handover_at: string | null
  handler_employee_id: string | null
  receiver: string | null
  disposal_method: string | null
  attachment_file_id: string | null
  notes: string | null
  status: WasteRecordStatus
  created_at: string
  created_by: string | null
  updated_at: string
  // 直连 join 门店/员工
  stores?: { name: string | null, code: string | null } | null
  employees?: { name: string | null } | null
}

/** 废弃物保存入参(storeId 由 StorePicker 提供,员工用 EmployeePicker) */
export interface SaveWasteRecordInput {
  storeId: string
  recordId?: string
  wasteType: string
  quantity?: number
  unit?: string
  generatedAt?: string
  handlerEmployeeId?: string
  notes?: string
  attachmentFileId?: string
  status?: 'draft' | 'recorded'
}

/** 废弃物交接入参(员工用 EmployeePicker) */
export interface HandoverWasteInput {
  handlerEmployeeId?: string
  receiver: string
  disposalMethod?: string
  handoverAt?: string
}

// ===== UI 显示映射 =====

/** 许可证状态标签映射(active 且已到期由列表派生"已过期") */
export const LICENSE_STATUS_LABELS: Record<LicenseStatus, string> = {
  draft: '草稿',
  active: '有效',
  suspended: '暂停',
  revoked: '注销',
  expired: '过期',
}

/** 年度报告状态标签映射 */
export const REGULATORY_REPORT_STATUS_LABELS: Record<RegulatoryReportStatus, string> = {
  draft: '草稿',
  generated: '已生成',
  submitted: '已提交',
  accepted: '已受理',
  rejected: '已驳回',
}

/** 疫情事件状态标签映射 */
export const EPIDEMIC_STATUS_LABELS: Record<EpidemicEventStatus, string> = {
  detected: '已发现',
  reported: '已上报',
  isolated: '已隔离',
  resolved: '已解除',
}

/** 医疗废弃物状态标签映射 */
export const WASTE_STATUS_LABELS: Record<WasteRecordStatus, string> = {
  draft: '草稿',
  recorded: '已记录',
  handed_over: '已交接',
}
