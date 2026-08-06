import { supabase } from '@/lib/supabase'

export default {
  // 角色列表(直连)
  async list() {
    const { data, error } = await supabase.from('roles').select('*').order('created_at', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: data ?? [] }
  },

  // 新增角色(直连,RLS 仅超管)
  async create(data: {
    code: string
    name: string
    description?: string
    permissions?: string[]
  }) {
    const { error } = await supabase.from('roles').insert({
      code: data.code,
      name: data.name,
      description: data.description ?? '',
      permissions: data.permissions ?? [],
      is_system: false,
    })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  // 编辑角色(直连)
  async update(data: {
    id: string
    name?: string
    description?: string
    permissions?: string[]
  }) {
    const patch: Record<string, string | string[]> = {}
    if (data.name !== undefined) {
      patch.name = data.name
    }
    if (data.description !== undefined) {
      patch.description = data.description
    }
    if (data.permissions !== undefined) {
      patch.permissions = data.permissions
    }
    const { error } = await supabase.from('roles').update(patch).eq('id', data.id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  // 删除角色(直连;内置角色由 RLS 拦截)
  async delete(id: string) {
    const { error } = await supabase.from('roles').delete().eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },
}
