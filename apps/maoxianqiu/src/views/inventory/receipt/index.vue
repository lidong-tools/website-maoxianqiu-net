<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { GoodsReceiptItemRow, GoodsReceiptRow } from '@/api/modules/inventory'
import type { GoodsReceipt, InventoryBalance, InventoryMovement, Warehouse } from '@/types/inventory'
import { FaButton } from '@fantastic-admin/components'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { GOODS_RECEIPT_STATUS_LABELS, INVENTORY_PERMISSIONS, MOVEMENT_TYPE_LABELS } from '@/types/inventory'

defineOptions({
  name: 'InventoryReceipt',
})

const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()
const loading = ref(false)
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

/** 入库单状态标签样式 */
function grStatusClass(status: GoodsReceipt['status']): string[] {
  const base = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs'
  const map: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    submitted: 'bg-blue-500/10 text-blue-600',
    approved: 'bg-cyan-500/10 text-cyan-600',
    posted: 'bg-green-500/10 text-green-600',
    cancelled: 'bg-red-500/10 text-red-600',
  }
  return [base, map[status] ?? 'bg-muted text-muted-foreground']
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

// ===== 入库单(R-1/R-2/R-3):草稿 → 提交 → 审核 → 过账 =====
const grList = ref<GoodsReceiptRow[]>([])
const grLoading = ref(false)
const grKeyword = ref('')
const grStatusFilter = ref('')
const grPage = ref(1)
const grPageSize = ref(20)

const grColumns = computed<TableColumn<GoodsReceiptRow>[]>(() => [
  {
    accessorKey: 'gr_no',
    header: '入库单号',
    cell: (info: any) => {
      const row = info.row.original as GoodsReceiptRow
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-sm font-medium' }, row.gr_no),
        h('div', { class: 'text-xs text-muted-foreground' }, embedName(row.stores)),
      ])
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const status = info.getValue() as GoodsReceipt['status']
      return h('span', { class: grStatusClass(status) }, GOODS_RECEIPT_STATUS_LABELS[status] ?? status)
    },
  },
  { accessorKey: 'warehouses', header: '仓库', cell: (info: any) => embedName(info.getValue()) },
  { accessorKey: 'supplier', header: '供应商', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'total_cost',
    header: '金额',
    cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  { accessorKey: 'created_at', header: '创建时间', cell: (info: any) => info.getValue()?.slice(0, 16).replace('T', ' ') },
  {
    id: 'operation',
    header: '操作',
    width: 90,
    align: 'center',
    fixed: 'right',
  },
])

/** 状态 + 关键词(单号/供应商)过滤入库单 */
const filteredGrList = computed(() => {
  const kw = grKeyword.value.trim().toLowerCase()
  return grList.value.filter((row) => {
    if (grStatusFilter.value && row.status !== grStatusFilter.value) {
      return false
    }
    if (!kw) {
      return true
    }
    return [row.gr_no, row.supplier ?? '']
      .some(v => v.toLowerCase().includes(kw))
  })
})

/** 当前分页的入库单(前端分页) */
const pagedGrList = computed(() => {
  const start = (grPage.value - 1) * grPageSize.value
  return filteredGrList.value.slice(start, start + grPageSize.value)
})

watch(filteredGrList, () => {
  const maxPage = Math.max(1, Math.ceil(filteredGrList.value.length / grPageSize.value))
  if (grPage.value > maxPage) {
    grPage.value = maxPage
  }
})

async function loadGoodsReceipts() {
  if (!tenantStore.currentStoreId) {
    grList.value = []
    return
  }
  grLoading.value = true
  try {
    grList.value = await apiInventory.listGoodsReceipts(tenantStore.currentStoreId)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载入库单失败')
  }
  finally {
    grLoading.value = false
  }
}

// ===== 入库单详情抽屉 =====
const grDetailVisible = ref(false)
const grDetailLoading = ref(false)
const grDetail = ref<GoodsReceiptRow | null>(null)
const grDetailItems = ref<GoodsReceiptItemRow[]>([])
const grActionLoading = ref(false)

