export type WorkbenchRole = 'frontdesk' | 'triage' | 'doctor' | 'nurse' | 'lab' | 'imaging' | 'cashier' | 'pharmacy' | 'followup' | 'manager'

export interface JourneyPerson {
  id: string
  name: string
  phone?: string
  species?: string
  breed?: string
  employee_no?: string
}

/** 工作台行统一展示信息(服务端聚合,替代模板分散拼接) */
export interface WorkbenchDisplay {
  businessNo?: string
  title: string
  subtitle?: string
  sourceLabel?: string
}

/** 工作台行时效信息:等待/截止与超时标记 */
export interface WorkbenchTiming {
  startedAt?: string | null
  dueAt?: string | null
  elapsedMinutes?: number
  overdue?: boolean
}

/** 详情抽屉的数据来源定位 */
export interface WorkbenchDetailTarget {
  type: 'encounter' | 'queue' | 'task' | 'charge'
  id: string
}

/**
 * 岗位工作台行(公共字段 + 岗位扩展 DTO)。
 * 服务端返回 display/timing/detailTarget/primaryAction/allowedActions;
 * 兼容字段保留给医生工作台、候诊大屏与既有页面使用。
 */
export interface WorkbenchRow {
  id: string
  status: string
  priority?: string
  customer?: JourneyPerson | null
  pet?: JourneyPerson | null
  assignee?: JourneyPerson | null
  lastOperator?: JourneyPerson | null
  /** 统一展示结构:业务单号/主标题/次要说明/来源标签 */
  display?: WorkbenchDisplay
  /** 等待时长与截止时间(服务端计算) */
  timing?: WorkbenchTiming
  /** 详情抽屉定位目标 */
  detailTarget?: WorkbenchDetailTarget | null
  /** 服务端按岗位工作流推导的主动作 key */
  primaryAction?: string
  allowedActions?: string[]
  // ===== 兼容字段(既有页面/医生工作台依赖) =====
  encounter_id?: string
  queue_no?: string
  queue_number?: string
  task_type?: string
  title?: string
  item_name?: string
  source_type?: string
  source_id?: string
  amount?: number
  quantity?: number
  unit_price?: number
  checked_in_at?: string | null
  called_at?: string
  waiting_at?: string | null
  due_at?: string
  created_at?: string
  room_name?: string | null
  call_sequence?: number
  pet_id?: string
  assigned_doctor_id?: string
  doctor_display_name?: string
}

export interface WorkbenchData {
  role: WorkbenchRole
  /** 完整业务范围的状态数量,不受分页影响 */
  counts: Record<string, number>
  total: number
  page: number
  pageSize: number
  list: WorkbenchRow[]
}

export interface JourneyEvent {
  id: string
  event_type: string
  from_status?: string | null
  to_status?: string | null
  reason?: string | null
  notes?: string | null
  actor_name: string
  actor_role: string
  actor_employee_no?: string | null
  occurred_at: string
  before_data?: Record<string, unknown> | null
  after_data?: Record<string, unknown> | null
}

export const WORKBENCH_ROLE_LABELS: Record<WorkbenchRole, string> = {
  frontdesk: '前台接待',
  triage: '分诊护士',
  doctor: '医生',
  nurse: '治疗护士',
  lab: '检验人员',
  imaging: '影像人员',
  cashier: '收银员',
  pharmacy: '药房',
  followup: '客服回访',
  manager: '门店管理',
}

export const WORKBENCH_ROLE_PERMISSIONS: Record<WorkbenchRole, string> = {
  frontdesk: 'workbench.frontdesk',
  triage: 'workbench.triage',
  doctor: 'workbench.doctor',
  nurse: 'workbench.nurse',
  lab: 'workbench.lab',
  imaging: 'workbench.imaging',
  cashier: 'workbench.cashier',
  pharmacy: 'workbench.pharmacy',
  followup: 'workbench.followup',
  manager: 'workbench.manager',
}

/** 兼容尚未刷新新版工作台权限码的既有租户。 */
export const WORKBENCH_ROLE_PERMISSION_ALTERNATIVES: Record<WorkbenchRole, string[]> = {
  frontdesk: ['workbench.frontdesk', 'queue.manage'],
  triage: ['workbench.triage', 'triage.write'],
  doctor: ['workbench.doctor', 'encounter.work'],
  nurse: ['workbench.nurse', 'nurse_task.view'],
  lab: ['workbench.lab', 'lab.view'],
  imaging: ['workbench.imaging', 'imaging.view'],
  cashier: ['workbench.cashier', 'invoice.create'],
  pharmacy: ['workbench.pharmacy', 'prescription.dispense'],
  followup: ['workbench.followup', 'followup.view'],
  manager: ['workbench.manager', 'journey.audit', 'store.manage'],
}

export const WORKBENCH_ROLE_CODES: Record<WorkbenchRole, string[]> = {
  frontdesk: ['receptionist'],
  triage: ['triage_nurse'],
  doctor: ['doctor'],
  nurse: ['nurse'],
  lab: ['lab_technician'],
  imaging: ['imaging_technician'],
  cashier: ['cashier'],
  pharmacy: ['pharmacist'],
  followup: ['followup_service'],
  manager: ['store_manager', 'tenant_owner'],
}

