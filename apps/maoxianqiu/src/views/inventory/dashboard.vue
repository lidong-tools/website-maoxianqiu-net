<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { InventoryBalance, NearExpiryItem, Warehouse, WriteOffReasonType } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { INVENTORY_PERMISSIONS, WRITE_OFF_REASON_LABELS } from '@/types/inventory'

defineOptions({
  name: 'InventoryDashboard',
})

const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()
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
      const days = Number(info.getValue())
      if (days < 0) {
        return h('span', { class: 'text-red-600 font-bold' }, `已过期 ${Math.abs(days)} 天`)
      }
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
  {
    id: 'operation',
    header: '操作',
    width: 90,
    align: 'center',
    fixed: 'right',
  },
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

// ===== 报损/报废/过期登记(B-R-2 / R-15,经 Hono Command + post_inventory_writeoff RPC) =====
const writeOffVisible = ref(false)
const writeOffSubmitting = ref(false)
const writeOffForm = reactive({
  warehouseId: '',
})

interface WriteOffItem {
  catalogItemId: string
  quantity: number
  reasonType: WriteOffReasonType
  reason: string
  batchId: string
}

const writeOffItems = ref<WriteOffItem[]>([])

const writeOffReasonOptions = Object.entries(WRITE_OFF_REASON_LABELS).map(([value, label]) => ({ label, value }))

/**
 * 打开报损登记弹窗
 * @param row 可选:从近效期列表点击「报损」时带入仓库/商品/数量/批次,原因默认为「过期」
 */
function openWriteOff(row?: NearExpiryItem) {
  writeOffForm.warehouseId = row?.warehouse_id || selectedWarehouseId.value || warehouses.value[0]?.id || ''
  writeOffItems.value = row
    ? [{
        catalogItemId: row.catalog_item_id,
        quantity: Number(row.quantity_remaining),
        reasonType: 'expired' as WriteOffReasonType,
        reason: '',
        batchId: row.batch_id,
      }]
    : [{ catalogItemId: '', quantity: 1, reasonType: 'write_off' as WriteOffReasonType, reason: '', batchId: '' }]
  writeOffVisible.value = true
}

function addWriteOffItem() {
  writeOffItems.value.push({ catalogItemId: '', quantity: 1, reasonType: 'write_off', reason: '', batchId: '' })
}

function removeWriteOffItem(idx: number) {
  writeOffItems.value.splice(idx, 1)
}

/** 提交报损:校验仓库与明细后调用 RPC(幂等) */
async function onWriteOffSubmit() {
  if (!writeOffForm.warehouseId) {
    useFaToast().warning('请选择仓库')
    return
  }
  if (writeOffItems.value.length === 0 || writeOffItems.value.some(i => !i.catalogItemId)) {
    useFaToast().warning('请添加至少一项有效报损明细')
    return
  }
  if (writeOffItems.value.some(i => Number(i.quantity) <= 0)) {
    useFaToast().warning('报损数量必须大于 0')
    return
  }
  writeOffSubmitting.value = true
  try {
    await apiInventory.postWriteOff({
      tenantId: tenantStore.currentTenantId,
      warehouseId: writeOffForm.warehouseId,
      items: writeOffItems.value.map(i => ({
        catalogItemId: i.catalogItemId,
        quantity: Number(i.quantity),
        reasonType: i.reasonType,
        reason: i.reason.trim() || undefined,
        batchId: i.batchId || undefined,
      })),
    }, generateIdempotencyKey())
    useFaToast().success('报损登记成功,库存已扣减')
    writeOffVisible.value = false
    await Promise.all([loadNearExpiry(), loadBalances()])
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    writeOffSubmitting.value = false
  }
}

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
      <div class="shrink-0 gap-4 grid grid-cols-2 xl:grid-cols-4">
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
            <div class="flex gap-2">
              <FaButton v-if="auth(INVENTORY_PERMISSIONS.writeOff)" size="sm" @click="openWriteOff()">
                <FaIcon name="i-lucide:package-minus" />
                报损登记
              </FaButton>
              <FaButton size="sm" variant="outline" @click="onRefresh">
                <FaIcon name="i-lucide:refresh-cw" />
                刷新
              </FaButton>
            </div>
          </div>
        </div>

        <!-- 表格区 -->
        <div class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            v-loading="loading"
            class="h-full min-h-0"
            table-root-class="overflow-hidden"
            row-key="batch_id"
            stripe
            border
            :columns="nearExpiryColumns"
            :data="pagedNearExpiry"
            empty-text="暂无近效期批次"
          >
            <template #cell-operation="{ row }">
              <div class="flex-center">
                <FaButton v-if="auth(INVENTORY_PERMISSIONS.writeOff)" size="sm" variant="outline" @click="openWriteOff(row.original)">
                  报损
                </FaButton>
              </div>
            </template>
          </FaTable>
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

    <!-- 报损/报废/过期登记 -->
    <FaModal v-model="writeOffVisible" title="报损登记" :footer="false" :close-on-click-overlay="false" width="860px">
      <div class="py-2 space-y-4">
        <div class="gap-x-4 gap-y-3 grid grid-cols-3">
          <FaLabel label="仓库 *" class="block">
            <FaSelect
              v-model="writeOffForm.warehouseId"
              placeholder="选择仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
            />
          </FaLabel>
        </div>

        <div class="text-sm font-medium">
          报损明细
        </div>
        <div class="space-y-2">
          <div class="text-xs text-muted-foreground px-1 gap-2 grid grid-cols-12">
            <span class="col-span-4">商品</span>
            <span class="col-span-2">数量</span>
            <span class="col-span-2">原因类型</span>
            <span class="col-span-3">原因说明(可选)</span>
            <span class="col-span-1" />
          </div>
          <div v-for="(item, idx) in writeOffItems" :key="idx" class="gap-2 grid grid-cols-12 items-center">
            <div class="col-span-4">
              <BusinessCatalogItemPicker v-model="item.catalogItemId" placeholder="搜索选择商品" />
            </div>
            <div class="col-span-2">
              <FaInputNumber v-model="item.quantity" :min="1" class="w-full" />
            </div>
            <div class="col-span-2">
              <FaSelect v-model="item.reasonType" class="w-full" :options="writeOffReasonOptions" />
            </div>
            <div class="col-span-3">
              <FaInput v-model="item.reason" placeholder="原因说明(可选)" class="w-full" />
            </div>
            <div class="flex col-span-1 justify-end">
              <FaButton size="sm" variant="ghost" @click="removeWriteOffItem(idx)">
                <FaIcon name="i-lucide:trash-2" />
              </FaButton>
            </div>
          </div>
          <FaButton variant="outline" size="sm" @click="addWriteOffItem">
            <FaIcon name="i-lucide:plus" />
            添加商品
          </FaButton>
        </div>

        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="writeOffVisible = false">
            取消
          </FaButton>
          <FaButton :loading="writeOffSubmitting" @click="onWriteOffSubmit">
            确认报损
          </FaButton>
        </div>
      </div>
    </FaModal>
  </div>
</template>
