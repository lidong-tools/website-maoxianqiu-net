import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { createServiceClient } from '../lib/supabase'
import { authMiddleware, canManageStore, hasRole, loadCaller } from '../middlewares/auth'

const userRoutes = new Hono<AppEnv>()

userRoutes.use('*', authMiddleware(), loadCaller())

// admin 建号(需 service role):建 auth 用户 + 建成员关系
userRoutes.post('/create', async (c) => {
  const body = await c.req.json<{
    account: string
    password: string
    realName?: string
    phone?: string
    storeId: string
    roleId: string
  }>()
  if (!body.storeId || !body.roleId) {
    return c.json({ status: 1, error: '请选择店铺和角色', data: null })
  }
  if (!canManageStore(c, body.storeId)) {
    return c.json({ status: 1, error: '无权限', data: null })
  }

  const service = createServiceClient()
  const { data, error } = await service.auth.admin.createUser({
    email: body.account,
    password: body.password,
    email_confirm: true,
    user_metadata: {
      account: body.account,
      real_name: body.realName ?? '',
      phone: body.phone ?? '',
    },
  })
  if (error) {
    return c.json({ status: 1, error: error.message, data: null })
  }

  const { error: memberError } = await service.from('store_members').insert({
    user_id: data.user.id,
    store_id: body.storeId,
    role_id: body.roleId,
  })
  if (memberError) {
    return c.json({ status: 1, error: memberError.message, data: null })
  }

  return c.json({ status: 1, error: '', data: { isSuccess: true, id: data.user.id } })
})

// admin 重置密码(需 service role)
userRoutes.post('/reset-password', async (c) => {
  const body = await c.req.json<{ id: string, password: string }>()
  const service = createServiceClient()

  if (!hasRole(c, 'system_admin')) {
    const { data: memberships } = await service.from('store_members').select('store_id').eq('user_id', body.id)
    const managed = (memberships ?? []).some((item: any) => canManageStore(c, item.store_id))
    if (!managed) {
      return c.json({ status: 1, error: '无权限', data: null })
    }
  }

  const { error } = await service.auth.admin.updateUserById(body.id, { password: body.password })
  if (error) {
    return c.json({ status: 1, error: error.message, data: null })
  }
  return c.json({ status: 1, error: '', data: { isSuccess: true } })
})

export default userRoutes
