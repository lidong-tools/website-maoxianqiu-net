import { supabase } from '@/lib/supabase'

export default {
  // 后端下发路由(当前使用前端路由,保留空实现)
  routeList: () => Promise.resolve({
    status: 1,
    error: '',
    data: [],
  }),

  // 我的资料(含成员关系/店铺/角色),浏览器直连
  async profile() {
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    const { data: profile } = userId
      ? await supabase.from('profiles').select('*').eq('id', userId).single()
      : { data: null }
    const { data: memberships } = userId
      ? await supabase.from('store_members')
          .select('id, store_id, role_id, status, stores(name, code), roles(code, name)')
          .eq('user_id', userId)
      : { data: [] }

    return {
      status: 1,
      error: '',
      data: {
        account: userData.user?.email ?? '',
        avatar: profile?.avatar ?? userData.user?.user_metadata?.avatar ?? '',
        realName: profile?.real_name ?? '',
        phone: profile?.phone ?? '',
        status: profile?.status ?? 'active',
        memberships: memberships ?? [],
      },
    }
  },

  // 权限聚合(成员关系对应角色的权限并集)
  async permission() {
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    let permissions: string[] = []
    if (userId) {
      const { data: memberships } = await supabase
        .from('store_members')
        .select('role_id, status')
        .eq('user_id', userId)
      const activeRoleIds = [...new Set((memberships ?? [])
        .filter((item: any) => item.status === 'active')
        .map((item: any) => item.role_id))]
      if (activeRoleIds.length > 0) {
        const { data: roles } = await supabase
          .from('roles')
          .select('permissions')
          .in('id', activeRoleIds)
        permissions = [...new Set((roles ?? [])
          .flatMap((role: any) => role.permissions ?? []))]
      }
    }
    return {
      status: 1,
      error: '',
      data: { permissions },
    }
  },
}
