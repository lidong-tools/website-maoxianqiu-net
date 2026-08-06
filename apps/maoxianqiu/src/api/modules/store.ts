import { supabase } from '@/lib/supabase'

export default {
  // 店铺列表(直连)
  async list(data?: {
    keyword?: string
    from?: number
    limit?: number
  }) {
    let query = supabase.from('stores').select('*', { count: 'exact' })
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

  // 新增店铺(直连,RLS 仅超管)
  async create(data: any) {
    const { error } = await supabase.from('stores').insert({
      name: data.name,
      code: data.code?.trim() || null,
      address: data.address ?? '',
      phone: data.phone ?? '',
      status: data.status ?? 'active',
    })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  // 编辑店铺(直连)
  async update(data: any) {
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

  // 删除店铺(直连)
  async delete(id: string) {
    const { error } = await supabase.from('stores').delete().eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },
}
