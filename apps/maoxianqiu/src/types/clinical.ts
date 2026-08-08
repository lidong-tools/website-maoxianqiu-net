/**
 * Clinical 诊疗核心领域类型定义(MXQ-7001~7011)
 * 与 supabase/migrations/20260806000019_clinical.sql 对齐
 */

// ===== 预约相关 =====

/** 预约状态机:pending→confirmed→checked_in→in_progress→completed;任意非终态→cancelled/no_show */
export type AppointmentStatus = 'pending' | 'confirmed' | 'checked_in' | 'in_progress' | 'completed' | 'cancelled' | 'no_show'

/** 预约来源 */
export type AppointmentSource = 'walk_in' | 'phone' | 'online'

/** appointments 表记录 */
export interface AppointmentRecord {
  id: string
  tenant_id: string
  store_id: string | null
  customer_id: string
  pet_id: string
  doctor_id: string | null
  scheduled_start: string
  scheduled_end: string
  reason: string | null
  status: AppointmentStatus
  source: AppointmentSource
  remark: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** 预约列表查询参数 */
export interface AppointmentListParams {
  storeId?: string
  doctorId?: string
  petId?: string
  customerId?: string
  status?: AppointmentStatus
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
}

/** 预约列表响应 */
export interface AppointmentListResult {
  list: AppointmentRecord[]
  total: number
  page: number
  pageSize: number
}

/** 创建预约入参 */
export interface CreateAppointmentInput {
  tenantId: string
  storeId?: string
  customerId: string
  petId: string
  doctorId?: string
  scheduledStart: string
  scheduledEnd: string
  reason?: string
  source?: AppointmentSource
  remark?: string
}

/** 更新预约入参 */
export interface UpdateAppointmentInput {
  doctorId?: string
  scheduledStart?: string
  scheduledEnd?: string
  reason?: string
  source?: AppointmentSource
  remark?: string
}

// ===== 就诊/病历相关 =====

/** 就诊状态机:in_progress→completed→signed(终态,需修订) */
export type EncounterStatus = 'in_progress' | 'completed' | 'signed'

/** 病历归档状态:draft 草稿 / signed 已签署 / archived 已归档(S3.1-1 合规) */
export type ArchiveStatus = 'draft' | 'signed' | 'archived'

/** encounters 表记录 */
export interface EncounterRecord {
  id: string
  tenant_id: string
  store_id: string | null
  appointment_id: string | null
  customer_id: string
  pet_id: string
  doctor_id: string | null
  nurse_id: string | null
  started_at: string
  ended_at: string | null
  status: EncounterStatus
  chief_complaint: string | null
  history_present: string | null
  exam_findings: string | null
  diagnosis_codes: string[]
  diagnosis_text: string | null
  treatment_plan: string | null
  follow_up_date: string | null
  signed_by: string | null
  signed_at: string | null
  signed_by_employee_id: string | null
  archive_status: ArchiveStatus | null
  archive_due_at: string | null
  archived_at: string | null
  archived_by_employee_id: string | null
  retention_until: string | null
  retention_status: string | null
  /** 乐观锁版本号:每次更新 +1,保存时回传 expectedVersion 防并发覆盖 */
  version: number
  created_at: string
  updated_at: string
}

/** 就诊列表查询参数 */
export interface EncounterListParams {
  storeId?: string
  doctorId?: string
  petId?: string
  status?: EncounterStatus
  page?: number
  pageSize?: number
}

/** 就诊列表响应 */
export interface EncounterListResult {
  list: EncounterRecord[]
  total: number
  page: number
  pageSize: number
}

/** 创建就诊入参 */
export interface CreateEncounterInput {
  tenantId: string
  storeId?: string
  appointmentId?: string
  customerId: string
  petId: string
  doctorId?: string
  nurseId?: string
  chiefComplaint?: string
}

/** 更新就诊病历入参(仅 in_progress/completed 可改,signed 不可直接改) */
export interface UpdateEncounterInput {
  chiefComplaint?: string
  historyPresent?: string
  examFindings?: string
  diagnosisCodes?: string[]
  diagnosisText?: string
  treatmentPlan?: string
  followUpDate?: string
  nurseId?: string
  /** 状态推进(仅用于完成就诊等显式动作,RLS 拒绝 signed 回改) */
  status?: EncounterStatus
  /** 乐观锁:提交当前 version,不匹配时服务端返回 409 */
  expectedVersion?: number
}

/** 病历修订记录 */
export interface EncounterRevisionRecord {
  id: string
  encounter_id: string
  revision_no: number
  content_diff: Record<string, unknown>
  revised_by: string | null
  revised_at: string
  reason: string | null
  created_at: string
}

/** 签署病历入参 */
export interface SignEncounterInput {
  encounterId: string
  doctorId: string
}

/** 修订病历入参 */
export interface ReviseEncounterInput {
  encounterId: string
  content: Record<string, unknown>
  reason: string
}

// ===== 处方相关 =====

/** 处方状态机:draft→dispensed;draft→cancelled */
export type PrescriptionStatus = 'draft' | 'issued' | 'dispensed' | 'cancelled'

/** prescriptions 表记录 */
export interface PrescriptionRecord {
  id: string
  tenant_id: string
  store_id: string | null
  encounter_id: string
  customer_id: string
  pet_id: string
  doctor_id: string | null
  status: PrescriptionStatus
  issued_at: string | null
  valid_until: string | null
  prescriber_employee_id: string | null
  prescriber_user_id: string | null
  prescriber_veterinarian_registration_id: string | null
  signed_at: string | null
  signature_method: 'manual' | 'electronic' | null
  dispensed_by_employee_id: string | null
  dispensed_at: string | null
  retention_until: string | null
  retention_status: string | null
  created_at: string
  updated_at: string
}

/** prescription_items 表记录 */
export interface PrescriptionItemRecord {
  id: string
  prescription_id: string
  catalog_item_id: string | null
  drug_name: string
  dosage: string | null
  frequency: string | null
  duration_days: number | null
  quantity: number
  unit: string | null
  instructions: string | null
  sort_order: number
  created_at: string
}

/** 处方明细输入(保存处方时传入) */
export interface PrescriptionItemInput {
  catalogItemId?: string
  drugName: string
  dosage?: string
  frequency?: string
  durationDays?: number
  quantity?: number
  unit?: string
  instructions?: string
  sortOrder?: number
}

/** 保存处方入参 */
export interface SavePrescriptionInput {
  encounterId: string
  items: PrescriptionItemInput[]
}

/** 处方详情(含明细) */
export interface PrescriptionDetailResult {
  prescription: PrescriptionRecord
  items: PrescriptionItemRecord[]
}

// ===== 护士任务相关 =====

/** 护士任务类型 */
export type NurseTaskType = 'medication' | 'observation' | 'care' | 'sample_collection' | 'other'

/** 护士任务状态机(S3.1-C 扩展):pending→in_progress→completed/failed/cancelled;兼容旧 done/skipped */
export type NurseTaskStatus = 'pending' | 'in_progress' | 'done' | 'skipped' | 'completed' | 'failed' | 'cancelled'

/** 护士任务来源类型(medical_order 为医嘱自动生成,手动创建为空) */
export type NurseTaskSourceType = 'medical_order' | 'manual'

/** nurse_tasks 表记录 */
export interface NurseTaskRecord {
  id: string
  tenant_id: string
  store_id: string | null
  encounter_id: string | null
  pet_id: string
  assigned_to: string | null
  task_type: NurseTaskType
  description: string
  scheduled_at: string | null
  status: NurseTaskStatus
  completed_at: string | null
  completed_by: string | null
  note: string | null
  // S3.1-C 源增强(医嘱闭环)
  source_type: NurseTaskSourceType | null
  source_id: string | null
  started_at: string | null
  failed_reason: string | null
  exception_note: string | null
  overdue_at: string | null
  due_soon_at: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancel_reason: string | null
  created_at: string
  updated_at: string
}

/** 护士任务列表查询参数 */
export interface NurseTaskListParams {
  storeId?: string
  assigneeId?: string
  petId?: string
  encounterId?: string
  status?: NurseTaskStatus
  taskType?: NurseTaskType
  page?: number
  pageSize?: number
}

/** 护士任务列表响应 */
export interface NurseTaskListResult {
  list: NurseTaskRecord[]
  total: number
  page: number
  pageSize: number
}

/** 创建护士任务入参 */
export interface CreateNurseTaskInput {
  tenantId: string
  storeId?: string
  encounterId?: string
  petId: string
  assignedTo?: string
  taskType?: NurseTaskType
  description: string
  scheduledAt?: string
}

/** 更新护士任务入参 */
export interface UpdateNurseTaskInput {
  assignedTo?: string
  taskType?: NurseTaskType
  description?: string
  scheduledAt?: string
  status?: NurseTaskStatus
  note?: string
}

// ===== 医嘱(S3.1-C,migration 44) =====

/** 医嘱类型 */
export type MedicalOrderType = 'injection' | 'infusion' | 'treatment' | 'disposal' | 'nursing' | 'medication' | 'other'

/** 医嘱状态机:active→completed/cancelled/expired */
export type MedicalOrderStatus = 'active' | 'completed' | 'cancelled' | 'expired'

/** medical_orders 表记录 */
export interface MedicalOrderRecord {
  id: string
  tenant_id: string
  store_id: string | null
  encounter_id: string | null
  admission_id: string | null
  pet_id: string
  customer_id: string | null
  order_no: string
  order_type: MedicalOrderType
  item_name: string
  dosage: string | null
  frequency: string | null
  quantity: number
  unit: string | null
  instructions: string | null
  scheduled_at: string | null
  assignee_id: string | null
  status: MedicalOrderStatus
  created_by: string | null
  completed_at: string | null
  completed_by: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancel_reason: string | null
  created_at: string
  updated_at: string
}

/** 医嘱列表查询参数 */
export interface MedicalOrderListParams {
  storeId?: string
  petId?: string
  encounterId?: string
  admissionId?: string
  status?: MedicalOrderStatus
  orderType?: MedicalOrderType
  page?: number
  pageSize?: number
}

/** 开立医嘱入参(走 Hono Command + create_medical_order RPC) */
export interface CreateMedicalOrderInput {
  tenantId: string
  storeId?: string
  petId: string
  customerId?: string
  encounterId?: string
  admissionId?: string
  orderType?: MedicalOrderType
  itemName: string
  dosage?: string
  frequency?: string
  quantity?: number
  unit?: string
  instructions?: string
  scheduledAt?: string
  assigneeId?: string
  idempotencyKey?: string
}

/** 开立医嘱结果(含自动生成的护士任务 id) */
export interface CreateMedicalOrderResult {
  orderId: string
  taskId: string
  orderNo: string
  status: MedicalOrderStatus
}

/** 取消医嘱结果(未执行任务 → cancelled,已执行任务永久保留) */
export interface CancelMedicalOrderResult {
  orderId: string
  status: MedicalOrderStatus
  cancelledTasks: number
  keptExecutedTasks: number
}

/** medical_lab_refs 表记录(医嘱-检验申请关联) */
export interface MedicalLabRef {
  id: string
  tenant_id: string
  store_id: string | null
  medical_order_id: string
  lab_order_id: string
  link_type: 'order_request' | 'result_followup'
  created_by: string | null
  created_at: string
}

/** 医嘱详情(含关联护士任务与检验申请) */
export interface MedicalOrderDetailResult {
  order: MedicalOrderRecord
  tasks: NurseTaskRecord[]
  labRefs: MedicalLabRef[]
}

/** 护士任务超时扫描结果 */
export interface ScanNurseTaskOverdueResult {
  overdueCount: number
  dueSoonCount: number
}

// ===== 状态机转换矩阵 =====

/** 预约状态机转换矩阵 */
export const APPOINTMENT_STATUS_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending: ['confirmed', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
}

/** 就诊状态机转换矩阵 */
export const ENCOUNTER_STATUS_TRANSITIONS: Record<EncounterStatus, EncounterStatus[]> = {
  in_progress: ['completed', 'signed'],
  completed: ['signed'],
  signed: [],
}

/** 处方状态机转换矩阵 */
export const PRESCRIPTION_STATUS_TRANSITIONS: Record<PrescriptionStatus, PrescriptionStatus[]> = {
  draft: ['issued', 'cancelled'],
  issued: ['dispensed', 'cancelled'],
  dispensed: [],
  cancelled: [],
}

/** 护士任务状态机转换矩阵(S3.1-C:completed/failed/cancelled 为终态) */
export const NURSE_TASK_STATUS_TRANSITIONS: Record<NurseTaskStatus, NurseTaskStatus[]> = {
  pending: ['in_progress', 'skipped', 'completed', 'failed', 'cancelled'],
  in_progress: ['done', 'skipped', 'completed', 'failed', 'cancelled'],
  done: ['completed'],
  skipped: ['completed'],
  completed: [],
  failed: [],
  cancelled: [],
}

/**
 * 校验预约状态转换是否合法
 */
export function canTransitionAppointmentStatus(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * 校验就诊状态转换是否合法
 */
export function canTransitionEncounterStatus(from: EncounterStatus, to: EncounterStatus): boolean {
  return ENCOUNTER_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * 校验处方状态转换是否合法
 */
export function canTransitionPrescriptionStatus(from: PrescriptionStatus, to: PrescriptionStatus): boolean {
  return PRESCRIPTION_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * 校验护士任务状态转换是否合法
 */
export function canTransitionNurseTaskStatus(from: NurseTaskStatus, to: NurseTaskStatus): boolean {
  return NURSE_TASK_STATUS_TRANSITIONS[from].includes(to)
}

// ===== UI 显示映射 =====

/** 预约状态标签映射 */
export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending: '待确认',
  confirmed: '已确认',
  checked_in: '已候诊',
  in_progress: '就诊中',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '爽约',
}

/** 预约状态颜色映射(用于 UI 标签) */
export const APPOINTMENT_STATUS_COLORS: Record<AppointmentStatus, string> = {
  pending: 'default',
  confirmed: 'info',
  checked_in: 'warning',
  in_progress: 'primary',
  completed: 'success',
  cancelled: 'default',
  no_show: 'danger',
}

/** 预约来源标签映射 */
export const APPOINTMENT_SOURCE_LABELS: Record<AppointmentSource, string> = {
  walk_in: '到店',
  phone: '电话',
  online: '线上',
}

/** 就诊状态标签映射 */
export const ENCOUNTER_STATUS_LABELS: Record<EncounterStatus, string> = {
  in_progress: '进行中',
  completed: '已完成',
  signed: '已签署',
}

/** 就诊状态颜色映射 */
export const ENCOUNTER_STATUS_COLORS: Record<EncounterStatus, string> = {
  in_progress: 'primary',
  completed: 'info',
  signed: 'success',
}

/** 处方状态标签映射 */
export const PRESCRIPTION_STATUS_LABELS: Record<PrescriptionStatus, string> = {
  draft: '待发药',
  issued: '已开具',
  dispensed: '已发药',
  cancelled: '已取消',
}

/** 处方状态颜色映射 */
export const PRESCRIPTION_STATUS_COLORS: Record<PrescriptionStatus, string> = {
  draft: 'warning',
  issued: 'info',
  dispensed: 'success',
  cancelled: 'default',
}

/** 护士任务类型标签映射 */
export const NURSE_TASK_TYPE_LABELS: Record<NurseTaskType, string> = {
  medication: '给药',
  observation: '观察',
  care: '护理',
  sample_collection: '采样',
  other: '其他',
}

/** 护士任务状态标签映射 */
export const NURSE_TASK_STATUS_LABELS: Record<NurseTaskStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  done: '已完成(旧)',
  skipped: '已跳过',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已取消',
}

/** 护士任务状态颜色映射 */
export const NURSE_TASK_STATUS_COLORS: Record<NurseTaskStatus, string> = {
  pending: 'default',
  in_progress: 'primary',
  done: 'success',
  skipped: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'default',
}

// ===== 医嘱 UI 映射(S3.1-C) =====

/** 医嘱类型标签映射 */
export const MEDICAL_ORDER_TYPE_LABELS: Record<MedicalOrderType, string> = {
  injection: '注射',
  infusion: '输液',
  treatment: '治疗',
  disposal: '处置',
  nursing: '护理',
  medication: '用药',
  other: '其他',
}

/** 医嘱状态标签映射 */
export const MEDICAL_ORDER_STATUS_LABELS: Record<MedicalOrderStatus, string> = {
  active: '执行中',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已过期',
}

/** 医嘱状态颜色映射 */
export const MEDICAL_ORDER_STATUS_COLORS: Record<MedicalOrderStatus, string> = {
  active: 'primary',
  completed: 'success',
  cancelled: 'default',
  expired: 'warning',
}