const grDescriptions = computed(() => grDetail.value
  ? [
      { label: '入库单号', value: grDetail.value.gr_no },
      { label: '门店', value: embedName(grDetail.value.stores) },
      { label: '仓库', value: embedName(grDetail.value.warehouses) },
      { label: '供应商', value: grDetail.value.supplier ?? '-' },
      { label: '金额', value: `¥${Number(grDetail.value.total_cost).toFixed(2)}` },
      { label: '备注', value: grDetail.value.note ?? '-' },
    ]
  : [])

/** 入库单状态时间线(仅展示已发生/当前节点) */
const grTimeline = computed(() => {
  const gr = grDetail.value
  if (!gr) {
    return []
  }
  const steps: Array<{ label: string, at: string, active: boolean }> = [
    { label: '草稿', at: gr.created_at, active: true },
    { label: '待审核', at: gr.submitted_at ?? '', active: gr.status !== 'draft' },
    { label: '已审核', at: gr.approved_at ?? '', active: ['approved', 'posted'].includes(gr.status) },
    { label: '已过账', at: gr.posted_at ?? '', active: gr.status === 'posted' },
  ]
  if (gr.status === 'cancelled') {
    return [{ label: '已取消', at: gr.cancelled_at ?? '', active: true }]
  }
  return steps
})

const grItemColumns = computed<TableColumn<GoodsReceiptItemRow>[]>(() => [
  { id: 'catalog', header: '商品', cell: (info: any) => nameOf((info.row.original as GoodsReceiptItemRow).catalog_item_id) },
  { accessorKey: 'quantity', header: '数量' },
  { accessorKey: 'unit_cost', header: '单价', cell: (info: any) => `¥${Number(info.getValue()).toFixed(2)}` },
  {
    id: 'amount',
    header: '金额',
    cell: (info: any) => {
      const row = info.row.original as GoodsReceiptItemRow
      return `¥${(Number(row.quantity) * Number(row.unit_cost)).toFixed(2)}`
    },
  },
  { accessorKey: 'batch_no', header: '批次号', cell: (info: any) => info.getValue() ?? '-' },
  { accessorKey: 'expires_at', header: '失效日期', cell: (info: any) => info.getValue() ?? '-' },
])

async function openGrDetail(row: GoodsReceiptRow) {
  grDetail.value = row
  grDetailVisible.value = true
  grDetailLoading.value = true
  grDetailItems.value = []
  try {
    grDetailItems.value = await apiInventory.listGoodsReceiptItems(row.id)
    await enrichCatalog(grDetailItems.value)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载入库单明细失败')
  }
  finally {
    grDetailLoading.value = false
  }
}

async function reloadGrDetail() {
  if (!grDetail.value) {
    return
  }
  const rows = await apiInventory.listGoodsReceipts(grDetail.value.store_id)
  const found = rows.find(r => r.id === grDetail.value?.id) ?? null
  if (found) {
    grDetail.value = found
  }
  await loadGoodsReceipts()
}

// ===== 新建入库单草稿 =====
const grCreateVisible = ref(false)
const grCreateSubmitting = ref(false)
const grCreateForm = reactive({
  warehouseId: '',
  supplier: '',
  note: '',
})

interface GrCreateItem {
  catalogItemId: string
  quantity: number
  unitCost: number
  batchNo: string
  expiresAt: string
}

const grCreateItems = ref<GrCreateItem[]>([])

