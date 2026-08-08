import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import { getContext, loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * 审批中心聚合查询路由(CORE-05 Approval Inbox)
 * - GET /approvals/inbox     待我审批(pending)
 * - GET /approvals/mine      我发起的
 * - GET /approvals/processed 已处理(approved/rejected/applied)
 *
 * 统一 DTO,数据源:approvals(invoice_discount) + medical_record_amendments。
 * 决定动作仍走原业务域接口(billing/approvals/:id/decide、compliance/records/amendments/:id/review)。
 */
const approvalsRoutes = new Hono<AppEnv>()

approvalsRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

export interface ApprovalInboxItem {
  type: 'invoice_discount' | 'medical_record_amendment'
  id: string
  title: string
  storeId: string | null
  tenantId: string
  requestedBy: string | null
  requestedByName: string | null
  reason: string | null
  status: string
  risk: 'high' | 'medium' | 'low'
  amount: number | null
  createdAt: string
  entityId: string
  entityType: string
  summary: string
  detail: Record<string, unknown>
}

interface InvoiceApprovalRow {
  id: string
  tenant_id: string
  store_id: string | null
  entity_type: string
  entity_id: string
  requested_by: string | null
  reason: string | null
  status: string
  approval_metadata: Record<string, unknown> | null
  created_at: string
  invoice: { invoice_no: string, total: number | null, subtotal: number | null, discount_amount: number | null } | { invoice_no: string, total: number | null, subtotal: number | null, discount_amount: number | null }[] | null
}

interface AmendmentRow {
  id: string
  tenant_id: string
  store_id: string | null
  medical_record_type: string
  medical_record_id: string
  requested_by: string | null
  requested_at: string
  reason: string
  status: string
  before_snapshot: Record<string, unknown> | null
  after_snapshot: Record<string, unknown> | null
  encounter: { customer_id: string | null, pet_id: string | null, started_at: string | null } | { customer_id: string | null, pet_id: string | null, started_at: string | null }[] | null
}

/** 员工名映射:支持 user_id 与 employee_id 混合 */
async function mapEmployeeNames(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  userIds: string[],
  employeeIds: string[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  const uids = [...new Set(userIds.filter(Boolean))]
  if (uids.length > 0) {
    const { data } = await service
      .from('employees')
      .select('user_id, name')
      .eq('tenant_id', tenantId)
      .in('user_id', uids)
    for (const row of (data ?? []) as Array<{ user_id: string, name: string }>) {
      if (!map[row.user_id]) {
        map[row.user_id] = row.name
      }
    }
  }
  const eids = [...new Set(employeeIds.filter(Boolean))]
  if (eids.length > 0) {
    const { data } = await service
      .from('employees')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .in('id', eids)
    for (const row of (data ?? []) as Array<{ id: string, name: string }>) {
      map[`emp:${row.id}`] = row.name
    }
  }
  return map
}

function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0) || 0
}

function buildInvoiceItems(
  rows: InvoiceApprovalRow[],
  names: Record<string, string>,
): ApprovalInboxItem[] {
  return rows.map((row) => {
    const invoice = Array.isArray(row.invoice) ? row.invoice[0] : row.invoice
    const meta = (row.approval_metadata ?? {}) as Record<string, unknown>
    const discountPercent = toNum(meta.discount_percent)
    const risk: ApprovalInboxItem['risk'] = discountPercent > 30 ? 'high' : discountPercent > 10 ? 'medium' : 'low'
    return {
      type: 'invoice_discount',
      id: row.id,
      title: `发票折扣 ${invoice?.invoice_no ?? ''}`,
      storeId: row.store_id,
      tenantId: row.tenant_id,
      requestedBy: row.requested_by,
      requestedByName: row.requested_by ? names[row.requested_by] ?? null : null,
      reason: row.reason,
      status: row.status,
      risk,
      amount: invoice?.total != null ? toNum(invoice.total) : null,
      createdAt: row.created_at,
      entityId: row.entity_id,
      entityType: 'invoice',
      summary: `折扣 ${toNum(meta.discount_amount)} 元 (${discountPercent.toFixed(2)}%)，合计 ${invoice?.total != null ? toNum(invoice.total).toFixed(2) : '-'} 元`,
      detail: { approval_metadata: meta, invoice_no: invoice?.invoice_no ?? null },
    }
  })
}

