<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { EChartsOption } from 'echarts'
import type { CustomerReport, CustomerTierRow } from '@/types/analytics'
import apiAnalytics from '@/api/modules/analytics'
import { useAnalyticsContext } from '@/composables/business/useAnalyticsContext'
import AnalyticsKpiCard from '@/components/analytics/KpiCard.vue'
import AnalyticsChartCard from '@/components/analytics/ChartCard.vue'
import { formatMoney } from '@/utils/format'

defineOptions({
  name: 'AnalyticsCustomers',
})

const { ready, allStores, canViewTenant, startAt, endAt, params } = useAnalyticsContext()

const loading = ref(false)
const error = ref('')
const report = ref<CustomerReport | null>(null)

const tierColumns = computed<TableColumn<CustomerTierRow>[]>(() => [
  { accessorKey: 'label', header: '层级' },
  { accessorKey: 'count', header: '客户数' },
  {
    accessorKey: 'contribution',
    header: '本期消费',
    cell: (info: any) => formatMoney(info.getValue()),
  },
])

async function load() {
  if (!ready) {
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await apiAnalytics.customers(params.value)
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

/** 会员层级 Donut */
const tierOption = computed<EChartsOption>(() => {
  const rows = report.value?.tierBreakdown ?? []
  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => `${p.name}<br/>${p.value} 人(${p.percent}%)`,
    },
    series: [
      {
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '52%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: 'transparent', borderWidth: 2 },
        label: { show: false },
        data: rows.map(r => ({ name: r.label, value: r.count })),
      },
    ],
  }
})

const consumptionColumns = computed<TableColumn<any>[]>(() => [
  { accessorKey: 'label', header: '消费区间(净消费/元)' },
  { accessorKey: 'count', header: '客户数' },
  {
    accessorKey: 'amount',
    header: '消费合计',
    cell: (info: any) => formatMoney(info.getValue()),
  },
])

async function onExport() {
  try {
    await apiAnalytics.exportCsv({ ...params.value, report: 'customers' })
    useFaToast().success('导出成功')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '导出失败')
  }
}
</script>

<template>
  <FaPageMain>
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <FaLabel label="时间范围" class="mb-0">
        <div class="flex items-center gap-2">
          <FaDatePicker v-model="startAt" type="date" value-type="format" class="w-36" />
          <span>至</span>
          <FaDatePicker v-model="endAt" type="date" value-type="format" class="w-36" />
        </div>
      </FaLabel>
      <FaTooltip v-if="canViewTenant" content="全院模式需要 analytics.view.tenant 权限">
        <label class="flex cursor-pointer items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
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

    <div v-if="error" class="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">
      {{ error }}
    </div>

    <div class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      <AnalyticsKpiCard
        v-for="kpi in report?.kpis ?? []"
        :key="kpi.key"
        :kpi="kpi"
      />
    </div>

    <!-- 复诊率定义说明 -->
    <div class="mt-4 flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
      <FaIcon name="i-carbon:information" class="mt-0.5 shrink-0" />
      <div>
        <span class="font-medium">复诊率口径:</span>
        <span class="ml-1">{{ report?.repeatRateDefinition ?? '加载中...' }}</span>
      </div>
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <AnalyticsChartCard title="会员层级分布" :option="tierOption" :height="300" />
      <FaCard title="会员层级明细">
        <FaTable
          row-key="tier"
          stripe
          border
          :columns="tierColumns"
          :data="report?.tierBreakdown ?? []"
        />
      </FaCard>
    </div>

    <div class="mt-4">
      <FaCard title="客户消费分层">
        <FaTable
          row-key="key"
          stripe
          border
          :columns="consumptionColumns"
          :data="report?.consumptionTiers ?? []"
        />
        <div v-if="!loading && report && report.consumptionTiers.length === 0" class="py-8 text-center text-sm text-gray-400">
          暂无消费数据
        </div>
      </FaCard>
    </div>
  </FaPageMain>
</template>