async function openGrCreate() {
  grCreateForm.warehouseId = ''
  grCreateForm.supplier = ''
  grCreateForm.note = ''
  grCreateItems.value = []
  try {
    const res = await apiInventory.listWarehouses(tenantStore.currentStoreId || undefined)
    warehouses.value = res.data.list
    if (warehouses.value.length > 0) {
      grCreateForm.warehouseId = warehouses.value[0].id
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载仓库失败')
  }
  grCreateVisible.value = true
}

function addGrItem() {
  grCreateItems.value.push({ catalogItemId: '', quantity: 1, unitCost: 0, batchNo: '', expiresAt: '' })
}

function removeGrItem(idx: number) {
  grCreateItems.value.splice(idx, 1)
}

const grCreateTotal = computed(() => grCreateItems.value.reduce((sum, i) => sum + i.quantity * i.unitCost, 0))

async function onGrCreateSubmit() {
  if (!grCreateForm.warehouseId) {
    useFaToast().warning('请选择仓库')
    return
  }
  if (grCreateItems.value.length === 0 || grCreateItems.value.some(i => !i.catalogItemId)) {
    useFaToast().warning('请添加至少一项有效入库明细')
    return
  }
  if (grCreateItems.value.some(i => i.quantity <= 0)) {
    useFaToast().warning('数量必须大于 0')
    return
  }
  grCreateSubmitting.value = true
  try {
    await apiInventory.createGoodsReceipt({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId,
      warehouseId: grCreateForm.warehouseId,
      supplier: grCreateForm.supplier.trim() || undefined,
      note: grCreateForm.note.trim() || undefined,
      items: grCreateItems.value.map(i => ({
        catalogItemId: i.catalogItemId,
        quantity: i.quantity,
        unitCost: i.unitCost,
        batchNo: i.batchNo || undefined,
        expiresAt: i.expiresAt || undefined,
      })),
    })
    useFaToast().success('入库单已创建(草稿)')
    grCreateVisible.value = false
    await loadGoodsReceipts()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    grCreateSubmitting.value = false
  }
}

// ===== 入库单流转:提交 / 审核 / 取消 / 过账 =====
const grConfirmVisible = ref(false)
const grConfirmAction = ref<'approve' | 'cancel'>('approve')
const grConfirmTitle = computed(() => grConfirmAction.value === 'approve' ? '审核入库单' : '取消入库单')
const grConfirmText = computed(() => grConfirmAction.value === 'approve' ? '确认通过该入库单审核?' : '确认取消该入库单?(取消后不可恢复)')

function openGrConfirm(action: 'approve' | 'cancel') {
  grConfirmAction.value = action
  grConfirmVisible.value = true
}

async function onGrConfirmSubmit() {
  if (!grDetail.value) {
    return
  }
  grActionLoading.value = true
  try {
    if (grConfirmAction.value === 'approve') {
      await apiInventory.approveGoodsReceipt({ tenantId: tenantStore.currentTenantId, grId: grDetail.value.id })
      useFaToast().success('已审核通过')
    }
    else {
      await apiInventory.cancelGoodsReceipt({ tenantId: tenantStore.currentTenantId, grId: grDetail.value.id })
      useFaToast().success('已取消')
    }
    grConfirmVisible.value = false
    await reloadGrDetail()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    grActionLoading.value = false
  }
}

async function onGrSubmit() {
  if (!grDetail.value) {
    return
  }
  grActionLoading.value = true
  try {
    await apiInventory.submitGoodsReceipt({ tenantId: tenantStore.currentTenantId, grId: grDetail.value.id })
    useFaToast().success('已提交审核')
    await reloadGrDetail()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    grActionLoading.value = false
  }
}

async function onGrPost() {
  if (!grDetail.value) {
    return
  }
  grActionLoading.value = true
  const idempotencyKey = generateIdempotencyKey()
  try {
    await apiInventory.postGoodsReceiptDoc({ tenantId: tenantStore.currentTenantId, grId: grDetail.value.id }, idempotencyKey)
    useFaToast().success('过账成功,库存已入库')
    await reloadGrDetail()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    grActionLoading.value = false
  }
}

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

// ===== 工具栏:筛选/搜索 + 前端分页(参考优惠券界面布局) =====
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)

