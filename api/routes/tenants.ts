import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import { loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * 租户初始化 Command 路由(S3.1 并发任务 A)
 * 新建医院后一键初始化:首店 / tenant_owner / 默认仓库 / 支付上下文 / 基础字典 / 打印设置。
 * - POST /tenants/initialize            执行初始化(幂等,可恢复)
 * - GET  /tenants/:id/initialization    查询初始化状态(not_started / pending / running / completed / failed)
 * 初始化是租户级状态转换,必须走 Hono Command + service-role-only RPC,禁止前端串多个 API 冒充事务。
 */
const tenantRoutes = new Hono<AppEnv>()

tenantRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const initializeSchema = z.object({
  // 二选一:tenantId(已存在租户) 或 tenantSlug + tenantName(平台管理员新建租户)
  tenantId: z.string().uuid('租户参数无效').optional(),
  tenantSlug: z.string().min(2, '租户 slug 至少 2 个字符').optional(),
  tenantName: z.string().min(1, '租户名称不能为空').optional(),
  storeName: z.string().min(1, '门店名称不能为空'),
  storeCode: z.string().min(1, '门店编码不能为空'),
  ownerUserId: z.string().uuid('所有者用户参数无效'),
  ownerName: z.string().min(1, '所有者姓名不能为空'),
  ownerPhone: z.string().optional(),
  timezone: z.string().default('Asia/Shanghai'),
  idempotencyKey: z.string().optional(),
}).refine(
  data => data.tenantId || (data.tenantSlug && data.tenantName),
  { message: '必须提供 tenantId,或 tenantSlug + tenantName 以新建租户', path: ['tenantId'] },
)

/**
 * 执行租户初始化(S3.1-A)
 * - 已存在租户:requireScopedPermission(tenant.initialize, tenantId)
 * - 新建租户(平台管理员):先创建 tenants 行,再调用 initialize_tenant RPC
 * - RPC 幂等:同 (tenantId, idempotencyKey) 重复请求返回首次结果,不重复创建资源
 */
tenantRoutes.post('/initialize', async (c) => {
  const input = await parseJsonBody(c, initializeSchema)
  const service = createServiceClient()
  const user = c.get('user')
  const isPlatformAdmin = c.get('isPlatformAdmin') === true

  let tenantId = input.tenantId
  let tenantSlug = input.tenantSlug

  // 新建租户:仅平台管理员可执行(独立平台授权来源 platform_user_roles)
  if (!tenantId) {
    if (!isPlatformAdmin) {
      throw err.forbidden('仅平台管理员可创建新租户并初始化')
    }
    const { data: newTenant, error: tenantError } = await service
      .from('tenants')
      .insert({
        slug: tenantSlug,
        name: input.tenantName,
        timezone: input.timezone,
      })
      .select('id, slug')
      .single()
    if (tenantError) {
      // 唯一约束冲突:slug 已被占用
      if (tenantError.message.includes('duplicate') || tenantError.message.includes('unique')) {
        throw err.conflict('租户 slug 已存在')
      }
      throw err.internal(`创建租户失败: ${tenantError.message}`)
    }
    tenantId = newTenant.id
    tenantSlug = newTenant.slug
  }

  // 已存在租户:基于租户实体解析授权作用域(平台管理员跨租户放行)
  const { data: tenant } = await service
    .from('tenants')
    .select('id, slug, name')
    .eq('id', tenantId)
    .maybeSingle()
  if (!tenant) {
    throw err.notFound('租户不存在')
  }
  await requireScopedPermission(c, { code: 'tenant.initialize', tenantId: tenant.id })

  const { data, error } = await service.rpc('initialize_tenant', {
    p_tenant_id: tenantId,
    p_tenant_slug: tenantSlug ?? tenant.slug,
    p_tenant_name: input.tenantName ?? tenant.name,
    p_store_name: input.storeName,
    p_store_code: input.storeCode,
    p_owner_user_id: input.ownerUserId,
    p_owner_name: input.ownerName,
    p_owner_phone: input.ownerPhone ?? null,
    p_timezone: input.timezone,
    p_operator_id: user.id,
    p_idempotency_key: input.idempotencyKey,
  })

  if (error) {
    if (error.message.includes('TENANT_INIT_IN_PROGRESS')) {
      // 并发/轮询场景:返回进行中状态,由前端轮询 GET /:id/initialization
      return ok(c, { status: 'running', tenantId, note: '初始化进行中,请轮询状态' })
    }
    if (error.message.includes('TENANT_INIT_MAX_RETRIES')) {
      throw err.unprocessable('初始化失败已达上限,请人工介入')
    }
    throw err.internal(`初始化失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'tenant.initialize',
    entityType: 'tenant',
    entityId: tenantId,
    tenantId,
    metadata: {
      storeName: input.storeName,
      status: data?.status,
      initializationId: data?.initializationId,
    },
  })

  return ok(c, data)
})

const updateTenantSchema = z.object({
  name: z.string().min(1, '医院名称不能为空').max(100).optional(),
  shortName: z.string().max(50).optional(),
  timezone: z.string().max(64).optional(),
  currency: z.string().max(16).optional(),
  locale: z.string().max(16).optional(),
})

/**
 * 查询租户(医院信息,系统设置用)
 * - 权限:settings.tenant.read
 */
tenantRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw err.badRequest('租户参数无效')
  }
  const service = createServiceClient()
  const { data: tenant } = await service
    .from('tenants')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (!tenant) {
    throw err.notFound('租户不存在')
  }
  await requireScopedPermission(c, { code: 'settings.tenant.read', tenantId: id })
  return ok(c, tenant)
})

/**
 * 更新租户(医院信息,系统设置用)
 * - 权限:settings.tenant.manage
 */
tenantRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw err.badRequest('租户参数无效')
  }
  const input = await parseJsonBody(c, updateTenantSchema)
  const service = createServiceClient()
  const { data: tenant } = await service
    .from('tenants')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (!tenant) {
    throw err.notFound('租户不存在')
  }
  const scope = await requireScopedPermission(c, { code: 'settings.tenant.manage', tenantId: id })

  const patch: Record<string, string | null> = {}
  if (input.name !== undefined) {
    patch.name = input.name
  }
  if (input.shortName !== undefined) {
    patch.short_name = input.shortName || null
  }
  if (input.timezone !== undefined) {
    patch.timezone = input.timezone
  }
  if (input.currency !== undefined) {
    patch.currency = input.currency
  }
  if (input.locale !== undefined) {
    patch.locale = input.locale
  }

  const { error } = await service.from('tenants').update(patch).eq('id', id)
  if (error) {
    throw err.internal(`更新租户失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'tenant.settings.update',
    entityType: 'tenant',
    entityId: id,
    tenantId: scope.tenantId,
    metadata: patch,
  })

  return ok(c, { isSuccess: true })
})

/**
 * 查询租户初始化状态(S3.1-A)
 * - 权限:tenant.initialization.read
 * - 未初始化返回 { status: 'not_started' }
 */
tenantRoutes.get('/:id/initialization', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw err.badRequest('租户参数无效')
  }
  const service = createServiceClient()

  const { data: tenant } = await service
    .from('tenants')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (!tenant) {
    throw err.notFound('租户不存在')
  }

  await requireScopedPermission(c, { code: 'tenant.initialization.read', tenantId: id })

  const { data, error } = await service.rpc('get_tenant_initialization', {
    p_tenant_id: id,
  })
  if (error) {
    throw err.internal(`查询初始化状态失败: ${error.message}`)
  }

  return ok(c, data)
})

