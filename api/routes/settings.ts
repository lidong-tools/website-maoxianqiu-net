import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * 系统设置路由(CORE-06)
 * - GET    /settings/effective       生效配置合并(门店覆盖 → 租户默认 → 系统默认),标注来源
 * - GET    /settings                 原始配置记录
 * - PUT    /settings/:namespace/:key 写入(storeId 有值=门店覆盖,否则租户默认)
 * - DELETE /settings/:namespace/:key/override  删除门店覆盖恢复继承
 */
const settingsRoutes = new Hono<AppEnv>()

settingsRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/**
 * 设置强类型注册表(P0-11)
 * 业务规则配置写入时必须符合对应 Schema,API 不信任 UI。
 * key 格式:namespace.key
 */
const SETTING_REGISTRY: Record<string, z.ZodTypeAny> = {
  'business.discount.approval.threshold': z.number().min(0).max(1),
  'business.refund.approval.threshold': z.number().min(0),
  'business.inventory.adjust.approval.threshold': z.number().min(0),
  'business.transfer.approval.enabled': z.boolean(),
  'business.near_expiry.reminder.days': z.number().int().min(1).max(3650),
}

/** 业务规则内置系统默认(读取优先级最低) */
const BUSINESS_RULE_DEFS: Array<{ key: string, label: string, defaultValue: unknown, type: 'percent' | 'number' | 'days' | 'bool' }> = [
  { key: 'discount.approval.threshold', label: '折扣审批阈值', defaultValue: 0.1, type: 'percent' },
  { key: 'refund.approval.threshold', label: '高额退款审批阈值(元)', defaultValue: 1000, type: 'number' },
  { key: 'inventory.adjust.approval.threshold', label: '高额库存调整审批阈值(元)', defaultValue: 5000, type: 'number' },
  { key: 'transfer.approval.enabled', label: '跨店调拨需审批', defaultValue: true, type: 'bool' },
  { key: 'near_expiry.reminder.days', label: '近效期提醒天数', defaultValue: 90, type: 'days' },
]

interface SystemSettingRow {
  store_id: string | null
  key: string
  value_json: unknown
}

/**
 * 生效配置合并(只支持 business 命名空间的内置规则)
 * 权限:settings.store.read(租户/门店范围内)
 */
settingsRoutes.get('/effective', async (c) => {
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  const namespace = c.req.query('namespace') ?? 'business'
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  const scope = await requireScopedPermission(c, {
    code: 'settings.store.read',
    tenantId,
    storeId: storeId || undefined,
    dataScope: true,
  })

  const service = createServiceClient()
  const { data, error } = await service
    .from('system_settings')
    .select('store_id, key, value_json')
    .eq('tenant_id', scope.tenantId)
    .eq('namespace', namespace)
  if (error) {
    throw err.internal(`查询配置失败: ${error.message}`)
  }

  const rows = (data ?? []) as SystemSettingRow[]
  const overrideMap = new Map(rows.filter(r => r.store_id === storeId).map(r => [r.key, r.value_json]))
  const tenantMap = new Map(rows.filter(r => r.store_id === null).map(r => [r.key, r.value_json]))

  const items = BUSINESS_RULE_DEFS.map((def) => {
    let value: unknown
    let source: 'store' | 'tenant' | 'system' = 'system'
    if (overrideMap.has(def.key)) {
      value = overrideMap.get(def.key)
      source = 'store'
    }
    else if (tenantMap.has(def.key)) {
      value = tenantMap.get(def.key)
      source = 'tenant'
    }
    else {
      value = def.defaultValue
      source = 'system'
    }
    return { namespace, key: def.key, label: def.label, type: def.type, value, source }
  })

  await writeAudit(c, {
    action: 'settings.effective.view',
    entityType: 'system_setting',
    tenantId: scope.tenantId,
    storeId: storeId || undefined,
    metadata: { namespace, total: items.length },
  })

  return ok(c, { items })
})

/**
 * 原始配置记录列表
 * 权限:settings.store.read(租户/门店范围内)
 */