/** 按关键词(商品名称/ID)过滤余额列表 */
const filteredBalances = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) {
    return balances.value
  }
  return balances.value.filter((row) => {
    const name = catalogNameMap.value[row.catalog_item_id] ?? ''
    return `${name} ${row.catalog_item_id}`.toLowerCase().includes(kw)
  })
})

/** 按关键词(商品名称/ID)过滤流水列表 */
const filteredMovements = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) {
    return movements.value
  }
  return movements.value.filter((row) => {
    const name = catalogNameMap.value[row.catalog_item_id] ?? ''
    return `${name} ${row.catalog_item_id}`.toLowerCase().includes(kw)
  })
})

/** 当前 tab 的过滤后条数 */
const tableTotal = computed(() => (activeTab.value === 'balance' ? filteredBalances.value.length : filteredMovements.value.length))

/** 当前分页的余额(前端分页) */
const pagedBalances = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredBalances.value.slice(start, start + pageSize.value)
})

/** 当前分页的流水(前端分页) */
const pagedMovements = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredMovements.value.slice(start, start + pageSize.value)
})

// 切 tab 或过滤变化时修正越界页码
watch(activeTab, () => {
  page.value = 1
})
watch([filteredBalances, filteredMovements], () => {
  const maxPage = Math.max(1, Math.ceil(tableTotal.value / pageSize.value))
  if (page.value > maxPage) {
    page.value = maxPage
  }
})

watch(() => form.warehouseId, () => {
  loadInventoryData()
})

// P1(审计 25):未保存内容保护 - 预留表单有用户输入时视为 dirty(仓库为自动选中项不计入)
const receiptGuard = usePageUnsavedGuard('inventory-receipt')
watch(reserveForm, () => {
  const rf = reserveForm
  receiptGuard.setDirty(
    !!rf.catalogItemId || rf.quantity !== 1 || !!rf.referenceType || !!rf.referenceId,
  )
}, { deep: true, immediate: true })

// P0-06:切店后清空仓库选择并按新门店重载
useStoreScopedPage({
  load: async () => {
    await loadWarehouses()
    await loadGoodsReceipts()
  },
  reset: () => {
    form.warehouseId = ''
  },
})

onMounted(async () => {
  await loadWarehouses()
  await loadGoodsReceipts()
})
</script>