// ============================================================
// 标签映射:岗位工作台与患者旅程时间线共用,替代模板直接展示 raw key
// ============================================================

/** 候诊队列状态中文标签 */
export const QUEUE_STATUS_LABELS: Record<string, string> = {
  waiting: '待叫号',
  called: '已叫号',
  in_consultation: '诊疗中',
  checked_in: '已候诊',
  triage: '待分诊',
  missed: '未到店',
  closed: '已结束',
  cancelled: '已取消',
}

/** 候诊队列状态颜色映射(EntityStatusTag variant) */
export const QUEUE_STATUS_VARIANTS: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  waiting: 'warning',
  called: 'info',
  in_consultation: 'success',
  checked_in: 'warning',
  triage: 'warning',
  missed: 'neutral',
  closed: 'neutral',
  cancelled: 'neutral',
}

/** 收费项状态中文标签(收银工作台) */
export const CHARGE_STATUS_LABELS: Record<string, string> = {
  pending: '待付款',
  invoiced: '已开票',
  paid: '已支付',
  voided: '已作废',
}

/** 岗位任务状态中文标签(任务型工作台) */
export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '待领取',
  claimed: '已领取',
  in_progress: '执行中',
  completed: '已完成',
  failed: '已失败',
}

/** 患者旅程事件类型中文标签(时间线展示,含触发器动态派生类型) */
export const JOURNEY_EVENT_TYPE_LABELS: Record<string, string> = {
  'queue.checked_in': '前台签到',
  'queue.waiting': '进入候诊',
  'queue.called': '叫号',
  'queue.in_consultation': '开始接诊',
  'queue.missed': '过号未到',
  'queue.closed': '患者离院',
  'queue.cancelled': '队列取消',
  'triage.completed': '分诊完成',
  'charge_item.created': '创建收费项',
  'charge_item.updated': '更新收费项',
  'charge_item.voided': '作废收费项',
  'charge_item.paid': '收费结清',
  'workflow_task.created': '创建岗位任务',
  'workflow_task.claimed': '领取任务',
  'workflow_task.started': '开始任务',
  'workflow_task.completed': '完成任务',
  'workflow_task.failed': '任务失败',
  'workflow_task.transferred': '转派任务',
  'encounter.completed': '完成诊疗',
  'encounter.closed': '结束就诊',
  'encounter.followup_plan': '离院医嘱',
  'prescription.issued': '处方已开具',
  'invoice.created_from_charges': '生成收费发票',
  'lab_order.created': '创建检验申请',
  'imaging_order.created': '创建影像检查',
}

/** 旅程时间线状态变更标签(from_status/to_status,合并各实体状态) */
export const JOURNEY_STATUS_LABELS: Record<string, string> = {
  ...QUEUE_STATUS_LABELS,
  ...CHARGE_STATUS_LABELS,
  ...TASK_STATUS_LABELS,
  active: '进行中',
  draft: '草稿',
  issued: '已开具',
  dispensed: '已发药',
}

/** 角色码中文标签(旅程时间线操作人岗位展示) */
export const ROLE_CODE_LABELS: Record<string, string> = {
  system_admin: '运维管理员',
  tenant_owner: '租户所有者',
  store_manager: '店长',
  staff: '店员',
  receptionist: '前台接待',
  triage_nurse: '分诊护士',
  doctor: '医生',
  nurse: '护士',
  lab_technician: '检验人员',
  imaging_technician: '影像人员',
  cashier: '收银员',
  pharmacist: '药房',
  followup_service: '客服回访',
  waiting_display: '候诊大屏',
}

/** 收费项/岗位任务来源类型中文标签(收银工作台来源展示) */
export const JOURNEY_SOURCE_TYPE_LABELS: Record<string, string> = {
  prescription: '处方',
  lab_order: '检验申请',
  imaging_order: '影像检查',
  medical_order: '医嘱',
  followup: '回访',
  procedure: '手动录入',
  manual: '手动录入',
  encounter: '就诊',
  discharge: '离院',
  reminder: '提醒',
  complaint: '投诉',
}

// ============================================================
// 医生工作台 DTO(consumes GET /workbenches/doctor 与 GET /clinical/encounters/:id/workspace)
// ============================================================

/** 队列主动作:医生在候诊列表上可直接执行的一步操作 */
export type DoctorQueuePrimaryAction = 'call' | 'start' | 'continue' | 'view'

