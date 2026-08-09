<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { InventoryBalance, NearExpiryItem, Warehouse } from '@/types/inventory'
import apiInventory from '@/api/modules/inventory'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'InventoryDashboard',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const warehouses = ref<Warehouse[]>([])
const selectedWarehouseId = ref('')
const nearExpiryList = ref<NearExpiryItem[]>([])
const balances = ref<InventoryBalance[]>([])
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)

const nearExpiryColumns = computed<TableColumn<NearExpiryItem>[]>(() => [
  { accessorKey: 'warehouse_name', header: '仓库' },
  { accessorKey: 'batch_no', header: '批次号' },
  { accessorKey: 'catalog_item_id', header: '商品 ID', cell: (info: any) => info.getValue()?.slice(0, 8) },
  { accessorKey: 'expiry_date', header: '失效日期' },
  {
    accessorKey: 'days_to_expiry',
    header: '剩余天数',
    cell: (info: any) => {
      const days = info.getValue()
      if (days <= 7) {
        return h('span', { class: 'text-red-500 font-bold' }, `${days} 天`)
      }
      if (days <= 14) {
        return h('span', { class: 'text-orange-500' }, `${days} 天`)
      }
      return `${days} 天`
    },
  },
  { accessorKey: 'quantity_remaining', header: '剩余数量' },
  { accessorKey: 'supplier', header: '供应商' },
])

async function loadWarehouses() {
  try {
    const res = await apiInventory.listWarehouses(tenantStore.currentStoreId || undefined)
    warehouses.value = res.data.list
    if (warehouses.value.length > 0 && !selectedWarehouseId.value) {
      selectedWarehouseId.value = warehouses.value[0].id
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载仓库失败')
  }
}

async function loadNearExpiry() {
  loading.value = true
  try {
    nearExpiryList.value = await apiInventory.listNearExpiryByView(tenantStore.currentStoreId || undefined)
    page.value = 1
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载近效期预警失败')
  }
  finally {
    loading.value = false
  }
}

/** 加载各仓余额用于 KPI(在库/预占/SKU 数) */
async function loadBalances() {
  const targets = warehouses.value.length ? warehouses.value : []
  const all: InventoryBalance[] = []
  for (const w of targets) {
    try {
      const res = await apiInventory.listBalances(w.id)
      all.push(...res.data.list)
    }
    catch {
      // 单个仓库失败不阻塞
    }
  }
  balances.value = all
}

/** 按仓库 + 关键词(批次号/供应商/商品ID/仓库名)过滤近效期列表 */
const filteredNearExpiry = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return nearExpiryList.value.filter((item) => {
    if (selectedWarehouseId.value && item.warehouse_id !== selectedWarehouseId.value) {
      return false
    }
    if (!kw) {
      return true
    }
    return [item.batch_no, item.supplier, item.catalog_item_id, item.warehouse_name]
      .some(v => (v ?? '').toLowerCase().includes(kw))
  })
})

/** 当前分页的近效期数据(前端分页) */
const pagedNearExpiry = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredNearExpiry.value.slice(start, start + pageSize.value)
})

const skuCount = computed(() => new Set(balances.value.map(b => b.catalog_item_id)).size)
const totalOnHand = computed(() => balances.value.reduce((s, b) => s + Number(b.quantity_on_hand), 0))
const totalReserved = computed(() => balances.value.reduce((s, b) => s + Number(b.quantity_reserved), 0))
const nearExpiryCount = computed(() => nearExpiryList.value.length)

function onRefresh() {
  Promise.all([loadNearExpiry(), loadBalances()])
}

// P0-06:切店后按新门店重载仓库/近效期/余额
useStoreScopedPage({
  load: async () => {
    await loadWarehouses()
    await Promise.all([loadNearExpiry(), loadBalances()])
  },
  reset: () => {
    selectedWarehouseId.value = ''
  },
})

onMounted(async () => {
  await loadWarehouses()
  await Promise.all([loadNearExpiry(), loadBalances()])
})
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(参考优惠券界面布局) -->
    <!--
    <EntityPageHeader compact title="库存概览" description="SKU / 在库 / 预占 / 近效期预警">
      <template #actions>
        <FaSelect
          v-model="selectedWarehouseId"
          placeholder="全部仓库"
          clearable
          class="w-40"
          :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
        />
        <FaButton size="sm" variant="outline" @click="onRefresh">
          <FaIcon name="i-lucide:refresh-cw" />
          刷新
        </FaButton>
      </template>
    </EntityPageHeader>
    -->

    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <!-- KPI -->
      <div class="gap-4 grid grid-cols-2 shrink-0 xl:grid-cols-4">
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ skuCount }}
          </div>
          <div class="text-xs text-muted-foreground">
            SKU 数
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ totalOnHand }}
          </div>
          <div class="text-xs text-muted-foreground">
            在库总量
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ totalReserved }}
          </div>
          <div class="text-xs text-muted-foreground">
            预占量
          </div>
        </div>
        <div class="p-3 border border-orange-200 rounded-lg bg-orange-50">
          <div class="text-2xl text-orange-600 font-semibold tabular-nums">
            {{ nearExpiryCount }}
          </div>
          <div class="text-xs text-orange-600/70 font-medium">
            近效期
          </div>
        </div>
      </div>

      <!-- 主要内容卡片:工具栏(左筛选/搜索,右功能按钮) + 表格 + 分页 -->
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 工具栏 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 flex items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaSelect
                v-model="selectedWarehouseId"
                placeholder="全部仓库"
                clearable
                class="w-36"
                :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
                @change="page = 1"
              />
              <FaInput
                v-model="keyword"
                placeholder="搜索批次号/供应商/商品"
                clearable
                class="w-52"
                @update:model-value="page = 1"
              />
              <span class="text-sm text-muted-foreground">
                共 {{ filteredNearExpiry.length }} 条近效期
              </span>
            </div>
            <FaButton size="sm" variant="outline" @click="onRefresh">
              <FaIcon name="i-lucide:refresh-cw" />
              刷新
            </FaButton>
          </div>
        </div>

        <!-- 表格区 -->
        <div class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            v-loading="loading"
            table-root-class="overflow-hidden"
            row-key="batch_id"
            stripe
            border
            :columns="nearExpiryColumns"
            :data="pagedNearExpiry"
            empty-text="暂无近效期批次"
          />
        </div>

        <!-- 分页区 -->
        <FaPagination
          :page="page"
          :size="pageSize"
          :total="filteredNearExpiry.length"
          class="mt-2 px-4 pb-3 shrink-0"
          @page-change="p => { page = p }"
          @size-change="s => { pageSize = s; page = 1 }"
        />
      </div>
    </div>
  </div>
</template>
