/**
 * Inpatient 住院管理领域类型定义(MXQ-11001~11009)
 * 与 supabase/migrations/20260806000021_inpatient.sql 对齐
 */

/** 房间类型 */
export type RoomType = 'ward' | 'icu' | 'isolation' | 'standard'

/** 笼位类型 */
export type CageType = 'cage' | 'run' | 'tank'

/** 笼位状态机:available → occupied → available(出院);available → maintenance/cleaning → available */
export type CageStatus = 'available' | 'occupied' | 'maintenance' | 'cleaning'

/** 入院状态机:admitted → discharged;admitted → transferred(换房不改状态,只更新 cage_id) */
export type AdmissionStatus = 'admitted' | 'discharged' | 'transferred'

/** 护理频率 */
export type NursingFrequency = 'q4h' | 'q6h' | 'q8h' | 'q12h' | 'daily' | 'twice_daily'

/** 护理任务类型 */
export type NursingTaskType
  = | 'medication'
    | 'feeding'
    | 'walking'
    | 'observation'
    | 'wound_care'
    | 'fluid'
    | 'other'

/** 护理任务状态机:pending → in_progress → done;pending → skipped */
export type NursingTaskStatus = 'pending' | 'in_progress' | 'done' | 'skipped'

/** 班次类型 */
export type ShiftType = 'morning' | 'evening' | 'night'

/** rooms 表记录(房间) */
export interface Room {
  id: string
  tenant_id: string
  store_id: string
  name: string
  code: string
  floor: string | null
  room_type: RoomType
  capacity: number
  is_active: boolean
  created_at: string
  updated_at: string
}

/** cages 表记录(笼位) */
export interface Cage {
  id: string
  tenant_id: string
  store_id: string
  room_id: string
  name: string
  code: string
  cage_type: CageType
  daily_rate: number
  status: CageStatus
  current_admission_id: string | null
  created_at: string
  updated_at: string
}

/** admissions 表记录(住院记录) */
export interface Admission {
  id: string
  tenant_id: string
  store_id: string
  customer_id: string
  pet_id: string
  cage_id: string
  doctor_id: string | null
  admission_reason: string | null
  admitted_at: string
  status: AdmissionStatus
  discharged_at: string | null
  discharge_reason: string | null
  discharge_notes: string | null
  total_charge: number
  created_at: string
  updated_at: string
}

/** nursing_plans 表记录(护理计划) */
export interface NursingPlan {
  id: string
  tenant_id: string
  store_id: string
  admission_id: string
  pet_id: string
  plan_name: string
  frequency: NursingFrequency
  start_date: string
  end_date: string | null
  is_active: boolean
  created_by: string | null
  created_at: string
}

/** nursing_tasks 表记录(护理任务) */
export interface NursingTask {
  id: string
  tenant_id: string
  store_id: string
  admission_id: string
  pet_id: string
  plan_id: string | null
  task_type: NursingTaskType
  description: string | null
  scheduled_at: string
  assigned_to: string | null
  status: NursingTaskStatus
  completed_at: string | null
  completed_by: string | null
  note: string | null
  created_at: string
}

/** shift_handovers 表记录(交接班) */
export interface ShiftHandover {
  id: string
  tenant_id: string
  store_id: string
  shift_date: string
  shift_type: ShiftType
  outgoing_user: string | null
  incoming_user: string | null
  /** 按宠物汇总的交接班内容 */
  summary: Record<string, unknown>
  acknowledged_at: string | null
  acknowledged_by: string | null
  created_at: string
}

/** cage_transfers 表记录(换房历史) */
export interface CageTransfer {
  id: string
  tenant_id: string
  store_id: string
  admission_id: string
  from_cage_id: string
  to_cage_id: string
  reason: string | null
  operator_id: string | null
  created_at: string
}

/** inpatient_charges 表记录(住院费用) */
export interface InpatientCharge {
  id: string
  tenant_id: string
  store_id: string
  admission_id: string
  charge_date: string
  catalog_item_id: string | null
  description: string | null
  quantity: number
  unit_price: number
  amount: number
  is_auto: boolean
  created_at: string
}

