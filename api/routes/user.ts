import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { assertStoreTenant, requireScopedPermission } from '../lib/permission'
import { getContext, loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, canManageStore, loadCaller } from '../middlewares/auth'

const userRoutes = new Hono<AppEnv>()

userRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const createSchema = z.object({
  account: z.string().email('账号必须是合法邮箱'),
  password: z.string().min(8, '密码至少 8 位'),
  realName: z.string().max(50).optional(),
  phone: z.string().max(20).optional(),
  storeId: z.string().uuid('店铺参数无效'),
  roleId: z.string().uuid('角色参数无效'),
  tenantId: z.string().uuid('租户参数无效').optional(),
  employeeNo: z.string().max(50).optional(),
})

/**
 * admin 建号(需 service role):建 auth 用户 → 调 invite_employee RPC(事务化建成员/员工/分配/角色)
 * MXQ-3009:RPC 失败时补偿删除 auth 用户,避免孤立账号
 * 兼容旧前端:未传 tenantId/employeeNo 时从 store_id 派生 tenant_id,employeeNo 用 account
 */
userRoutes.post('/create', async (c) => {
  const input = await parseJsonBody(c, createSchema)
  const service = createServiceClient()
  const user = c.get('user')

  // MXQ-3007 跨租户防护:门店归属租户须与调用者一致;传入的 tenantId 须与门店租户一致(未传则派生)
  const storeTenantId = await assertStoreTenant(c, input.storeId)
  if (input.tenantId && input.tenantId !== storeTenantId) {
    throw err.badRequest('租户与门店归属不一致')
  }
  const tenantId = input.tenantId ?? storeTenantId
  // P0-02 scoped: 按解析后的租户+门店解析授权作用域(平台管理员跨租户放行)
  const scope = await requireScopedPermission(c, { code: 'system.user.create', tenantId, storeId: input.storeId })

  // S30-F01:系统平台角色(scope='system')只能通过 platform_user_roles 授予,禁止建号时选择
  const { data: role } = await service
    .from('roles')
    .select('scope')
    .eq('id', input.roleId)
    .maybeSingle()
  if (!role) {
    throw err.notFound('角色不存在')
  }
  if (role.scope === 'system') {
    throw err.forbidden('系统平台角色不可分配给租户员工')
  }

  if (!canManageStore(c, scope.storeId ?? input.storeId)) {
    throw err.forbidden('无权限管理该店铺')
  }

  // 1) 建 auth 用户
  const { data, error } = await service.auth.admin.createUser({
    email: input.account,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      account: input.account,
      real_name: input.realName ?? '',
      phone: input.phone ?? '',
    },
  })
  if (error) {
    throw err.unprocessable('创建账号失败', { _root: [error.message] })
  }
  const userId = data.user.id

  // 2) 调 invite_employee RPC(事务化建 tenant_membership + employee + store_assignment + role_assignment)
  const { error: rpcError } = await service.rpc('invite_employee', {
    p_tenant_id: scope.tenantId,
    p_user_id: userId,
    p_employee_no: input.employeeNo || input.account,
    p_name: input.realName || input.account,
    p_phone: input.phone ?? null,
    p_email: input.account,
    p_store_id: scope.storeId ?? null,
    p_role_id: input.roleId,
    p_is_primary: true,
    p_invited_by: user.id,
  })
  if (rpcError) {
    // MXQ-3009 补偿:RPC 失败时删除已创建的 auth 用户,避免孤立账号
    await service.auth.admin.deleteUser(userId)
    throw err.unprocessable('添加员工失败', { _root: [rpcError.message] })
  }

  await writeAudit(c, {
    action: 'user.create',
    entityType: 'user',
    entityId: userId,
    storeId: input.storeId,
    tenantId,
    metadata: { account: input.account },
  })

  return ok(c, { isSuccess: true, id: userId })
})

const resetSchema = z.object({
  id: z.string().uuid('用户参数无效'),
  password: z.string().min(8, '密码至少 8 位'),
})

// admin 重置密码(需 service role)
userRoutes.post('/reset-password', async (c) => {
  const input = await parseJsonBody(c, resetSchema)

  // P0-02 scoped: 以调用者默认租户为授权目标租户(平台管理员跨租户放行)
  const tenantId = getContext(c).memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.forbidden('无权访问该租户的数据')
  }
  const scope = await requireScopedPermission(c, { code: 'system.user.resetPassword', tenantId })

  if (!scope.isPlatformAdmin) {
    const service = createServiceClient()
    const { data: memberships } = await service.from('store_members').select('store_id').eq('user_id', input.id)
    const managed = (memberships ?? []).some((item: { store_id: string }) => canManageStore(c, item.store_id))
    if (!managed) {
      throw err.forbidden('无权限重置该用户密码')
    }
  }

  const service = createServiceClient()
  const { error } = await service.auth.admin.updateUserById(input.id, { password: input.password })
  if (error) {
    throw err.unprocessable('重置密码失败', { _root: [error.message] })
  }

  await writeAudit(c, {
    action: 'user.resetPassword',
    entityType: 'user',
    entityId: input.id,
  })

  return ok(c, { isSuccess: true })
})

export default userRoutes
