/**
 * CRM 领域类型定义(MXQ-5001~5010)
 * 与 supabase/migrations/20260806000015_crm_customers_pets.sql +
 *     supabase/migrations/20260806000015_crm.sql 对齐
 */

// ===== 客户相关 =====

/** 客户状态机:active → archived;active → merged(终态) */
export type CustomerStatus = 'active' | 'archived' | 'merged'

/** 客户性别 */
export type CustomerGender = 'male' | 'female' | 'unknown'

/** 会员等级 */
export type MemberLevel = 'normal' | 'silver' | 'gold' | 'diamond'

/** 客户来源 */
export type CustomerSource = 'walk_in' | 'referral' | 'online' | 'import' | string

/** customers 表记录 */
export interface CustomerRecord {
  id: string
  tenant_id: string
  store_id: string | null
  customer_no: string
  name: string
  gender: CustomerGender | null
  phone: string | null
  email: string | null
  address: string | null
  birthday: string | null
  source: string | null
  member_level: MemberLevel
  member_points: number
  balance: number
  remark: string | null
  status: CustomerStatus
  /** 合并目标客户 id(源客户被合并后指向目标) */
  merged_into: string | null
  /** 创建人(MXQ-5001 补充字段) */
  created_by: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

/** 客户列表查询参数 */
export interface CustomerListParams {
  keyword?: string
  storeId?: string
  memberLevel?: MemberLevel
  status?: CustomerStatus
  page?: number
  pageSize?: number
}

/** 客户列表响应 */
export interface CustomerListResult {
  list: CustomerRecord[]
  total: number
  page: number
  pageSize: number
}

/** 创建客户入参 */
export interface CreateCustomerInput {
  tenantId: string
  storeId?: string
  name: string
  gender?: CustomerGender
  phone?: string
  email?: string
  address?: string
  birthday?: string
  source?: string
  memberLevel?: MemberLevel
  remark?: string
  customerNo?: string
}

/** 更新客户入参 */
export interface UpdateCustomerInput {
  name?: string
  gender?: CustomerGender
  phone?: string
  email?: string
  address?: string
  birthday?: string
  source?: string
  memberLevel?: MemberLevel
  memberPoints?: number
  balance?: number
  remark?: string
}

/** 合并客户入参 */
export interface MergeCustomersInput {
  sourceId: string
  targetId: string
}

/** 客户详情响应(含宠物列表) */
export interface CustomerDetailResult {
  customer: CustomerRecord
  pets: PetRecord[]
}

// ===== 宠物相关 =====

/** 宠物状态机:active → deceased / lost;active/deceased/lost → archived */
export type PetStatus = 'active' | 'deceased' | 'lost' | 'archived'

/** 宠物性别 */
export type PetGender = 'male' | 'female' | 'unknown'

/** 宠物物种 */
export type PetSpecies = 'dog' | 'cat' | 'rabbit' | 'bird' | 'reptile' | 'other' | string

/** pets 表记录 */
export interface PetRecord {
  id: string
  tenant_id: string
  customer_id: string
  name: string
  species: PetSpecies | null
  breed: string | null
  gender: PetGender | null
  birth_date: string | null
  /** 当前体重 kg */
  weight: number | null
  is_neutered: boolean
  microchip: string | null
  color: string | null
  photo_file_id: string | null
  /** 风险标签(过敏/攻击性/慢性病等) */
  risk_tags: string[]
  temperament: string | null
  medical_notes: string | null
  /** 备注(MXQ-5005 补充字段) */
  remark: string | null
  status: PetStatus
  deceased_at: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

/** 宠物列表查询参数 */
export interface PetListParams {
  customerId: string
  status?: PetStatus
}

/** 创建宠物入参 */
export interface CreatePetInput {
  tenantId: string
  customerId: string
  name: string
  species?: string
  breed?: string
  gender?: PetGender
  birthDate?: string
  weight?: number
  isNeutered?: boolean
  microchip?: string
  color?: string
  photoFileId?: string
  riskTags?: string[]
  temperament?: string
  medicalNotes?: string
}

/** 更新宠物入参 */
export interface UpdatePetInput {
  name?: string
  species?: string
  breed?: string
  gender?: PetGender
  birthDate?: string
  weight?: number
  isNeutered?: boolean
  microchip?: string
  color?: string
  photoFileId?: string
  riskTags?: string[]
  temperament?: string
  medicalNotes?: string
  status?: PetStatus
}

/** 宠物详情响应(含体重记录) */
export interface PetDetailResult {
  pet: PetRecord
  weights: PetWeightRecord[]
}

// ===== 体重记录 =====

/** pet_weights 表记录 */
export interface PetWeightRecord {
  id: string
  tenant_id: string
  pet_id: string
  /** 体重 kg */
  weight: number
  recorded_at: string
  recorded_by: string | null
  note: string | null
  created_at: string
}

// ===== 导入任务 =====

/** 导入任务状态机:pending → processing → completed/failed */
export type ImportJobStatus = 'pending' | 'processing' | 'completed' | 'failed'

/** 导入任务类型 */
export type ImportJobType = 'customer' | 'pet'

/** import_jobs 表记录 */
export interface ImportJobRecord {
  id: string
  tenant_id: string
  store_id: string | null
  type: ImportJobType
  status: ImportJobStatus
  total_rows: number
  success_count: number
  failed_count: number
  error_file_key: string | null
  source_file_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** 批量导入客户行 */
export interface BatchImportCustomerRow {
  name: string
  gender?: CustomerGender
  phone?: string
  email?: string
  address?: string
  birthday?: string
  source?: string
  memberLevel?: MemberLevel
  remark?: string
}

/** 批量导入客户入参 */
export interface BatchImportCustomersInput {
  tenantId: string
  storeId?: string
  rows: BatchImportCustomerRow[]
}

/** 批量导入结果行 */
export interface BatchImportResultRow {
  rowIndex: number
  success: boolean
  customerId?: string
  customerNo?: string
  error?: string
}

/** 批量导入客户响应 */
export interface BatchImportCustomersResult {
  total: number
  succeeded: number
  failed: number
  results: BatchImportResultRow[]
}

// ===== 状态机转换矩阵 =====

/** 客户状态机转换矩阵 */
export const CUSTOMER_STATUS_TRANSITIONS: Record<CustomerStatus, CustomerStatus[]> = {
  active: ['archived', 'merged'],
  archived: [],
  merged: [],
}

/** 宠物状态机转换矩阵 */
export const PET_STATUS_TRANSITIONS: Record<PetStatus, PetStatus[]> = {
  active: ['deceased', 'lost', 'archived'],
  deceased: ['archived'],
  lost: ['archived'],
  archived: [],
}

/** 导入任务状态机转换矩阵 */
export const IMPORT_JOB_STATUS_TRANSITIONS: Record<ImportJobStatus, ImportJobStatus[]> = {
  pending: ['processing'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
}

/**
 * 校验客户状态转换是否合法
 */
export function canTransitionCustomerStatus(from: CustomerStatus, to: CustomerStatus): boolean {
  return CUSTOMER_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * 校验宠物状态转换是否合法
 */
export function canTransitionPetStatus(from: PetStatus, to: PetStatus): boolean {
  return PET_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * 校验导入任务状态转换是否合法
 */
export function canTransitionImportJobStatus(from: ImportJobStatus, to: ImportJobStatus): boolean {
  return IMPORT_JOB_STATUS_TRANSITIONS[from].includes(to)
}

// ===== UI 显示映射 =====

/** 客户状态标签映射 */
export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  active: '活跃',
  archived: '已归档',
  merged: '已合并',
}

/** 客户性别标签映射 */
export const CUSTOMER_GENDER_LABELS: Record<CustomerGender, string> = {
  male: '男',
  female: '女',
  unknown: '未知',
}

/** 会员等级标签映射 */
export const MEMBER_LEVEL_LABELS: Record<MemberLevel, string> = {
  normal: '普通',
  silver: '银卡',
  gold: '金卡',
  diamond: '钻石',
}

/** 宠物状态标签映射 */
export const PET_STATUS_LABELS: Record<PetStatus, string> = {
  active: '正常',
  deceased: '已去世',
  lost: '走失',
  archived: '已归档',
}

/** 宠物性别标签映射 */
export const PET_GENDER_LABELS: Record<PetGender, string> = {
  male: '公',
  female: '母',
  unknown: '未知',
}

/** 宠物物种标签映射 */
export const PET_SPECIES_LABELS: Record<string, string> = {
  dog: '犬',
  cat: '猫',
  rabbit: '兔',
  bird: '鸟',
  reptile: '爬行',
  other: '其他',
}

/** 导入任务状态标签映射 */
export const IMPORT_JOB_STATUS_LABELS: Record<ImportJobStatus, string> = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
}

// ===== 客户回访任务(S3.1-AGENT-04) =====

/** 回访任务状态机:pending → in_progress → completed;pending/in_progress → cancelled */
export type FollowupStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** 回访来源类型 */
export type FollowupSourceType = 'manual' | 'encounter' | 'discharge' | 'reminder' | 'complaint'

/** 回访任务类型 */
export type FollowupTaskType = 'post_visit' | 'post_discharge' | 'medication' | 'recheck' | 'customer_care' | 'other'

/** 回访渠道 */
export type FollowupChannel = 'phone' | 'wechat' | 'sms' | 'in_person' | 'other'

/** 回访结果码(消息发送成功 ≠ 回访完成) */
export type FollowupResultCode = 'contacted' | 'unreachable' | 'rescheduled' | 'other'

/** followup_tasks 表记录(含服务端聚合的名称字段) */
export interface FollowupTaskRecord {
  id: string
  tenant_id: string
  store_id: string | null
  customer_id: string
  pet_id: string | null

  source_type: FollowupSourceType
  source_id: string | null

  task_type: FollowupTaskType
  scheduled_at: string
  assignee_employee_id: string | null
  channel: FollowupChannel | null

  status: FollowupStatus

  result_code: FollowupResultCode | null
  result_note: string | null
  started_at: string | null
  completed_at: string | null
  completed_by: string | null
  cancel_reason: string | null
  next_followup_at: string | null

  created_by: string | null
  created_at: string
  updated_at: string

  // 服务端聚合(Hono enrich)
  customer_name?: string | null
  customer_no?: string | null
  customer_phone?: string | null
  pet_name?: string | null
  pet_species?: string | null
  assignee_name?: string | null
}

/** 回访列表查询参数 */
export interface FollowupListParams {
  /** 时间桶:逾期/今天/未来/已完成/全部;与 status 二选一,status 优先 */
  bucket?: 'overdue' | 'today' | 'upcoming' | 'finished' | 'all'
  status?: FollowupStatus
  keyword?: string
  customerId?: string
  assigneeId?: string
  storeId?: string
  page?: number
  pageSize?: number
}

/** 回访列表响应 */
export interface FollowupListResult {
  list: FollowupTaskRecord[]
  total: number
  page: number
  pageSize: number
}

/** 创建回访入参(仅手动创建;自动触发由对应域 Owner 集成) */
export interface CreateFollowupInput {
  tenantId: string
  storeId?: string
  customerId: string
  petId?: string
  sourceType?: FollowupSourceType
  sourceId?: string
  taskType?: FollowupTaskType
  scheduledAt?: string
  assigneeEmployeeId?: string
  channel?: FollowupChannel
}

/** 更新回访入参(仅 pending 可改) */
export interface UpdateFollowupInput {
  scheduledAt?: string
  assigneeEmployeeId?: string | null
  channel?: FollowupChannel | null
  taskType?: FollowupTaskType
}

/** 登记回访结果入参(in_progress → completed) */
export interface CompleteFollowupInput {
  resultCode?: FollowupResultCode
  resultNote?: string
  nextFollowupAt?: string | null
}

/** 客户 360 聚合响应 */
export interface Customer360Result {
  customer: CustomerRecord
  pets: PetRecord[]
  recentEncounters: Array<{
    id: string
    pet_id: string
    started_at: string
    ended_at: string | null
    status: string
    chief_complaint: string | null
    follow_up_date: string | null
    doctor_id: string | null
  }>
  recentInvoices: Array<{
    id: string
    invoice_no: string
    total: number
    paid_amount: number
    status: string
    created_at: string
  }>
  followups: FollowupTaskRecord[]
  followupCounts: Record<FollowupStatus, number>
}

// ===== 回访状态机与展示映射 =====

/** 回访任务状态机转换矩阵 */
export const FOLLOWUP_STATUS_TRANSITIONS: Record<FollowupStatus, FollowupStatus[]> = {
  pending: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

/** 校验回访状态转换是否合法 */
export function canTransitionFollowupStatus(from: FollowupStatus, to: FollowupStatus): boolean {
  return FOLLOWUP_STATUS_TRANSITIONS[from].includes(to)
}

/** 回访状态标签映射 */
export const FOLLOWUP_STATUS_LABELS: Record<FollowupStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}

/** 回访来源类型标签映射 */
export const FOLLOWUP_SOURCE_LABELS: Record<FollowupSourceType, string> = {
  manual: '手动',
  encounter: '就诊',
  discharge: '出院',
  reminder: '提醒',
  complaint: '投诉',
}

/** 回访任务类型标签映射 */
export const FOLLOWUP_TASK_TYPE_LABELS: Record<FollowupTaskType, string> = {
  post_visit: '诊后回访',
  post_discharge: '出院回访',
  medication: '用药跟进',
  recheck: '复诊提醒',
  customer_care: '关怀回访',
  other: '其他',
}

/** 回访渠道标签映射 */
export const FOLLOWUP_CHANNEL_LABELS: Record<FollowupChannel, string> = {
  phone: '电话',
  wechat: '微信',
  sms: '短信',
  in_person: '当面',
  other: '其他',
}

/** 回访结果码标签映射 */
export const FOLLOWUP_RESULT_LABELS: Record<FollowupResultCode, string> = {
  contacted: '已联系',
  unreachable: '未接通',
  rescheduled: '已改期',
  other: '其他',
}