/** 医生岗位候诊队列行(服务端聚合,浏览器不再跨表拼装) */
export interface DoctorQueueRow extends WorkbenchRow {
  /** 预约最小摘要:原因与预约时段 */
  appointment?: {
    id: string
    reason?: string | null
    scheduled_start: string
    scheduled_end: string
  } | null
  /** 就诊摘要:状态与乐观锁版本 */
  encounter?: {
    id: string
    status: string
    clinical_status: string
    archive_status?: string | null
    version: number
  } | null
  /** 分诊摘要:分级、生命体征与风险标记 */
  triage?: {
    acuity?: string | null
    risk_flags?: string[] | null
    temperature_c?: number | null
    heart_rate?: number | null
    respiratory_rate?: number | null
    pain_score?: number | null
    weight_kg?: number | null
    allergy_notes?: string | null
  } | null
  /** 服务端推导的主动作:waiting→call / called→start / in_consultation→continue */
  primaryAction: DoctorQueuePrimaryAction
  allowedActions: string[]
  /** 候诊起始时间(等待时长计算基准) */
  waiting_at?: string | null
  checked_in_at?: string | null
  room_name?: string | null
}

/** 收费汇总(服务端计算,浏览器不自行跨表聚合) */
export interface WorkspaceBillingSummary {
  pendingAmount: number
  noPriceCount: number
  pendingCount: number
  paidAmount: number
}

/** 用药安全检查摘要(仅本次就诊已触发的未处理检查) */
export interface MedicationSafetyCheckView {
  id: string
  rule_code: string
  rule_type: string
  severity: 'info' | 'warning' | 'error'
  blocking: boolean
  status: 'triggered' | 'overridden' | 'resolved'
  message_snapshot: string
  recommendation_snapshot?: string | null
  prescription_id?: string | null
  item_index: number
}

/** 患者工作区 DTO(GET /clinical/encounters/:id/workspace) */
export interface EncounterWorkspace {
  encounter: Record<string, any>
  queue: Record<string, any> | null
  triage: Record<string, any> | null
  tasks: Record<string, any>[]
  charges: Record<string, any>[]
  timeline: JourneyEvent[]
  prescriptions: Array<Record<string, any> & { items?: Record<string, any>[] }>
  labOrders: Record<string, any>[]
  imagingOrders: Record<string, any>[]
  medicalOrders: Record<string, any>[]
  /** 宠物与主人完整安全摘要 */
  pet: Record<string, any> | null
  customer: Record<string, any> | null
  /** 当前宠物最近病历摘要(排除本次) */
  recentEncounters: Record<string, any>[]
  billing: WorkspaceBillingSummary
  medicationSafety: {
    blockingChecks: MedicationSafetyCheckView[]
    warningChecks: MedicationSafetyCheckView[]
    hasBlocking: boolean
  }
  journeyStage: string
  blockers: Array<{ type: string, id: string, label: string }>
  warnings: unknown[]
  nextOwnerRole: string | null
  allowedActions: string[]
  /** 各实体最新更新时间戳,用于后台刷新校准 */
  workspaceVersion: number
}

/** 诊疗方案提交命令入参(POST /clinical/encounters/:id/plan/commit) */
export interface ClinicalPlanCommitInput {
  /** 病历乐观锁版本:提交方案前必须显式保存病历并回传最新 version */
  expectedVersion: number
  /** 幂等键:body 与 idempotency-key header 复用同一键,超时重试时由调用方复用 */
  idempotencyKey?: string
  /** 病历字段更新(与草稿同源;服务端按版本在一个事务内原子落库) */
  encounterUpdates?: {
    chiefComplaint?: string
    historyPresent?: string
    examFindings?: string
    diagnosisText?: string
    treatmentPlan?: string
    followUpDate?: string
  }
  /** 处方药品行(同一次开具;受控药/用药安全门禁由服务端 issue 规则执行) */
  prescriptions?: Array<{
    catalogItemId?: string
    drugName?: string
    dosage?: string
    frequency?: string
    durationDays?: number
    quantity?: number
    unit?: string
    instructions?: string
  }>
  /** 检验申请(每个 catalogItemId 创建一张申请,服务端同步收费与检验任务) */
  labs?: Array<{ catalogItemId: string, remark?: string }>
  /** 影像申请(服务端同步收费与影像任务) */
  imaging?: Array<{ catalogItemId: string, imagingType: string, clinicalQuestion?: string }>
  /** 医嘱(服务端自动生成护士任务) */
  medicalOrders?: Array<{
    orderType: string
    itemName: string
    dosage?: string
    frequency?: string
    quantity: number
    unit?: string
    instructions?: string
    /** 计划执行时间(可选,缺省立即执行) */
    scheduledAt?: string
    /** 指定执行护士(auth.users.id,可空=待分派) */
    assigneeId?: string
  }>
  /** 是否将 encounter 推进到 plan_ready(下游岗位待办保留) */
  finishConsultation?: boolean
}

/** 诊疗方案提交结果(POST /clinical/encounters/:id/plan/commit 返回摘要,非 EncounterWorkspace) */
export interface ClinicalPlanCommitResult {
  encounterId: string
  encounterVersion: number
  clinicalStatus: string
  prescriptionId: string | null
  prescriptionStatus: string | null
  prescriptionItemsCount: number
  labOrderIds: string[]
  imagingOrderIds: string[]
  medicalOrderIds: string[]
  medicalOrderNos: string[]
  finishConsultation: boolean
  billingPendingCount: number
  taskCount: number
}
