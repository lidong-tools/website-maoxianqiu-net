<script setup lang="ts">
import type { StatusDef, StatusVariant } from '@/utils/status'

defineOptions({
  name: 'BusinessEntityPageHeader',
})

withDefaults(defineProps<{
  title?: string
  description?: string
  showStatus?: boolean
  status?: string
  statusMap?: Record<string, StatusDef>
  statusLabel?: string
  statusVariant?: StatusVariant
}>(), {
  showStatus: false,
})
</script>

<template>
  <FaPageHeader :title="title" :description="description">
    <template #title>
      <div class="flex flex-wrap gap-3 items-center">
        <span>{{ title }}</span>
        <EntityStatusTag
          v-if="showStatus"
          :status="status"
          :map="statusMap"
          :label="statusLabel"
          :variant="statusVariant"
        />
      </div>
    </template>
    <template v-if="$slots.actions" #default>
      <slot name="actions" />
    </template>
  </FaPageHeader>
</template>
