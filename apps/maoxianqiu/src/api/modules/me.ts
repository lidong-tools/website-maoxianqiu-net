import api from '../index'

/**
 * 当前用户工作上下文 API(P0-01..P0-05)
 * 唯一事实来源:浏览器不再维护第二套权限/上下文算法。
 * 返回 { user, platformRoles, mode, tenants, permissions, primaryStoreId }
 */
export default {
  async getContext(): Promise<{
    user: { id: string, name: string, email: string }
    mode: 'platform' | 'tenant' | 'none'
    platformRoles: string[]
    tenants: Array<{
      id: string
      name: string
      roles: string[]
      permissions: string[]
      primaryStoreId?: string
      stores: Array<{
        id: string
        name: string
        code?: string
        isPrimary: boolean
        roles: string[]
        permissions: string[]
      }>
    }>
    permissions: string[]
    primaryStoreId?: string
  }> {
    const res: any = await api.get('me/context')
    return res?.data ?? null
  },
}