// ============================================================
// 平台租户管理(S3.1 并发任务 A:平台租户列表/详情/停用/恢复)
// 仅平台管理员(platform.tenant.* 权限码,唯一来源 platform_user_roles)。
// 普通租户员工无对应权限码,且 resolveScopedAccess 空/目标租户无员工档案会被拒。
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const statusChangeSchema = z.object({
  reason: z.string().min(1, '原因不能为空').max(200, '原因不能超过 200 字'),
})

/**
 * 平台租户列表(仅平台管理员)
 * - 权限:platform.tenant.list
 * - tenantId 传空:平台管理员跨租户放行;普通员工无员工档案匹配被拒
 */
tenantRoutes.get('/', async (c) => {
  await requireScopedPermission(c, { code: 'platform.tenant.list', tenantId: '' })
  const service = createServiceClient()

  const { data, error } = await service
    .from('tenants')
    .select('id, slug, name, short_name, status, trial_ends_at, timezone, currency, locale, created_at, updated_at')
    .order('created_at', { ascending: true })
  if (error) {
    throw err.internal(`查询租户失败: ${error.message}`)
  }
  const tenants = (data ?? []) as Array<{
    id: string
    slug: string
    name: string
    short_name: string | null
    status: string
    trial_ends_at: string | null
    timezone: string
    currency: string
    locale: string
    created_at: string
    updated_at: string
  }>
  const tenantIds = tenants.map(t => t.id)

  // 聚合门店/员工计数(一次 grouped select,避免逐租户 N+1)
  const [storeRows, empRows] = tenantIds.length > 0
    ? await Promise.all([
      service.from('stores')
        .select('tenant_id')
        .in('tenant_id', tenantIds)
        .is('archived_at', null),
      service.from('employees')
        .select('tenant_id, status')
        .in('tenant_id', tenantIds),
    ])
    : [{ data: null, error: null }, { data: null, error: null }]

  if (storeRows.error || empRows.error) {
    throw err.internal('查询租户统计失败')
  }
  const storeCount = new Map<string, number>()
  for (const row of (storeRows.data ?? []) as Array<{ tenant_id: string }>) {
    storeCount.set(row.tenant_id, (storeCount.get(row.tenant_id) ?? 0) + 1)
  }
  const empCount = new Map<string, { active: number, total: number }>()
  for (const row of (empRows.data ?? []) as Array<{ tenant_id: string, status: string }>) {
    const cur = empCount.get(row.tenant_id) ?? { active: 0, total: 0 }
    cur.total += 1
    if (row.status === 'active') {
      cur.active += 1
    }
    empCount.set(row.tenant_id, cur)
  }

  return ok(c, {
    list: tenants.map(t => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      shortName: t.short_name,
      status: t.status,
      trialEndsAt: t.trial_ends_at,
      timezone: t.timezone,
      currency: t.currency,
      locale: t.locale,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      storeCount: storeCount.get(t.id) ?? 0,
      activeEmployeeCount: empCount.get(t.id)?.active ?? 0,
      employeeCount: empCount.get(t.id)?.total ?? 0,
    })),
  })
})

