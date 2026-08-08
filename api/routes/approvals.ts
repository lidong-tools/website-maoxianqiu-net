import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext, resolveRequestedTenant } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

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
  range?: { from: number, to: number },
) {
  let query = service
    .from('approvals')
    .select('*, invoice:invoices(invoice_no, total, subtotal, discount_amount)', { count: 'exact' })
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
  query = query.order('created_at', { ascending: false })
  if (range) {
    query = query.range(range.from, range.to)
  }
  else {
    query = query.limit(100)
  }
  const { data, error, count } = await query
  if (error) {
    throw err.internal(`查询折扣审批失败: ${error.message}`)
  }
  return { rows: (data ?? []) as InvoiceApprovalRow[], total: count ?? 0 }
}

async function queryAmendments(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  allowedStoreIds: string[],
  filter: 'pending' | 'mine' | 'processed',
  employeeId: string,
  range?: { from: number, to: number },
) {
  let query = service
    .from('medical_record_amendments')
    .select('*, encounter:encounters(customer_id, pet_id, started_at)', { count: 'exact' })
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
  query = query.order('requested_at', { ascending: false })
  if (range) {
    query = query.range(range.from, range.to)
  }
  else {
    query = query.limit(100)
  }
  const { data, error, count } = await query
  if (error) {
    throw err.internal(`查询病历修订审批失败: ${error.message}`)
  }
  return { rows: (data ?? []) as AmendmentRow[], total: count ?? 0 }
}

type ApprovalFilter = 'pending' | 'mine' | 'processed'

/** 单个 filter 的总数(approvals + amendments) */
async function countForFilter(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  allowedStoreIds: string[],
  filter: ApprovalFilter,
  userId: string,
  employeeId: string,
): Promise<number> {
  const [a, m] = await Promise.all([
    queryApprovals(service, tenantId, allowedStoreIds, filter, userId, employeeId, { from: 0, to: 0 }),
    queryAmendments(service, tenantId, allowedStoreIds, filter, employeeId, { from: 0, to: 0 }),
  ])
  return a.total + m.total
}

/** P0-18:三个 Tab 的独立计数,避免拉全量列表只为算数字 */
async function loadCounts(c: Parameters<typeof requireScopedPermission>[0]) {
  const tenantId = resolveRequestedTenant(c, c.req.query('tenantId')) ?? ''
  const scope = await requireScopedPermission(c, {
    code: 'approval.inbox.view',
    tenantId,
    dataScope: true,
  })
  const service = createServiceClient()
  const [inbox, mine, processed] = await Promise.all([
    countForFilter(service, scope.tenantId, scope.allowedStoreIds, 'pending', scope.userId, scope.employeeId),
    countForFilter(service, scope.tenantId, scope.allowedStoreIds, 'mine', scope.userId, scope.employeeId),
    countForFilter(service, scope.tenantId, scope.allowedStoreIds, 'processed', scope.userId, scope.employeeId),
  ])
  return { inbox, mine, processed }
}

async function loadInbox(
  c: Parameters<typeof requireScopedPermission>[0],
  filter: ApprovalFilter,
  page = 1,
  pageSize = 20,
) {
  const tenantId = resolveRequestedTenant(c, c.req.query('tenantId')) ?? ''
  const scope = await requireScopedPermission(c, {
    code: 'approval.inbox.view',
    tenantId,
    dataScope: true,
  })

  const service = createServiceClient()
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  const [approvalRes, amendmentRes] = await Promise.all([
    queryApprovals(service, scope.tenantId, scope.allowedStoreIds, filter, scope.userId, scope.employeeId, { from, to }),
    queryAmendments(service, scope.tenantId, scope.allowedStoreIds, filter, scope.employeeId, { from, to }),
  ])

  const names = await mapEmployeeNames(
    service,
    scope.tenantId,
    approvalRes.rows.map(r => r.requested_by ?? ''),
    amendmentRes.rows.map(r => r.requested_by ?? ''),
  )

  const items: ApprovalInboxItem[] = [
    ...buildInvoiceItems(approvalRes.rows, names),
    ...buildAmendmentItems(amendmentRes.rows, names),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  const total = approvalRes.total + amendmentRes.total
  const facets = await loadCounts(c)

  await writeAudit(c, {
    action: `approvals.${filter}.view`,
    entityType: 'approval',
    tenantId: scope.tenantId,
    metadata: { filter, page, pageSize, total },
  })

  return ok(c, { list: items, total, pagination: { page, pageSize, total }, facets })
}

// P0-18:分页 + 计数统一入口
approvalsRoutes.get('/', async (c) => {
  const tab = c.req.query('tab') ?? 'inbox'
  const filter: ApprovalFilter = tab === 'mine' ? 'mine' : tab === 'processed' ? 'processed' : 'pending'
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize')) || 20))
  return loadInbox(c, filter, page, pageSize)
})

// P0-18:独立计数
approvalsRoutes.get('/counts', async (c) => {
  const facets = await loadCounts(c)
  await writeAudit(c, {
    action: 'approvals.counts.view',
    entityType: 'approval',
    metadata: { facets },
  })
  return ok(c, facets)
})

// 兼容旧入口(无分页,默认拉前 100)
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
