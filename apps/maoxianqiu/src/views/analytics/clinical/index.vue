<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { EChartsOption } from 'echarts'
import type { ClinicalDailyRow, ClinicalReport } from '@/types/analytics'
import apiAnalytics from '@/api/modules/analytics'
import AnalyticsChartCard from '@/components/analytics/ChartCard.vue'
import AnalyticsKpiCard from '@/components/analytics/KpiCard.vue'
import { useAnalyticsContext } from '@/composables/business/useAnalyticsContext'

defineOptions({
  name: 'AnalyticsClinical',
})

const { ready, allStores, canViewTenant, startAt, endAt, params } = useAnalyticsContext()

const loading = ref(false)
const error = ref('')
const report = ref<ClinicalReport | null>(null)

const dailyColumns = computed<TableColumn<ClinicalDailyRow>[]>(() => [
  { accessorKey: 'date', header: '日期' },
  { accessorKey: 'appointments', header: '预约数' },
  { accessorKey: 'showUps', header: '到店数' },
  { accessorKey: 'noShows', header: 'No-show' },
  { accessorKey: 'encounters', header: '接诊数' },
  { accessorKey: 'signedEncounters', header: '完成病历' },
])

async function load() {
  if (!ready) {
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await apiAnalytics.clinical(params.value)
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

const dailyOption = computed<EChartsOption>(() => {
  const rows = report.value?.dailyRows ?? []
  return {
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: rows.map(r => r.date.slice(5)),
    },
    yAxis: { type: 'value' },
    series: [
      {
        name: '预约数',
        type: 'bar',
        data: rows.map(r => r.appointments),
      },
      {
        name: '接诊数',
        type: 'line',
        smooth: true,
        data: rows.map(r => r.encounters),
      },
      {
        name: '完成病历',
        type: 'line',
        smooth: true,
        data: rows.map(r => r.signedEncounters),
      },
    ],
  }
})

async function onExport() {
  try {
    await apiAnalytics.exportCsv({ ...params.value, report: 'clinical' })
    useFaToast().success('导出成功')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '导出失败')
  }
}
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
      <FaTooltip v-if="canViewTenant" content="全院模式需要 analytics.view.tenant 权限">
        <label class="text-sm text-gray-600 flex gap-2 cursor-pointer items-center dark:text-gray-300">
          <FaSwitch v-model="allStores" size="sm" />
          全院
        </label>
      </FaTooltip>
      <div class="flex-1" />
      <FaButton variant="outline" @click="onExport">
        <template #icon>
          <FaIcon name="i-carbon:download" />
        </template>
        导出 CSV
      </FaButton>
      <FaButton type="primary" :loading="loading" @click="load">
        刷新
      </FaButton>
    </div>

    <div v-if="error" class="text-sm text-red-600 mb-4 px-4 py-3 rounded-lg bg-red-50 dark:text-red-400 dark:bg-red-950/40">
      {{ error }}
    </div>

    <div class="gap-4 grid grid-cols-2 md:grid-cols-4">
      <AnalyticsKpiCard
        v-for="kpi in report?.kpis ?? []"
        :key="kpi.key"
        :kpi="kpi"
      />
    </div>

    <div class="mt-4">
      <AnalyticsChartCard
        title="每日预约/接诊/完成病历趋势"
        :option="dailyOption"
        :height="320"
      />
    </div>

    <div class="mt-4">
      <FaCard title="每日明细">
        <FaTable
          row-key="date"
          stripe
          border
          :columns="dailyColumns"
          :data="report?.dailyRows ?? []"
        />
        <div v-if="!loading && report && report.dailyRows.length === 0" class="text-sm text-gray-400 py-8 text-center">
          该时间段暂无数据
        </div>
      </FaCard>
    </div>
  </FaPageMain>
</template>
