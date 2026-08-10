/**
 * Diagnostics 疫苗与检验领域类型定义(MXQ-10001~10011)
 * 与 supabase/migrations/20260806000022_diagnostics.sql 对齐
 */

// ===== 疫苗方案(MXQ-10001) =====

/** 物种 */
export type PetSpecies = 'dog' | 'cat' | 'rabbit' | 'other'

/** vaccine_protocols 表记录 */
export interface VaccineProtocol {
  id: string
  tenant_id: string
  code: string
  name: string
  species: PetSpecies
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/** vaccine_protocol_items 表记录 */
export interface VaccineProtocolItem {
  id: string
  protocol_id: string
  vaccine_catalog_item_id: string | null
  dose_no: number
  min_age_weeks: number | null
  max_age_weeks: number | null
  interval_days: number | null
  is_required: boolean
  remark: string | null
  created_at: string
}

/** 疫苗方案含明细(联表查询结果) */
export interface VaccineProtocolWithItems extends VaccineProtocol {
  items?: VaccineProtocolItem[]
}

/** 创建疫苗方案入参 */
export interface CreateVaccineProtocolInput {
  tenantId: string
  code: string
  name: string
  species?: PetSpecies
  description?: string
  isActive?: boolean
}

/** 创建疫苗方案明细入参 */
export interface CreateVaccineProtocolItemInput {
  protocolId: string
  vaccineCatalogItemId?: string
  doseNo: number
  minAgeWeeks?: number
  maxAgeWeeks?: number
  intervalDays?: number
  isRequired?: boolean
  remark?: string
}

// ===== 疫苗接种(MXQ-10002) =====

/** 疫苗接种状态机:scheduled→administered; scheduled→overdue; scheduled→skipped */
export type VaccinationStatus = 'scheduled' | 'administered' | 'skipped' | 'overdue'

/** vaccinations 表记录 */
export interface VaccinationRecord {
  id: string
  tenant_id: string
  store_id: string | null
  customer_id: string
  pet_id: string
  encounter_id: string | null
  vaccine_catalog_item_id: string | null
  protocol_item_id: string | null
  dose_no: number
  scheduled_date: string | null
  administered_date: string | null
  administered_by: string | null
  batch_no: string | null
  manufacturer: string | null
  status: VaccinationStatus
  next_due_date: string | null
  remark: string | null
  created_at: string
  updated_at: string
}

/** 疫苗接种列表查询参数 */
export interface VaccinationListParams {
  storeId?: string
  petId?: string
  customerId?: string
  status?: VaccinationStatus
  encounterId?: string
  page?: number
  pageSize?: number
}

/** 疫苗接种列表响应 */
export interface VaccinationListResult {
  list: VaccinationRecord[]
  total: number
  page: number
  pageSize: number
}

/** 创建疫苗接种入参 */
export interface CreateVaccinationInput {
  tenantId: string
  storeId?: string
  customerId: string
  petId: string
  encounterId?: string
  vaccineCatalogItemId?: string
  protocolItemId?: string
  doseNo?: number
  scheduledDate?: string
  batchNo?: string
  manufacturer?: string
  remark?: string
}

/** 更新疫苗接种入参 */
export interface UpdateVaccinationInput {
  scheduledDate?: string
  administeredDate?: string
  batchNo?: string
  manufacturer?: string
  status?: VaccinationStatus
  nextDueDate?: string
  remark?: string
}

// ===== 驱虫(MXQ-10003) =====

/** 寄生虫类型 */
export type ParasiteType = 'internal' | 'external' | 'both'

/** 驱虫记录状态:done/scheduled */
export type DewormingStatus = 'done' | 'scheduled'

/** deworming_records 表记录 */
export interface DewormingRecord {
  id: string
  tenant_id: string
  store_id: string | null
  customer_id: string
  pet_id: string
  encounter_id: string | null
  drug_catalog_item_id: string | null
  drug_name: string
  dose: string | null
  administered_date: string
  administered_by: string | null
  next_due_date: string | null
  parasite_type: ParasiteType
  status: DewormingStatus
  remark: string | null
  created_at: string
}

/** 创建驱虫记录入参 */
export interface CreateDewormingInput {
  tenantId: string
  storeId?: string
  customerId: string
  petId: string
  encounterId?: string
  drugCatalogItemId?: string
  drugName: string
  dose?: string
  administeredDate?: string
  nextDueDate?: string
  parasiteType?: ParasiteType
  status?: DewormingStatus
  remark?: string
}

/** 更新驱虫记录入参 */
export interface UpdateDewormingInput {
  drugName?: string
  dose?: string
  administeredDate?: string
  nextDueDate?: string
  parasiteType?: ParasiteType
  status?: DewormingStatus
  remark?: string
}

// ===== 提醒(MXQ-10004) =====

/** 提醒类型 */
export type DiagReminderType = 'vaccine' | 'deworming'

/** 提醒状态:pending/sent/cancelled */
export type DiagReminderStatus = 'pending' | 'sent' | 'cancelled'

/** diag_reminders 表记录 */
export interface DiagReminder {
  id: string
  tenant_id: string
  store_id: string | null
  customer_id: string
  pet_id: string
  reminder_type: DiagReminderType
  reference_id: string | null
  due_date: string
  status: DiagReminderStatus
  created_at: string
  sent_at: string | null
}

/** 提醒列表查询参数 */
export interface DiagReminderListParams {
  storeId?: string
  petId?: string
  reminderType?: DiagReminderType
  status?: DiagReminderStatus
  page?: number
  pageSize?: number
}

/** 扫描提醒 RPC 返回结果 */
export interface ScanRemindersResult {
  scanned_count: number
  inserted_count: number
}

// ===== 疫苗证明(MXQ-10005) =====

/** 疫苗证明状态:issued/revoked */
export type VaccineCertificateStatus = 'issued' | 'revoked'

/** vaccine_certificates 表记录 */
export interface VaccineCertificate {
  id: string
  tenant_id: string
  store_id: string | null
  pet_id: string
  customer_id: string
  vaccination_id: string
  certificate_no: string
  issued_date: string
  issued_by: string | null
  certificate_data: Record<string, unknown>
  pdf_file_id: string | null
  status: VaccineCertificateStatus
  created_at: string
}

/** 签发证明入参 */
export interface IssueCertificateInput {
  vaccinationId: string
  pdfFileId?: string
}

// ===== 检验申请(MXQ-10006) =====

/** 检验申请状态机:requested→collected→completed; requested→cancelled */
export type LabOrderStatus = 'requested' | 'collected' | 'completed' | 'cancelled'

/** lab_orders 表记录 */
export interface LabOrderRecord {
  id: string
  tenant_id: string
  store_id: string | null
  customer_id: string
  pet_id: string
  encounter_id: string | null
  panel_id: string | null
  order_no: string
  status: LabOrderStatus
  requested_by: string | null
  requested_at: string
  collected_at: string | null
  collected_by: string | null
  completed_at: string | null
  remark: string | null
  created_at: string
  updated_at: string
}

/** 检验申请列表查询参数 */
export interface LabOrderListParams {
  storeId?: string
  petId?: string
  customerId?: string
  encounterId?: string
  status?: LabOrderStatus
  page?: number
  pageSize?: number
}

/** 检验申请列表响应 */
export interface LabOrderListResult {
  list: LabOrderRecord[]
  total: number
  page: number
  pageSize: number
}

// ===== 检验工作台统一业务状态(P0-27) =====

/** 工作台业务状态:后端推导,前端只消费 */
export type LabWorkflowStage = 'awaiting_sample' | 'testing' | 'awaiting_review' | 'published' | 'rejected' | 'cancelled'

/** 工作台主动作 */
export type LabPrimaryAction = 'collect' | 'publish' | 'review' | null

/** lab-workbench 端点返回的带业务状态的行 */
export interface LabWorkbenchRecord extends LabOrderRecord {
  workflowStage: LabWorkflowStage
  primaryAction: LabPrimaryAction
  canEditResult: boolean
  canReview: boolean
  canPublish: boolean
}

/** 检验工作台查询参数 */
export interface LabWorkbenchListParams {
  storeId?: string
  petId?: string
  encounterId?: string
  stage?: LabWorkflowStage
  page?: number
  pageSize?: number
}

/** 检验工作台列表响应 */
export interface LabWorkbenchListResult {
  list: LabWorkbenchRecord[]
  total: number
  page: number
  pageSize: number
}

/** 工作台业务状态中文标签 */
export const LAB_WORKFLOW_STAGE_LABELS: Record<LabWorkflowStage, string> = {
  awaiting_sample: '待采样',
  testing: '检测中',
  awaiting_review: '待审核',
  published: '已发布',
  rejected: '退回',
  cancelled: '已取消',
}

// ===== 影像工作流(PRD §12.3) =====

export type ImagingType = 'ultrasound' | 'xray' | 'cr' | 'ct' | 'mri' | 'other'
export type ImagingOrderStatus = 'requested' | 'scheduled' | 'in_progress' | 'performed' | 'reported' | 'reviewed' | 'published' | 'cancelled'
export type ImagingOrderStage = 'awaiting_schedule' | 'awaiting_perform' | 'awaiting_report' | 'awaiting_review' | 'published' | 'cancelled'
export type ImagingReportStatus = 'draft' | 'submitted' | 'reviewed' | 'published'

/** imaging_orders 表记录 */
export interface ImagingOrderRecord {
  id: string
  tenant_id: string
  store_id: string | null
  order_no: string
  encounter_id: string | null
  customer_id: string
  pet_id: string
  requested_by: string | null
  imaging_type: ImagingType
  catalog_item_id: string | null
  scheduled_at: string | null
  performed_at: string | null
  performed_by: string | null
  status: ImagingOrderStatus
  clinical_question: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

/** 影像工作台行:后端推导 workflowStage/primaryAction */
export interface ImagingOrderWorkbenchRecord extends ImagingOrderRecord {
  workflowStage: ImagingOrderStage
  primaryAction: 'schedule' | 'perform' | 'report' | 'review' | null
  /** S3.1-Fix B4:每单最新报告行状态(draft 优先);无报告时为 null */
  latestReportStatus?: ImagingReportStatus | null
  /** S3.1-Fix B4:最新报告为 draft 且订单未取消(已发布报告存在修订待处理) */
  revisionPending?: boolean
}

/** imaging_reports 表记录(版本化) */
export interface ImagingReportRecord {
  id: string
  tenant_id: string
  store_id: string | null
  imaging_order_id: string
  version: number
  findings: string | null
  impression: string | null
  recommendation: string | null
  author_id: string | null
  reviewer_id: string | null
  status: ImagingReportStatus
  published_at: string | null
  created_at: string
  updated_at: string
}

/** 影像附件(attachments + files) */
export interface ImagingAttachmentRecord {
  id: string
  entity_type: 'imaging_order' | 'imaging_report'
  entity_id: string
  purpose: string
  created_at: string
  file: {
    id: string
    original_name: string
    mime_type: string
    size_bytes: number
    object_key: string
    status: string
  }
}

export const IMAGING_TYPE_LABELS: Record<ImagingType, string> = {
  ultrasound: 'B 超',
  xray: 'X 光',
  cr: 'CR',
  ct: 'CT',
  mri: 'MRI',
  other: '其他',
}

export const IMAGING_STAGE_LABELS: Record<ImagingOrderStage, string> = {
  awaiting_schedule: '待预约',
  awaiting_perform: '待执行',
  awaiting_report: '待报告',
  awaiting_review: '待审核',
  published: '已发布',
  cancelled: '已取消',
}

export const IMAGING_REPORT_STATUS_LABELS: Record<ImagingReportStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  reviewed: '已审核',
  published: '已发布',
}

/** 创建检验申请入参 */
export interface CreateLabOrderInput {
  tenantId: string
  storeId?: string
  customerId: string
  petId: string
  encounterId?: string
  panelId?: string
  catalogItemId?: string
  remark?: string
}

// ===== 检验结果项(MXQ-10006/10008) =====

/** 结果标志 */
export type ResultFlag = 'low' | 'high' | 'critical'

/** lab_order_analytes 表记录 */
export interface LabOrderAnalyte {
  id: string
  lab_order_id: string
  analyte_id: string | null
  result_value: string | null
  result_numeric: number | null
  is_abnormal: boolean
  is_critical: boolean
  flag: ResultFlag | null
  resulted_at: string | null
  resulted_by: string | null
  note: string | null
  /** S3.1-C:危急值项目代码(如 'GLU-H'),可空 */
  critical_value_code: string | null
  created_at: string
}

/** 录入检验结果项 */
export interface LabResultInput {
  id: string
  result_value?: string
  result_numeric?: number
  is_abnormal?: boolean
  is_critical?: boolean
  flag?: ResultFlag
  note?: string
}

/** 发布检验结果入参(走 RPC) */
export interface PublishLabResultsInput {
  labOrderId: string
  results: LabResultInput[]
}

// ===== 标本(MXQ-10007) =====

/** 标本类型 */
export type SpecimenType = 'blood' | 'urine' | 'feces' | 'tissue' | 'other'

/** 标本状态机:collected→in_transit→received→discarded */
export type SpecimenStatus = 'collected' | 'in_transit' | 'received' | 'discarded'

/** lab_specimens 表记录 */
export interface LabSpecimen {
  id: string
  tenant_id: string
  lab_order_id: string
  specimen_type: SpecimenType
  collection_method: string | null
  collected_at: string
  collected_by: string | null
  container_id: string | null
  storage_condition: string | null
  status: SpecimenStatus
  received_at: string | null
  received_by: string | null
  remark: string | null
  created_at: string
}

/** 创建标本入参 */
export interface CreateLabSpecimenInput {
  tenantId: string
  labOrderId: string
  specimenType?: SpecimenType
  collectionMethod?: string
  containerId?: string
  storageCondition?: string
  remark?: string
}

/** 更新标本入参 */
export interface UpdateLabSpecimenInput {
  specimenType?: SpecimenType
  collectionMethod?: string
  containerId?: string
  storageCondition?: string
  status?: SpecimenStatus
  remark?: string
}

// ===== 标本流转闭环 lab_samples(S3.1-C,migration 45) =====

/** 标本流转状态机:planned→collected→received→testing→completed;任意非终态→rejected */
export type LabSampleStatus = 'planned' | 'collected' | 'received' | 'testing' | 'completed' | 'rejected'

/** lab_samples 表记录(S3.1 完整标本流转闭环,与旧 lab_specimens 并存) */
export interface LabSampleRecord {
  id: string
  tenant_id: string
  store_id: string | null
  lab_order_id: string
  sample_no: string
  sample_type: SpecimenType
  status: LabSampleStatus
  planned_at: string
  planned_by: string | null
  collected_at: string | null
  collected_by: string | null
  received_at: string | null
  received_by: string | null
  rejected_at: string | null
  rejected_by: string | null
  reject_reason: string | null
  container: string | null
  storage_condition: string | null
  remark: string | null
  created_at: string
  updated_at: string
}

/** 标本列表查询参数 */
export interface LabSampleListParams {
  storeId?: string
  labOrderId?: string
  status?: LabSampleStatus
  page?: number
  pageSize?: number
}

/** 创建标本入参(走 Hono Command + create_lab_sample RPC) */
export interface CreateLabSampleInput {
  labOrderId: string
  sampleType?: SpecimenType
  container?: string
  storageCondition?: string
  remark?: string
}

/** 标本状态流转入参(走 Hono Command + transition_lab_sample RPC) */
export interface TransitionLabSampleInput {
  toStatus: LabSampleStatus
  reason?: string
}

// ===== 检验结果审核(MXQ-10008) =====

/** 审核决定 */
export type ReviewDecision = 'approved' | 'rejected'

/** lab_result_reviews 表记录 */
export interface LabResultReview {
  id: string
  lab_order_id: string
  reviewed_by: string | null
  reviewed_at: string
  decision: ReviewDecision
  comment: string | null
  created_at: string
}

/** 审核结果入参(走 RPC) */
export interface ReviewLabResultsInput {
  labOrderId: string
  decision: ReviewDecision
  comment?: string
}

// ===== 危急值告警(MXQ-10009) =====

/** 告警等级 */
export type CriticalAlertLevel = 'critical' | 'significant'

/** 危急值告警状态机:pending→acknowledged→resolved */
export type CriticalAlertStatus = 'pending' | 'acknowledged' | 'resolved'

/** critical_value_alerts 表记录 */
export interface CriticalValueAlert {
  id: string
  tenant_id: string
  store_id: string | null
  lab_order_id: string
  analyte_id: string | null
  pet_id: string
  alert_level: CriticalAlertLevel
  message: string | null
  status: CriticalAlertStatus
  acknowledged_by: string | null
  acknowledged_at: string | null
  /** S3.1-C:危急值项目代码(如 'GLU-H'),可空 */
  critical_value_code: string | null
  notified_at: string | null
  notified_by: string | null
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
}

/** 危急值告警列表查询参数 */
export interface CriticalAlertListParams {
  storeId?: string
  petId?: string
  status?: CriticalAlertStatus
  labOrderId?: string
  page?: number
  pageSize?: number
}

/** 通知渠道 */
export type NotifyChannel = 'phone' | 'wechat' | 'inperson' | 'other'

/** 通知危急值入参(走 Hono Command + notify_critical_value RPC,不改变状态) */
export interface NotifyCriticalValueInput {
  channel?: NotifyChannel
}

/** 确认/解除危急值入参(走 Hono Command + ack_critical_value RPC) */
export interface AckCriticalValueInput {
  toStatus?: 'acknowledged' | 'resolved'
  note?: string
}

// ===== 状态机转换矩阵 =====

/** 疫苗接种状态机 */
export const VACCINATION_STATUS_TRANSITIONS: Record<VaccinationStatus, VaccinationStatus[]> = {
  scheduled: ['administered', 'overdue', 'skipped'],
  administered: [],
  overdue: [],
  skipped: [],
}

/** 检验申请状态机 */
export const LAB_ORDER_STATUS_TRANSITIONS: Record<LabOrderStatus, LabOrderStatus[]> = {
  requested: ['collected', 'cancelled'],
  collected: ['completed'],
  completed: [],
  cancelled: [],
}

/** 标本状态机 */
export const SPECIMEN_STATUS_TRANSITIONS: Record<SpecimenStatus, SpecimenStatus[]> = {
  collected: ['in_transit', 'discarded'],
  in_transit: ['received', 'discarded'],
  received: ['discarded'],
  discarded: [],
}

/** 标本流转状态机(S3.1-C):planned→collected→received→testing→completed;任意非终态→rejected */
export const LAB_SAMPLE_STATUS_TRANSITIONS: Record<LabSampleStatus, LabSampleStatus[]> = {
  planned: ['collected', 'rejected'],
  collected: ['received', 'rejected'],
  received: ['testing', 'rejected'],
  testing: ['completed', 'rejected'],
  completed: [],
  rejected: [],
}

/** 危急值告警状态机 */
export const CRITICAL_ALERT_STATUS_TRANSITIONS: Record<CriticalAlertStatus, CriticalAlertStatus[]> = {
  pending: ['acknowledged'],
  acknowledged: ['resolved'],
  resolved: [],
}

/** 疫苗证明状态机 */
export const VACCINE_CERTIFICATE_STATUS_TRANSITIONS: Record<VaccineCertificateStatus, VaccineCertificateStatus[]> = {
  issued: ['revoked'],
  revoked: [],
}

/**
 * 校验标本流转状态转换是否合法(S3.1-C)
 */
export function canTransitionLabSampleStatus(from: LabSampleStatus, to: LabSampleStatus): boolean {
  return LAB_SAMPLE_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * 校验疫苗接种状态转换是否合法
 */
export function canTransitionVaccinationStatus(from: VaccinationStatus, to: VaccinationStatus): boolean {
  return VACCINATION_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * 校验检验申请状态转换是否合法
 */
export function canTransitionLabOrderStatus(from: LabOrderStatus, to: LabOrderStatus): boolean {
  return LAB_ORDER_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * 校验标本状态转换是否合法
 */
export function canTransitionSpecimenStatus(from: SpecimenStatus, to: SpecimenStatus): boolean {
  return SPECIMEN_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * 校验危急值告警状态转换是否合法
 */
export function canTransitionCriticalAlertStatus(from: CriticalAlertStatus, to: CriticalAlertStatus): boolean {
  return CRITICAL_ALERT_STATUS_TRANSITIONS[from].includes(to)
}

// ===== UI 显示映射 =====

/** 疫苗接种状态标签 */
export const VACCINATION_STATUS_LABELS: Record<VaccinationStatus, string> = {
  scheduled: '已计划',
  administered: '已接种',
  skipped: '已跳过',
  overdue: '已逾期',
}

/** 疫苗接种状态颜色 */
export const VACCINATION_STATUS_COLORS: Record<VaccinationStatus, string> = {
  scheduled: 'info',
  administered: 'success',
  skipped: 'default',
  overdue: 'danger',
}

/** 物种标签 */
export const PET_SPECIES_LABELS: Record<PetSpecies, string> = {
  dog: '犬',
  cat: '猫',
  rabbit: '兔',
  other: '其他',
}

/** 寄生虫类型标签 */
export const PARASITE_TYPE_LABELS: Record<ParasiteType, string> = {
  internal: '体内',
  external: '体外',
  both: '内外',
}

/** 驱虫状态标签 */
export const DEWORMING_STATUS_LABELS: Record<DewormingStatus, string> = {
  done: '已完成',
  scheduled: '已计划',
}

/** 提醒类型标签 */
export const DIAG_REMINDER_TYPE_LABELS: Record<DiagReminderType, string> = {
  vaccine: '疫苗',
  deworming: '驱虫',
}

/** 提醒状态标签 */
export const DIAG_REMINDER_STATUS_LABELS: Record<DiagReminderStatus, string> = {
  pending: '待发送',
  sent: '已发送',
  cancelled: '已取消',
}

/** 疫苗证明状态标签 */
export const VACCINE_CERTIFICATE_STATUS_LABELS: Record<VaccineCertificateStatus, string> = {
  issued: '已签发',
  revoked: '已撤销',
}

/** 检验申请状态标签 */
export const LAB_ORDER_STATUS_LABELS: Record<LabOrderStatus, string> = {
  requested: '已申请',
  collected: '已采集',
  completed: '已完成',
  cancelled: '已取消',
}

/** 检验申请状态颜色 */
export const LAB_ORDER_STATUS_COLORS: Record<LabOrderStatus, string> = {
  requested: 'info',
  collected: 'warning',
  completed: 'success',
  cancelled: 'default',
}

/** 标本类型标签 */
export const SPECIMEN_TYPE_LABELS: Record<SpecimenType, string> = {
  blood: '血液',
  urine: '尿液',
  feces: '粪便',
  tissue: '组织',
  other: '其他',
}

/** 标本状态标签 */
export const SPECIMEN_STATUS_LABELS: Record<SpecimenStatus, string> = {
  collected: '已采集',
  in_transit: '运送中',
  received: '已接收',
  discarded: '已废弃',
}

/** 标本状态颜色 */
export const SPECIMEN_STATUS_COLORS: Record<SpecimenStatus, string> = {
  collected: 'info',
  in_transit: 'warning',
  received: 'success',
  discarded: 'default',
}

/** 标本流转状态标签(S3.1-C) */
export const LAB_SAMPLE_STATUS_LABELS: Record<LabSampleStatus, string> = {
  planned: '待采集',
  collected: '已采集',
  received: '已签收',
  testing: '检测中',
  completed: '已完成',
  rejected: '已拒收',
}

/** 标本流转状态颜色(S3.1-C) */
export const LAB_SAMPLE_STATUS_COLORS: Record<LabSampleStatus, string> = {
  planned: 'default',
  collected: 'info',
  received: 'warning',
  testing: 'primary',
  completed: 'success',
  rejected: 'danger',
}

/** 通知渠道标签(S3.1-C) */
export const NOTIFY_CHANNEL_LABELS: Record<NotifyChannel, string> = {
  phone: '电话',
  wechat: '微信',
  inperson: '当面',
  other: '其他',
}

/** 审核决定标签 */
export const REVIEW_DECISION_LABELS: Record<ReviewDecision, string> = {
  approved: '通过',
  rejected: '驳回',
}

/** 危急值告警等级标签 */
export const CRITICAL_ALERT_LEVEL_LABELS: Record<CriticalAlertLevel, string> = {
  critical: '危急',
  significant: '显著',
}

/** 危急值告警状态标签 */
export const CRITICAL_ALERT_STATUS_LABELS: Record<CriticalAlertStatus, string> = {
  pending: '待确认',
  acknowledged: '已确认',
  resolved: '已解决',
}

/** 危急值告警状态颜色 */
export const CRITICAL_ALERT_STATUS_COLORS: Record<CriticalAlertStatus, string> = {
  pending: 'danger',
  acknowledged: 'warning',
  resolved: 'success',
}

/** 结果标志标签 */
export const RESULT_FLAG_LABELS: Record<ResultFlag, string> = {
  low: '偏低',
  high: '偏高',
  critical: '危急',
}
