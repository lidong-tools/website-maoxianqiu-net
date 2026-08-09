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

// ===== 工具栏:筛选/搜索 + 前端分页(参考优惠券界面布局) =====
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)

/** 按关键词(商品名称/ID)过滤盘点行 */
const filteredCountRows = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) {
    return countRows.value
  }
  return countRows.value.filter((row) => {
    const name = catalogNameMap.value[row.catalog_item_id] ?? ''
    return `${name} ${row.catalog_item_id}`.toLowerCase().includes(kw)
  })
})

/** 当前分页的盘点行(前端分页) */
const pagedCountRows = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredCountRows.value.slice(start, start + pageSize.value)
})

// 过滤条件变化时修正越界页码
watch(filteredCountRows, () => {
  const maxPage = Math.max(1, Math.ceil(filteredCountRows.value.length / pageSize.value))
  if (page.value > maxPage) {
    page.value = maxPage
  }
})

async function enrichCatalog() {
  const ids = [...new Set(countRows.value.map(r => r.catalog_item_id).filter(Boolean))]
  if (!ids.length) {
    return
  }
  const { data } = await supabase.from('catalog_items').select('id, name').in('id', ids)
  data?.forEach((c: any) => {
    catalogNameMap.value[c.id] = c.name
  })
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
    page.value = 1
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

// P1(审计 25):未保存内容保护 - 存在盘点差异(实盘与系统不一致)时视为 dirty
const countGuard = usePageUnsavedGuard('inventory-count')
watch(() => countRows.value.some(row => row.diff !== 0), (hasDiff) => {
  countGuard.setDirty(hasDiff)
}, { immediate: true })

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
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(参考优惠券界面布局) -->
    <!--
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
    -->

    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <!-- 主要内容卡片:工具栏(左筛选/搜索,右功能按钮) + 表格 + 分页 -->
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 工具栏 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 flex items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaSelect
                v-model="selectedWarehouseId"
                placeholder="选择仓库"
                class="w-36"
                :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
              />
              <FaInput
                v-model="keyword"
                placeholder="搜索商品名称/ID"
                clearable
                class="w-52"
                @update:model-value="page = 1"
              />
              <span class="text-sm text-muted-foreground">
                共 {{ filteredCountRows.length }} 项
              </span>
            </div>
            <FaButton size="sm" variant="outline" @click="onResetCount">
              <FaIcon name="i-lucide:rotate-ccw" />
              重置为系统数
            </FaButton>
          </div>
        </div>

        <!-- 表格区 -->
        <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="countColumns"
            :data="pagedCountRows"
            empty-text="暂无盘点数据"
          />
        </div>

        <!-- 分页区 -->
        <FaPagination
          :page="page"
          :size="pageSize"
          :total="filteredCountRows.length"
          class="mt-2 px-4 pb-3 shrink-0"
          @page-change="p => { page = p }"
          @size-change="s => { pageSize = s; page = 1 }"
        />
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
