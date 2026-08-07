<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { InventoryBalance, Warehouse } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'InventoryCount',
})

interface CountRow extends InventoryBalance {
  countedQuantity: number
  diff: number
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const submitting = ref(false)
const warehouses = ref<Warehouse[]>([])
const countRows = ref<CountRow[]>([])

const selectedWarehouseId = ref('')

const countColumns = computed<TableColumn<CountRow>[]>(() => [
  { accessorKey: 'catalog_item_id', header: '商品 ID', cell: (info: any) => info.getValue()?.slice(0, 8) },
  { accessorKey: 'quantity_on_hand', header: '系统在库量' },
  {
    id: 'counted',
    header: '盘点数量',
    cell: (info: any) => {
      return h('input', {
        type: 'number',
        value: info.row.original.countedQuantity,
        min: 0,
        class: 'w-24 px-2 py-1 border rounded',
        onInput: (e: Event) => {
          const val = Number((e.target as HTMLInputElement).value)
          info.row.original.countedQuantity = val
          info.row.original.diff = val - info.row.original.quantity_on_hand
        },
      })
    },
  },
  {
    id: 'diff',
    header: '差异',
    cell: (info: any) => {
      const diff = info.row.original.diff
      if (diff > 0) {
        return h('span', { class: 'text-green-500' }, `+${diff}`)
      }
      if (diff < 0) {
        return h('span', { class: 'text-red-500' }, `${diff}`)
      }
      return h('span', { class: 'text-gray-400' }, '0')
    },
  },
])

/** 加载仓库列表 */
async function loadWarehouses() {
  try {
    const res = await apiInventory.listWarehouses(tenantStore.currentStoreId || undefined)
    warehouses.value = res.data.list
    if (warehouses.value.length > 0 && !selectedWarehouseId.value) {
      selectedWarehouseId.value = warehouses.value[0].id
      await loadBalances()
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载仓库失败')
  }
}

/** 加载余额作为盘点基础,初始化盘点数量=系统在库量 */
async function loadBalances() {
  if (!selectedWarehouseId.value) {
    return
  }
  loading.value = true
  try {
    const res = await apiInventory.listBalances(selectedWarehouseId.value)
    countRows.value = res.data.list.map(bal => ({
      ...bal,
      countedQuantity: bal.quantity_on_hand,
      diff: 0,
    }))
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载余额失败')
  }
  finally {
    loading.value = false
  }
}

/** 提交盘点(走 Hono Command + post_stock_count RPC,批量幂等) */
async function onSubmit() {
  if (!selectedWarehouseId.value) {
    useFaToast().warning('请选择仓库')
    return
  }
  // 仅提交有差异的项
  const diffItems = countRows.value.filter(row => row.diff !== 0)
  if (diffItems.length === 0) {
    useFaToast().info('无盘点差异,无需提交')
    return
  }

  submitting.value = true
  const idempotencyKey = generateIdempotencyKey()
  try {
    await apiInventory.postStockCount({
      tenantId: tenantStore.currentTenantId,
      warehouseId: selectedWarehouseId.value,
      items: diffItems.map(row => ({
        catalogItemId: row.catalog_item_id,
        countedQuantity: row.countedQuantity,
      })),
    }, idempotencyKey)
    useFaToast().success(`盘点完成,已调整 ${diffItems.length} 项`)
    await loadBalances()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    submitting.value = false
  }
}

watch(selectedWarehouseId, () => {
  loadBalances()
})

onMounted(loadWarehouses)
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="盘点" class="mb-0">
      <template #description>
        盘点走 Hono Command + post_stock_count RPC,逐项对比余额写 adjust 流水,有差异才提交
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="仓库" class="col-span-1">
              <FaSelect
                v-model="selectedWarehouseId"
                placeholder="选择仓库"
                class="w-full"
                :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
              />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton variant="outline" @click="loadBalances">
                <FaIcon name="i-ri:refresh-line" />
                重新加载
              </FaButton>
              <FaButton type="primary" :loading="submitting" @click="onSubmit">
                <FaIcon name="i-ri:checkbox-circle-line" />
                提交盘点
              </FaButton>
            </div>
          </div>
        </template>
      </FaSearchBar>
      <div class="mx--4 my-3 border-t border-t-dashed" />

      <FaTable
        v-loading="loading"
        table-root-class="rounded-lg overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="countColumns"
        :data="countRows"
      />
    </FaPageMain>
  </div>
</template>
