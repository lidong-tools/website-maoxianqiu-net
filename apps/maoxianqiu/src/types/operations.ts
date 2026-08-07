/**
 * Operations 领域类型定义(MXQ-12001~12009)
 * 与 supabase/migrations/20260806000018_operations.sql 对齐
 */

// ===== MXQ-12001 会员等级 =====

/** 会员等级记录 */
export interface MembershipTier {
  id: string
  tenant_id: string
  code: string
  name: string
  /** 折扣百分比(0-100,100 表示不打折) */
  discount_percent: number
  /** 积分倍数(1.00 表示无加成) */
  points_multiplier: number
  is_active: boolean
  sort_order: number
  created_at: string
}

/** 客户会员关系(等级 + 积分余额) */
export interface CustomerMembership {
  id: string
  tenant_id: string
  customer_id: string
  tier_id: string | null
  points_balance: number
  joined_at: string
  expires_at: string | null
  created_at: string
}

// ===== MXQ-12002 积分流水 =====

/** 积分变动原因 */
export type PointReason = 'purchase' | 'redeem' | 'adjust' | 'expiry'

/** 积分流水记录(不可变) */
export interface PointTransaction {
  id: string
  tenant_id: string
  customer_id: string
  /** 正数获得,负数消耗 */
  delta: number
  reason: PointReason
  reference_type: string | null
  reference_id: string | null
  /** 操作后余额快照 */
  balance_after: number
  operator_id: string | null
  created_at: string
}

/** adjust_points RPC 返回 */
export interface AdjustPointsResult {
  transaction_id: string
  customer_id: string
  balance_after: number
  delta: number
}

/** adjust_points 请求 */
export interface AdjustPointsInput {
  tenantId: string
  customerId: string
  delta: number
  reason: PointReason
  referenceId?: string
  referenceType?: string
  idempotencyKey?: string
}

// ===== MXQ-12003 消息模板 =====

/** 消息渠道 */
export type MessageChannel = 'sms' | 'email' | 'wechat' | 'work_wechat'

/** 消息模板记录 */
export interface MessageTemplate {
  id: string
  tenant_id: string
  code: string
  name: string
  channel: MessageChannel
  subject: string | null
  body: string
  /** 变量 schema 定义(jsonb) */
  variables: Record<string, unknown>
  is_active: boolean
  version: number
  created_at: string
  updated_at: string
}

// ===== MXQ-12004 提醒 =====

/** 提醒类型 */
export type ReminderType = 'vaccine' | 'deworming' | 'revisit' | 'birthday' | 'other'

/** 提醒状态:pending → sent / pending → cancelled */
export type ReminderStatus = 'pending' | 'sent' | 'cancelled'

/** 提醒记录 */
export interface Reminder {
  id: string
  tenant_id: string
  store_id: string | null
  customer_id: string | null
  pet_id: string | null
  type: ReminderType
  scheduled_at: string
  status: ReminderStatus
  payload: Record<string, unknown>
  created_at: string
  sent_at: string | null
}

/** scan_reminders RPC 返回 */
export interface ScanRemindersResult {
  scanned_count: number
  scanned_at: string
}

/** 提醒状态机转换矩阵 */
export const REMINDER_STATUS_TRANSITIONS: Record<ReminderStatus, ReminderStatus[]> = {
  pending: ['sent', 'cancelled'],
  sent: [],
  cancelled: [],
}

/**
 * 校验提醒状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 */
export function canTransitionReminderStatus(from: ReminderStatus, to: ReminderStatus): boolean {
  return REMINDER_STATUS_TRANSITIONS[from].includes(to)
}

// ===== MXQ-12005 发送适配器 =====

/** 发送状态:queued → sent / queued → failed / queued → retry → sent */
export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'retry'

/** 发送记录 */
export interface MessageDelivery {
  id: string
  tenant_id: string
  reminder_id: string | null
  template_id: string | null
  channel: MessageChannel
  recipient: string
  content_snapshot: string
  provider_message_id: string | null
  status: DeliveryStatus
  error: string | null
  attempts: number
  sent_at: string | null
  created_at: string
}

/** 发送状态机转换矩阵 */
export const DELIVERY_STATUS_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  queued: ['sent', 'failed', 'retry'],
  retry: ['sent', 'failed'],
  sent: [],
  failed: [],
}

/**
 * 校验发送状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 */
export function canTransitionDeliveryStatus(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_STATUS_TRANSITIONS[from].includes(to)
}

// ===== MXQ-12006 导入任务 =====

/** 导入业务类型 */
export type ImportType = 'customer' | 'pet' | 'product' | 'inventory'

/** 导入任务状态:pending → processing → completed | failed */
export type ImportTaskStatus = 'pending' | 'processing' | 'completed' | 'failed'

/** 导入任务记录 */
export interface ImportTask {
  id: string
  tenant_id: string
  store_id: string | null
  type: ImportType
  file_id: string | null
  status: ImportTaskStatus
  total_rows: number
  success_count: number
  failed_count: number
  error_summary: Record<string, unknown>
  created_by: string | null
  created_at: string
  updated_at: string
}

/** 创建导入任务请求 */
export interface CreateImportTaskInput {
  tenantId: string
  storeId?: string
  type: ImportType
  fileId?: string
}

