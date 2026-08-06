import { defineStore } from 'pinia'

const TENANT_KEY = 'currentTenantId'
const STORE_KEY = 'currentStoreId'

/**
 * 当前租户/门店上下文(仅 UI 偏好与工作上下文,不是权限依据)。
 * 权限与数据边界由服务端 RLS / API 独立判断(见 v0.4 文档 02 §5.2)。
 */
export const useAppTenantStore = defineStore('appTenant', () => {
  const currentTenantId = ref(localStorage.getItem(TENANT_KEY) ?? '')
  const currentStoreId = ref(localStorage.getItem(STORE_KEY) ?? '')

  function setTenant(id: string) {
    currentTenantId.value = id
    if (id) {
      localStorage.setItem(TENANT_KEY, id)
    }
    else {
      localStorage.removeItem(TENANT_KEY)
    }
  }

  function setStore(id: string) {
    currentStoreId.value = id
    if (id) {
      localStorage.setItem(STORE_KEY, id)
    }
    else {
      localStorage.removeItem(STORE_KEY)
    }
  }

  function clear() {
    setTenant('')
    setStore('')
  }

  return {
    currentTenantId,
    currentStoreId,
    setTenant,
    setStore,
    clear,
  }
})
