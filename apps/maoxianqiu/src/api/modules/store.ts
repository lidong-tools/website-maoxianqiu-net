import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * 门店 API 模块
 * MXQ-3008:归档/恢复走 Hono Command,禁止前端直连 delete
 */
export default {
  /**
   * 门店列表(浏览器直连,RLS 兜底)
   * @param data 查询参数
   * @param data.keyword 关键词(可选)
   * @param data.from 起始行(可选)
   * @param data.limit 行数(可选)
   * @param data.includeArchived 是否包含已归档门店(默认 false)
   */
  async list(data?: {
    keyword?: string
    from?: number
    limit?: number
    includeArchived?: boolean
  }) {
    let query = supabase.from('stores').select('*', { count: 'exact' })
    if (!data?.includeArchived) {
      query = query.is('archived_at', null)
    }
    if (data?.keyword) {
      query = query.or(`name.ilike.%${data.keyword}%,code.ilike.%${data.keyword}%`)
    }
    if (data?.from !== undefined && data?.limit !== undefined) {
      query = query.range(data.from, data.from + data.limit - 1)
    }
    const { data: rows, error, count } = await query.order('created_at', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: rows ?? [], total: count ?? 0 } }
  },

  /**
   * 新增门店(直连,RLS 仅超管/有 store.create 权限)
   * 注意:tenant_id 由 RLS/触发器或后端补充,前端不直传
   */
  async create(data: {
    name: string
    code?: string
    address?: string
    phone?: string
    status?: string
    tenantId?: string
  }) {
    const { error } = await supabase.from('stores').insert({
      name: data.name,
      code: data.code?.trim() || null,
      address: data.address ?? '',
      phone: data.phone ?? '',
      status: data.status ?? 'active',
      tenant_id: data.tenantId ?? null,
    })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 编辑门店(直连)
   */
  async update(data: {
    id: string
    name?: string
    code?: string
    address?: string
    phone?: string
    status?: string
  }) {
    const patch: Record<string, string | null> = {}
    if (data.name !== undefined) {
      patch.name = data.name
    }
    if (data.code !== undefined) {
      patch.code = data.code.trim() || null
    }
    if (data.address !== undefined) {
      patch.address = data.address
    }
    if (data.phone !== undefined) {
      patch.phone = data.phone
    }
    if (data.status !== undefined) {
      patch.status = data.status
    }
    const { error } = await supabase.from('stores').update(patch).eq('id', data.id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 归档门店(MXQ-3008)
   * 走 Hono Command + archive_store RPC,禁止前端直连 update archived_at
   */
  archive: (id: string) => api.post(`stores/${id}/archive`, {}),

  /**
   * 恢复门店(MXQ-3008)
   * 走 Hono Command + restore_store RPC
   */
  restore: (id: string) => api.post(`stores/${id}/restore`, {}),
}
