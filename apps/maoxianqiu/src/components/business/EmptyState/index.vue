<script setup lang="ts">
defineOptions({
  name: 'BusinessEmptyState',
})

withDefaults(defineProps<{
  title?: string
  description?: string
  icon?: string
  compact?: boolean
}>(), {
  title: '暂无数据',
  description: '',
  icon: 'i-lucide:inbox',
  compact: false,
})
</script>

<template>
  <div
    class="text-center flex flex-col gap-3 items-center justify-center"
    :class="compact ? 'py-6' : 'py-16'"
  >
    <div class="rounded-full bg-muted/50 flex h-14 w-14 items-center justify-center">
      <FaIcon :name="icon" class="text-muted-foreground size-7" />
    </div>
    <div>
      <div class="text-sm text-foreground font-medium">
        {{ title }}
      </div>
      <div v-if="description" class="text-xs text-muted-foreground mt-1">
        {{ description }}
      </div>
    </div>
    <div v-if="$slots.action" class="mt-1">
      <slot name="action" />
    </div>
  </div>
</template>
