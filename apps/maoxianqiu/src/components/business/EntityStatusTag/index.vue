<script setup lang="ts">
import type { StatusDef, StatusVariant } from '@/utils/status'

defineOptions({
  name: 'BusinessEntityStatusTag',
})

const props = withDefaults(defineProps<{
  status?: string
  label?: string
  variant?: StatusVariant
  /** 领域自定义状态映射,优先级高于 label/variant */
  map?: Record<string, StatusDef>
  dot?: boolean
}>(), {
  dot: true,
  variant: 'neutral',
})

const VARIANT_COLOR: Record<StatusVariant, string> = {
  neutral: 'var(--status-neutral)',
  info: 'var(--status-info)',
  success: 'var(--status-success)',
  warning: 'var(--status-warning)',
  danger: 'var(--status-danger)',
}

const display = computed<{ label: string, variant: StatusVariant }>(() => {
  if (props.status && props.map?.[props.status]) {
    const def = props.map[props.status]
    return {
      label: def.label,
      variant: def.variant,
    }
  }
  return {
    label: props.label ?? props.status ?? '-',
    variant: props.variant,
  }
})

const color = computed(() => VARIANT_COLOR[display.value.variant] ?? VARIANT_COLOR.neutral)
</script>

<template>
  <span
    class="text-xs font-medium px-2 py-0.5 border rounded-md inline-flex gap-1.5 whitespace-nowrap items-center"
    :style="{
      color: `oklch(${color})`,
      borderColor: `color-mix(in oklch, oklch(${color}) 45%, transparent)`,
      backgroundColor: `color-mix(in oklch, oklch(${color}) 12%, transparent)`,
    }"
  >
    <span v-if="dot" class="rounded-full shrink-0 size-1.5" :style="{ backgroundColor: `oklch(${color})` }" />
    <span>{{ display.label }}</span>
  </span>
</template>
