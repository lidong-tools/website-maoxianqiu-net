import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { assertTenantAccess, requirePermission } from '../lib/permission'
import { loadContext, requireTenant } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * 员工管理 Command 路由(MXQ-3009 / MXQ-3010)
 * 邀请、停用/启用、改角色:全部走 Hono Command + PostgreSQL RPC。
 */
const employeeRoutes = new Hono<AppEnv>()

employeeRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const inviteSchema = z.object({
  account: z.string().email('账号必须是合法邮箱'),
  password: z.string().min(8, '密码至少 8 位'),
  employeeNo: z.string().min(1, '员工工号必填').max(50),
  name: z.string().min(1, '员工姓名必填').max(100),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional().or(z.literal('')),
  title: z.string().max(100).optional(),
  tenantId: z.string().uuid('租户参数无效'),
  storeId: z.string().uuid('门店参数无效'),
  roleId: z.string().uuid('角色参数无效'),
  isPrimary: z.boolean().optional(),
})

/**
 * 邀请员工(MXQ-3009)
 * - 权限:employee.invite
 * - 行为:建 auth 用户 → 调 invite_employee RPC(事务化建成员/员工/分配/角色)
 * - 补偿:RPC 失败时删除已建 auth 用户,避免孤立账号
 */
employeeRoutes.post('/invite', async (c) => {
  const input = await parseJsonBody(c, inviteSchema)
  await requirePermission(c, { code: 'employee.invite', storeId: input.storeId })

  const service = createServiceClient()
  const user = c.get('user')

  // MXQ-3007 跨租户防护:请求租户须为调用者所属租户,且 store/role 归属同一租户
  assertTenantAccess(c, input.tenantId)
  const { data: store } = await service
    .from('stores')
    .select('tenant_id')
    .eq('id', input.storeId)
    .maybeSingle()
  if (!store) {
    throw err.notFound('门店不存在')
  }
  if (store.tenant_id !== input.tenantId) {
    throw err.badRequest('门店不属于该租户')
  }
  const { data: role } = await service
    .from('roles')
    .select('tenant_id')
    .eq('id', input.roleId)
    .maybeSingle()
  if (!role) {
    throw err.notFound('角色不存在')
  }
  // 系统角色(tenant_id 为 null)可全局分配;租户角色必须与邀请租户一致
  if (role.tenant_id !== null && role.tenant_id !== input.tenantId) {
    throw err.badRequest('角色不属于该租户')
  }

  // 1) 建 auth 用户
  const { data: authData, error: authError } = await service.auth.admin.createUser({
    email: input.account,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      account: input.account,
      real_name: input.name,
      phone: input.phone ?? '',
    },
  })
  if (authError) {
    throw err.unprocessable('创建账号失败', { _root: [authError.message] })
  }
  const userId = authData.user.id

  // 2) 调 invite_employee RPC(事务化)
  const { data: employee, error: rpcError } = await service.rpc('invite_employee', {
    p_tenant_id: input.tenantId,
    p_user_id: userId,
    p_employee_no: input.employeeNo,
    p_name: input.name,
    p_phone: input.phone ?? null,
    p_email: input.email || null,
    p_title: input.title ?? null,
    p_store_id: input.storeId,
    p_role_id: input.roleId,
    p_is_primary: input.isPrimary ?? false,
    p_invited_by: user.id,
  })

  if (rpcError) {
    // MXQ-3009 补偿:RPC 失败时删除已建 auth 用户
    await service.auth.admin.deleteUser(userId)
    if (rpcError.message.includes('duplicate key')
      || rpcError.message.includes('unique')) {
      throw err.conflict('员工工号已存在', { employeeNo: ['同租户内工号已占用'] })
    }
    throw err.unprocessable('邀请员工失败', { _root: [rpcError.message] })
  }

  await writeAudit(c, {
    action: 'employee.invite',
    entityType: 'employee',
    entityId: employee?.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { account: input.account, employeeNo: input.employeeNo },
  })

  return ok(c, { isSuccess: true, employeeId: employee?.id, userId })
})

const setStatusSchema = z.object({
  employeeId: z.string().uuid('员工参数无效'),
  status: z.enum(['active', 'disabled', 'resigned'], {
    error: '状态无效',
  }),
})

/**
 * 员工启用/停用(MXQ-3010)
 * - 权限:employee.disable / employee.enable(根据目标状态)
 * - 行为:调 set_employee_status RPC,同步租户成员关系状态
 */
