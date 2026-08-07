import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * 用户/员工 API 模块
 * MXQ-3010:迁移到新模型 employees + employee_role_assignments + employee_store_assignments
 * 兼容期:若新模型无数据,回退查 store_members
 */
export default {
  /**
   * 员工列表(浏览器直连,RLS 兜底)
   * 优先查新模型 employee_role_assignments,无数据回退 store_members
   */
  async list(params: {
    storeId?: string
    tenantId?: string
    keyword?: string
    from: number
    limit: number
  }) {
    // 优先新模型:employees + employee_store_assignments + employee_role_assignments
    let query = supabase
      .from('employees')
      .select(`
        id,
        tenant_id,
        user_id,
        employee_no,
        name,
        phone,
        email,
        title,
        status,
        created_at,
        assignments:employee_store_assignments(
          id,
          store_id,
          is_primary,
          stores(id, name, code)
        ),
        roles:employee_role_assignments(
          id,
          role_id,
          store_id,
          roles(id, code, name)
        )
      `, { count: 'exact' })

    if (params.tenantId) {
      query = query.eq('tenant_id', params.tenantId)
    }
    if (params.storeId) {
      // 通过 assignments 过滤:有该门店分配的员工
      query = query.eq('assignments.store_id', params.storeId)
    }
    if (params.keyword) {
      query = query.or(`name.ilike.%${params.keyword}%,employee_no.ilike.%${params.keyword}%,email.ilike.%${params.keyword}%`)
    }

    const { data, error, count } = await query
      .range(params.from, params.from + params.limit - 1)
      .order('created_at', { ascending: false })

    if (error) {
      // 兼容回退:新模型查询失败时回退 store_members
      return this.legacyList(params)
    }

    return { status: 1, error: '', data: { list: data ?? [], total: count ?? 0 } }
  },

  /**
   * 兼容旧模型列表(store_members)
   */
  async legacyList(params: {
    storeId?: string
    keyword?: string
    from: number
    limit: number
  }) {
    let query = supabase
      .from('store_members')
      .select('id, user_id, store_id, role_id, status, created_at, profiles(id, account, real_name, phone, avatar, status), roles(code, name), stores(name, code)', { count: 'exact' })

    if (params.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params.keyword) {
      const { data: matched } = await supabase
        .from('profiles')
        .select('id')
        .or(`account.ilike.%${params.keyword}%,real_name.ilike.%${params.keyword}%`)
      const ids = (matched ?? []).map((item: any) => item.id)
      if (ids.length === 0) {
        return { status: 1, error: '', data: { list: [], total: 0 } }
      }
      query = query.in('user_id', ids)
    }

    const { data, error, count } = await query
      .range(params.from, params.from + params.limit - 1)
      .order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: data ?? [], total: count ?? 0 } }
  },

  /**
   * 员工详情(直连新模型)
   */
  async detail(employeeId: string) {
    const { data: employee, error } = await supabase
      .from('employees')
      .select(`
        *,
        assignments:employee_store_assignments(
          id, store_id, is_primary, stores(id, name, code)
        ),
        roles:employee_role_assignments(
          id, role_id, store_id, roles(id, code, name)
        )
      `)
      .eq('id', employeeId)
      .maybeSingle()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: employee }
  },

  /**
   * 建号/邀请员工(MXQ-3009,需 service role,走后端)
   */
  create: (data: {
    account: string
    password: string
    realName?: string
    phone?: string
    storeId: string
    roleId: string
    tenantId?: string
    employeeNo?: string
  }) => api.post('user/create', data),

  /**
   * 邀请员工(新端点,MXQ-3009)
   */
  invite: (data: {
    account: string
    password: string
    employeeNo: string
    name: string
    phone?: string
    email?: string
    title?: string
    tenantId: string
    storeId: string
    roleId: string
    isPrimary?: boolean
  }) => api.post('employees/invite', data),

  /**
   * 更新资料(直连 profiles)
   */
  async update(data: {
    id: string
    realName?: string
    phone?: string
    status?: string
  }) {
    const patch: Record<string, string> = {}
    if (data.realName !== undefined) {
      patch.real_name = data.realName
    }
    if (data.phone !== undefined) {
      patch.phone = data.phone
    }
    if (data.status !== undefined) {
      patch.status = data.status
    }
    const { error } = await supabase.from('profiles').update(patch).eq('id', data.id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 员工启用/停用(MXQ-3010,走后端 RPC)
   */
  setStatus: (data: {
    employeeId: string
    status: 'active' | 'disabled' | 'resigned'
  }) => api.post('employees/set-status', data),

  /**
   * 分配门店(MXQ-3010,走后端)
   */
  assignStore: (data: {
    employeeId: string
    storeId: string
    isPrimary?: boolean
  }) => api.post('employees/assign-store', data),

  /**
   * 取消门店分配(MXQ-3010,走后端)
   */
  removeStore: (data: {
    employeeId: string
    storeId: string
  }) => api.post('employees/remove-store', data),

  /**
   * 变更角色(MXQ-3010,走后端)
   */
  changeRole: (data: {
    employeeId: string
    roleId: string
    storeId?: string
  }) => api.post('employees/change-role', data),

  /**
   * 重置密码(需 service role,走后端)
   */
  resetPassword: (data: {
    id: string
    password: string
  }) => api.post('user/reset-password', data),
}
