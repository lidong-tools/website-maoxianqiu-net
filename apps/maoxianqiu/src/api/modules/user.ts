import { supabase } from '@/lib/supabase'
import api from '../index'

export default {
  // 成员列表(浏览器直连,RLS 兜底)
  async list(params: {
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

  // 用户详情(直连)
  async detail(id: string) {
    const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', id).single()
    if (error) {
      throw new Error(error.message)
    }
    const { data: memberships } = await supabase
      .from('store_members')
      .select('id, store_id, role_id, status, stores(name, code), roles(code, name)')
      .eq('user_id', id)
    return { status: 1, error: '', data: { profile, memberships: memberships ?? [] } }
  },

  // 建号(需 service role,走后端)
  create: (data: any) => api.post('user/create', data),

  // 更新资料(直连)
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

  // 加成员(直连,RLS 校验店长权限)
  async membershipAdd(data: {
    userId: string
    storeId: string
    roleId: string
  }) {
    const { error } = await supabase.from('store_members').insert({
      user_id: data.userId,
      store_id: data.storeId,
      role_id: data.roleId,
    })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  // 改成员角色/状态(直连)
  async membershipUpdate(data: {
    membershipId: string
    roleId?: string
    status?: string
  }) {
    const patch: Record<string, string> = {}
    if (data.roleId !== undefined) {
      patch.role_id = data.roleId
    }
    if (data.status !== undefined) {
      patch.status = data.status
    }
    const { error } = await supabase.from('store_members').update(patch).eq('id', data.membershipId)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  // 移除成员(直连)
  async membershipRemove(membershipId: string) {
    const { error } = await supabase.from('store_members').delete().eq('id', membershipId)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  // 重置密码(需 service role,走后端)
  resetPassword: (data: {
    id: string
    password: string
  }) => api.post('user/reset-password', data),
}
