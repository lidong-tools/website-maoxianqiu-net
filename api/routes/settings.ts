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
 * 系统设置路由(CORE-06)
 * - GET    /settings/effective       生效配置合并(门店覆盖 → 租户默认 → 系统默认),标注来源
 * - GET    /settings                 原始配置记录
 * - PUT    /settings/:namespace/:key 写入(storeId 有值=门店覆盖,否则租户默认)
 * - DELETE /settings/:namespace/:key/override  删除门店覆盖恢复继承
 */
const settingsRoutes = new Hono<AppEnv>()

settingsRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

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

export default settingsRoutes
