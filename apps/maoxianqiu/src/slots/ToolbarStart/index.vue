<script setup lang="ts">
defineOptions({
  name: 'ToolbarStart',
})

const router = useRouter()
const appTenantStore = useAppTenantStore()
const { confirmLeave } = useUnsavedChangesGuard()
const { auth } = useAppAuth()

// 当前上下文标题
const contextTitle = computed(() => {
  const c = appTenantStore.context
  if (!c) {
    return ''
  }
  for (const t of c.tenants) {
    const store = t.stores.find(s => s.id === appTenantStore.currentStoreId)
    if (store) {
      return `${t.name} / ${store.name}`
    }
  }
  return ''
})

const canManageStore = computed(() => auth('system:store:manage'))

async function onSwitchStore(storeId: string) {
  if (storeId === appTenantStore.currentStoreId) {
    return
  }
  const ok = await confirmLeave('切换门店将放弃当前页面尚未保存的内容，确定切换吗？')
  if (ok) {
    appTenantStore.switchStore(storeId)
  }
}

// 门店分组(每组一个租户),选中项带对勾
const dropdownItems = computed(() => {
  const c = appTenantStore.context
  const groups: Array<Array<{ label: string, icon: string, disabled?: boolean, handle: () => void }>> = []
  if (!c) {
    return groups
  }
  for (const tenant of c.tenants) {
    if (tenant.stores.length === 0) {
      continue
    }
    const items: Array<{ label: string, icon: string, disabled?: boolean, handle: () => void }> = tenant.stores.map(store => ({
      label: `${store.name}${store.roles.length > 0 ? `（${store.roles.join('/')}）` : ''}`,
      icon: store.id === appTenantStore.currentStoreId ? 'i-mdi:check' : 'i-mdi:store-outline',
      disabled: store.id === appTenantStore.currentStoreId,
      handle: () => onSwitchStore(store.id),
    }))
    groups.push(items)
  }
  if (canManageStore.value) {
    groups.push([
      {
        label: '管理门店',
        icon: 'i-mdi:store-cog-outline',
        handle: () => router.push({ path: '/system/store' }),
      },
    ])
  }
  return groups
})
</script>

<template>
  <FaDropdown v-if="contextTitle" :items="dropdownItems" align="start" side="bottom">
    <FaButton variant="ghost" class="text-sm font-medium px-2 h-9 max-w-64">
      <span class="truncate">
        {{ contextTitle }}
      </span>
      <FaIcon name="i-mdi:chevron-down" class="flex-shrink-0" />
    </FaButton>
  </FaDropdown>
</template>
