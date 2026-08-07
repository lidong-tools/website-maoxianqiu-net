<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { InventoryBalance, InventoryMovement, Warehouse } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'
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
/** 正在确认/释放的流水 id(行级处理中状态,防止重复提交) */
const processingMovementId = ref('')
const warehouses = ref<Warehouse[]>([])
const balances = ref<InventoryBalance[]>([])
const movements = ref<InventoryMovement[]>([])

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

/** 预留操作表单(点击余额表「预留」按钮自动填充商品 ID) */
const reserveForm = reactive({
  catalogItemId: '',
  quantity: 1,
  referenceType: '',
  referenceId: '',
})

const balanceColumns = computed<TableColumn<InventoryBalance>[]>(() => [
  { accessorKey: 'catalog_item_id', header: '商品 ID', cell: (info: any) => info.getValue()?.slice(0, 8) },
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
      return h('button', {
        type: 'button',
        class: 'px-2 py-1 text-xs border rounded hover:bg-gray-100',
        onClick: () => startReserve(row),
      }, '预留')
    },
  },
])

const movementColumns = computed<TableColumn<InventoryMovement>[]>(() => [
  { accessorKey: 'catalog_item_id', header: '商品 ID', cell: (info: any) => info.getValue()?.slice(0, 8) },
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
      // 仅 reserve 流水可确认/释放
      if (row.movement_type !== 'reserve') {
        return null
      }
      const processing = processingMovementId.value === row.id
      return h('div', { class: 'flex gap-2' }, [
        h('button', {
          type: 'button',
          class: 'px-2 py-1 text-xs text-white bg-blue-500 rounded hover:bg-blue-600 disabled:opacity-50',
          disabled: processing || !auth(INVENTORY_PERMISSIONS.confirm),
          onClick: () => onConfirmReservation(row),
        }, processing ? '处理中' : '确认'),
        h('button', {
          type: 'button',
          class: 'px-2 py-1 text-xs text-white bg-orange-500 rounded hover:bg-orange-600 disabled:opacity-50',
          disabled: processing || !auth(INVENTORY_PERMISSIONS.release),
          onClick: () => onReleaseReservation(row),
        }, processing ? '处理中' : '释放'),
      ])
    },
  },
])

/** 加载仓库列表 */
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

/** 加载余额与流水 */
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
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载库存数据失败')
  }
  finally {
    loading.value = false
  }
}

/** 提交入库(走 Hono Command + post_goods_receipt RPC,幂等) */
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
  // 生成幂等键,提交失败重试时复用同一 key,防止重复入库
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

/** 点击余额行「预留」:填充预留表单并提示可预留数量 */
function startReserve(row: InventoryBalance) {
  reserveForm.catalogItemId = row.catalog_item_id
  const available = Math.max(0, Number(row.quantity_on_hand) - Number(row.quantity_reserved))
  reserveForm.quantity = Math.max(1, Math.floor(available))
  useFaToast().info(`已选择商品 ${row.catalog_item_id.slice(0, 8)},可用量 ${available},请确认预留数量`)
}

/** 提交预留(走 Hono Command + reserve_inventory RPC,幂等) */
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
  // 生成幂等键,提交失败重试时复用同一 key,防止重复预留
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

