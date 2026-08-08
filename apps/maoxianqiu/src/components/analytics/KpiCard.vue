<script setup lang="ts">
import type { AnalyticsKpi } from '@/types/analytics'
import { formatMoney } from '@/utils/format'

defineOptions({
  name: 'AnalyticsKpiCard',
})

const props = defineProps<{
  kpi: AnalyticsKpi
}>()

/** 数值展示(按 format 格式化,仅展示) */
function displayValue(kpi: AnalyticsKpi): string {
  const v = kpi.value
  switch (kpi.format) {
    case 'money':
      return formatMoney(v)
    case 'percent':
      return `${Number(v.toFixed(1))}%`
    case 'integer':
      return Math.round(v).toLocaleString('zh-CN')
    case 'ratio':
      return Number(v.toFixed(2)).toString()
    default:
      return Number(v.toFixed(2)).toString()
  }
}

const kpi = computed(() => props.kpi)
const valueText = computed(() => displayValue(kpi.value))
</script>

<template>
  <div class="relative rounded-xl border border-gray-100 bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-gray-800 dark:bg-gray-900">
    <div class="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
      <span class="truncate">{{ kpi.label }}</span>
      <FaTooltip :content="kpi.definition">
        <FaIcon name="i-carbon:information" class="cursor-help text-gray-400" />
      </FaTooltip>
    </div>
    <div class="mt-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">
      {{ valueText }}
    </div>
    <div v-if="kpi.hint" class="mt-1 truncate text-xs text-gray-400 dark:text-gray-500">
      {{ kpi.hint }}
    </div>
  </div>
</template>