<template>
  <!-- 绝对定位占满父容器,与回访任务等列表页保持内容区高度一致 -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 工具栏:左筛选/搜索,右功能按钮 -->
        <div class="px-4 pt-3 border-b">
          <div class="pb-3 flex items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaSelect
                v-model="form.warehouseId"
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
              <span v-if="activeTab === 'balance' || activeTab === 'movement'" class="text-sm text-muted-foreground">
                共 {{ tableTotal }} 条
              </span>
              <span v-else-if="activeTab === 'receipt'" class="text-sm text-muted-foreground">
                共 {{ filteredGrList.length }} 个入库单
              </span>
            </div>
            <FaButton size="sm" variant="outline" @click="loadInventoryData">
              <FaIcon name="i-lucide:refresh-cw" />
              刷新
            </FaButton>
          </div>
        </div>

        <!-- 页内 Tabs -->
        <div class="px-4 pt-1 border-b flex gap-1 items-center">
          <FaButton size="sm" :variant="activeTab === 'receipt' ? 'default' : 'ghost'" @click="activeTab = 'receipt'">
            入库单
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
          <!-- 入库单(单据流程:草稿 → 提交 → 审核 → 过账) -->
          <div v-if="activeTab === 'receipt'">
            <div class="mb-3 flex gap-2 items-center justify-between">
              <div class="flex gap-2 items-center">
                <FaSelect
                  v-model="grStatusFilter"
                  :options="[{ label: '全部状态', value: '' }, ...Object.entries(GOODS_RECEIPT_STATUS_LABELS).map(([value, label]) => ({ label, value }))]"
                  class="w-32"
                  @update:model-value="grPage = 1"
                />
                <FaInput
                  v-model="grKeyword"
                  placeholder="搜索单号/供应商"
                  clearable
                  class="w-48"
                  @update:model-value="grPage = 1"
                />
              </div>
              <FaButton v-if="auth(INVENTORY_PERMISSIONS.receive)" size="sm" @click="openGrCreate">
                <FaIcon name="i-lucide:plus" />
                新建入库单
              </FaButton>
            </div>
            <FaTable
              v-loading="grLoading"
              table-root-class="overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="grColumns"
              :data="pagedGrList"
              empty-text="暂无入库单"
              @row-click="openGrDetail"
            >
              <template #cell-operation="{ row }">
                <div class="flex-center">
                  <FaButton variant="outline" size="icon-sm" @click.stop="openGrDetail(row.original)">
                    <FaIcon name="i-ri:eye-line" />
                  </FaButton>
                </div>
              </template>
            </FaTable>
            <FaPagination
              :page="grPage"
              :size="grPageSize"
              :total="filteredGrList.length"
              class="mt-2"
              @page-change="p => { grPage = p }"
              @size-change="s => { grPageSize = s; grPage = 1 }"
            />
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
              table-root-class="overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="balanceColumns"
              :data="pagedBalances"
              empty-text="暂无余额"
            />
            <FaPagination
              :page="page"
              :size="pageSize"
              :total="filteredBalances.length"
              class="mt-2"
              @page-change="p => { page = p }"
              @size-change="s => { pageSize = s; page = 1 }"
            />
          </div>

          <!-- 最近流水 -->
          <div v-if="activeTab === 'movement'">
            <FaTable
              table-root-class="overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="movementColumns"
              :data="pagedMovements"
              empty-text="暂无流水"
            />
            <FaPagination
              :page="page"
              :size="pageSize"
              :total="filteredMovements.length"
              class="mt-2"
              @page-change="p => { page = p }"
              @size-change="s => { pageSize = s; page = 1 }"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 入库单详情 -->
    <FaDrawer v-model="grDetailVisible" :title="grDetail?.gr_no ?? '入库单详情'" width="720px" :footer="false">
      <template v-if="grDetail">
        <FaDescriptions :items="grDescriptions" label-width="88px" :column="2" />

        <div class="text-sm font-medium mb-2 mt-5">
          状态进度
        </div>
        <div class="p-4 border rounded-lg">
          <div class="flex flex-wrap gap-2 items-center">
            <template v-for="(step, idx) in grTimeline" :key="step.label">
              <div class="flex gap-2 items-center">
                <span class="rounded-full bg-green-500 inline-flex size-2" />
                <span class="text-xs">
                  {{ step.label }}
                  <span v-if="step.at" class="text-muted-foreground">
                    · {{ step.at.slice(0, 16).replace('T', ' ') }}
                  </span>
                </span>
              </div>
              <span v-if="idx < grTimeline.length - 1" class="text-xs text-muted-foreground">
                →
              </span>
            </template>
          </div>
        </div>

        <div class="text-sm font-medium mb-2 mt-5">
          入库明细
        </div>
        <div v-loading="grDetailLoading">
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="grItemColumns"
            :data="grDetailItems"
            empty-text="暂无明细"
          />
        </div>

        <!-- 状态流转操作 -->
        <div class="mt-5 pt-5 border-t flex flex-wrap gap-2 justify-end">
          <template v-if="grDetail.status === 'draft'">
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.receive)" :disabled="grActionLoading" @click="onGrSubmit">
              提交审核
            </FaButton>
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.receive)" :disabled="grActionLoading" variant="outline" class="text-red-600" @click="openGrConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="grDetail.status === 'submitted'">
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.receive)" :disabled="grActionLoading" @click="openGrConfirm('approve')">
              审核通过
            </FaButton>
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.receive)" :disabled="grActionLoading" variant="outline" class="text-red-600" @click="openGrConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="grDetail.status === 'approved'">
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.receive)" :disabled="grActionLoading" @click="onGrPost">
              过账入库
            </FaButton>
          </template>
        </div>
      </template>
    </FaDrawer>

    <!-- 新建入库单草稿 -->
    <FaModal v-model="grCreateVisible" title="新建入库单" :footer="false" :close-on-click-overlay="false" width="860px">
      <div class="py-2 space-y-4">
        <div class="gap-x-4 gap-y-3 grid grid-cols-3">
          <FaLabel label="仓库 *" class="block">
            <FaSelect
              v-model="grCreateForm.warehouseId"
              placeholder="选择仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
            />
          </FaLabel>
          <FaLabel label="供应商(可选)" class="block">
            <FaInput v-model="grCreateForm.supplier" placeholder="供应商名称(可选)" class="w-full" />
          </FaLabel>
          <FaLabel label="备注(可选)" class="block">
            <FaInput v-model="grCreateForm.note" placeholder="备注(可选)" class="w-full" />
          </FaLabel>
        </div>

        <div class="text-sm font-medium">
          入库明细
        </div>
        <div class="space-y-2">
          <div class="text-xs text-muted-foreground px-1 gap-2 grid grid-cols-12">
            <span class="col-span-3">商品</span>
            <span class="col-span-2">数量</span>
            <span class="col-span-2">单价</span>
            <span class="col-span-2">批次号</span>
            <span class="col-span-2">失效日期</span>
            <span class="col-span-1" />
          </div>
          <div v-for="(item, idx) in grCreateItems" :key="idx" class="gap-2 grid grid-cols-12 items-center">
            <div class="col-span-3">
              <BusinessCatalogItemPicker v-model="item.catalogItemId" placeholder="搜索选择商品" />
            </div>
            <div class="col-span-2">
              <FaInputNumber v-model="item.quantity" :min="1" class="w-full" />
            </div>
            <div class="col-span-2">
              <FaInputNumber v-model="item.unitCost" :min="0" :precision="2" class="w-full" />
            </div>
            <div class="col-span-2">
              <FaInput v-model="item.batchNo" placeholder="批次号(可选)" class="w-full" />
            </div>
            <div class="col-span-2">
              <FaInput v-model="item.expiresAt" type="date" class="w-full" />
            </div>
            <div class="flex col-span-1 justify-end">
              <FaButton size="sm" variant="ghost" @click="removeGrItem(idx)">
                <FaIcon name="i-lucide:trash-2" />
              </FaButton>
            </div>
          </div>
          <FaButton variant="outline" size="sm" @click="addGrItem">
            <FaIcon name="i-lucide:plus" />
            添加商品
          </FaButton>
        </div>

        <div class="pt-2 flex items-center justify-between">
          <span class="text-sm">
            合计:
            <span class="font-medium tabular-nums">¥{{ grCreateTotal.toFixed(2) }}</span>
          </span>
          <div class="flex gap-2">
            <FaButton variant="outline" @click="grCreateVisible = false">
              取消
            </FaButton>
            <FaButton :loading="grCreateSubmitting" @click="onGrCreateSubmit">
              创建草稿
            </FaButton>
          </div>
        </div>
      </div>
    </FaModal>

    <!-- 审核/取消确认 -->
    <FaModal v-model="grConfirmVisible" :title="grConfirmTitle" :footer="false" :close-on-click-overlay="false">
      <div class="py-3">
        <p class="text-sm text-muted-foreground">
          {{ grConfirmText }}
        </p>
        <div class="pt-4 flex gap-2 justify-end">
          <FaButton variant="outline" @click="grConfirmVisible = false">
            取消
          </FaButton>
          <FaButton :variant="grConfirmAction === 'cancel' ? 'destructive' : 'default'" :loading="grActionLoading" @click="onGrConfirmSubmit">
            确认
          </FaButton>
        </div>
      </div>
    </FaModal>
  </div>
</template>