/** 确认预留(支付确认,预留转正式扣减;走 confirm_inventory_reservation RPC) */
async function onConfirmReservation(row: InventoryMovement) {
  if (processingMovementId.value) {
    return
  }
  processingMovementId.value = row.id
  movements.value = movements.value.slice() // 触发表格重渲染,展示「处理中」状态
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

/** 释放预留(取消释放;走 release_inventory_reservation RPC) */
async function onReleaseReservation(row: InventoryMovement) {
  if (processingMovementId.value) {
    return
  }
  processingMovementId.value = row.id
  movements.value = movements.value.slice() // 触发表格重渲染,展示「处理中」状态
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
  <div>
    <FaPageHeader title="入库" class="mb-0">
      <template #description>
        采购入库走 Hono Command + post_goods_receipt RPC,事务化创建批次/余额/流水,幂等防重复
      </template>
    </FaPageHeader>
    <FaPageMain>
      <!-- 入库表单 -->
      <div class="mb-6 p-4 border rounded-lg">
        <div class="text-lg font-bold mb-3">
          入库登记
        </div>
        <div class="gap-x-8 gap-y-3 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
          <FaLabel label="仓库" class="col-span-1">
            <FaSelect
              v-model="form.warehouseId"
              placeholder="选择仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
            />
          </FaLabel>
          <FaLabel label="商品" class="col-span-1">
            <BusinessCatalogItemPicker v-model="form.catalogItemId" placeholder="搜索选择服务/药品" />
          </FaLabel>
          <FaLabel label="批次号" class="col-span-1">
            <FaInput
              v-model="form.batchNo"
              placeholder="批次号(可选)"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="数量" class="col-span-1">
            <FaInputNumber
              v-model="form.quantity"
              :min="1"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="单位成本" class="col-span-1">
            <FaInputNumber
              v-model="form.unitCost"
              :min="0"
              :precision="2"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="失效日期" class="col-span-1">
            <FaInput
              v-model="form.expiryDate"
              type="date"
              placeholder="失效日期(可选)"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="供应商" class="col-span-1">
            <FaInput
              v-model="form.supplier"
              placeholder="供应商(可选)"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="参考单号" class="col-span-1">
            <FaInput
              v-model="form.referenceId"
              placeholder="采购单号(可选)"
              class="w-full"
            />
          </FaLabel>
        </div>
        <div class="mt-4 flex gap-2">
          <FaButton type="primary" :loading="submitting" @click="onSubmit">
            <FaIcon name="i-ri:archive-add-line" />
            确认入库
          </FaButton>
        </div>
      </div>

      <!-- 预留操作(挂单/下单冻结库存,MXQ-9008) -->
      <div v-if="auth(INVENTORY_PERMISSIONS.reserve)" class="mb-6 p-4 border rounded-lg">
        <div class="text-lg font-bold mb-3">
          预留冻结库存
        </div>
        <div class="gap-x-8 gap-y-3 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
          <FaLabel label="商品" class="col-span-1">
            <FaInput
              v-model="reserveForm.catalogItemId"
              placeholder="点击余额表「预留」自动填充"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="数量" class="col-span-1">
            <FaInputNumber
              v-model="reserveForm.quantity"
              :min="1"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="参考类型" class="col-span-1">
            <FaInput
              v-model="reserveForm.referenceType"
              placeholder="挂单/订单(可选)"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="参考单号" class="col-span-1">
            <FaInput
              v-model="reserveForm.referenceId"
              placeholder="挂单号/订单号(可选)"
              class="w-full"
            />
          </FaLabel>
        </div>
        <div class="mt-4 flex gap-3 items-center">
          <FaButton type="primary" :loading="reserving" @click="onReserve">
            <FaIcon name="i-ri:lock-line" />
            确认预留
          </FaButton>
          <span class="text-xs text-gray-500">可用量 = 在库量 - 预占量;预留成功后可在流水表对该行执行「确认」或「释放」</span>
        </div>
      </div>

      <!-- 余额列表 -->
      <div class="mb-6">
        <div class="mb-2 flex gap-2 items-center">
          <FaIcon name="i-ri:store-2-line" />
          <span class="text-lg font-bold">库存余额</span>
        </div>
        <FaTable
          v-loading="loading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="balanceColumns"
          :data="balances"
        />
      </div>

      <!-- 最近流水 -->
      <div>
        <div class="mb-2 flex gap-2 items-center">
          <FaIcon name="i-ri:list-check" />
          <span class="text-lg font-bold">最近流水</span>
          <FaTag variant="outline" size="sm">
            预留流水可确认/释放
          </FaTag>
        </div>
        <FaTable
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="movementColumns"
          :data="movements"
        />
      </div>
    </FaPageMain>
  </div>
</template>
