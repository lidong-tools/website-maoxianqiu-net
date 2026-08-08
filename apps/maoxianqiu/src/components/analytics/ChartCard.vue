<script setup lang="ts">
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'

defineOptions({
  name: 'AnalyticsChartCard',
})

const props = withDefaults(defineProps<{
  title?: string
  option: EChartsOption
  height?: number
}>(), {
  title: '',
  height: 320,
})

const chartRef = useTemplateRef('chartRef')
let chart: echarts.ECharts | null = null
let darkObserver: MutationObserver | null = null

const isDark = () => document.documentElement.classList.contains('dark')

/** 依据暗色模式计算基础文本色 */
function resolveTextColor(): string {
  return isDark() ? '#d1d5db' : '#4b5563'
}

function resolveSplitColor(): string {
  return isDark() ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)'
}

function mergedOption(): EChartsOption {
  const textColor = resolveTextColor()
  const splitColor = resolveSplitColor()
  return {
    ...props.option,
    backgroundColor: 'transparent',
    textStyle: {
      color: textColor,
      ...(props.option.textStyle ?? {}),
    },
    grid: {
      left: 12,
      right: 16,
      top: 36,
      bottom: 8,
      containLabel: true,
      ...(props.option.grid ?? {}),
    },
    tooltip: props.option.tooltip ?? { trigger: 'axis' },
    legend: {
      textStyle: { color: textColor },
      ...(props.option.legend ?? {}),
    },
    // 坐标轴默认颜色
    xAxis: normalizeAxis(props.option.xAxis, textColor, splitColor),
    yAxis: normalizeAxis(props.option.yAxis, textColor, splitColor),
  } as EChartsOption
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeAxis(axis: any, textColor: string, splitColor: string): any {
  if (Array.isArray(axis)) {
    return axis.map(a => applyAxisStyle(a, textColor, splitColor))
  }
  if (axis && typeof axis === 'object') {
    return applyAxisStyle(axis, textColor, splitColor)
  }
  return {
    type: 'category',
    axisLabel: { color: textColor },
    axisLine: { lineStyle: { color: splitColor } },
    splitLine: { lineStyle: { color: splitColor } },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyAxisStyle(axis: any, textColor: string, splitColor: string): any {
  return {
    type: 'value',
    ...axis,
    axisLabel: { color: textColor, ...((axis.axisLabel as object) ?? {}) },
    axisLine: { lineStyle: { color: splitColor }, ...((axis.axisLine as object) ?? {}) },
    splitLine: { lineStyle: { color: splitColor }, ...((axis.splitLine as object) ?? {}) },
  }
}

function render() {
  if (!chart) {
    return
  }
  chart.setOption(mergedOption(), true)
}

function onResize() {
  chart?.resize()
}

onMounted(() => {
  if (!chartRef.value) {
    return
  }
  chart = echarts.init(chartRef.value)
  render()
  window.addEventListener('resize', onResize)
  // 监听 html.dark 类变化,切换图表文字颜色
  darkObserver = new MutationObserver(() => {
    render()
  })
  darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  darkObserver?.disconnect()
  chart?.dispose()
  chart = null
})

watch(() => props.option, () => render(), { deep: true })
</script>

<template>
  <div class="rounded-xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
    <div v-if="title" class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
      {{ title }}
    </div>
    <div
      ref="chartRef"
      :style="{ width: '100%', height: `${height}px` }"
    />
  </div>
</template>
