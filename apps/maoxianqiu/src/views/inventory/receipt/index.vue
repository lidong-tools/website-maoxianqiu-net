<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { InventoryBalance, InventoryMovement, Warehouse } from '@/types/inventory'
import { FaButton } from '@fantastic-admin/components'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { INVENTORY_PERMISSIONS, MOVEMENT_TYPE_LABELS } from '@/types/inventory'

defineOptions({
  name: 'InventoryReceipt',
})

const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()
const loading = ref(false)
const submitting = ref(false)
const reserving = ref(false)
const processingMovementId = ref('')
const warehouses = ref<Warehouse[]>([])
const balances = ref<InventoryBalance[]>([])
const movements = ref<InventoryMovement[]>([])
const activeTab = ref('receipt')

const catalogNameMap = ref<Record<string, string>>({})

const form = reactive({
  warehouseId: '',
  catalogItemId: '',
  batchNo: '',
  quantity: 1,
  unitCost: 0,
  expiryDate: '',
  supplier: '',
  referenceId: '',
})

const reserveForm = reactive({
  catalogItemId: '',
  quantity: 1,
  referenceType: '',
  referenceId: '',
})

async function enrichCatalog(rows: Array<{ catalog_item_id: string }>) {
  const ids = [...new Set(rows.map(r => r.catalog_item_id).filter(Boolean))]
  if (!ids.length) {
    return
  }
  const { data } = await supabase.from('catalog_items').select('id, name').in('id', ids)
  data?.forEach((c: any) => { catalogNameMap.value[c.id] = c.name })
}

function nameOf(id: string | null | undefined): string {
  if (!id) {
    return '-'
  }
  return catalogNameMap.value[id] ?? id.slice(0, 8)
}

const balanceColumns = computed<TableColumn<InventoryBalance>[]>(() => [
  {
    id: 'catalog',
    header: '商品',
    cell: (info: any) => {
      const row = info.row.original as InventoryBalance
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-xs font-medium' }, nameOf(row.catalog_item_id)),
        h('div', { class: 'text-xs text-muted-foreground' }, row.catalog_item_id.slice(0, 8)),
      ])
    },
  },
  { accessorKey: 'quantity_on_hand', header: '在库量' },
  { accessorKey: 'quantity_reserved', header: '预占量' },
  {
    id: 'available',
    header: '可用量',
    cell: (info: any) => {
      const row = info.row.original as InventoryBalance
      return Math.max(0, Number(row.quantity_on_hand) - Number(row.quantity_reserved))
    },
  },
  { accessorKey: 'updated_at', header: '更新时间', cell: (info: any) => info.getValue()?.slice(0, 19).replace('T', ' ') },
  {
    id: 'actions',
    header: '操作',
    cell: (info: any) => {
      if (!auth(INVENTORY_PERMISSIONS.reserve)) {
        return null
      }
      const row = info.row.original as InventoryBalance
      return h('div', { class: 'flex justify-end' }, h(FaButton, { size: 'sm', variant: 'outline', onClick: () => startReserve(row) }, () => '预留'))
    },
  },
])

const movementColumns = computed<TableColumn<InventoryMovement>[]>(() => [
  {
    id: 'catalog',
    header: '商品',
    cell: (info: any) => nameOf((info.row.original as InventoryMovement).catalog_item_id),
  },
  {
    accessorKey: 'movement_type',
    header: '类型',
    cell: (info: any) => MOVEMENT_TYPE_LABELS[info.getValue() as InventoryMovement['movement_type']] ?? info.getValue(),
  },
  { accessorKey: 'quantity', header: '数量', cell: (info: any) => info.getValue() },
  { accessorKey: 'balance_after', header: '操作后余额' },
  { accessorKey: 'created_at', header: '时间', cell: (info: any) => info.getValue()?.slice(0, 19).replace('T', ' ') },
  {
    id: 'actions',
    header: '操作',
    cell: (info: any) => {
      const row = info.row.original as InventoryMovement
      if (row.movement_type !== 'reserve') {
        return null
      }
      const processing = processingMovementId.value === row.id
      return h('div', { class: 'flex justify-end gap-1' }, [
        h(FaButton, { size: 'sm', variant: 'outline', disabled: processing || !auth(INVENTORY_PERMISSIONS.confirm), onClick: () => onConfirmReservation(row) }, () => processing ? '处理中' : '确认'),
        h(FaButton, { size: 'sm', variant: 'outline', disabled: processing || !auth(INVENTORY_PERMISSIONS.release), onClick: () => onReleaseReservation(row) }, () => processing ? '处理中' : '释放'),
      ])
    },
  },
])

