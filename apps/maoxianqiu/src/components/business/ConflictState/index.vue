<script setup lang="ts">
defineOptions({
  name: 'BusinessConflictState',
})

withDefaults(defineProps<{
  title?: string
  message?: string
  compact?: boolean
}>(), {
  title: '数据已变更',
  message: '该记录已被他人更新或状态已改变，请刷新后重试',
  compact: false,
})

const emit = defineEmits<{
  reload: []
}>()
</script>

<template>
  <div
    class="text-center flex flex-col gap-3 items-center justify-center"
    :class="compact ? 'py-6' : 'py-16'"
  >
    <div
      class="rounded-full flex h-14 w-14 items-center justify-center"
      :style="{ backgroundColor: 'color-mix(in oklch, oklch(var(--status-warning)) 15%, transparent)' }"
    >
      <FaIcon name="i-lucide:refresh-cw" class="size-7" :style="{ color: 'oklch(var(--status-warning))' }" />
    </div>
    <div>
      <div class="text-sm text-foreground font-medium">
        {{ title }}
      </div>
      <div v-if="message" class="text-xs text-muted-foreground mt-1">
        {{ message }}
      </div>
    </div>
    <div v-if="$slots.action || true" class="mt-1">
      <slot name="action">
        <FaButton variant="outline" size="sm" @click="emit('reload')">
          <FaIcon name="i-lucide:rotate-ccw" class="mr-1" />
          刷新
        </FaButton>
      </slot>
    </div>
  </div>
</template>
