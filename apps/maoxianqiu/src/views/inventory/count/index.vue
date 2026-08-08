<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { InventoryBalance, Warehouse } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import { supabase } from '@/lib/supabase'
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
const catalogNameMap = ref<Record<string, string>>({})

const diffCount = computed(() => countRows.value.filter(row => row.diff !== 0).length)
const totalCounted = computed(() => countRows.value.length)

async function enrichCatalog() {
  const ids = [...new Set(countRows.value.map(r => r.catalog_item_id).filter(Boolean))]
  if (!ids.length) {
    return
  }
  const { data } = await supabase.from('catalog_items').select('id, name').in('id', ids)
  data?.forEach((c: any) => { catalogNameMap.value[c.id] = c.name })
}

const countColumns = computed<TableColumn<CountRow>[]>(() => [
  {
    id: 'catalog',
    header: '商品',
    cell: (info: any) => {
      const id = (info.row.original as CountRow).catalog_item_id
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-xs font-medium' }, catalogNameMap.value[id] ?? id.slice(0, 8)),
        h('div', { class: 'text-xs text-muted-foreground' }, id.slice(0, 8)),
      ])
    },
  },
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
    await enrichCatalog()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载余额失败')
  }
  finally {
    loading.value = false
  }
}

async function onSubmit() {
  if (!selectedWarehouseId.value) {
    useFaToast().warning('请选择仓库')
    return
  }
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

function onResetCount() {
  countRows.value.forEach((row) => {
    row.countedQuantity = row.quantity_on_hand
    row.diff = 0
  })
}

watch(selectedWarehouseId, () => {
  loadBalances()
})

// P0-06:切店后清空仓库选择并按新门店重载
useStoreScopedPage({
  load: loadWarehouses,
  reset: () => {
    selectedWarehouseId.value = ''
  },
})

onMounted(loadWarehouses)
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="盘点管理" description="系统在库 vs 实盘 · 有差异才提交">
      <template #actions>
        <FaSelect
          v-model="selectedWarehouseId"
          placeholder="选择仓库"
          class="w-44"
          :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
        />
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <div class="px-4 py-2.5 border-b flex items-center justify-between">
          <span class="text-sm font-medium">盘点工作表({{ totalCounted }} 项)</span>
          <FaButton size="sm" variant="outline" @click="onResetCount">
            <FaIcon name="i-lucide:rotate-ccw" />
            重置为系统数
          </FaButton>
        </div>
        <div v-loading="loading" class="flex-1 min-h-0 overflow-auto">
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="countColumns"
            :data="countRows"
          />
        </div>
      </div>
    </div>

    <WorkflowFixedBar>
      <template #left>
        <span class="text-sm text-muted-foreground">
          差异商品 <span class="text-foreground font-semibold">{{ diffCount }}</span> 项
        </span>
      </template>
      <template #right>
        <FaButton size="sm" variant="outline" @click="loadBalances">
          <FaIcon name="i-lucide:refresh-cw" />
          重新加载
        </FaButton>
        <FaButton size="sm" :loading="submitting" @click="onSubmit">
          <FaIcon name="i-lucide:clipboard-check" />
          提交盘点
        </FaButton>
      </template>
    </WorkflowFixedBar>
  </div>
</template>
