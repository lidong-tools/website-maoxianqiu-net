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
 * 角色权限管理 Command 路由(MXQ-3010)
 * 角色权限替换走 Hono Command + replace_role_permissions RPC,事务化同步 role_permissions 与 roles.permissions 数组。
 */
const roleRoutes = new Hono<AppEnv>()

roleRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const replacePermissionsSchema = z.object({
  roleId: z.string().uuid('角色参数无效'),
  permissionCodes: z.array(z.string()).default([]),
})

/**
 * 替换角色权限(MXQ-3010)
 * - 权限:role.permission.update
 * - 行为:调 replace_role_permissions RPC,事务化替换
 * - 系统角色(is_system)不允许修改权限
 */
roleRoutes.post('/replace-permissions', async (c) => {
  const input = await parseJsonBody(c, replacePermissionsSchema)

  const service = createServiceClient()

  // 系统角色保护
  const { data: role } = await service
    .from('roles')
    .select('id, code, is_system, tenant_id')
    .eq('id', input.roleId)
    .maybeSingle()

  if (!role) {
    throw err.notFound('角色不存在')
  }
  if (role.is_system) {
    throw err.forbidden('系统内置角色不可修改权限')
  }
  // P0-02 scoped: 租户角色必须归属租户,基于实体租户解析授权作用域(平台管理员跨租户放行)
  if (!role.tenant_id) {
    throw err.badRequest('缺少租户标识')
  }
  await requireScopedPermission(c, { code: 'role.permission.update', tenantId: role.tenant_id })

  const { error } = await service.rpc('replace_role_permissions', {
    p_role_id: input.roleId,
    p_permission_codes: input.permissionCodes,
  })

  if (error) {
    throw err.internal(`权限更新失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'role.replacePermissions',
    entityType: 'role',
    entityId: input.roleId,
    tenantId: role.tenant_id ?? undefined,
    metadata: {
      code: role.code,
      permissionCount: input.permissionCodes.length,
    },
  })

  return ok(c, { isSuccess: true })
})

export default roleRoutes
