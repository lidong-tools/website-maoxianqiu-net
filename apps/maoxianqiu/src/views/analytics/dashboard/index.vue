<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import type { DashboardReport } from '@/types/analytics'
import apiAnalytics from '@/api/modules/analytics'
import AnalyticsChartCard from '@/components/analytics/ChartCard.vue'
import AnalyticsKpiCard from '@/components/analytics/KpiCard.vue'
import { useAnalyticsContext } from '@/composables/business/useAnalyticsContext'
import { formatMoney } from '@/utils/format'

defineOptions({
  name: 'AnalyticsDashboard',
})

const { ready, allStores, canViewTenant, startAt, endAt, params } = useAnalyticsContext()

const loading = ref(false)
const error = ref('')
const report = ref<DashboardReport | null>(null)

async function load() {
  if (!ready) {
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await apiAnalytics.dashboard(params.value)
    report.value = res.data
  }
  catch (e: any) {
    error.value = e?.message || '加载失败'
    useFaToast().error(error.value)
  }
  finally {
    loading.value = false
  }
}

useStoreScopedPage({ load })

onMounted(load)

watch([startAt, endAt, allStores], () => load())

/** 本月每日净收入趋势 */
const trendOption = computed<EChartsOption>(() => {
  const rows = report.value?.revenueTrend ?? []
  return {
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: any) => formatMoney(Number(v)),
    },
    xAxis: {
      type: 'category',
      data: rows.map(r => r.bucket.slice(5)),
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (v: number) => formatMoney(v) },
    },
    series: [
      {
        name: '净收入',
        type: 'line',
        smooth: true,
        areaStyle: { opacity: 0.15 },
        data: rows.map(r => r.net),
      },
      {
        name: '退款',
        type: 'bar',
        data: rows.map(r => r.refund),
        itemStyle: { color: '#f87171' },
      },
    ],
  }
})
</script>

<template>
  <FaPageMain>
    <div class="mb-4 flex flex-wrap gap-3 items-center">
      <FaLabel label="时间范围" class="mb-0">
        <div class="flex gap-2 items-center">
          <FaDatePicker v-model="startAt" type="date" value-type="format" class="w-36" />
          <span>至</span>
          <FaDatePicker v-model="endAt" type="date" value-type="format" class="w-36" />
        </div>
      </FaLabel>
      <FaTooltip
        v-if="canViewTenant"
        content="全院模式需要 analytics.view.tenant 权限,汇总全部门店数据"
      >
        <label class="text-sm text-gray-600 flex gap-2 cursor-pointer items-center dark:text-gray-300">
          <FaSwitch v-model="allStores" size="sm" />
          全院
        </label>
      </FaTooltip>
      <div class="flex-1" />
      <FaButton type="primary" :loading="loading" @click="load">
        刷新
      </FaButton>
    </div>

    <div v-if="error" class="text-sm text-red-600 mb-4 px-4 py-3 rounded-lg bg-red-50 dark:text-red-400 dark:bg-red-950/40">
      {{ error }}
    </div>

    <!-- KPI 卡片 -->
    <div class="gap-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
      <AnalyticsKpiCard
        v-for="kpi in report?.kpis ?? []"
        :key="kpi.key"
        :kpi="kpi"
      />
    </div>

    <!-- 收入趋势 -->
    <div class="mt-4">
      <AnalyticsChartCard
        title="本月每日收入趋势(净收入 / 退款)"
        :option="trendOption"
        :height="320"
      />
    </div>

    <!-- 库存预警快捷提示 -->
    <div class="mt-4 gap-4 grid md:grid-cols-2">
      <div class="text-sm text-amber-800 p-4 border border-amber-200 rounded-xl bg-amber-50 dark:text-amber-300 dark:border-amber-900 dark:bg-amber-950/40">
        <div class="font-medium flex gap-2 items-center">
          <FaIcon name="i-carbon:warning-alt" />
          缺货预警
        </div>
        <div class="text-xs text-amber-700 mt-2 dark:text-amber-400">
          当前可用数量 ≤ 0(断货/不可售)的 SKU 共
          <span class="font-semibold">{{ report?.lowStockCount ?? 0 }}</span>
          个,详见「库存分析」。
        </div>
      </div>
      <div class="text-sm text-orange-800 p-4 border border-orange-200 rounded-xl bg-orange-50 dark:text-orange-300 dark:border-orange-900 dark:bg-orange-950/40">
        <div class="font-medium flex gap-2 items-center">
          <FaIcon name="i-carbon:time" />
          近效期预警
        </div>
        <div class="text-xs text-orange-700 mt-2 dark:text-orange-400">
          查询周期结束日起 30 天内到期且有库存的批次共
          <span class="font-semibold">{{ report?.expiringCount ?? 0 }}</span>
          个,详见「库存分析」。
        </div>
      </div>
    </div>

    <div v-if="!loading && !report" class="text-sm text-gray-400 py-16 text-center">
      暂无数据,请调整时间范围后刷新。
    </div>
  </FaPageMain>
</template>
