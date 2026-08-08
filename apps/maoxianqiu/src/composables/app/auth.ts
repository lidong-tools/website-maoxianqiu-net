export function useAppAuth() {
  /**
   * 权限判断(唯一事实来源 = tenantStore.effectivePermissions)。
   * 审计 P0:effectivePermissions 会随 currentTenant/currentStore 实时变化,
   * 切换租户/门店后 useAppAuth().auth() / PermissionButton / 菜单守卫自动生效,
   * 无需再手动调用 account.getPermissions() 刷新快照。
   */
  function hasPermission(permission: string) {
    const appSettingsStore = useAppSettingsStore()
    const appTenantStore = useAppTenantStore()
    if (appSettingsStore.settings.app.account.auth) {
      return appTenantStore.effectivePermissions.includes(permission)
    }
    else {
      return true
    }
  }

  function auth(value: string | string[]) {
    let auth
    if (typeof value === 'string') {
      auth = value !== '' ? hasPermission(value) : true
    }
    else {
      auth = value.length > 0 ? value.some(item => hasPermission(item)) : true
    }
    return auth
  }

  function authAll(value: string[]) {
    return value.length > 0 ? value.every(item => hasPermission(item)) : true
  }

  return {
    auth,
    authAll,
  }
}
