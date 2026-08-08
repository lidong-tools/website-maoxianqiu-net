<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { ExpiringRow, InventoryReport, LowStockRow } from '@/types/analytics'
import apiAnalytics from '@/api/modules/analytics'
import { useAnalyticsContext } from '@/composables/business/useAnalyticsContext'
import AnalyticsKpiCard from '@/components/analytics/KpiCard.vue'
import { formatMoney } from '@/utils/format'

defineOptions({
  name: 'AnalyticsInventory',
})

const { ready, allStores, canViewTenant, startAt, endAt, params } = useAnalyticsContext()

const loading = ref(false)
const error = ref('')
const report = ref<InventoryReport | null>(null)

const lowStockColumns = computed<TableColumn<LowStockRow>[]>(() => [
  { accessorKey: 'warehouseName', header: '仓库' },
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'name', header: '名称' },
  {
    accessorKey: 'quantityOnHand',
    header: '在库',
  },
  {
    accessorKey: 'quantityReserved',
    header: '预留',
  },
  {
    accessorKey: 'available',
    header: '可用',
    cell: (info: any) => (
      Number(info.getValue()) <= 0
        ? `<span class="text-red-500">${info.getValue()}</span>`
        : info.getValue()
    ),
  },
  {
    accessorKey: 'stockValue',
    header: '成本价值',
    cell: (info: any) => formatMoney(info.getValue()),
  },
])

const expiringColumns = computed<TableColumn<ExpiringRow>[]>(() => [
  { accessorKey: 'warehouseName', header: '仓库' },
  { accessorKey: 'batchNo', header: '批次号' },
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'quantityRemaining', header: '剩余数量' },
  {
    accessorKey: 'expiryDate',
    header: '有效期至',
  },
  {
    accessorKey: 'daysToExpiry',
    header: '剩余天数',
    cell: (info: any) => {
      const v = Number(info.getValue())
      return v < 0
        ? `<span class="text-red-500">已过期 ${Math.abs(v)} 天</span>`
        : `${v} 天`
    },
  },
  {
    accessorKey: 'value',
    header: '批次价值',
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
    const res = await apiAnalytics.inventory(params.value)
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

async function onExport() {
  try {
    await apiAnalytics.exportCsv({ ...params.value, report: 'inventory' })
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

    <div class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
      <AnalyticsKpiCard
        v-for="kpi in report?.kpis ?? []"
        :key="kpi.key"
        :kpi="kpi"
      />
    </div>

    <div class="mt-4">
      <FaCard title="低库存明细(可用数量 ≤ 0)">
        <FaTable
          row-key="catalogItemId"
          stripe
          border
          :columns="lowStockColumns"
          :data="report?.lowStockRows ?? []"
        />
        <div v-if="!loading && report && report.lowStockRows.length === 0" class="py-8 text-center text-sm text-gray-400">
          无低库存商品
        </div>
      </FaCard>
    </div>

    <div class="mt-4">
      <FaCard title="近效期明细(30 天内到期)">
        <FaTable
          row-key="batchId"
          stripe
          border
          :columns="expiringColumns"
          :data="report?.expiringRows ?? []"
        />
        <div v-if="!loading && report && report.expiringRows.length === 0" class="py-8 text-center text-sm text-gray-400">
          无近效期批次
        </div>
      </FaCard>
    </div>
  </FaPageMain>
</template>
