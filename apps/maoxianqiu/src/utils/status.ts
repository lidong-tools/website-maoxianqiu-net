/**
 * 业务状态统一映射(毛线球设计系统)。
 * 约定:状态必须同时具备 label 与 variant,禁止页面自行写三元表达式。
 * 通用 variant:neutral / info / success / warning / danger
 */
export type StatusVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface StatusDef {
  label: string
  variant: StatusVariant
}

/** 通用启停/归档状态 */
export const commonStatusMap: Record<string, StatusDef> = {
  active: { label: '启用', variant: 'success' },
  disabled: { label: '停用', variant: 'neutral' },
  archived: { label: '已归档', variant: 'neutral' },
  pending: { label: '待处理', variant: 'warning' },
  draft: { label: '草稿', variant: 'neutral' },
  submitted: { label: '已提交', variant: 'info' },
  approved: { label: '已通过', variant: 'success' },
  rejected: { label: '已驳回', variant: 'danger' },
  cancelled: { label: '已取消', variant: 'danger' },
  completed: { label: '已完成', variant: 'success' },
}

/** 门店状态 */
export const storeStatusMap: Record<string, StatusDef> = {
  active: { label: '营业中', variant: 'success' },
  disabled: { label: '停业', variant: 'neutral' },
  archived: { label: '已归档', variant: 'neutral' },
}

/** 员工状态 */
export const employeeStatusMap: Record<string, StatusDef> = {
  active: { label: '在职', variant: 'success' },
  invited: { label: '待接受', variant: 'warning' },
  disabled: { label: '停用', variant: 'neutral' },
  resigned: { label: '离职', variant: 'neutral' },
}

/** 租户状态 */
export const tenantStatusMap: Record<string, StatusDef> = {
  active: { label: '正常', variant: 'success' },
  trial: { label: '试用', variant: 'info' },
  suspended: { label: '已停用', variant: 'danger' },
}

/** 会员关系状态 */
export const membershipStatusMap: Record<string, StatusDef> = {
  active: { label: '正常', variant: 'success' },
  invited: { label: '待接受', variant: 'warning' },
  suspended: { label: '已停用', variant: 'danger' },
  left: { label: '已退出', variant: 'neutral' },
}
