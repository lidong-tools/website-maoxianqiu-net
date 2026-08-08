import { defineStore } from 'pinia'
import { supabase } from '@/lib/supabase'

/**
 * 当前租户/门店上下文(仅 UI 偏好与工作上下文,不是权限依据)。
 * 权限与数据边界由服务端 RLS / API 独立判断(见 v0.4 文档 02 §5.2)。
 *
 * 存储策略:localStorage key 按用户隔离(mxq:{userId}:tenant/store),
 * 避免同一台电脑不同账号登录时残留他人门店上下文。
 */

export interface ContextStore {
  id: string
  name: string
  isPrimary: boolean
  roles: string[]
}

export interface ContextTenant {
  id: string
  name: string
  stores: ContextStore[]
}

export interface TenantContext {
  tenants: ContextTenant[]
}

const LEGACY_TENANT_KEY = 'currentTenantId'
const LEGACY_STORE_KEY = 'currentStoreId'

export const useAppTenantStore = defineStore('appTenant', () => {
  const currentTenantId = ref(localStorage.getItem(LEGACY_TENANT_KEY) ?? '')
  const currentStoreId = ref(localStorage.getItem(LEGACY_STORE_KEY) ?? '')

  // 用户可访问的租户/门店树(登录成功后加载)
  const context = ref<TenantContext | null>(null)
  const isReady = ref(false)

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
   * 登录后初始化用户可访问的租户/门店上下文。
   * 优先新模型 employee_role_assignments,无数据时回退旧模型 store_members。
   * 校验本地持久化的上下文仍合法,非法则选第一个有效门店。
   */
  async function initContext() {
    isReady.value = false
    const userId = await getUserId()
    if (!userId) {
      context.value = null
      isReady.value = true
      return
    }
    const keys = storageKeys(userId)

    // 优先读取 per-user key,其次旧 key
    const persistedTenantId = localStorage.getItem(keys.tenant) ?? localStorage.getItem(LEGACY_TENANT_KEY)
    const persistedStoreId = localStorage.getItem(keys.store) ?? localStorage.getItem(LEGACY_STORE_KEY)

    const tenantMap = new Map<string, ContextTenant>()
    const tenantScopedRoles: string[] = []

    // 新模型:employee_role_assignments
    const { data: era } = await supabase
      .from('employee_role_assignments')
      .select('tenant_id, store_id, role_code:roles(code), tenant:tenants(name), store:stores(name)')
      .eq('employee.user_id', userId)

    if (era && era.length > 0) {
      for (const row of era as any[]) {
        const tid = row.tenant_id
        if (!tid) {
          continue
        }
        if (!tenantMap.has(tid)) {
          tenantMap.set(tid, { id: tid, name: row.tenant?.name ?? '', stores: [] })
        }
        const tenant = tenantMap.get(tid)!
        const roleCode = row.role_code?.code
        if (row.store_id) {
          let store = tenant.stores.find(s => s.id === row.store_id)
          if (!store) {
            store = { id: row.store_id, name: row.store?.name ?? '', isPrimary: false, roles: [] }
            tenant.stores.push(store)
          }
          if (roleCode && !store.roles.includes(roleCode)) {
            store.roles.push(roleCode)
          }
        }
        else if (roleCode && !tenantScopedRoles.includes(roleCode)) {
          tenantScopedRoles.push(roleCode)
        }
      }
    }

    // 回退旧模型:store_members
    if (tenantMap.size === 0) {
      const { data: sm } = await supabase
        .from('store_members')
        .select('store_id, status, store:stores(id, name, tenant_id), role:roles(code)')
        .eq('user_id', userId)
      for (const row of (sm ?? []) as any[]) {
        if (row.status !== 'active' || !row.store) {
          continue
        }
        const tid = row.store.tenant_id
        if (!tid) {
          continue
        }
        if (!tenantMap.has(tid)) {
          tenantMap.set(tid, { id: tid, name: '', stores: [] })
        }
        const tenant = tenantMap.get(tid)!
        let store = tenant.stores.find(s => s.id === row.store_id)
        if (!store) {
          store = { id: row.store_id, name: row.store.name, isPrimary: false, roles: [] }
          tenant.stores.push(store)
        }
        const roleCode = row.role?.code
        if (roleCode && !store.roles.includes(roleCode)) {
          store.roles.push(roleCode)
        }
      }
    }

    // 租户级角色附加到该租户所有门店
    for (const tenant of tenantMap.values()) {
      for (const store of tenant.stores) {
        for (const role of tenantScopedRoles) {
          if (!store.roles.includes(role)) {
            store.roles.push(role)
          }
        }
      }
    }

    context.value = { tenants: [...tenantMap.values()] }
    cachedUserId = userId

    // 校验持久化上下文
    const valid = context.value.tenants.some(t =>
      t.id === persistedTenantId && t.stores.some(s => s.id === persistedStoreId),
    )
    if (valid && persistedTenantId && persistedStoreId) {
      setTenant(persistedTenantId)
      setStore(persistedStoreId)
    }
    else {
      // 无 primary 时选第一个有效门店
      const firstTenant = context.value.tenants[0]
      const firstStore = firstTenant?.stores[0]
      if (firstTenant && firstStore) {
        setTenant(firstTenant.id)
        setStore(firstStore.id)
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
    setTenant,
    setStore,
    switchStore,
    initContext,
    clear,
  }
})
