<script setup lang="ts">
defineOptions({
  name: 'BusinessErrorState',
})

withDefaults(defineProps<{
  title?: string
  message?: string
  retryText?: string
  compact?: boolean
}>(), {
  title: '加载失败',
  message: '请求服务时发生错误，请稍后重试',
  retryText: '重试',
  compact: false,
})

const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <div
    class="text-center flex flex-col gap-3 items-center justify-center"
    :class="compact ? 'py-6' : 'py-16'"
  >
    <div class="rounded-full bg-destructive/10 flex h-14 w-14 items-center justify-center">
      <FaIcon name="i-lucide:circle-alert" class="text-destructive size-7" />
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
        <FaButton variant="outline" size="sm" @click="emit('retry')">
          <FaIcon name="i-lucide:rotate-ccw" class="mr-1" />
          {{ retryText }}
        </FaButton>
      </slot>
    </div>
  </div>
</template>
