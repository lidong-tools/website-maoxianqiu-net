import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import { loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * 门店归档/恢复 Command 路由(MXQ-3008)
 * 归档与恢复属于状态转换,必须走 Hono Command + PostgreSQL RPC,禁止前端直连 update。
 */
const storeRoutes = new Hono<AppEnv>()

storeRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/**
 * 归档门店
 * - 权限:store.archive
 * - 行为:调用 archive_store RPC,设置 archived_at + status=archived
 * - 已归档门店不可再次归档(409)
 */
storeRoutes.post('/:id/archive', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()
  const user = c.get('user')

  // P0-02 scoped:先查门店实体,基于其租户+门店解析授权作用域(平台管理员跨租户放行)
  const { data: store } = await service
    .from('stores')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (!store) {
    throw err.notFound('门店不存在')
  }
  const scope = await requireScopedPermission(c, { code: 'store.archive', tenantId: store.tenant_id, storeId: id })

  const { data, error } = await service.rpc('archive_store', {
    p_tenant_id: scope.tenantId,
    p_store_id: id,
    p_archived_by: user.id,
  })

  if (error) {
    if (error.message.includes('STORE_NOT_FOUND')) {
      throw err.notFound('门店不存在')
    }
    if (error.message.includes('STORE_ALREADY_ARCHIVED')) {
      throw err.conflict('门店已归档')
    }
    throw err.internal(`归档失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'store.archive',
    entityType: 'store',
    entityId: id,
    storeId: id,
    metadata: { name: data?.name },
  })

  return ok(c, data)
})

/**
 * 恢复门店
 * - 权限:store.restore
 * - 行为:调用 restore_store RPC,清除 archived_at + status=active
 * - 同租户 code 冲突时返回 409
 */
storeRoutes.post('/:id/restore', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()
  const user = c.get('user')

  // P0-02 scoped: 先查门店实体,基于其租户+门店解析授权作用域(平台管理员跨租户放行)
  const { data: store } = await service
    .from('stores')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (!store) {
    throw err.notFound('门店不存在')
  }
  const scope = await requireScopedPermission(c, { code: 'store.restore', tenantId: store.tenant_id, storeId: id })

  const { data, error } = await service.rpc('restore_store', {
    p_tenant_id: scope.tenantId,
    p_store_id: id,
    p_restored_by: user.id,
  })

  if (error) {
    if (error.message.includes('STORE_NOT_FOUND')) {
      throw err.notFound('门店不存在')
    }
    if (error.message.includes('STORE_NOT_ARCHIVED')) {
      throw err.conflict('门店未归档')
    }
    if (error.message.includes('STORE_CODE_CONFLICT')) {
      throw err.conflict('门店编码已被占用,无法恢复')
    }
    throw err.internal(`恢复失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'store.restore',
    entityType: 'store',
    entityId: id,
    storeId: id,
    metadata: { name: data?.name },
  })

  return ok(c, data)
})

export default storeRoutes