settingsRoutes.get('/', async (c) => {
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  const namespace = c.req.query('namespace')
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  const scope = await requireScopedPermission(c, {
    code: 'settings.store.read',
    tenantId,
    storeId: storeId || undefined,
    dataScope: true,
  })

  const service = createServiceClient()
  let query = service
    .from('system_settings')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
  // 门店级角色只返回其授权门店的覆盖 + 租户默认;租户级角色 allowedStoreIds = 全租户,等价无过滤
  if (scope.allowedStoreIds.length > 0 && !storeId) {
    query = query.or(`store_id.in.(${scope.allowedStoreIds.join(',')}),store_id.is.null`)
  }
  if (storeId) {
    query = query.eq('store_id', storeId)
  }
  if (namespace) {
    query = query.eq('namespace', namespace)
  }
  const { data, error, count } = await query.order('updated_at', { ascending: false })
  if (error) {
    throw err.internal(`查询配置失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

const saveSettingSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误').optional(),
  value: z.union([z.number(), z.boolean(), z.string(), z.record(z.string(), z.unknown())]),
})

/**
 * 写入配置
 * - storeId 有值:门店覆盖(settings.store.manage,限定该门店)
 * - storeId 为空:租户默认(settings.tenant.manage,仅租户级角色)
 */
settingsRoutes.put('/:namespace/:key', async (c) => {
  const namespace = c.req.param('namespace')
  const key = c.req.param('key')
  const input = await parseJsonBody(c, saveSettingSchema)
  const user = c.get('user')
  const service = createServiceClient()

  // P0-11:注册表强类型校验,拒绝越界/非法值(折扣阈值 -1、近效期 -200 天等)
  const registrySchema = SETTING_REGISTRY[`${namespace}.${key}`]
  if (registrySchema) {
    const parsed = registrySchema.safeParse(input.value)
    if (!parsed.success) {
      throw err.unprocessable('配置值不符合业务规则', {
        value: parsed.error.issues.map(i => i.message),
      })
    }
    input.value = parsed.data as typeof input.value
  }

  if (input.storeId) {
    const scope = await requireScopedPermission(c, {
      code: 'settings.store.manage',
      tenantId: input.tenantId,
      storeId: input.storeId,
    })
    const { error } = await service.from('system_settings').upsert({
      tenant_id: scope.tenantId,
      store_id: input.storeId,
      namespace,
      key,
      value_json: input.value,
      updated_by: user.id,
    }, { onConflict: 'tenant_id,store_id,namespace,key' })
    if (error) {
      throw err.internal(`写入门店配置失败: ${error.message}`)
    }
  }
  else {
    const scope = await requireScopedPermission(c, {
      code: 'settings.tenant.manage',
      tenantId: input.tenantId,
    })
    const { error } = await service.from('system_settings').upsert({
      tenant_id: scope.tenantId,
      store_id: null,
      namespace,
      key,
      value_json: input.value,
      updated_by: user.id,
    }, { onConflict: 'tenant_id,store_id,namespace,key' })
    if (error) {
      throw err.internal(`写入租户配置失败: ${error.message}`)
    }
  }

  await writeAudit(c, {
    action: 'settings.save',
    entityType: 'system_setting',
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { namespace, key, storeId: input.storeId ?? null },
  })

  return ok(c, { isSuccess: true })
})

/**
 * 删除门店覆盖,恢复继承租户默认
 */
settingsRoutes.delete('/:namespace/:key/override', async (c) => {
  const namespace = c.req.param('namespace')
  const key = c.req.param('key')
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  if (!tenantId || !storeId) {
    throw err.badRequest('缺少租户或门店标识')
  }
  const scope = await requireScopedPermission(c, {
    code: 'settings.store.manage',
    tenantId,
    storeId,
  })

  const service = createServiceClient()
  const { error } = await service
    .from('system_settings')
    .delete()
    .eq('tenant_id', scope.tenantId)
    .eq('store_id', storeId)
    .eq('namespace', namespace)
    .eq('key', key)
  if (error) {
    throw err.internal(`删除门店覆盖失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'settings.removeOverride',
    entityType: 'system_setting',
    tenantId: scope.tenantId,
    storeId,
    metadata: { namespace, key },
  })

  return ok(c, { isSuccess: true })
})

// ============================================================
// P0-12:支付 / 打印 / 字典设置写入走 Hono Command + 审计
// 浏览器不再直连写关键业务设置(RLS 只做兜底,审计统一进 audit_logs)
// ============================================================

