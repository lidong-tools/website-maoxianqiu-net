<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { NearExpiryItem, Warehouse } from '@/types/inventory'
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

/** 加载仓库列表(按当前门店过滤) */
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

/** 加载近效期预警(直连视图,RLS 按门店过滤) */
async function loadNearExpiry() {
  loading.value = true
  try {
    nearExpiryList.value = await apiInventory.listNearExpiryByView(tenantStore.currentStoreId || undefined)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载近效期预警失败')
  }
  finally {
    loading.value = false
  }
}

/** 按选中仓库过滤近效期列表 */
const filteredNearExpiry = computed(() => {
  if (!selectedWarehouseId.value) {
    return nearExpiryList.value
  }
  return nearExpiryList.value.filter(item => item.warehouse_id === selectedWarehouseId.value)
})

onMounted(async () => {
  await loadWarehouses()
  await loadNearExpiry()
})
</script>

<template>
  <div>
    <FaPageHeader title="库存概览" class="mb-0">
      <template #description>
        查看近效期预警与库存概览,30 天内到期的批次将在此高亮显示
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="仓库" class="col-span-1">
              <FaSelect
                v-model="selectedWarehouseId"
                placeholder="全部仓库"
                clearable
                class="w-full"
                :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
              />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton type="primary" @click="loadNearExpiry">
                <FaIcon name="i-ri:refresh-line" />
                刷新
              </FaButton>
            </div>
          </div>
        </template>
      </FaSearchBar>
      <div class="mx--4 my-3 border-t border-t-dashed" />

      <!-- 近效期预警卡片 -->
      <div class="mb-4">
        <div class="mb-2 flex gap-2 items-center">
          <FaIcon name="i-ri:alarm-warning-line" class="text-orange-500" />
          <span class="text-lg font-bold">近效期预警</span>
          <FaTag variant="outline" size="sm">
            {{ filteredNearExpiry.length }} 项
          </FaTag>
        </div>
        <FaTable
          v-loading="loading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="batch_id"
          stripe
          border
          :columns="nearExpiryColumns"
          :data="filteredNearExpiry"
        />
      </div>
    </FaPageMain>
  </div>
</template>
