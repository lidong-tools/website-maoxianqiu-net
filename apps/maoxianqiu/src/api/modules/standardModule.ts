import { supabase } from '@/lib/supabase'

export default {
  // 列表(直连)
  async list(data: {
    title?: string
    from: number
    limit: number
  }) {
    let query = supabase.from('standard_module').select('*', { count: 'exact' })
    if (data.title) {
      query = query.ilike('title', `%${data.title}%`)
    }
    const { data: rows, error, count } = await query
      .range(data.from, data.from + data.limit - 1)
      .order('id', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: rows ?? [], total: count ?? 0 } }
  },

  // 详情(直连)
  async detail(id: number | string) {
    const { data, error } = await supabase.from('standard_module').select('*').eq('id', Number(id)).single()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data }
  },

  // 新增(直连)
  async create(data: any) {
    const { error } = await supabase.from('standard_module').insert({ title: data.title })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  // 编辑(直连)
  async edit(data: any) {
    const { error } = await supabase.from('standard_module').update({ title: data.title }).eq('id', data.id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  // 删除(直连)
  async delete(id: number | string) {
    const { error } = await supabase.from('standard_module').delete().eq('id', Number(id))
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },
}
