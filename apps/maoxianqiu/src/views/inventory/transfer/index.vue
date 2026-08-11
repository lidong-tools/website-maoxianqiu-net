<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { TransferItemRow, TransferRow } from '@/api/modules/inventory'
import type { TransferOrder, Warehouse } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { INVENTORY_PERMISSIONS, TRANSFER_STATUS_LABELS } from '@/types/inventory'

defineOptions({
  name: 'InventoryTransfer',
})

const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()
const loading = ref(false)
const list = ref<TransferRow[]>([])

const catalogNameMap = ref<Record<string, string>>({})
async function enrichCatalog(rows: Array<{ catalog_item_id: string }>) {
  const ids = [...new Set(rows.map(r => r.catalog_item_id).filter(Boolean))]
  if (!ids.length) {
    return
  }
  const { data } = await supabase.from('catalog_items').select('id, name').in('id', ids)
  data?.forEach((c: any) => {
    catalogNameMap.value[c.id] = c.name
  })
}
function nameOf(id: string | null | undefined): string {
  if (!id) {
    return '-'
  }
  return catalogNameMap.value[id] ?? id.slice(0, 8)
}

/** 归一化内嵌字段(PostgREST to-one 返回单对象;类型推断可能为数组) */
function embedName(v: unknown): string {
  if (Array.isArray(v)) {
    return (v[0] as { name?: string } | undefined)?.name ?? '-'
  }
  return (v as { name?: string } | null)?.name ?? '-'
}

/** 调拨单状态标签样式 */
function tfStatusClass(status: TransferOrder['status']): string[] {
  const base = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs'
  const map: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    submitted: 'bg-blue-500/10 text-blue-600',
    approved: 'bg-cyan-500/10 text-cyan-600',
    outbound: 'bg-amber-500/10 text-amber-600',
    partially_received: 'bg-orange-500/10 text-orange-600',
    received: 'bg-green-500/10 text-green-600',
    cancelled: 'bg-red-500/10 text-red-600',
  }
  return [base, map[status] ?? 'bg-muted text-muted-foreground']
}

const columns = computed<TableColumn<TransferRow>[]>(() => [
  {
    accessorKey: 'transfer_no',
    header: '调拨单号',
    cell: (info: any) => {
      const row = info.row.original as TransferRow
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-sm font-medium' }, row.transfer_no),
        h('div', { class: 'text-xs text-muted-foreground' }, embedName(row.stores)),
      ])
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const status = info.getValue() as TransferOrder['status']
      return h('span', { class: tfStatusClass(status) }, TRANSFER_STATUS_LABELS[status] ?? status)
    },
  },
  { accessorKey: 'from_warehouses', header: '源仓库', cell: (info: any) => embedName(info.getValue()) },
  { accessorKey: 'to_warehouses', header: '目标仓库', cell: (info: any) => embedName(info.getValue()) },
  { accessorKey: 'created_at', header: '创建时间', cell: (info: any) => info.getValue()?.slice(0, 16).replace('T', ' ') },
  {
    id: 'operation',
    header: '操作',
    width: 90,
    align: 'center',
    fixed: 'right',
  },
])

async function loadList() {
  if (!tenantStore.currentStoreId) {
    list.value = []
    return
  }
  loading.value = true
  try {
    list.value = await apiInventory.listTransfers(tenantStore.currentStoreId)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载调拨单失败')
  }
  finally {
    loading.value = false
  }
}

// 门店作用域:切店后清空并重载
useStoreScopedPage({
  load: loadList,
  reset: () => {
    list.value = []
  },
})

onMounted(loadList)

const keyword = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)

/** 状态 + 关键词(单号)过滤调拨单 */
const filteredList = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return list.value.filter((row) => {
    if (statusFilter.value && row.status !== statusFilter.value) {
      return false
    }
    if (!kw) {
      return true
    }
    return row.transfer_no.toLowerCase().includes(kw)
  })
})
/** 当前分页的调拨单(前端分页) */
const pagedList = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredList.value.slice(start, start + pageSize.value)
})
// 过滤条件变化时修正越界页码
watch(filteredList, () => {
  const maxPage = Math.max(1, Math.ceil(filteredList.value.length / pageSize.value))
  if (page.value > maxPage) {
    page.value = maxPage
  }
})

// ===== 详情抽屉 =====
const detailVisible = ref(false)
const detailLoading = ref(false)
const detail = ref<TransferRow | null>(null)
const detailItems = ref<TransferItemRow[]>([])
const actionLoading = ref(false)