/** inpatient_cage_status 视图记录(房态看板) */
export interface CageStatusView {
  cage_id: string
  tenant_id: string
  store_id: string
  room_id: string
  room_name: string | null
  room_code: string | null
  room_floor: string | null
  room_type: RoomType | null
  cage_name: string
  cage_code: string
  cage_type: CageType
  daily_rate: number
  cage_status: CageStatus
  current_admission_id: string | null
  pet_id: string | null
  customer_id: string | null
  doctor_id: string | null
  admitted_at: string | null
  admission_reason: string | null
}

/**
 * 入院请求(MXQ-11003)
 * 走 Hono Command + admit_patient RPC,事务化创建 admission + 锁笼位
 */
export interface AdmitPatientInput {
  tenantId: string
  storeId: string
  customerId: string
  petId: string
  cageId: string
  doctorId?: string
  admissionReason?: string
}

/** 入院响应 */
export interface AdmitPatientResult {
  admissionId: string
  cageId: string
  status: AdmissionStatus
  admittedAt: string
}

/**
 * 换房请求(MXQ-11006)
 * 走 Hono Command + transfer_cage RPC,事务化释放旧笼位 + 占用新笼位
 */
export interface TransferCageInput {
  admissionId: string
  newCageId: string
  reason?: string
}

/** 换房响应 */
export interface TransferCageResult {
  transferId: string
  admissionId: string
  fromCageId: string
  toCageId: string
}

/**
 * 出院请求(MXQ-11008)
 * 走 Hono Command + discharge_patient RPC,事务化汇总费用 + 释放笼位
 */
export interface DischargePatientInput {
  admissionId: string
  dischargeReason?: string
  dischargeNotes?: string
}

/** 出院响应 */
export interface DischargePatientResult {
  admissionId: string
  status: AdmissionStatus
  totalCharge: number
  dischargedAt: string
}

/**
 * 交接班请求(MXQ-11005)
 * 走 Hono Command + create_handover RPC,同班次已存在则更新 summary
 */
export interface CreateHandoverInput {
  tenantId: string
  storeId: string
  shiftDate: string
  shiftType: ShiftType
  outgoingUser?: string
  incomingUser?: string
  summary?: Record<string, unknown>
}

/** 交接班响应 */
export interface CreateHandoverResult {
  handoverId: string
  shiftDate: string
  shiftType: ShiftType
}

/** 自动计费响应(MXQ-11007) */
export interface GenerateDailyChargesResult {
  targetDate: string
  generatedCount: number
}

/** 房间新建/编辑请求 */
export interface RoomUpsertInput {
  tenantId: string
  storeId: string
  name: string
  code: string
  floor?: string
  roomType?: RoomType
  capacity?: number
  isActive?: boolean
}

/** 笼位新建/编辑请求 */
export interface CageUpsertInput {
  tenantId: string
  storeId: string
  roomId: string
  name: string
  code: string
  cageType?: CageType
  dailyRate?: number
  status?: CageStatus
}

/** 护理计划新建请求 */
export interface NursingPlanInput {
  tenantId: string
  storeId: string
  admissionId: string
  petId: string
  planName: string
  frequency: NursingFrequency
  startDate?: string
  endDate?: string
}

/** 护理任务新建请求 */
export interface NursingTaskInput {
  tenantId: string
  storeId: string
  admissionId: string
  petId: string
  planId?: string
  taskType: NursingTaskType
  description?: string
  scheduledAt: string
  assignedTo?: string
}

/** 笼位状态机转换矩阵 */
export const CAGE_STATUS_TRANSITIONS: Record<CageStatus, CageStatus[]> = {
  available: ['occupied', 'maintenance', 'cleaning'],
  occupied: ['available'],
  maintenance: ['available', 'cleaning'],
  cleaning: ['available', 'maintenance'],
}

/**
 * 校验笼位状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 * @returns 是否允许转换
 */
export function canTransitionCageStatus(from: CageStatus, to: CageStatus): boolean {
  return CAGE_STATUS_TRANSITIONS[from].includes(to)
}

