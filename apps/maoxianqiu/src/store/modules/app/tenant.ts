import { defineStore } from 'pinia'
import { supabase } from '@/lib/supabase'
import apiMe from '@/api/modules/me'

/**
 * 当前租户/门店上下文(仅 UI 偏好与工作上下文,不是权限依据)。
 * 权限与数据边界由服务端 RLS / API 独立判断(见 v0.4 文档 02 §5.2)。
 * P0-01..P0-05:上下文与权限的唯一事实来源 = GET /api/me/context,
 * 浏览器不再维护第二套权限/上下文算法。
 *
 * 存储策略:localStorage key 按用户隔离(mxq:{userId}:tenant/store),
 * 避免同一台电脑不同账号登录时残留他人门店上下文。
 */

export interface ContextStore {
  id: string
  name: string
  code?: string
  isPrimary: boolean
  roles: string[]
  permissions: string[]
}

export interface ContextTenant {
  id: string
  name: string
  roles: string[]
  primaryStoreId?: string
  stores: ContextStore[]
}

export interface TenantContext {
  tenants: ContextTenant[]
}

export type ContextMode = 'platform' | 'tenant' | 'none'

const LEGACY_TENANT_KEY = 'currentTenantId'
const LEGACY_STORE_KEY = 'currentStoreId'

export const useAppTenantStore = defineStore('appTenant', () => {
  const currentTenantId = ref(localStorage.getItem(LEGACY_TENANT_KEY) ?? '')
  const currentStoreId = ref(localStorage.getItem(LEGACY_STORE_KEY) ?? '')

  // 用户可访问的租户/门店树(登录成功后加载)
  const context = ref<TenantContext | null>(null)
  const isReady = ref(false)

  /** P0-05:上下文模式,platform = 平台管理员(跨租户,不强制默认门店) */
  const mode = ref<ContextMode>('none')
  /** P0-05:平台角色(platform_user_roles) */
  const platformRoles = ref<string[]>([])
  /** P0-01:当前用户聚合权限码(供 account.getPermissions 桥接,useAppAuth 消费) */
  const permissions = ref<string[]>([])

  // 当前登录用户 id(用于 per-user localStorage key)
  let cachedUserId = ''

  async function getUserId(): Promise<string> {
    if (cachedUserId) {
      return cachedUserId
    }
    const { data } = await supabase.auth.getUser()
    cachedUserId = data.user?.id ?? ''
    return cachedUserId
  }

  function storageKeys(userId: string) {
    return {
      tenant: `mxq:${userId}:tenant`,
      store: `mxq:${userId}:store`,
    }
  }

  function setTenant(id: string) {
    currentTenantId.value = id
    if (cachedUserId) {
      localStorage.setItem(storageKeys(cachedUserId).tenant, id)
    }
    if (id) {
      localStorage.setItem(LEGACY_TENANT_KEY, id)
    }
    else {
      localStorage.removeItem(LEGACY_TENANT_KEY)
    }
  }

  function setStore(id: string) {
    currentStoreId.value = id
    if (cachedUserId) {
      localStorage.setItem(storageKeys(cachedUserId).store, id)
    }
    if (id) {
      localStorage.setItem(LEGACY_STORE_KEY, id)
    }
    else {
      localStorage.removeItem(LEGACY_STORE_KEY)
    }
  }

  /**
   * 登录后初始化用户可访问的租户/门店上下文与权限。
   * 数据来源 = /api/me/context(服务端 resolveScopedAccess 同一套模型)。
   * 选择策略:已保存且有效的 Store → Primary Store → 第一个有效 Store;
   * 平台管理员(mode='platform')不强制默认门店。
   */
  async function initContext() {
    isReady.value = false
    const userId = await getUserId()
    if (!userId) {
      context.value = null
      mode.value = 'none'
      platformRoles.value = []
      permissions.value = []
      isReady.value = true
      return
    }
    const keys = storageKeys(userId)

    // 优先读取 per-user key,其次旧 key
    const persistedTenantId = localStorage.getItem(keys.tenant) ?? localStorage.getItem(LEGACY_TENANT_KEY)
    const persistedStoreId = localStorage.getItem(keys.store) ?? localStorage.getItem(LEGACY_STORE_KEY)

    let ctx: any
    try {
      ctx = await apiMe.getContext()
    }
    catch {
      context.value = null
      mode.value = 'none'
      platformRoles.value = []
      permissions.value = []
      isReady.value = true
      return
    }
    cachedUserId = userId

    if (!ctx) {
      context.value = null
      mode.value = 'none'
      platformRoles.value = []
      permissions.value = []
      isReady.value = true
      return
    }

    mode.value = ctx.mode ?? 'none'
    platformRoles.value = ctx.platformRoles ?? []
    permissions.value = ctx.permissions ?? []
    context.value = {
      tenants: (ctx.tenants ?? []).map((t: any) => ({
        id: t.id,
        name: t.name ?? '',
        roles: t.roles ?? [],
        primaryStoreId: t.primaryStoreId,
        stores: (t.stores ?? []).map((s: any) => ({
          id: s.id,
          name: s.name ?? '',
          code: s.code,
          isPrimary: !!s.isPrimary,
          roles: s.roles ?? [],
          permissions: s.permissions ?? [],
        })),
      })),
    }

    // 校验持久化上下文
    const valid = context.value.tenants.some(t =>
      t.id === persistedTenantId && t.stores.some(s => s.id === persistedStoreId),
    )
    if (valid && persistedTenantId && persistedStoreId) {
      setTenant(persistedTenantId)
      setStore(persistedStoreId)
    }
    else if (ctx.mode === 'platform') {
      // P0-05:平台管理员进入平台上下文,不强行伪装成普通医院员工
      setTenant('')
      setStore('')
    }
    else {
      // 无 primary 时选第一个有效门店;优先 primary 门店
      const primaryTenant = context.value.tenants.find(t => t.primaryStoreId) ?? context.value.tenants[0]
      const primaryStoreId = primaryTenant?.primaryStoreId
      const firstStoreId = primaryTenant?.stores[0]?.id
      if (primaryTenant && (primaryStoreId ?? firstStoreId)) {
        setTenant(primaryTenant.id)
        setStore(primaryStoreId ?? firstStoreId!)
      }
      else {
        setTenant('')
        setStore('')
      }
    }
    isReady.value = true
  }

  /** 切换当前门店(仅工作上下文,不做权限判断;页面自行 watch currentStoreId 刷新) */
  function switchStore(storeId: string) {
    const tenant = context.value?.tenants.find(t => t.stores.some(s => s.id === storeId))
    if (tenant) {
      setTenant(tenant.id)
      setStore(storeId)
    }
  }

  function clear() {
    context.value = null
    mode.value = 'none'
    platformRoles.value = []
    permissions.value = []
    isReady.value = false
    if (cachedUserId) {
      localStorage.removeItem(storageKeys(cachedUserId).tenant)
      localStorage.removeItem(storageKeys(cachedUserId).store)
    }
    setTenant('')
    setStore('')
  }

  return {
    currentTenantId,
    currentStoreId,
    context,
    isReady,
    mode,
    platformRoles,
    permissions,
    setTenant,
    setStore,
    switchStore,
    initContext,
    clear,
  }
})