const detailDescriptions = computed(() => detail.value
  ? [
      { label: '调拨单号', value: detail.value.transfer_no },
      { label: '门店', value: embedName(detail.value.stores) },
      { label: '源仓库', value: embedName(detail.value.from_warehouses) },
      { label: '目标仓库', value: embedName(detail.value.to_warehouses) },
      { label: '备注', value: detail.value.note ?? '-' },
    ]
  : [])

/** 调拨单状态时间线(仅展示已发生/当前节点) */
const timeline = computed(() => {
  const tf = detail.value
  if (!tf) {
    return []
  }
  const steps: Array<{ label: string, at: string, active: boolean }> = [
    { label: '草稿', at: tf.created_at, active: true },
    { label: '待审核', at: tf.submitted_at ?? '', active: tf.status !== 'draft' },
    { label: '已审核', at: tf.approved_at ?? '', active: ['approved', 'outbound', 'partially_received', 'received'].includes(tf.status) },
    { label: '已发货', at: tf.shipped_at ?? '', active: ['outbound', 'partially_received', 'received'].includes(tf.status) },
    { label: '已收货', at: tf.received_at ?? '', active: tf.status === 'received' },
  ]
  if (tf.status === 'cancelled') {
    return [{ label: '已取消', at: tf.cancelled_at ?? '', active: true }]
  }
  return steps
})

const itemColumns = computed<TableColumn<TransferItemRow>[]>(() => [
  { id: 'catalog', header: '商品', cell: (info: any) => nameOf((info.row.original as TransferItemRow).catalog_item_id) },
  { accessorKey: 'quantity', header: '调拨数量' },
  { accessorKey: 'shipped_qty', header: '已发数量' },
  { accessorKey: 'received_qty', header: '已收数量' },
  { accessorKey: 'batch_no', header: '批次号', cell: (info: any) => info.getValue() ?? '-' },
  { accessorKey: 'expires_at', header: '失效日期', cell: (info: any) => info.getValue() ?? '-' },
])

async function openDetail(row: TransferRow) {
  detail.value = row
  detailVisible.value = true
  detailLoading.value = true
  detailItems.value = []
  try {
    detailItems.value = await apiInventory.listTransferItems(row.id)
    await enrichCatalog(detailItems.value)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载调拨明细失败')
  }
  finally {
    detailLoading.value = false
  }
}

async function reloadDetail() {
  if (!detail.value) {
    return
  }
  const rows = await apiInventory.listTransfers(detail.value.store_id)
  const found = rows.find(r => r.id === detail.value?.id) ?? null
  if (found) {
    detail.value = found
  }
  await loadList()
}

// ===== 新建调拨单草稿 =====
const createVisible = ref(false)
const createSubmitting = ref(false)
const warehouses = ref<Warehouse[]>([])
const createForm = reactive({
  fromWarehouseId: '',
  toWarehouseId: '',
  note: '',
})

interface TfCreateItem {
  catalogItemId: string
  quantity: number
}

const createItems = ref<TfCreateItem[]>([])
const createTotalQuantity = computed(() => createItems.value.reduce((sum, i) => sum + Number(i.quantity || 0), 0))

