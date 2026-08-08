<script setup lang="ts">
import type { StatusVariant } from '@/utils/status'

defineOptions({
  name: 'BusinessEntitySummaryHeader',
})

withDefaults(defineProps<{
  avatar?: string
  subtitle?: string
  tags?: { label: string, variant?: StatusVariant }[]
  facts?: { label: string, value: string | number }[]
}>(), {
  tags: () => [],
  facts: () => [],
})
</script>

<template>
  <div class="px-4 py-3 border-b bg-card flex flex-wrap gap-4 items-center justify-between">
    <div class="flex gap-3 min-w-0 items-center">
      <div v-if="avatar" class="rounded-full bg-muted flex shrink-0 size-11 items-center justify-center">
        <FaIcon :name="avatar" class="text-xl text-muted-foreground" />
      </div>
      <div class="min-w-0">
        <div class="text-lg leading-tight font-medium flex flex-wrap gap-2 items-center">
          <slot name="title" />
          <span v-if="!$slots.title">{{ subtitle }}</span>
        </div>
        <div v-if="subtitle && $slots.title" class="text-sm text-muted-foreground truncate">
          {{ subtitle }}
        </div>
        <div v-if="tags.length" class="mt-1 flex flex-wrap gap-1.5 items-center">
          <EntityStatusTag v-for="t in tags" :key="t.label" :label="t.label" :variant="t.variant" :dot="false" />
        </div>
      </div>
    </div>
    <div class="flex gap-5 items-center">
      <div v-for="f in facts" :key="f.label" class="text-center">
        <div class="text-sm font-semibold tabular-nums">
          {{ f.value }}
        </div>
        <div class="text-xs text-muted-foreground">
          {{ f.label }}
        </div>
      </div>
      <div v-if="$slots.actions" class="ml-2 flex gap-2 items-center">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>