/** 入院状态机转换矩阵 */
export const ADMISSION_STATUS_TRANSITIONS: Record<AdmissionStatus, AdmissionStatus[]> = {
  admitted: ['discharged', 'transferred'],
  discharged: [],
  transferred: ['discharged'],
}

/**
 * 校验入院状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 * @returns 是否允许转换
 */
export function canTransitionAdmissionStatus(from: AdmissionStatus, to: AdmissionStatus): boolean {
  return ADMISSION_STATUS_TRANSITIONS[from].includes(to)
}

/** 护理任务状态机转换矩阵 */
export const NURSING_TASK_STATUS_TRANSITIONS: Record<NursingTaskStatus, NursingTaskStatus[]> = {
  pending: ['in_progress', 'skipped'],
  in_progress: ['done'],
  done: [],
  skipped: [],
}

/**
 * 校验护理任务状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 * @returns 是否允许转换
 */
export function canTransitionNursingTaskStatus(
  from: NursingTaskStatus,
  to: NursingTaskStatus,
): boolean {
  return NURSING_TASK_STATUS_TRANSITIONS[from].includes(to)
}

/** 房间类型标签映射(UI 显示用) */
export const ROOM_TYPE_LABELS: Record<RoomType, string> = {
  ward: '病房',
  icu: 'ICU',
  isolation: '隔离房',
  standard: '普通房',
}

/** 笼位类型标签映射(UI 显示用) */
export const CAGE_TYPE_LABELS: Record<CageType, string> = {
  cage: '笼位',
  run: '活动场',
  tank: '水族箱',
}

/** 笼位状态标签映射(UI 显示用) */
export const CAGE_STATUS_LABELS: Record<CageStatus, string> = {
  available: '空闲',
  occupied: '占用',
  maintenance: '维护',
  cleaning: '清洁',
}

/** 笼位状态对应的 UI 颜色 */
export const CAGE_STATUS_COLORS: Record<CageStatus, string> = {
  available: 'success',
  occupied: 'destructive',
  maintenance: 'warning',
  cleaning: 'info',
}

/** 入院状态标签映射(UI 显示用) */
export const ADMISSION_STATUS_LABELS: Record<AdmissionStatus, string> = {
  admitted: '在院',
  discharged: '已出院',
  transferred: '换房中',
}

/** 护理频率标签映射(UI 显示用) */
export const NURSING_FREQUENCY_LABELS: Record<NursingFrequency, string> = {
  q4h: '每4小时',
  q6h: '每6小时',
  q8h: '每8小时',
  q12h: '每12小时',
  daily: '每日',
  twice_daily: '每日两次',
}

/** 护理任务类型标签映射(UI 显示用) */
export const NURSING_TASK_TYPE_LABELS: Record<NursingTaskType, string> = {
  medication: '用药',
  feeding: '喂食',
  walking: '遛狗',
  observation: '观察',
  wound_care: '伤口护理',
  fluid: '输液',
  other: '其他',
}

/** 护理任务状态标签映射(UI 显示用) */
export const NURSING_TASK_STATUS_LABELS: Record<NursingTaskStatus, string> = {
  pending: '待执行',
  in_progress: '执行中',
  done: '已完成',
  skipped: '已跳过',
}

/** 护理任务状态对应的 UI 颜色 */
export const NURSING_TASK_STATUS_COLORS: Record<NursingTaskStatus, string> = {
  pending: 'default',
  in_progress: 'info',
  done: 'success',
  skipped: 'warning',
}

/** 班次类型标签映射(UI 显示用) */
export const SHIFT_TYPE_LABELS: Record<ShiftType, string> = {
  morning: '白班',
  evening: '晚班',
  night: '夜班',
}

/** 权限码常量 */
export const INPATIENT_PERMISSIONS = {
  view: 'inpatient.view',
  admit: 'inpatient.admit',
  discharge: 'inpatient.discharge',
  transfer: 'inpatient.transfer',
  nursingView: 'nursing.view',
  nursingManage: 'nursing.manage',
  handoverManage: 'handover.manage',
} as const
