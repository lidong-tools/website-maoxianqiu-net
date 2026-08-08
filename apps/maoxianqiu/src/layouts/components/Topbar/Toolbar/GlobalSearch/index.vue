<script setup lang="ts">
import BusinessGlobalSearch from '@/components/business/GlobalSearch/index.vue'
import { useHotkeyBindings } from '@/hotkeys'

defineOptions({
  name: 'ToolbarGlobalSearch',
})

const appSettingsStore = useAppSettingsStore()

const isShow = ref(false)

const useMobileStyle = computed(() => {
  return appSettingsStore.mode !== 'pc' || !appSettingsStore.settings.toolbar.globalSearch.hotkeys
})

useHotkeyBindings({
  'global.search.open': () => {
    isShow.value = true
  },
})
</script>

<template>
  <FaButton :variant="useMobileStyle ? 'ghost' : 'outline'" :size="useMobileStyle ? 'icon-sm' : undefined" :class="{ 'mx-2 px-3 h-9': !useMobileStyle }" title="业务全局搜索 (Ctrl/⌘+Shift+K)" @click="isShow = true">
    <FaIcon name="i-ri:search-eye-line" class="size-4" />
    <template v-if="!useMobileStyle">
      <FaKbdGroup v-if="appSettingsStore.settings.toolbar.globalSearch.hotkeys" class="-me-1">
        <FaKbd>{{ appSettingsStore.os === 'mac' ? '⌘' : 'Ctrl' }}</FaKbd>
        <FaKbd>Shift</FaKbd>
        <FaKbd>K</FaKbd>
      </FaKbdGroup>
    </template>
  </FaButton>
  <BusinessGlobalSearch v-model="isShow" />
</template>
