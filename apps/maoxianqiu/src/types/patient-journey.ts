export type WorkbenchRole = 'frontdesk' | 'triage' | 'doctor' | 'nurse' | 'lab' | 'imaging' | 'cashier' | 'pharmacy' | 'followup' | 'manager'

export interface JourneyPerson {
  id: string
  name: string
  phone?: string
  species?: string
  breed?: string
  employee_no?: string
}

export interface WorkbenchRow {
  id: string
  status: string
  encounter_id?: string
  queue_no?: string
  queue_number?: string
  task_type?: string
  title?: string
  item_name?: string
  source_type?: string
  priority?: string
  amount?: number
  quantity?: number
  unit_price?: number
  checked_in_at?: string
  called_at?: string
  due_at?: string
  created_at?: string
  customer?: JourneyPerson | null
  pet?: JourneyPerson | null
  assignee?: JourneyPerson | null
  [key: string]: unknown
}

export interface WorkbenchData {
  role: WorkbenchRole
  counts: Record<string, number>
  total: number
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