async function openCreate() {
  createForm.fromWarehouseId = ''
  createForm.toWarehouseId = ''
  createForm.note = ''
  createItems.value = []
  try {
    const res = await apiInventory.listWarehouses(tenantStore.currentStoreId || undefined)
    warehouses.value = res.data.list
    if (warehouses.value.length > 0) {
      createForm.fromWarehouseId = warehouses.value[0].id
    }
    if (warehouses.value.length > 1) {
      createForm.toWarehouseId = warehouses.value[1].id
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载仓库失败')
  }
  createVisible.value = true
}

function addTfItem() {
  createItems.value.push({ catalogItemId: '', quantity: 1 })
}

function removeTfItem(idx: number) {
  createItems.value.splice(idx, 1)
}

async function onCreateSubmit() {
  if (!createForm.fromWarehouseId) {
    useFaToast().warning('请选择源仓库')
    return
  }
  if (!createForm.toWarehouseId) {
    useFaToast().warning('请选择目标仓库')
    return
  }
  if (createForm.fromWarehouseId === createForm.toWarehouseId) {
    useFaToast().warning('源仓库与目标仓库不能相同')
    return
  }
  if (createItems.value.length === 0 || createItems.value.some(i => !i.catalogItemId)) {
    useFaToast().warning('请添加至少一项有效调拨明细')
    return
  }
  if (createItems.value.some(i => Number(i.quantity) <= 0)) {
    useFaToast().warning('调拨数量必须大于 0')
    return
  }
  createSubmitting.value = true
  try {
    await apiInventory.createTransfer({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId,
      fromWarehouseId: createForm.fromWarehouseId,
      toWarehouseId: createForm.toWarehouseId,
      note: createForm.note.trim() || undefined,
      items: createItems.value.map(i => ({
        catalogItemId: i.catalogItemId,
        quantity: Number(i.quantity),
      })),
    })
    useFaToast().success('调拨单已创建(草稿)')
    createVisible.value = false
    await loadList()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    createSubmitting.value = false
  }
}

// ===== 调拨单流转:提交 / 审核 / 取消 / 发货 =====
const confirmVisible = ref(false)
const confirmAction = ref<'approve' | 'cancel' | 'ship'>('approve')
const confirmTitle = computed(() => {
  const map = { approve: '审核调拨单', cancel: '取消调拨单', ship: '发货' } as const
  return map[confirmAction.value]
})
const confirmText = computed(() => {
  const map = {
    approve: '确认通过该调拨单审核?',
    cancel: '确认取消该调拨单?(取消后不可恢复)',
    ship: '发货将按 FEFO 从源仓库扣减库存并生成调拨流水,确认发货?',
  } as const
  return map[confirmAction.value]
})

function openConfirm(action: 'approve' | 'cancel' | 'ship') {
  confirmAction.value = action
  confirmVisible.value = true
}

async function onConfirmSubmit() {
  if (!detail.value) {
    return
  }
  actionLoading.value = true
  try {
    if (confirmAction.value === 'approve') {
      await apiInventory.approveTransfer({ tenantId: tenantStore.currentTenantId, transferId: detail.value.id })
      useFaToast().success('已审核通过')
    }
    else if (confirmAction.value === 'cancel') {
      await apiInventory.cancelTransfer({ tenantId: tenantStore.currentTenantId, transferId: detail.value.id })
      useFaToast().success('已取消')
    }
    else {
      await apiInventory.shipTransfer({ tenantId: tenantStore.currentTenantId, transferId: detail.value.id }, generateIdempotencyKey())
      useFaToast().success('发货成功,源仓库库存已扣减')
    }
    confirmVisible.value = false
    await reloadDetail()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    actionLoading.value = false
  }
}

async function onSubmit() {
  if (!detail.value) {
    return
  }
  actionLoading.value = true
  try {
    await apiInventory.submitTransfer({ tenantId: tenantStore.currentTenantId, transferId: detail.value.id })
    useFaToast().success('已提交审核')
    await reloadDetail()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    actionLoading.value = false
  }
}

// ===== 收货(outbound / partially_received):按明细录入实收 =====
const receiveVisible = ref(false)
const receiveSubmitting = ref(false)

interface TfReceiveRow {
  id: string
  catalogItemId: string
  shippedQty: number
  receivedQty: number
  remaining: number
  receivedQuantity: number
  batchNo: string
  expiresAt: string
}

const receiveRows = ref<TfReceiveRow[]>([])

/** 打开收货弹窗:预填剩余应收数量,批次/失效日期可选 */
function openReceive() {
  receiveRows.value = detailItems.value.map((item) => {
    const remaining = Math.max(0, Number(item.shipped_qty) - Number(item.received_qty))
    return {
      id: item.id,
      catalogItemId: item.catalog_item_id,
      shippedQty: Number(item.shipped_qty),
      receivedQty: Number(item.received_qty),
      remaining,
      receivedQuantity: remaining,
      batchNo: item.batch_no ?? '',
      expiresAt: item.expires_at ?? '',
    }
  }).filter(row => row.remaining > 0)
  receiveVisible.value = true
}

async function onReceiveSubmit() {
  if (!detail.value) {
    return
  }
  const items = receiveRows.value.filter(row => Number(row.receivedQuantity) > 0)
  if (items.length === 0) {
    useFaToast().warning('请至少录入一项实收数量')
    return
  }
  if (items.some(row => Number(row.receivedQuantity) > row.remaining)) {
    useFaToast().warning('实收数量不能超过剩余应收数量')
    return
  }
  receiveSubmitting.value = true
  try {
    await apiInventory.receiveTransfer({
      tenantId: tenantStore.currentTenantId,
      transferId: detail.value.id,
      items: items.map(row => ({
        id: row.id,
        receivedQuantity: Number(row.receivedQuantity),
        batchNo: row.batchNo.trim() || undefined,
        expiresAt: row.expiresAt || undefined,
      })),
    }, generateIdempotencyKey())
    useFaToast().success('收货成功,目标仓库库存已入库')
    receiveVisible.value = false
    await reloadDetail()
    if (detail.value) {
      await openDetail(detail.value)
    }
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    receiveSubmitting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 工具栏:左筛选/搜索,右功能按钮 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 flex items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaSelect
                v-model="statusFilter"
                :options="[{ label: '全部状态', value: '' }, ...Object.entries(TRANSFER_STATUS_LABELS).map(([value, label]) => ({ label, value }))]"
                class="w-32"
                @update:model-value="page = 1"
              />
              <FaInput
                v-model="keyword"
                placeholder="搜索调拨单号"
                clearable
                class="w-48"
                @update:model-value="page = 1"
              />
              <span class="text-sm text-muted-foreground">
                共 {{ filteredList.length }} 个调拨单
              </span>
            </div>
            <div class="flex gap-2">
              <FaButton v-if="auth(INVENTORY_PERMISSIONS.transfer)" @click="openCreate">
                <FaIcon name="i-lucide:plus" />
                新建调拨单
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
            row-key="id"
            stripe
            border
            :columns="columns"
            :data="pagedList"
            empty-text="暂无调拨单"
            @row-click="openDetail"
          >
            <template #cell-operation="{ row }">
              <div class="flex-center">
                <FaButton variant="outline" size="icon-sm" @click.stop="openDetail(row.original)">
                  <FaIcon name="i-ri:eye-line" />
                </FaButton>
              </div>
            </template>
          </FaTable>
        </div>
        <!-- 分页区 -->
        <FaPagination
          :page="page"
          :size="pageSize"
          :total="filteredList.length"
          class="mt-2 px-4 pb-3 shrink-0"
          @page-change="p => { page = p }"
          @size-change="s => { pageSize = s; page = 1 }"
        />
      </div>
    </div>

    <!-- 调拨单详情 -->
    <FaDrawer v-model="detailVisible" :title="detail?.transfer_no ?? '调拨单详情'" width="860px" :footer="false">
      <template v-if="detail">
        <FaDescriptions :items="detailDescriptions" label-width="88px" :column="2" />

        <div class="text-sm font-medium mb-2 mt-5">
          状态进度
        </div>
        <div class="p-4 border rounded-lg">
          <div class="flex flex-wrap gap-2 items-center">
            <template v-for="(step, idx) in timeline" :key="step.label">
              <div class="flex gap-2 items-center">
                <span class="rounded-full bg-green-500 inline-flex size-2" />
                <span class="text-xs">
                  {{ step.label }}
                  <span v-if="step.at" class="text-muted-foreground">
                    · {{ step.at.slice(0, 16).replace('T', ' ') }}
                  </span>
                </span>
              </div>
              <span v-if="idx < timeline.length - 1" class="text-xs text-muted-foreground">
                →
              </span>
            </template>
          </div>
        </div>

        <div class="text-sm font-medium mb-2 mt-5">
          调拨明细
        </div>
        <div v-loading="detailLoading">
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="itemColumns"
            :data="detailItems"
            empty-text="暂无明细"
          />
        </div>

        <!-- 状态流转操作 -->
        <div class="mt-5 pt-5 border-t flex flex-wrap gap-2 justify-end">
          <template v-if="detail.status === 'draft'">
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.transfer)" :disabled="actionLoading" @click="onSubmit">
              提交审核
            </FaButton>
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.transfer)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="detail.status === 'submitted'">
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.transfer)" :disabled="actionLoading" @click="openConfirm('approve')">
              审核通过
            </FaButton>
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.transfer)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="detail.status === 'approved'">
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.transfer)" :disabled="actionLoading" @click="openConfirm('ship')">
              发货
            </FaButton>
          </template>
          <template v-else-if="detail.status === 'outbound' || detail.status === 'partially_received'">
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.transfer)" :disabled="actionLoading" @click="openReceive">
              {{ detail.status === 'partially_received' ? '继续收货' : '收货' }}
            </FaButton>
          </template>
        </div>
      </template>
    </FaDrawer>

    <!-- 新建调拨单草稿 -->
    <FaModal v-model="createVisible" title="新建调拨单" :footer="false" :close-on-click-overlay="false" width="860px">
      <div class="py-2 space-y-4">
        <div class="gap-x-4 gap-y-3 grid grid-cols-3">
          <FaLabel label="源仓库 *" class="block">
            <FaSelect
              v-model="createForm.fromWarehouseId"
              placeholder="选择源仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
            />
          </FaLabel>
          <FaLabel label="目标仓库 *" class="block">
            <FaSelect
              v-model="createForm.toWarehouseId"
              placeholder="选择目标仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
            />
          </FaLabel>
          <FaLabel label="备注(可选)" class="block">
            <FaInput v-model="createForm.note" placeholder="备注(可选)" class="w-full" />
          </FaLabel>
        </div>

        <div class="text-sm font-medium">
          调拨明细
        </div>
        <div class="space-y-2">
          <div class="text-xs text-muted-foreground px-1 gap-2 grid grid-cols-12">
            <span class="col-span-8">商品</span>
            <span class="col-span-3">数量</span>
            <span class="col-span-1" />
          </div>
          <div v-for="(item, idx) in createItems" :key="idx" class="gap-2 grid grid-cols-12 items-center">
            <div class="col-span-8">
              <BusinessCatalogItemPicker v-model="item.catalogItemId" placeholder="搜索选择商品" />
            </div>
            <div class="col-span-3">
              <FaInputNumber v-model="item.quantity" :min="1" class="w-full" />
            </div>
            <div class="flex col-span-1 justify-end">
              <FaButton size="sm" variant="ghost" @click="removeTfItem(idx)">
                <FaIcon name="i-lucide:trash-2" />
              </FaButton>
            </div>
          </div>
          <FaButton variant="outline" size="sm" @click="addTfItem">
            <FaIcon name="i-lucide:plus" />
            添加商品
          </FaButton>
        </div>

        <div class="pt-2 flex items-center justify-between">
          <span class="text-sm">
            合计:
            <span class="font-medium tabular-nums">{{ createTotalQuantity }}</span>
            件
          </span>
          <div class="flex gap-2">
            <FaButton variant="outline" @click="createVisible = false">
              取消
            </FaButton>
            <FaButton :loading="createSubmitting" @click="onCreateSubmit">
              创建草稿
            </FaButton>
          </div>
        </div>
      </div>
    </FaModal>

    <!-- 收货 -->
    <FaModal v-model="receiveVisible" title="调拨收货" :footer="false" :close-on-click-overlay="false" width="860px">
      <div class="py-2 space-y-4">
        <div class="text-xs text-muted-foreground px-1 gap-2 grid grid-cols-12">
          <span class="col-span-3">商品</span>
          <span class="col-span-1">应发</span>
          <span class="col-span-1">已收</span>
          <span class="col-span-2">实收数量 *</span>
          <span class="col-span-3">批次号(可选)</span>
          <span class="col-span-2">失效日期</span>
        </div>
        <div v-for="row in receiveRows" :key="row.id" class="gap-2 grid grid-cols-12 items-center">
          <span class="col-span-3 text-sm truncate">
            {{ nameOf(row.catalogItemId) }}
          </span>
          <span class="col-span-1 text-sm tabular-nums">
            {{ row.shippedQty }}
          </span>
          <span class="col-span-1 text-sm tabular-nums">
            {{ row.receivedQty }}
          </span>
          <div class="col-span-2">
            <FaInputNumber v-model="row.receivedQuantity" :min="0" :max="row.remaining" class="w-full" />
          </div>
          <div class="col-span-3">
            <FaInput v-model="row.batchNo" placeholder="批次号(可选)" class="w-full" />
          </div>
          <div class="col-span-2">
            <FaInput v-model="row.expiresAt" type="date" class="w-full" />
          </div>
        </div>

        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="receiveVisible = false">
            取消
          </FaButton>
          <FaButton :loading="receiveSubmitting" @click="onReceiveSubmit">
            确认收货
          </FaButton>
        </div>
      </div>
    </FaModal>

    <!-- 审核/取消/发货确认 -->
    <FaModal v-model="confirmVisible" :title="confirmTitle" :footer="false" :close-on-click-overlay="false">
      <div class="py-3">
        <p class="text-sm text-muted-foreground">
          {{ confirmText }}
        </p>
        <div class="pt-4 flex gap-2 justify-end">
          <FaButton variant="outline" @click="confirmVisible = false">
            取消
          </FaButton>
          <FaButton :variant="confirmAction === 'cancel' ? 'destructive' : 'default'" :loading="actionLoading" @click="onConfirmSubmit">
            确认
          </FaButton>
        </div>
      </div>
    </FaModal>
  </div>
</template>