/**
 * 租户概览(详情页:基础信息 + 门店/员工统计)
 * - 权限:platform.tenant.read
 */
tenantRoutes.get('/:id/overview', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    throw err.badRequest('租户参数无效')
  }
  const service = createServiceClient()
  const { data: tenant } = await service
    .from('tenants')
    .select('id, slug, name, short_name, status, trial_ends_at, timezone, currency, locale, created_at, updated_at')
    .eq('id', id)
    .maybeSingle()
  if (!tenant) {
    throw err.notFound('租户不存在')
  }
  await requireScopedPermission(c, { code: 'platform.tenant.read', tenantId: id })

  const [storeRows, empRows] = await Promise.all([
    service.from('stores').select('id').eq('tenant_id', id).is('archived_at', null),
    service.from('employees').select('id, status').eq('tenant_id', id),
  ])
  if (storeRows.error || empRows.error) {
    throw err.internal('查询租户统计失败')
  }
  const totalEmployeeCount = (empRows.data ?? []).length
  const activeEmployeeCount = (empRows.data ?? [] as Array<{ status: string }>)
    .filter((e: { status: string }) => e.status === 'active').length

  return ok(c, {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    shortName: tenant.short_name,
    status: tenant.status,
    trialEndsAt: tenant.trial_ends_at,
    timezone: tenant.timezone,
    currency: tenant.currency,
    locale: tenant.locale,
    createdAt: tenant.created_at,
    updatedAt: tenant.updated_at,
    storeCount: (storeRows.data ?? []).length,
    totalEmployeeCount,
    activeEmployeeCount,
  })
})

/**
 * 租户下门店列表(平台租户详情)
 * - 权限:platform.tenant.read
 */
