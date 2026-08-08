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
  /** 高频工作台/列表页使用的紧凑标题栏(高度约 56-72px) */
  compact?: boolean
}>(), {
  showStatus: false,
  compact: false,
})
</script>

<template>
  <FaPageHeader
    :title="title"
    :description="description"
    :class="compact ? 'px-4 py-2' : ''"
  >
    <template #title>
      <div class="flex flex-wrap gap-3 items-center" :class="compact ? 'text-lg' : ''">
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