function buildAmendmentItems(
  rows: AmendmentRow[],
  names: Record<string, string>,
): ApprovalInboxItem[] {
  return rows.map((row) => {
    const encounter = Array.isArray(row.encounter) ? row.encounter[0] : row.encounter
    return {
      type: 'medical_record_amendment',
      id: row.id,
      title: `病历修订申请（${row.medical_record_type === 'admission' ? '住院' : '门诊'}）`,
      storeId: row.store_id,
      tenantId: row.tenant_id,
      requestedBy: row.requested_by ? `emp:${row.requested_by}` : null,
      requestedByName: row.requested_by ? names[`emp:${row.requested_by}`] ?? null : null,
      reason: row.reason,
      status: row.status,
      risk: 'medium',
      amount: null,
      createdAt: row.requested_at,
      entityId: row.medical_record_id,
      entityType: row.medical_record_type,
      summary: encounter?.started_at ? `病历开始于 ${String(encounter.started_at).slice(0, 19).replace('T', ' ')}` : '病历修订',
      detail: {
        before_snapshot: row.before_snapshot ?? {},
        after_snapshot: row.after_snapshot ?? {},
        medical_record_type: row.medical_record_type,
      },
    }
  })
}

async function queryApprovals(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  allowedStoreIds: string[],
  filter: 'pending' | 'mine' | 'processed',
  userId: string,
  employeeId: string,
) {
  let query = service
    .from('approvals')
    .select('*, invoice:invoices(invoice_no, total, subtotal, discount_amount)')
    .eq('tenant_id', tenantId)
    .eq('entity_type', 'invoice_discount')
  // 门店级角色只返回其授权门店的审批(租户级角色 allowedStoreIds = 全租户,等价无过滤)
  if (allowedStoreIds.length > 0) {
    query = query.in('store_id', allowedStoreIds)
  }
  if (filter === 'pending') {
    query = query.eq('status', 'pending')
  }
  else if (filter === 'processed') {
    query = query.in('status', ['approved', 'rejected'])
  }
  else {
    query = query.eq('requested_by', userId)
  }
  const { data, error } = await query.order('created_at', { ascending: false }).limit(100)
  if (error) {
    throw err.internal(`查询折扣审批失败: ${error.message}`)
  }
  return (data ?? []) as InvoiceApprovalRow[]
}

async function queryAmendments(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  allowedStoreIds: string[],
  filter: 'pending' | 'mine' | 'processed',
  employeeId: string,
) {
  let query = service
    .from('medical_record_amendments')
    .select('*, encounter:encounters(customer_id, pet_id, started_at)')
    .eq('tenant_id', tenantId)
  if (allowedStoreIds.length > 0) {
    query = query.in('store_id', allowedStoreIds)
  }
  if (filter === 'pending') {
    query = query.eq('status', 'pending')
  }
  else if (filter === 'processed') {
    query = query.in('status', ['approved', 'rejected', 'applied'])
  }
  else {
    query = query.eq('requested_by', employeeId)
  }
  const { data, error } = await query.order('requested_at', { ascending: false }).limit(100)
  if (error) {
    throw err.internal(`查询病历修订审批失败: ${error.message}`)
  }
  return (data ?? []) as AmendmentRow[]
}

async function loadInbox(c: Parameters<typeof requireScopedPermission>[0], filter: 'pending' | 'mine' | 'processed') {
  const tenantId = c.req.query('tenantId') ?? (getContext(c).memberships[0]?.tenant_id ?? '')
  const scope = await requireScopedPermission(c, {
    code: 'approval.inbox.view',
    tenantId,
    dataScope: true,
  })

  const service = createServiceClient()
  const [approvalRows, amendmentRows] = await Promise.all([
    queryApprovals(service, scope.tenantId, scope.allowedStoreIds, filter, scope.userId, scope.employeeId),
    queryAmendments(service, scope.tenantId, scope.allowedStoreIds, filter, scope.employeeId),
  ])

  const names = await mapEmployeeNames(
    service,
    scope.tenantId,
    approvalRows.map(r => r.requested_by ?? ''),
    amendmentRows.map(r => r.requested_by ?? ''),
  )

  const items: ApprovalInboxItem[] = [
    ...buildInvoiceItems(approvalRows, names),
    ...buildAmendmentItems(amendmentRows, names),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  await writeAudit(c, {
    action: `approvals.${filter}.view`,
    entityType: 'approval',
    tenantId: scope.tenantId,
    metadata: { filter, total: items.length },
  })

  return ok(c, { list: items, total: items.length })
}

approvalsRoutes.get('/inbox', async (c) => {
  return loadInbox(c, 'pending')
})

approvalsRoutes.get('/mine', async (c) => {
  return loadInbox(c, 'mine')
})

approvalsRoutes.get('/processed', async (c) => {
  return loadInbox(c, 'processed')
})

export default approvalsRoutes