async function loadWarehouses() {
  try {
    const res = await apiInventory.listWarehouses(tenantStore.currentStoreId || undefined)
    warehouses.value = res.data.list
    if (warehouses.value.length > 0 && !form.warehouseId) {
      form.warehouseId = warehouses.value[0].id
      await loadInventoryData()
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载仓库失败')
  }
}

async function loadInventoryData() {
  if (!form.warehouseId) {
    return
  }
  loading.value = true
  try {
    const [balRes, mvRes] = await Promise.all([
      apiInventory.listBalances(form.warehouseId),
      apiInventory.listMovements(form.warehouseId, 20),
    ])
    balances.value = balRes.data.list
    movements.value = mvRes.data.list
    await enrichCatalog([...balances.value, ...movements.value])
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载库存数据失败')
  }
  finally {
    loading.value = false
  }
}

async function onSubmit() {
  if (!form.warehouseId) {
    useFaToast().warning('请选择仓库')
    return
  }
  if (!form.catalogItemId) {
    useFaToast().warning('请选择商品')
    return
  }
  if (form.quantity <= 0) {
    useFaToast().warning('数量必须大于 0')
    return
  }
  submitting.value = true
  const idempotencyKey = generateIdempotencyKey()
  try {
    await apiInventory.postGoodsReceipt({
      tenantId: tenantStore.currentTenantId,
      warehouseId: form.warehouseId,
      catalogItemId: form.catalogItemId,
      batchNo: form.batchNo || undefined,
      quantity: form.quantity,
      unitCost: form.unitCost || undefined,
      expiryDate: form.expiryDate || undefined,
      supplier: form.supplier || undefined,
      referenceId: form.referenceId || undefined,
    }, idempotencyKey)
    useFaToast().success('入库成功')
    form.catalogItemId = ''
    form.batchNo = ''
    form.quantity = 1
    form.unitCost = 0
    form.expiryDate = ''
    form.supplier = ''
    form.referenceId = ''
    await loadInventoryData()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    submitting.value = false
  }
}

function startReserve(row: InventoryBalance) {
  reserveForm.catalogItemId = row.catalog_item_id
  const available = Math.max(0, Number(row.quantity_on_hand) - Number(row.quantity_reserved))
  reserveForm.quantity = Math.max(1, Math.floor(available))
  useFaToast().info(`已选择商品 ${nameOf(row.catalog_item_id)},可用量 ${available},请确认预留数量`)
}

async function onReserve() {
  if (!form.warehouseId) {
    useFaToast().warning('请选择仓库')
    return
  }
  if (!reserveForm.catalogItemId) {
    useFaToast().warning('请选择商品(可在余额表点击「预留」)')
    return
  }
  if (reserveForm.quantity <= 0) {
    useFaToast().warning('数量必须大于 0')
    return
  }
  reserving.value = true
  const idempotencyKey = generateIdempotencyKey()
  try {
    await apiInventory.reserve({
      tenantId: tenantStore.currentTenantId,
      warehouseId: form.warehouseId,
      catalogItemId: reserveForm.catalogItemId,
      quantity: reserveForm.quantity,
      referenceType: reserveForm.referenceType || undefined,
      referenceId: reserveForm.referenceId || undefined,
    }, idempotencyKey)
    useFaToast().success(`预留成功,已冻结 ${reserveForm.quantity} 件`)
    reserveForm.catalogItemId = ''
    reserveForm.quantity = 1
    reserveForm.referenceType = ''
    reserveForm.referenceId = ''
    await loadInventoryData()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    reserving.value = false
  }
}

async function onConfirmReservation(row: InventoryMovement) {
  if (processingMovementId.value) {
    return
  }
  processingMovementId.value = row.id
  movements.value = movements.value.slice()
  const idempotencyKey = generateIdempotencyKey()
  try {
    await apiInventory.confirmReservation({
      tenantId: tenantStore.currentTenantId,
      reservationId: row.id,
    }, idempotencyKey)
    useFaToast().success(`已确认预留 ${Math.abs(row.quantity)} 件,库存正式扣减`)
    await loadInventoryData()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    processingMovementId.value = ''
  }
}

async function onReleaseReservation(row: InventoryMovement) {
  if (processingMovementId.value) {
    return
  }
  processingMovementId.value = row.id
  movements.value = movements.value.slice()
  const idempotencyKey = generateIdempotencyKey()
  try {
    await apiInventory.releaseReservation({
      tenantId: tenantStore.currentTenantId,
      reservationId: row.id,
    }, idempotencyKey)
    useFaToast().success(`已释放预留 ${Math.abs(row.quantity)} 件`)
    await loadInventoryData()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    processingMovementId.value = ''
  }
}

watch(() => form.warehouseId, () => {
  loadInventoryData()
})

onMounted(loadWarehouses)
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="入库管理" description="采购入库 · 预留冻结 · 余额与流水">
      <template #actions>
        <FaSelect
          v-model="form.warehouseId"
          placeholder="选择仓库"
          class="w-44"
          :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
        />
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <!-- 页内 Tabs -->
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <div class="px-3 py-2 border-b flex gap-1 items-center">
          <FaButton size="sm" :variant="activeTab === 'receipt' ? 'default' : 'ghost'" @click="activeTab = 'receipt'">
            入库登记
          </FaButton>
          <FaButton v-if="auth(INVENTORY_PERMISSIONS.reserve)" size="sm" :variant="activeTab === 'reserve' ? 'default' : 'ghost'" @click="activeTab = 'reserve'">
            预留管理
          </FaButton>
          <FaButton size="sm" :variant="activeTab === 'balance' ? 'default' : 'ghost'" @click="activeTab = 'balance'">
            库存余额
          </FaButton>
          <FaButton size="sm" :variant="activeTab === 'movement' ? 'default' : 'ghost'" @click="activeTab = 'movement'">
            最近流水
          </FaButton>
        </div>

        <div v-loading="loading" class="p-4 flex-1 min-h-0 overflow-auto">
          <!-- 入库登记 -->
          <div v-if="activeTab === 'receipt'" class="max-w-3xl">
            <div class="mb-3 gap-x-6 gap-y-3 grid grid-cols-2">
              <FaLabel label="商品">
                <BusinessCatalogItemPicker v-model="form.catalogItemId" placeholder="搜索选择服务/药品" />
              </FaLabel>
              <FaLabel label="数量">
                <FaInputNumber v-model="form.quantity" :min="1" class="w-full" />
              </FaLabel>
              <FaLabel label="批次号">
                <FaInput v-model="form.batchNo" placeholder="批次号(可选)" class="w-full" />
              </FaLabel>
              <FaLabel label="单位成本">
                <FaInputNumber v-model="form.unitCost" :min="0" :precision="2" class="w-full" />
              </FaLabel>
              <FaLabel label="失效日期">
                <FaInput v-model="form.expiryDate" type="date" placeholder="失效日期(可选)" class="w-full" />
              </FaLabel>
              <FaLabel label="供应商">
                <FaInput v-model="form.supplier" placeholder="供应商(可选)" class="w-full" />
              </FaLabel>
              <FaLabel label="参考单号">
                <FaInput v-model="form.referenceId" placeholder="采购单号(可选)" class="w-full" />
              </FaLabel>
            </div>
            <div class="pt-2 flex gap-2 items-center">
              <FaButton :loading="submitting" @click="onSubmit">
                <FaIcon name="i-lucide:package-plus" />
                确认入库
              </FaButton>
              <span class="text-xs text-muted-foreground">走 Hono Command + post_goods_receipt RPC,幂等防重复</span>
            </div>
          </div>

          <!-- 预留管理 -->
          <div v-if="activeTab === 'reserve'" class="max-w-3xl">
            <div class="mb-3 gap-x-6 gap-y-3 grid grid-cols-2">
              <FaLabel label="商品">
                <BusinessCatalogItemPicker v-model="reserveForm.catalogItemId" placeholder="点击余额表「预留」自动填充" />
              </FaLabel>
              <FaLabel label="数量">
                <FaInputNumber v-model="reserveForm.quantity" :min="1" class="w-full" />
              </FaLabel>
              <FaLabel label="参考类型">
                <FaInput v-model="reserveForm.referenceType" placeholder="挂单/订单(可选)" class="w-full" />
              </FaLabel>
              <FaLabel label="参考单号">
                <FaInput v-model="reserveForm.referenceId" placeholder="挂单号/订单号(可选)" class="w-full" />
              </FaLabel>
            </div>
            <div class="pt-2 flex gap-3 items-center">
              <FaButton :loading="reserving" @click="onReserve">
                <FaIcon name="i-lucide:lock" />
                确认预留
              </FaButton>
              <span class="text-xs text-muted-foreground">可用量 = 在库量 - 预占量;预留后可在流水表确认或释放</span>
            </div>
          </div>

          <!-- 库存余额 -->
          <div v-if="activeTab === 'balance'">
            <FaTable
              table-root-class="rounded-lg overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="balanceColumns"
              :data="balances"
            />
          </div>

          <!-- 最近流水 -->
          <div v-if="activeTab === 'movement'">
            <FaTable
              table-root-class="rounded-lg overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="movementColumns"
              :data="movements"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