tenantRoutes.get('/:id/stores', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    throw err.badRequest('租户参数无效')
  }
  await requireScopedPermission(c, { code: 'platform.tenant.read', tenantId: id })
  const service = createServiceClient()
  const { data, error } = await service
    .from('stores')
    .select('id, name, code, status, address, phone, timezone, business_hours, archived_at, created_at')
    .eq('tenant_id', id)
    .order('created_at', { ascending: true })
  if (error) {
    throw err.internal(`查询门店失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

/**
 * 租户下人员列表(平台租户详情,含角色码与归属门店)
 * - 权限:platform.tenant.read
 */
tenantRoutes.get('/:id/employees', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    throw err.badRequest('租户参数无效')
  }
  await requireScopedPermission(c, { code: 'platform.tenant.read', tenantId: id })
  const service = createServiceClient()

  const { data: empRows, error: empErr } = await service
    .from('employees')
    .select('id, employee_no, name, phone, email, title, status, created_at, user_id')
    .eq('tenant_id', id)
    .order('created_at', { ascending: true })
  if (empErr) {
    throw err.internal(`查询人员失败: ${empErr.message}`)
  }
  const employees = (empRows ?? []) as Array<{
    id: string
    employee_no: string
    name: string
    phone: string | null
    email: string | null
    title: string | null
    status: string
    created_at: string
    user_id: string | null
  }>
  const empIds = employees.map(e => e.id)

  const [roleRows, storeAssignRows] = empIds.length > 0
    ? await Promise.all([
      service.from('employee_role_assignments')
        .select('employee_id, store_id, roles(code)')
        .eq('tenant_id', id)
        .in('employee_id', empIds),
      service.from('employee_store_assignments')
        .select('employee_id, store_id, is_primary, stores(name)')
        .eq('tenant_id', id)
        .in('employee_id', empIds),
    ])
    : [{ data: null, error: null }, { data: null, error: null }]
  if (roleRows.error || storeAssignRows.error) {
    throw err.internal('查询人员归属失败')
  }

  const roleMap = new Map<string, string[]>()
  for (const r of (roleRows.data ?? []) as Array<{
    employee_id: string
    roles: { code: string } | { code: string }[] | null
  }>) {
    if (!r.roles) {
      continue
    }
    const codes = Array.isArray(r.roles) ? r.roles.map(x => x.code) : [r.roles.code]
    const arr = roleMap.get(r.employee_id) ?? []
    arr.push(...codes)
    roleMap.set(r.employee_id, [...new Set(arr)])
  }

  const storeMap = new Map<string, Array<{ id: string, name: string, isPrimary: boolean }>>()
  for (const s of (storeAssignRows.data ?? []) as Array<{
    employee_id: string
    store_id: string
    is_primary: boolean
    stores: { name: string } | { name: string }[] | null
  }>) {
    const name = Array.isArray(s.stores) ? s.stores[0]?.name : s.stores?.name
    const arr = storeMap.get(s.employee_id) ?? []
    arr.push({ id: s.store_id, name: name ?? '', isPrimary: !!s.is_primary })
    storeMap.set(s.employee_id, arr)
  }

  return ok(c, {
    list: employees.map(e => ({
      id: e.id,
      employeeNo: e.employee_no,
      name: e.name,
      phone: e.phone,
      email: e.email,
      title: e.title,
      status: e.status,
      createdAt: e.created_at,
      roles: roleMap.get(e.id) ?? [],
      stores: storeMap.get(e.id) ?? [],
    })),
  })
})

/**
 * 停用租户(仅平台管理员,必须带原因)
 * - 权限:platform.tenant.suspend
 * - 走 suspend_tenant RPC(行锁状态转换),审计由本 Command 写入
 * - 停用后新业务 Command / RLS 直连均被拦截(见 resolveScopedAccess 与 RLS helper)
 */
tenantRoutes.post('/:id/suspend', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    throw err.badRequest('租户参数无效')
  }
  const input = await parseJsonBody(c, statusChangeSchema)
  const service = createServiceClient()
  const user = c.get('user')

  const { data: tenant } = await service
    .from('tenants')
    .select('id, name')
    .eq('id', id)
    .maybeSingle()
  if (!tenant) {
    throw err.notFound('租户不存在')
  }
  const scope = await requireScopedPermission(c, { code: 'platform.tenant.suspend', tenantId: id })

  const { data, error } = await service.rpc('suspend_tenant', {
    p_tenant_id: id,
    p_operator_id: user.id,
    p_reason: input.reason,
  })
  if (error) {
    if (error.message.includes('TENANT_NOT_FOUND')) {
      throw err.notFound('租户不存在')
    }
    if (error.message.includes('TENANT_ALREADY_SUSPENDED')) {
      throw err.conflict('租户已停用')
    }
    throw err.internal(`停用租户失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'tenant.suspend',
    entityType: 'tenant',
    entityId: id,
    tenantId: scope.tenantId,
    metadata: { name: tenant.name, reason: input.reason },
  })

  return ok(c, data)
})

/**
 * 恢复租户(仅平台管理员,必须带原因)
 * - 权限:platform.tenant.resume
 * - 走 resume_tenant RPC(行锁状态转换),审计由本 Command 写入
 */
tenantRoutes.post('/:id/resume', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) {
    throw err.badRequest('租户参数无效')
  }
  const input = await parseJsonBody(c, statusChangeSchema)
  const service = createServiceClient()
  const user = c.get('user')

  const { data: tenant } = await service
    .from('tenants')
    .select('id, name')
    .eq('id', id)
    .maybeSingle()
  if (!tenant) {
    throw err.notFound('租户不存在')
  }
  const scope = await requireScopedPermission(c, { code: 'platform.tenant.resume', tenantId: id })

  const { data, error } = await service.rpc('resume_tenant', {
    p_tenant_id: id,
    p_operator_id: user.id,
    p_reason: input.reason,
  })
  if (error) {
    if (error.message.includes('TENANT_NOT_FOUND')) {
      throw err.notFound('租户不存在')
    }
    if (error.message.includes('TENANT_NOT_SUSPENDED')) {
      throw err.conflict('租户未停用')
    }
    throw err.internal(`恢复租户失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'tenant.resume',
    entityType: 'tenant',
    entityId: id,
    tenantId: scope.tenantId,
    metadata: { name: tenant.name, reason: input.reason },
  })

  return ok(c, data)
})

export default tenantRoutes
