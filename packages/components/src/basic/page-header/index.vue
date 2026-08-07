<script setup lang="ts">
import type { HTMLAttributes, VNode } from 'vue'
import { cn } from '#utils'

defineOptions({
  name: 'BuiltInPageHeader',
})

const props = defineProps<{
  title?: string
  description?: string
  /**
   * 是否展示页面标题栏
   * @default true
   * @description 设为 false 时整块标题栏不渲染,用于按页面配置隐藏 title/desc
   */
  show?: boolean
  class?: HTMLAttributes['class']
  mainClass?: HTMLAttributes['class']
  defaultClass?: HTMLAttributes['class']
}>()

const slots = defineSlots<{
  title?: () => VNode
  description?: () => VNode
  default?: () => VNode
}>()
</script>

<template>
  <div v-if="show !== false" :class="cn('mb-4 flex flex-wrap items-center justify-between gap-5 border-b bg-background px-5 py-4', props.class)">
    <div :class="cn('flex-[1_1_70%]', props.mainClass)">
      <div class="text-2xl">
        <slot name="title">
          {{ title }}
        </slot>
      </div>
      <div class="text-sm text-secondary-foreground/50 mt-2 empty-hidden">
        <slot name="description">
          {{ description }}
        </slot>
      </div>
    </div>
    <div v-if="!!slots.default" :class="cn('ml-a flex-none', props.defaultClass)">
      <slot />
    </div>
  </div>
</template>