const paymentContextSchema = z.object({
  id: z.string().uuid().optional(),
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  method: z.enum(['cash', 'card', 'wechat', 'alipay', 'other']),
  label: z.string().min(1, '支付名称不能为空').max(50),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

settingsRoutes.get('/payment-contexts', async (c) => {
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  if (!tenantId || !storeId) {
    throw err.badRequest('缺少租户或门店标识')
  }
  const scope = await requireScopedPermission(c, {
    code: 'settings.store.read',
    tenantId,
    storeId,
    dataScope: true,
  })
  const service = createServiceClient()
  const { data, error } = await service
    .from('payment_contexts')
    .select('*')
    .eq('tenant_id', scope.tenantId)
    .eq('store_id', storeId)
    .order('method', { ascending: true })
  if (error) {
    throw err.internal(`查询支付方式失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

settingsRoutes.put('/payment-contexts', async (c) => {
  const input = await parseJsonBody(c, paymentContextSchema)
  const scope = await requireScopedPermission(c, {
    code: 'settings.store.manage',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const user = c.get('user')
  const service = createServiceClient()
  const payload = {
    tenant_id: scope.tenantId,
    store_id: input.storeId,
    method: input.method,
    label: input.label,
    is_default: input.isDefault ?? false,
    is_active: input.isActive ?? true,
  }
  if (input.id) {
    const { error } = await service.from('payment_contexts').update(payload).eq('id', input.id).eq('tenant_id', scope.tenantId)
    if (error) {
      throw err.internal(`更新支付方式失败: ${error.message}`)
    }
  }
  else {
    const { error } = await service.from('payment_contexts').insert(payload)
    if (error) {
      throw err.internal(`新增支付方式失败: ${error.message}`)
    }
  }
  await writeAudit(c, {
    action: 'settings.paymentContext.save',
    entityType: 'payment_context',
    entityId: input.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { method: input.method, label: input.label, isActive: input.isActive ?? true },
  })
  return ok(c, { isSuccess: true, id: input.id ?? undefined })
})

settingsRoutes.delete('/payment-contexts/:id', async (c) => {
  const id = c.req.param('id')
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  if (!tenantId || !storeId) {
    throw err.badRequest('缺少租户或门店标识')
  }
  await requireScopedPermission(c, {
    code: 'settings.store.manage',
    tenantId,
    storeId,
  })
  const service = createServiceClient()
  const { error } = await service.from('payment_contexts').delete().eq('id', id).eq('tenant_id', tenantId).eq('store_id', storeId)
  if (error) {
    throw err.internal(`删除支付方式失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'settings.paymentContext.delete',
    entityType: 'payment_context',
    entityId: id,
    tenantId,
    storeId,
    metadata: {},
  })
  return ok(c, { isSuccess: true })
})

const printSettingSchema = z.object({
  id: z.string().uuid().optional(),
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  paperSize: z.enum(['58mm', '80mm', 'a4']),
  label: z.string().min(1, '模板名称不能为空').max(50),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

settingsRoutes.get('/print-settings', async (c) => {
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  if (!tenantId || !storeId) {
    throw err.badRequest('缺少租户或门店标识')
  }
  const scope = await requireScopedPermission(c, {
    code: 'settings.store.read',
    tenantId,
    storeId,
    dataScope: true,
  })
  const service = createServiceClient()
  const { data, error } = await service
    .from('print_settings')
    .select('*')
    .eq('tenant_id', scope.tenantId)
    .eq('store_id', storeId)
    .order('paper_size', { ascending: true })
  if (error) {
    throw err.internal(`查询打印设置失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

settingsRoutes.put('/print-settings', async (c) => {
  const input = await parseJsonBody(c, printSettingSchema)
  const scope = await requireScopedPermission(c, {
    code: 'settings.store.manage',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })
  const service = createServiceClient()
  const payload = {
    tenant_id: scope.tenantId,
    store_id: input.storeId,
    paper_size: input.paperSize,
    label: input.label,
    is_default: input.isDefault ?? false,
    is_active: input.isActive ?? true,
  }
  if (input.id) {
    const { error } = await service.from('print_settings').update(payload).eq('id', input.id).eq('tenant_id', scope.tenantId)
    if (error) {
      throw err.internal(`更新打印设置失败: ${error.message}`)
    }
  }
  else {
    const { error } = await service.from('print_settings').insert(payload)
    if (error) {
      throw err.internal(`新增打印设置失败: ${error.message}`)
    }
  }
  await writeAudit(c, {
    action: 'settings.printSetting.save',
    entityType: 'print_setting',
    entityId: input.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { paperSize: input.paperSize, label: input.label },
  })
  return ok(c, { isSuccess: true, id: input.id ?? undefined })
})

settingsRoutes.delete('/print-settings/:id', async (c) => {
  const id = c.req.param('id')
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  if (!tenantId || !storeId) {
    throw err.badRequest('缺少租户或门店标识')
  }
  await requireScopedPermission(c, {
    code: 'settings.store.manage',
    tenantId,
    storeId,
  })
  const service = createServiceClient()
  const { error } = await service.from('print_settings').delete().eq('id', id).eq('tenant_id', tenantId).eq('store_id', storeId)
  if (error) {
    throw err.internal(`删除打印设置失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'settings.printSetting.delete',
    entityType: 'print_setting',
    entityId: id,
    tenantId,
    storeId,
    metadata: {},
  })
  return ok(c, { isSuccess: true })
})

const dictionarySchema = z.object({
  id: z.string().uuid().optional(),
  tenantId: z.string().uuid('租户 id 格式错误'),
  category: z.string().min(1, '字典分类不能为空').max(50),
  code: z.string().min(1, '字典编码不能为空').max(50),
  label: z.string().min(1, '字典名称不能为空').max(100),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

settingsRoutes.get('/dictionaries', async (c) => {
  const tenantId = c.req.query('tenantId')
  const category = c.req.query('category')
  if (!tenantId || !category) {
    throw err.badRequest('缺少租户或字典分类标识')
  }
  const scope = await requireScopedPermission(c, {
    code: 'settings.tenant.read',
    tenantId,
    dataScope: true,
  })
  const service = createServiceClient()
  const { data, error } = await service
    .from('base_dictionaries')
    .select('*')
    .eq('tenant_id', scope.tenantId)
    .eq('category', category)
    .order('sort_order', { ascending: true })
  if (error) {
    throw err.internal(`查询字典失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [] })
})

settingsRoutes.put('/dictionaries', async (c) => {
  const input = await parseJsonBody(c, dictionarySchema)
  const scope = await requireScopedPermission(c, {
    code: 'settings.tenant.manage',
    tenantId: input.tenantId,
  })
  const service = createServiceClient()
  const payload = {
    tenant_id: scope.tenantId,
    category: input.category,
    code: input.code,
    label: input.label,
    sort_order: input.sortOrder ?? 0,
    is_active: input.isActive ?? true,
  }
  if (input.id) {
    const { error } = await service.from('base_dictionaries').update(payload).eq('id', input.id).eq('tenant_id', scope.tenantId)
    if (error) {
      throw err.internal(`更新字典失败: ${error.message}`)
    }
  }
  else {
    const { error } = await service.from('base_dictionaries').insert(payload)
    if (error) {
      throw err.internal(`新增字典失败: ${error.message}`)
    }
  }
  await writeAudit(c, {
    action: 'settings.dictionary.save',
    entityType: 'base_dictionary',
    entityId: input.id,
    tenantId: input.tenantId,
    metadata: { category: input.category, code: input.code, label: input.label },
  })
  return ok(c, { isSuccess: true, id: input.id ?? undefined })
})

settingsRoutes.delete('/dictionaries/:id', async (c) => {
  const id = c.req.param('id')
  const tenantId = c.req.query('tenantId')
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  await requireScopedPermission(c, {
    code: 'settings.tenant.manage',
    tenantId,
  })
  const service = createServiceClient()
  const { error } = await service.from('base_dictionaries').delete().eq('id', id).eq('tenant_id', tenantId)
  if (error) {
    throw err.internal(`删除字典失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'settings.dictionary.delete',
    entityType: 'base_dictionary',
    entityId: id,
    tenantId,
    metadata: {},
  })
  return ok(c, { isSuccess: true })
})

export default settingsRoutes
