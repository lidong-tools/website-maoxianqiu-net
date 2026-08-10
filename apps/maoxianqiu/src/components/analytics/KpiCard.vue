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
  <div class="p-4 border border-gray-100 rounded-xl bg-white shadow-sm transition-shadow relative dark:border-gray-800 dark:bg-gray-900 hover:shadow-md">
    <div class="text-xs text-gray-500 flex gap-1 items-center dark:text-gray-400">
      <span class="truncate">{{ kpi.label }}</span>
      <FaTooltip :content="kpi.definition">
        <FaIcon name="i-carbon:information" class="text-gray-400 cursor-help" />
      </FaTooltip>
    </div>
    <div class="text-2xl text-gray-900 font-semibold mt-2 dark:text-gray-100">
      {{ valueText }}
    </div>
    <div v-if="kpi.hint" class="text-xs text-gray-400 mt-1 truncate dark:text-gray-500">
      {{ kpi.hint }}
    </div>
  </div>
</template>
