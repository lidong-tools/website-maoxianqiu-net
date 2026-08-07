import { supabase } from '@/lib/supabase'

/**
 * App API 模块
 * MXQ-3010:profile/permission 迁移到新模型 employees + employee_role_assignments + role_permissions
 */
export default {
  // 后端下发路由(当前使用前端路由,保留空实现)
  routeList: () => Promise.resolve({
    status: 1,
    error: '',
    data: [],
  }),

  /**
   * 我的资料(含员工档案/门店分配/角色),浏览器直连新模型
   * 兼容回退:新模型无数据时查 store_members
   */
  async profile() {
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    const { data: profile } = userId
      ? await supabase.from('profiles').select('*').eq('id', userId).single()
      : { data: null }

    // 新模型:employees + assignments + roles
    let memberships: any[] = []
    if (userId) {
      const { data: employee } = await supabase
        .from('employees')
        .select(`
          id,
          tenant_id,
          employee_no,
          name,
          title,
          status,
          assignments:employee_store_assignments(
            id, store_id, is_primary, stores(id, name, code)
          ),
          roles:employee_role_assignments(
            id, role_id, store_id, roles(id, code, name)
          )
        `)
        .eq('user_id', userId)
        .eq('status', 'active')

      if (employee && employee.length > 0) {
        // 展开为兼容旧前端的 memberships 结构
        for (const emp of employee) {
          for (const era of (emp.roles ?? [])) {
            memberships.push({
              id: era.id,
              employee_id: emp.id,
              tenant_id: emp.tenant_id,
              store_id: era.store_id,
              role_id: era.role_id,
              status: 'active',
              roles: era.roles,
              stores: (emp.assignments ?? []).find((a: any) => a.store_id === era.store_id)?.stores ?? null,
            })
          }
        }
      }
      else {
        // 兼容回退:旧模型 store_members
        const { data: legacy } = await supabase
          .from('store_members')
          .select('id, store_id, role_id, status, stores(name, code), roles(code, name)')
          .eq('user_id', userId)
        memberships = legacy ?? []
      }
    }

    return {
      status: 1,
      error: '',
      data: {
        account: userData.user?.email ?? '',
        avatar: profile?.avatar ?? userData.user?.user_metadata?.avatar ?? '',
        realName: profile?.real_name ?? '',
        phone: profile?.phone ?? '',
        status: profile?.status ?? 'active',
        memberships,
      },
    }
  },

  /**
   * 权限聚合(MXQ-3010)
   * 新模型:role_permissions 关联 ∪ roles.permissions 数组
   * 兼容回退:旧模型 store_members + roles.permissions
   */
  async permission() {
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    let permissions: string[] = []
    if (userId) {
      // 新模型:employees → employee_role_assignments → role_permissions
      const { data: empRoles } = await supabase
        .from('employees')
        .select('id, roles:employee_role_assignments(role_id)')
        .eq('user_id', userId)
        .eq('status', 'active')

      const roleIds = [...new Set((empRoles ?? [])
        .flatMap((emp: any) => (emp.roles ?? []).map((r: any) => r.role_id)))]

      if (roleIds.length > 0) {
        // role_permissions 关联
        const { data: rp } = await supabase
          .from('role_permissions')
          .select('permissions(code)')
          .in('role_id', roleIds)
        const rpPerms = (rp ?? []).flatMap((row: any) => {
          if (!row.permissions) {
            return []
          }
          return Array.isArray(row.permissions)
            ? row.permissions.map((p: any) => p.code)
            : [row.permissions.code]
        })

        // roles.permissions 数组(兼容)
        const { data: roles } = await supabase
          .from('roles')
          .select('permissions')
          .in('id', roleIds)
        const legacyPerms = (roles ?? []).flatMap((r: any) => r.permissions ?? [])

        permissions = [...new Set([...rpPerms, ...legacyPerms])]
      }
      else {
        // 兼容回退:旧模型
        const { data: memberships } = await supabase
          .from('store_members')
          .select('role_id, status')
          .eq('user_id', userId)
        const activeRoleIds = [...new Set((memberships ?? [])
          .filter((item: any) => item.status === 'active')
          .map((item: any) => item.role_id))]
        if (activeRoleIds.length > 0) {
          const { data: rolesData } = await supabase
            .from('roles')
            .select('permissions')
            .in('id', activeRoleIds)
          permissions = [...new Set((rolesData ?? [])
            .flatMap((role: any) => role.permissions ?? []))]
        }
      }
    }
    return {
      status: 1,
      error: '',
      data: { permissions },
    }
  },
}
