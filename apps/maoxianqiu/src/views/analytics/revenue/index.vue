<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { EChartsOption } from 'echarts'
import type {
  AnalyticsGroupBy,
  RevenueDimension,
  RevenueDimensionRow,
  RevenueReport,
} from '@/types/analytics'
import apiAnalytics from '@/api/modules/analytics'
import AnalyticsChartCard from '@/components/analytics/ChartCard.vue'
import AnalyticsKpiCard from '@/components/analytics/KpiCard.vue'
import { useAnalyticsContext } from '@/composables/business/useAnalyticsContext'
import {
  CATALOG_TYPE_LABELS,
  GROUP_BY_LABELS,
  PAYMENT_CHANNEL_LABELS,
  REVENUE_DIMENSION_LABELS,
} from '@/types/analytics'
import { formatMoney } from '@/utils/format'

defineOptions({
  name: 'AnalyticsRevenue',
})

const { ready, allStores, canViewTenant, startAt, endAt, params } = useAnalyticsContext()

const loading = ref(false)
const error = ref('')
const exporting = ref(false)
const report = ref<RevenueReport | null>(null)

const groupBy = ref<AnalyticsGroupBy>('day')
const dimension = ref<RevenueDimension>('store')

const groupByOptions = (Object.entries(GROUP_BY_LABELS) as [AnalyticsGroupBy, string][]).map(([value, label]) => ({ label, value }))
const dimensionOptions = (Object.entries(REVENUE_DIMENSION_LABELS) as [RevenueDimension, string][]).map(([value, label]) => ({ label, value }))

function dimensionLabel(row: RevenueDimensionRow): string {
  switch (dimension.value) {
    case 'payment_channel':
      return PAYMENT_CHANNEL_LABELS[row.key] ?? row.label
    case 'catalog_type':
      return CATALOG_TYPE_LABELS[row.key] ?? row.label
    default:
      return row.label
  }
}

const tableColumns = computed<TableColumn<RevenueDimensionRow>[]>(() => [
  {
    accessorKey: 'label',
    header: REVENUE_DIMENSION_LABELS[dimension.value] ?? '维度',
    cell: (info: any) => dimensionLabel(info.row.original),
  },
  {
    accessorKey: 'gross',
    header: 'Gross',
    cell: (info: any) => formatMoney(info.getValue()),
  },
  {
    accessorKey: 'net',
    header: '净收入',
    cell: (info: any) => formatMoney(info.getValue()),
  },
  {
    accessorKey: 'invoiceCount',
    // doctor 维度 count 为接诊数(encounter),其余维度为发票数(审计 v2 §17)
    header: dimension.value === 'doctor' ? '接诊数' : '发票数',
  },
  {
    accessorKey: 'averageTicket',
    header: '客单价',
    cell: (info: any) => formatMoney(info.getValue()),
  },
  {
    accessorKey: 'share',
    header: '占比',
    cell: (info: any) => `${Number(info.getValue()).toFixed(1)}%`,
  },
])

async function load() {
  if (!ready) {
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await apiAnalytics.revenue({
      ...params.value,
      groupBy: groupBy.value,
      dimension: dimension.value,
    })
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

watch([startAt, endAt, groupBy, dimension, allStores], () => load())

const trendOption = computed<EChartsOption>(() => {
  const rows = report.value?.trend ?? []
  return {
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: any) => formatMoney(Number(v)),
    },
    xAxis: {
      type: 'category',
      data: rows.map(r => (groupBy.value === 'month' ? r.bucket : r.bucket.slice(5))),
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (v: number) => formatMoney(v) },
    },
    series: [
      {
        name: 'Gross',
        type: 'bar',
        stack: 'revenue',
        data: rows.map(r => r.gross),
        itemStyle: { color: '#60a5fa' },
      },
      {
        name: '退款',
        type: 'bar',
        stack: 'revenue',
        data: rows.map(r => r.refund),
        itemStyle: { color: '#f87171' },
      },
      {
        name: '净收入',
        type: 'line',
        data: rows.map(r => r.net),
      },
    ],
  }
})

async function onExport() {
  exporting.value = true
  try {
    await apiAnalytics.exportCsv({
      ...params.value,
      report: 'revenue',
      groupBy: groupBy.value,
      dimension: dimension.value,
    })
    useFaToast().success('导出成功')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '导出失败')
  }
  finally {
    exporting.value = false
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
      <FaLabel label="分组" class="mb-0">
        <FaSelect v-model="groupBy" :options="groupByOptions" class="w-28" />
      </FaLabel>
      <FaLabel label="维度" class="mb-0">
        <FaSelect v-model="dimension" :options="dimensionOptions" class="w-32" />
      </FaLabel>
      <FaTooltip v-if="canViewTenant" content="全院模式需要 analytics.view.tenant 权限">
        <label class="text-sm text-gray-600 flex gap-2 cursor-pointer items-center dark:text-gray-300">
          <FaSwitch v-model="allStores" size="sm" />
          全院
        </label>
      </FaTooltip>
      <div class="flex-1" />
      <FaButton variant="outline" :loading="exporting" @click="onExport">
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

    <div class="gap-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      <AnalyticsKpiCard
        v-for="kpi in report?.kpis ?? []"
        :key="kpi.key"
        :kpi="kpi"
      />
    </div>

    <div class="mt-4">
      <AnalyticsChartCard
        title="收入趋势(Gross / 退款 / 净收入)"
        :option="trendOption"
        :height="340"
      />
    </div>

    <div class="mt-4">
      <FaCard :title="`按${REVENUE_DIMENSION_LABELS[dimension]}汇总`">
        <div
          v-if="dimension === 'payment_channel'"
          class="text-xs text-amber-700 mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40"
        >
          收款渠道按实际收款时间(payments.created_at)统计,与 Overall 的发票开账(应计)口径不同,合计可能与总净收入不一致(审计 v2 §16)。
        </div>
        <FaTable
          row-key="key"
          stripe
          border
          :columns="tableColumns"
          :data="report?.dimensionRows ?? []"
        />
        <div v-if="!loading && report && report.dimensionRows.length === 0" class="text-sm text-gray-400 py-8 text-center">
          该维度暂无数据
        </div>
      </FaCard>
    </div>
  </FaPageMain>
</template>
