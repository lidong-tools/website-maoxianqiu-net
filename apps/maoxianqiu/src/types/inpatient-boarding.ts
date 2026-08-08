/**
 * 寄养(Boarding)领域类型定义(S3.1 Agent-06)
 * 与 supabase/migrations/20260810000070~73_*.sql 对齐
 *
 * 状态机:planned → checked_in → in_service → checkout_pending → checked_out
 *         planned → cancelled
 * 与医疗住院(admissions)分开,权限码为 boarding.*
 */

/** 寄养状态 */
export type BoardingStayStatus
  = | 'planned'
    | 'checked_in'
    | 'in_service'
    | 'checkout_pending'
    | 'checked_out'
    | 'cancelled'

/** boarding_stays 表记录(寄养单) */
export interface BoardingStay {
  id: string
  tenant_id: string
  store_id: string
  boarding_no: string
  customer_id: string
  pet_id: string
  cage_id: string
  check_in_at: string | null
  expected_check_out_at: string | null
  checked_out_at: string | null
  status: BoardingStayStatus
  diet_notes: string | null
  walking_notes: string | null
  medication_notes: string | null
  vaccine_verified: boolean
  risk_acknowledged: boolean
  emergency_contact: Record<string, unknown>
  total_charge: number
  created_by: string | null
  created_at: string
  updated_at: string
}

/** boarding_daily_records 表记录(每日照护) */
export interface BoardingDailyRecord {
  id: string
  tenant_id: string
  store_id: string
  boarding_stay_id: string
  record_date: string
  feeding: string | null
  walking: string | null
  medication: string | null
  condition: string | null
  note: string | null
  recorded_by: string | null
  created_at: string
}

/** boarding_service_charges 表记录(额外服务费) */
export interface BoardingServiceCharge {
  id: string
  tenant_id: string
  store_id: string
  boarding_stay_id: string
  catalog_item_id: string | null
  description: string | null
  quantity: number
  unit_price: number
  amount: number
  charge_date: string
  created_by: string | null
  created_at: string
}

/** boarding_cage_status 视图记录(寄养房态看板) */
export interface BoardingCageStatusView {
  cage_id: string
  tenant_id: string
  store_id: string
  room_id: string
  room_name: string | null
  room_code: string | null
  room_floor: string | null
  room_type: string | null
  cage_name: string
  cage_code: string
  cage_type: string
  daily_rate: number
  cage_status: string
  current_boarding_stay_id: string | null
  current_admission_id: string | null
  pet_id: string | null
  customer_id: string | null
  boarding_no: string | null
  check_in_at: string | null
  expected_check_out_at: string | null
  diet_notes: string | null
  walking_notes: string | null
  medication_notes: string | null
  risk_acknowledged: boolean | null
  boarding_status: BoardingStayStatus | null
}

/** 紧急联系人(emergency_contact jsonb) */
export interface BoardingEmergencyContact {
  name?: string
  phone?: string
  relation?: string
}

/** 预约寄养入参(boarding_book_stay RPC) */
export interface BoardingBookInput {
  tenantId: string
  storeId: string
  customerId: string
  petId: string
  cageId: string
  expectedCheckOutAt?: string
  checkInAt?: string
  dietNotes?: string
  walkingNotes?: string
  medicationNotes?: string
  vaccineVerified?: boolean
  riskAcknowledged?: boolean
  emergencyContact?: BoardingEmergencyContact
}

/** 办理入住入参(boarding_check_in RPC,支持直接入住或确认预约) */
export interface BoardingCheckInInput {
  tenantId: string
  storeId: string
  customerId?: string
  petId?: string
  cageId?: string
  expectedCheckOutAt?: string
  dietNotes?: string
  walkingNotes?: string
  medicationNotes?: string
  vaccineVerified?: boolean
  riskAcknowledged?: boolean
  emergencyContact?: BoardingEmergencyContact
  stayId?: string
}

/** 预约响应 */
export interface BoardingBookResult {
  stayId: string
  boardingNo: string
  status: BoardingStayStatus
}

/** 入住响应 */
export interface BoardingCheckInResult {
  stayId: string
  boardingNo: string
  cageId: string
  status: BoardingStayStatus
}

/** 取消预约响应 */
export interface BoardingCancelResult {
  stayId: string
  boardingNo: string
  status: BoardingStayStatus
}

/** 换笼位入参 */
export interface BoardingChangeCageInput {
  newCageId: string
  reason?: string
}

/** 换笼位响应 */
export interface BoardingChangeCageResult {
  stayId: string
  boardingNo: string
  fromCageId: string
  toCageId: string
}

/** 记录每日照护入参 */
export interface BoardingRecordDailyInput {
  recordDate?: string
  feeding?: string
  walking?: string
  medication?: string
  condition?: string
  note?: string
}

/** 追加额外服务费入参 */
export interface BoardingAddChargeInput {
  catalogItemId?: string
  description?: string
  quantity?: number
  unitPrice?: number
  chargeDate?: string
}

/** 准备离店响应(boarding_prepare_checkout RPC) */
export interface BoardingPrepareCheckoutResult {
  stayId: string
  boardingNo: string
  stayDays: number
  dailyAmount: number
  serviceAmount: number
  totalCharge: number
  status: BoardingStayStatus
}

/** 完成离店响应(boarding_checkout RPC) */
export interface BoardingCheckoutResult {
  stayId: string
  boardingNo: string
  stayDays: number
  dailyAmount: number
  serviceAmount: number
  totalCharge: number
  status: BoardingStayStatus
  checkedOutAt: string
}

/** 寄养状态机转换矩阵 */
export const BOARDING_STATUS_TRANSITIONS: Record<BoardingStayStatus, BoardingStayStatus[]> = {
  planned: ['checked_in', 'cancelled'],
  checked_in: ['in_service', 'checkout_pending'],
  in_service: ['checkout_pending'],
  checkout_pending: ['checked_out'],
  checked_out: [],
  cancelled: [],
}

/**
 * 校验寄养状态转换是否合法
 */
export function canTransitionBoardingStatus(from: BoardingStayStatus, to: BoardingStayStatus): boolean {
  return BOARDING_STATUS_TRANSITIONS[from].includes(to)
}

/** 寄养状态标签映射(UI 显示用) */
export const BOARDING_STATUS_LABELS: Record<BoardingStayStatus, string> = {
  planned: '已预约',
  checked_in: '已入住',
  in_service: '服务中',
  checkout_pending: '待离店',
  checked_out: '已离店',
  cancelled: '已取消',
}

/** 寄养状态对应的 UI 颜色 */
export const BOARDING_STATUS_COLORS: Record<BoardingStayStatus, string> = {
  planned: 'default',
  checked_in: 'info',
  in_service: 'primary',
  checkout_pending: 'warning',
  checked_out: 'success',
  cancelled: 'warning',
}

/** 权限码常量 */
export const BOARDING_PERMISSIONS = {
  view: 'boarding.view',
  manage: 'boarding.manage',
  care: 'boarding.care',
  checkout: 'boarding.checkout',
} as const