employeeRoutes.post('/set-status', async (c) => {
  const input = await parseJsonBody(c, setStatusSchema)
  const permissionCode = input.status === 'active' ? 'employee.enable' : 'employee.disable'
  await requirePermission(c, { code: permissionCode })

  const service = createServiceClient()
  const user = c.get('user')

  // MXQ-3007 跨租户防护:被操作员工须归属调用者租户
  const { data: employee } = await service
    .from('employees')
    .select('tenant_id')
    .eq('id', input.employeeId)
    .maybeSingle()
  if (!employee) {
    throw err.notFound('员工不存在')
  }
  assertTenantAccess(c, employee.tenant_id)

  const { data, error } = await service.rpc('set_employee_status', {
    p_employee_id: input.employeeId,
    p_status: input.status,
    p_operator_id: user.id,
  })

  if (error) {
    if (error.message.includes('EMPLOYEE_NOT_FOUND')) {
      throw err.notFound('员工不存在')
    }
    if (error.message.includes('INVALID_EMPLOYEE_STATUS')) {
      throw err.badRequest('员工状态无效')
    }
    throw err.internal(`状态变更失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: `employee.${input.status === 'active' ? 'enable' : 'disable'}`,
    entityType: 'employee',
    entityId: input.employeeId,
    tenantId: data?.tenant_id,
    metadata: { status: input.status },
  })

  return ok(c, data)
})

const assignStoreSchema = z.object({
  employeeId: z.string().uuid('员工参数无效'),
  storeId: z.string().uuid('门店参数无效'),
  isPrimary: z.boolean().optional(),
})

/**
 * 分配门店(MXQ-3010)
 * - 权限:employee.assignStore
 * - 行为:写入 employee_store_assignments(幂等)
 */
employeeRoutes.post('/assign-store', async (c) => {
  const input = await parseJsonBody(c, assignStoreSchema)
  await requirePermission(c, { code: 'employee.assignStore', storeId: input.storeId })
  const tenantId = requireTenant(c)
  // MXQ-3007 跨租户防护:调用者须属于上下文租户
  assertTenantAccess(c, tenantId)

  const service = createServiceClient()

  // MXQ-3007 跨租户防护:员工与门店须归属同一租户(即上下文租户)
  const [empRes, storeRes] = await Promise.all([
    service.from('employees').select('tenant_id').eq('id', input.employeeId).maybeSingle(),
    service.from('stores').select('tenant_id').eq('id', input.storeId).maybeSingle(),
  ])
  const employee = empRes.data
  const store = storeRes.data
  if (!employee) {
    throw err.notFound('员工不存在')
  }
  if (!store) {
    throw err.notFound('门店不存在')
  }
  if (employee.tenant_id !== tenantId || store.tenant_id !== tenantId) {
    throw err.forbidden('无权操作该租户的员工或门店')
  }

  const { error } = await service
    .from('employee_store_assignments')
    .upsert({
      tenant_id: tenantId,
      employee_id: input.employeeId,
      store_id: input.storeId,
      is_primary: input.isPrimary ?? false,
    }, {
      onConflict: 'employee_id,store_id',
    })

  if (error) {
    throw err.unprocessable('分配门店失败', { _root: [error.message] })
  }

  await writeAudit(c, {
    action: 'employee.assignStore',
    entityType: 'employee',
    entityId: input.employeeId,
    storeId: input.storeId,
    tenantId,
  })

  return ok(c, { isSuccess: true })
})

const removeStoreSchema = z.object({
  employeeId: z.string().uuid('员工参数无效'),
  storeId: z.string().uuid('门店参数无效'),
})

/**
 * 取消门店分配(MXQ-3010)
 * - 权限:employee.assignStore
 */
employeeRoutes.post('/remove-store', async (c) => {
  const input = await parseJsonBody(c, removeStoreSchema)
  await requirePermission(c, { code: 'employee.assignStore', storeId: input.storeId })

  const service = createServiceClient()
  const { error } = await service
    .from('employee_store_assignments')
    .delete()
    .eq('employee_id', input.employeeId)
    .eq('store_id', input.storeId)

  if (error) {
    throw err.unprocessable('取消门店分配失败', { _root: [error.message] })
  }

  await writeAudit(c, {
    action: 'employee.removeStore',
    entityType: 'employee',
    entityId: input.employeeId,
    storeId: input.storeId,
  })

  return ok(c, { isSuccess: true })
})

const changeRoleSchema = z.object({
  employeeId: z.string().uuid('员工参数无效'),
  roleId: z.string().uuid('角色参数无效'),
  storeId: z.string().uuid('门店参数无效').optional(),
})

/**
 * 变更角色(MXQ-3010)
 * - 权限:employee.changeRole
 * - 行为:删除旧门店角色分配,写入新分配
 */
employeeRoutes.post('/change-role', async (c) => {
  const input = await parseJsonBody(c, changeRoleSchema)
  await requirePermission(c, {
    code: 'employee.changeRole',
    storeId: input.storeId,
  })
  const tenantId = requireTenant(c)
  // MXQ-3007 跨租户防护:调用者须属于上下文租户
  assertTenantAccess(c, tenantId)

  const service = createServiceClient()

  // MXQ-3007 跨租户防护:员工与角色须归属上下文租户(系统角色 tenant_id 为 null,可全局分配)
  const [empRes, roleRes] = await Promise.all([
    service.from('employees').select('tenant_id').eq('id', input.employeeId).maybeSingle(),
    service.from('roles').select('tenant_id').eq('id', input.roleId).maybeSingle(),
  ])
  const employee = empRes.data
  const role = roleRes.data
  if (!employee) {
    throw err.notFound('员工不存在')
  }
  if (!role) {
    throw err.notFound('角色不存在')
  }
  if (employee.tenant_id !== tenantId || (role.tenant_id !== null && role.tenant_id !== tenantId)) {
    throw err.forbidden('无权操作该租户的员工或角色')
  }

  // 删除该员工在该门店的旧角色分配
  if (input.storeId) {
    await service
      .from('employee_role_assignments')
      .delete()
      .eq('employee_id', input.employeeId)
      .eq('store_id', input.storeId)
  }
  else {
    await service
      .from('employee_role_assignments')
      .delete()
      .eq('employee_id', input.employeeId)
      .is('store_id', null)
  }

  // 写入新角色分配
  const { error } = await service
    .from('employee_role_assignments')
    .insert({
      tenant_id: tenantId,
      employee_id: input.employeeId,
      role_id: input.roleId,
      store_id: input.storeId ?? null,
    })

  if (error) {
    throw err.unprocessable('变更角色失败', { _root: [error.message] })
  }

  await writeAudit(c, {
    action: 'employee.changeRole',
    entityType: 'employee',
    entityId: input.employeeId,
    storeId: input.storeId,
    tenantId,
    metadata: { roleId: input.roleId },
  })

  return ok(c, { isSuccess: true })
})

export default employeeRoutes
