import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * 角色 API 模块
 * MXQ-3010:权限走 role_permissions 关联表;替换权限走 Hono Command + replace_role_permissions RPC
 */
export default {
  /**
   * 角色列表(直连,含权限码聚合)
   * 同时返回 role_permissions 关联与 roles.permissions 数组(union)
   */
  async list() {
    const { data, error } = await supabase
      .from('roles')
      .select(`
        *,
        permission_codes:role_permissions(
          permission_id,
          permissions(code)
        )
      `)
      .order('created_at', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    // 聚合权限码:role_permissions 关联 ∪ roles.permissions 数组
    const roles = (data ?? []).map((role: any) => {
      const rpCodes = (role.permission_codes ?? [])
        .flatMap((rp: any) => {
          if (!rp.permissions) {
            return []
          }
          return Array.isArray(rp.permissions)
            ? rp.permissions.map((p: any) => p.code)
            : [rp.permissions.code]
        })
      const legacyCodes = role.permissions ?? []
      const allCodes = [...new Set([...rpCodes, ...legacyCodes])]
      return {
        ...role,
        permission_codes: allCodes,
      }
    })
    return { status: 1, error: '', data: roles }
  },

  /**
   * 新增角色(直连,RLS 仅超管/有 role.create 权限)
   */
  async create(data: {
    code: string
    name: string
    description?: string
    permissions?: string[]
    tenantId?: string
  }) {
    const { data: role, error } = await supabase
      .from('roles')
      .insert({
        code: data.code,
        name: data.name,
        description: data.description ?? '',
        permissions: data.permissions ?? [],
        is_system: false,
        tenant_id: data.tenantId ?? null,
        scope: data.tenantId ? 'tenant' : 'system',
      })
      .select()
      .single()
    if (error) {
      throw new Error(error.message)
    }
    // 写 role_permissions 关联(若有权限码)
    if (data.permissions && data.permissions.length > 0 && role) {
      const { data: perms } = await supabase
        .from('permissions')
        .select('id, code')
        .in('code', data.permissions)
      const inserts = (perms ?? []).map((p: any) => ({
        role_id: role.id,
        permission_id: p.id,
      }))
      if (inserts.length > 0) {
        await supabase.from('role_permissions').insert(inserts)
      }
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 编辑角色基本信息(直连)
   */
  async update(data: {
    id: string
    name?: string
    description?: string
  }) {
    const patch: Record<string, string> = {}
    if (data.name !== undefined) {
      patch.name = data.name
    }
    if (data.description !== undefined) {
      patch.description = data.description
    }
    const { error } = await supabase.from('roles').update(patch).eq('id', data.id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 替换角色权限(MXQ-3010,走后端 RPC)
   * 事务化替换 role_permissions + 同步 roles.permissions 数组
   */
  replacePermissions: (data: {
    roleId: string
    permissionCodes: string[]
  }) => api.post('roles/replace-permissions', data),

  /**
   * 删除角色(直连;内置角色由 RLS 拦截)
   */
  async delete(id: string) {
    const { error } = await supabase.from('roles').delete().eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 权限目录(直连,系统级只读)
   */
  async permissions() {
    const { data, error } = await supabase
      .from('permissions')
      .select('*')
      .order('module', { ascending: true })
      .order('code', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: data ?? [] }
  },
}
