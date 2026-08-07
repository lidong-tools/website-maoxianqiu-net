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
  await requireScopedPermission(c, { code: 'tenant.initialize', tenantId })

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

export default tenantRoutes