/** 导入状态机转换矩阵 */
export const IMPORT_TASK_STATUS_TRANSITIONS: Record<ImportTaskStatus, ImportTaskStatus[]> = {
  pending: ['processing'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
}

/**
 * 校验导入任务状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 */
export function canTransitionImportTaskStatus(from: ImportTaskStatus, to: ImportTaskStatus): boolean {
  return IMPORT_TASK_STATUS_TRANSITIONS[from].includes(to)
}

// ===== MXQ-12007 打印 =====

/** 打印模板类型 */
export type PrintTemplateType = 'invoice' | 'prescription' | 'medical_record' | 'lab_report' | 'vaccine_certificate' | 'label' | 'other'

/** 打印模板记录 */
export interface PrintTemplate {
  id: string
  tenant_id: string
  code: string
  name: string
  type: PrintTemplateType
  /** html / liquid 模板内容 */
  template: string
  is_active: boolean
  created_at: string
}

/** 打印任务状态:queued → printed / queued → failed */
export type PrintJobStatus = 'queued' | 'printed' | 'failed'

/** 打印任务记录 */
export interface PrintJob {
  id: string
  tenant_id: string
  store_id: string | null
  template_id: string | null
  entity_type: string
  entity_id: string
  status: PrintJobStatus
  operator_id: string | null
  created_at: string
}

/** 创建打印任务请求 */
export interface CreatePrintJobInput {
  tenantId: string
  storeId?: string
  templateId: string
  entityType: string
  entityId: string
}

/** 打印状态机转换矩阵 */
export const PRINT_JOB_STATUS_TRANSITIONS: Record<PrintJobStatus, PrintJobStatus[]> = {
  queued: ['printed', 'failed'],
  printed: [],
  failed: [],
}

/**
 * 校验打印任务状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 */
export function canTransitionPrintJobStatus(from: PrintJobStatus, to: PrintJobStatus): boolean {
  return PRINT_JOB_STATUS_TRANSITIONS[from].includes(to)
}

// ===== MXQ-12008 报表 =====

/** 报表分类 */
export type ReportCategory = 'revenue' | 'inventory' | 'customer' | 'medical'

/** 报表定义 */
export interface ReportDefinition {
  id: string
  tenant_id: string
  code: string
  name: string
  category: ReportCategory
  /** 查询参数 schema(jsonb) */
  query_config: Record<string, unknown>
  is_active: boolean
  created_at: string
}

/** 报表快照 */
export interface ReportSnapshot {
  id: string
  tenant_id: string
  report_id: string
  period_start: string
  period_end: string
  /** 报表数据(jsonb) */
  data: Record<string, unknown>
  generated_by: string | null
  created_at: string
}

/** 生成报表快照请求 */
export interface GenerateReportSnapshotInput {
  tenantId: string
  reportCode: string
  periodStart: string
  periodEnd: string
}

// ===== MXQ-12009 安全事件 =====

/** 安全事件类型 */
export type SecurityEventType
  = | 'login_failed'
    | 'permission_denied'
    | 'suspicious'
    | 'data_export'

/** 安全事件严重级别 */
export type SecurityEventSeverity = 'info' | 'warning' | 'critical'

/** 安全事件记录(不可变,仅 service_role 写入) */
export interface SecurityEvent {
  id: string
  tenant_id: string | null
  user_id: string | null
  event_type: SecurityEventType
  severity: SecurityEventSeverity
  description: string | null
  ip: string | null
  user_agent: string | null
  metadata: Record<string, unknown>
  created_at: string
}

// ===== UI 标签映射 =====

/** 会员等级折扣标签 */
export const MEMBERSHIP_CHANNEL_LABELS: Record<MessageChannel, string> = {
  sms: '短信',
  email: '邮件',
  wechat: '微信',
  work_wechat: '企业微信',
}

/** 提醒类型标签 */
export const REMINDER_TYPE_LABELS: Record<ReminderType, string> = {
  vaccine: '疫苗',
  deworming: '驱虫',
  revisit: '复诊',
  birthday: '生日',
  other: '其他',
}

/** 提醒状态标签 */
export const REMINDER_STATUS_LABELS: Record<ReminderStatus, string> = {
  pending: '待发送',
  sent: '已发送',
  cancelled: '已取消',
}

/** 发送状态标签 */
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  queued: '排队中',
  sent: '已发送',
  failed: '发送失败',
  retry: '重试中',
}

/** 导入类型标签 */
export const IMPORT_TYPE_LABELS: Record<ImportType, string> = {
  customer: '客户',
  pet: '宠物',
  product: '商品',
  inventory: '库存',
}

/** 导入任务状态标签 */
export const IMPORT_TASK_STATUS_LABELS: Record<ImportTaskStatus, string> = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
}

/** 打印模板类型标签 */
export const PRINT_TEMPLATE_TYPE_LABELS: Record<PrintTemplateType, string> = {
  invoice: '收据',
  prescription: '处方',
  medical_record: '病历',
  lab_report: '检验报告',
  vaccine_certificate: '疫苗证明',
  label: '标签',
  other: '其他',
}

/** 打印任务状态标签 */
export const PRINT_JOB_STATUS_LABELS: Record<PrintJobStatus, string> = {
  queued: '排队中',
  printed: '已打印',
  failed: '失败',
}

/** 报表分类标签 */
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  revenue: '收入',
  inventory: '库存',
  customer: '客户',
  medical: '医疗',
}

/** 安全事件类型标签 */
export const SECURITY_EVENT_TYPE_LABELS: Record<SecurityEventType, string> = {
  login_failed: '登录失败',
  permission_denied: '权限拒绝',
  suspicious: '可疑行为',
  data_export: '数据导出',
}

/** 安全事件严重级别标签 */
export const SECURITY_EVENT_SEVERITY_LABELS: Record<SecurityEventSeverity, string> = {
  info: '信息',
  warning: '警告',
  critical: '严重',
}
