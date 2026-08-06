import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { requirePermission } from '../lib/permission'
import { loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, canManageStore, hasRole, loadCaller } from '../middlewares/auth'

const userRoutes = new Hono<AppEnv>()

userRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const createSchema = z.object({
  account: z.string().email('账号必须是合法邮箱'),
  password: z.string().min(8, '密码至少 8 位'),
  realName: z.string().max(50).optional(),
  phone: z.string().max(20).optional(),
  storeId: z.string().uuid('店铺参数无效'),
  roleId: z.string().uuid('角色参数无效'),
})

// admin 建号(需 service role):建 auth 用户 + 建成员关系;成员失败时补偿删除 auth 用户
userRoutes.post('/create', async (c) => {
  const input = await parseJsonBody(c, createSchema)
  await requirePermission(c, { code: 'system.user.create', storeId: input.storeId })

  if (!canManageStore(c, input.storeId)) {
    throw err.forbidden('无权限管理该店铺')
  }

  const service = createServiceClient()
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
  const { error: memberError } = await service.from('store_members').insert({
    user_id: userId,
    store_id: input.storeId,
    role_id: input.roleId,
  })
  if (memberError) {
    // MXQ-3009 补偿:成员关系失败时删除已创建的 auth 用户,避免孤立账号
    await service.auth.admin.deleteUser(userId)
    throw err.unprocessable('添加店铺成员失败', { _root: [memberError.message] })
  }

  await writeAudit(c, {
    action: 'user.create',
    entityType: 'user',
    entityId: userId,
    storeId: input.storeId,
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
  await requirePermission(c, { code: 'system.user.resetPassword' })

  if (!hasRole(c, 'system_admin')) {
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
