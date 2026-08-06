<script setup lang="ts">
import type { StatusDef, StatusVariant } from '@/utils/status'

defineOptions({
  name: 'BusinessEntityDetailShell',
})

withDefaults(defineProps<{
  title?: string
  description?: string
  showStatus?: boolean
  status?: string
  statusMap?: Record<string, StatusDef>
  statusLabel?: string
  statusVariant?: StatusVariant
  loading?: boolean
  error?: string
}>(), {
  showStatus: false,
  loading: false,
  error: '',
})

const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <div>
    <EntityPageHeader
      :title="title"
      :description="description"
      :show-status="showStatus"
      :status="status"
      :status-map="statusMap"
      :status-label="statusLabel"
      :status-variant="statusVariant"
    >
      <template v-if="$slots.actions" #actions>
        <slot name="actions" />
      </template>
    </EntityPageHeader>
    <FaPageMain>
      <template v-if="error">
        <ErrorState :title="error" message="请检查网络或稍后重试" @retry="emit('retry')" />
      </template>
      <div v-else v-loading="loading">
        <slot />
      </div>
    </FaPageMain>
  </div>
</template>
