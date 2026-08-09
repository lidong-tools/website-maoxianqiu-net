<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { PurchaseOrderRow } from '@/api/modules/inventory'
import type { PurchaseOrder, PurchaseOrderItem, PurchaseOrderItemInput, Supplier, Warehouse } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { PURCHASE_ORDER_STATUS_LABELS, PURCHASE_PERMISSIONS } from '@/types/inventory'

defineOptions({
  name: 'InventoryPurchasing',
})

const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()

const loading = ref(false)
const list = ref<PurchaseOrderRow[]>([])

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

const columns = computed<TableColumn<PurchaseOrderRow>[]>(() => [
  {
    accessorKey: 'po_no',
    header: '采购单号',
    cell: (info: any) => {
      const row = info.row.original as PurchaseOrderRow
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-sm font-medium' }, row.po_no),
        h('div', { class: 'text-xs text-muted-foreground' }, row.stores?.name ?? '-'),
      ])
    },
  },
  {
    accessorKey: 'suppliers',
    header: '供应商',
    cell: (info: any) => embedName(info.getValue()),
  },
  {
    accessorKey: 'warehouses',
    header: '仓库',
    cell: (info: any) => embedName(info.getValue()),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const status = info.getValue() as PurchaseOrder['status']
      return h('span', {
        class: statusLabelClass(status),
      }, PURCHASE_ORDER_STATUS_LABELS[status] ?? status)
    },
  },
  {
    accessorKey: 'total_cost',
    header: '金额',
    cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  { accessorKey: 'expected_at', header: '预计到货', cell: (info: any) => info.getValue() ?? '-' },
  { accessorKey: 'created_at', header: '创建时间', cell: (info: any) => info.getValue()?.slice(0, 16).replace('T', ' ') },
  {
    id: 'operation',
    header: '操作',
    width: 90,
    align: 'center',
    fixed: 'right',
  },
])

function statusLabelClass(status: PurchaseOrder['status']): string[] {
  const base = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs'
  const map: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    submitted: 'bg-blue-500/10 text-blue-600',
    approved: 'bg-cyan-500/10 text-cyan-600',
    received: 'bg-amber-500/10 text-amber-600',
    posted: 'bg-green-500/10 text-green-600',
    cancelled: 'bg-red-500/10 text-red-600',
  }
  return [base, map[status] ?? 'bg-muted text-muted-foreground']
}

async function loadList() {
  if (!tenantStore.currentStoreId) {
    list.value = []
    return
  }
  loading.value = true
  try {
    list.value = await apiInventory.listPurchaseOrders(tenantStore.currentStoreId)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载采购单失败')
  }
  finally {
    loading.value = false
  }
}

const keyword = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)

/** 状态 + 关键词(单号/供应商)过滤采购单 */
const filteredList = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return list.value.filter((row) => {
    if (statusFilter.value && row.status !== statusFilter.value) {
      return false
    }
    if (!kw) {
      return true
    }
    return [row.po_no, embedName(row.suppliers)]
      .some(v => (v ?? '').toLowerCase().includes(kw))
  })
})

/** 当前分页的采购单(前端分页) */
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

// 门店作用域:切店后清空并重载
useStoreScopedPage({
  load: loadList,
  reset: () => {
    list.value = []
  },
})

onMounted(loadList)

// ===== 详情抽屉 =====
const detailVisible = ref(false)
const detailLoading = ref(false)
const detailPo = ref<PurchaseOrderRow | null>(null)
const detailItems = ref<PurchaseOrderItem[]>([])
const actionLoading = ref(false)

const detailDescriptions = computed(() => detailPo.value
  ? [
      { label: '采购单号', value: detailPo.value.po_no },
      { label: '供应商', value: embedName(detailPo.value.suppliers) },
      { label: '仓库', value: embedName(detailPo.value.warehouses) },
      { label: '门店', value: embedName(detailPo.value.stores) },
      { label: '预计到货', value: detailPo.value.expected_at ?? '-' },
      { label: '金额', value: `¥${Number(detailPo.value.total_cost).toFixed(2)}` },
      { label: '备注', value: detailPo.value.note ?? '-' },
    ]
  : [])

/** 状态时间线节点(仅展示已发生/当前节点) */
const timeline = computed(() => {
  const po = detailPo.value
  if (!po) {
    return []
  }
  const steps: Array<{ label: string, at: string, active: boolean }> = [
    { label: '草稿', at: po.created_at, active: true },
    { label: '待审核', at: po.submitted_at ?? '', active: po.status !== 'draft' },
    { label: '已审核', at: po.approved_at ?? '', active: ['approved', 'received', 'posted'].includes(po.status) },
    { label: '已收货', at: po.received_at ?? '', active: ['received', 'posted'].includes(po.status) },
    { label: '已过账', at: po.posted_at ?? '', active: po.status === 'posted' },
  ]
  if (po.status === 'cancelled') {
    return [{ label: '已取消', at: po.cancelled_at ?? '', active: true }]
  }
  return steps
})

const itemColumns = computed<TableColumn<PurchaseOrderItem>[]>(() => [
  { id: 'catalog', header: '商品', cell: (info: any) => nameOf((info.row.original as PurchaseOrderItem).catalog_item_id) },
  { accessorKey: 'ordered_qty', header: '订购数量', cell: (info: any) => info.getValue() },
  { accessorKey: 'received_qty', header: '实收数量', cell: (info: any) => info.getValue() },
  { accessorKey: 'unit_cost', header: '采购价', cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}` },
  {
    id: 'amount',
    header: '金额',
    cell: (info: any) => {
      const row = info.row.original as PurchaseOrderItem
      return `¥${(Number(row.received_qty || row.ordered_qty) * Number(row.unit_cost)).toFixed(2)}`
    },
  },
  { accessorKey: 'batch_no', header: '批次', cell: (info: any) => info.getValue() ?? '-' },
  { accessorKey: 'expires_at', header: '效期', cell: (info: any) => info.getValue() ?? '-' },
])

async function openDetail(row: PurchaseOrderRow) {
  detailPo.value = row
  detailVisible.value = true
  detailLoading.value = true
  detailItems.value = []
  try {
    const items = await apiInventory.listPurchaseOrderItems(row.id)
    detailItems.value = items
    await enrichCatalog(items)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载采购明细失败')
  }
  finally {
    detailLoading.value = false
  }
}

async function reloadDetail() {
  if (!detailPo.value) {
    return
  }
  const [po, items] = await Promise.all([
    apiInventory.listPurchaseOrders(detailPo.value.store_id).then(rows => rows.find(r => r.id === detailPo.value?.id) ?? null),
    apiInventory.listPurchaseOrderItems(detailPo.value.id),
  ])
  if (po) {
    detailPo.value = po
  }
  detailItems.value = items
  await enrichCatalog(items)
  await loadList()
}

// ===== 新建采购单 =====
const createVisible = ref(false)
const createSubmitting = ref(false)
const warehouses = ref<Warehouse[]>([])
const suppliers = ref<Supplier[]>([])
const editingPoId = ref('')
const createForm = reactive({
  supplierId: '',
  warehouseId: '',
  expectedAt: '',
  note: '',
})
const createItems = ref<PurchaseOrderItemInput[]>([])

async function openCreate() {
  createForm.supplierId = ''
  createForm.warehouseId = ''
  createForm.expectedAt = ''
  createForm.note = ''
  createItems.value = []
  try {
    const [whRes, supRes] = await Promise.all([
      apiInventory.listWarehouses(tenantStore.currentStoreId || undefined),
      apiInventory.listSuppliers(tenantStore.currentTenantId),
    ])
    warehouses.value = whRes.data.list
    suppliers.value = supRes.filter(s => s.status === 'active')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载基础数据失败')
  }
  createVisible.value = true
}

function addItem() {
  createItems.value.push({ catalogItemId: '', orderedQty: 1, unitCost: 0 })
}
function removeItem(idx: number) {
  createItems.value.splice(idx, 1)
}

const createTotal = computed(() => createItems.value.reduce((sum, i) => sum + i.orderedQty * (i.unitCost ?? 0), 0))

// ===== 收货 =====
const receiveVisible = ref(false)
const receiveSubmitting = ref(false)
const receiveForm = ref<Array<{ id: string, orderedQty: number, receivedQty: number, batchNo: string, expiresAt: string }>>([])

// P1(审计 25):未保存内容保护 - 采购草稿/收货表单相对打开时快照有变化视为 dirty
const purchaseGuard = usePageUnsavedGuard('inventory-purchasing')
const purchaseBaseline = ref('')
const purchaseSig = () => JSON.stringify([createForm, createItems.value, receiveForm.value])
function refreshPurchaseDirty() {
  purchaseGuard.setDirty(purchaseSig() !== purchaseBaseline.value)
}
watch(createVisible, (v) => {
  if (v) {
    purchaseBaseline.value = purchaseSig()
  }
  else {
    purchaseGuard.setDirty(false)
  }
})
watch(receiveVisible, (v) => {
  if (v) {
    purchaseBaseline.value = purchaseSig()
  }
  else {
    purchaseGuard.setDirty(false)
  }
})
watch(purchaseSig, refreshPurchaseDirty)

function openReceive() {
  receiveForm.value = detailItems.value
    .filter(i => i.ordered_qty > 0)
    .map(i => ({
      id: i.id,
      orderedQty: Number(i.ordered_qty),
      receivedQty: Number(i.received_qty ?? 0),
      batchNo: i.batch_no ?? '',
      expiresAt: i.expires_at ?? '',
    }))
  receiveVisible.value = true
}

async function onReceiveSubmit() {
  const invalid = receiveForm.value.some(i => i.receivedQty < 0 || i.receivedQty > i.orderedQty)
  if (invalid) {
    useFaToast().warning('实收数量须在 0 与订购数量之间')
    return
  }
  if (!detailPo.value) {
    return
  }
  receiveSubmitting.value = true
  try {
    await apiInventory.receivePurchaseOrder({
      tenantId: tenantStore.currentTenantId,
      poId: detailPo.value.id,
      items: receiveForm.value.map(i => ({
        id: i.id,
        receivedQty: i.receivedQty,
        batchNo: i.batchNo.trim() || undefined,
        expiresAt: i.expiresAt || undefined,
      })),
    })
    useFaToast().success('收货成功')
    receiveVisible.value = false
    await reloadDetail()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    receiveSubmitting.value = false
  }
}

// ===== 提交 / 审核 / 取消 / 过账 =====
const confirmVisible = ref(false)
const confirmAction = ref<'approve' | 'cancel'>('approve')
const confirmTitle = computed(() => confirmAction.value === 'approve' ? '审核采购单' : '取消采购单')
const confirmText = computed(() => confirmAction.value === 'approve' ? '确认通过该采购单审核?' : '确认取消该采购单?(取消后不可恢复)')

function openConfirm(action: 'approve' | 'cancel') {
  confirmAction.value = action
  confirmVisible.value = true
}

async function onConfirmSubmit() {
  if (!detailPo.value) {
    return
  }
  actionLoading.value = true
  try {
    if (confirmAction.value === 'approve') {
      await apiInventory.approvePurchaseOrder({ tenantId: tenantStore.currentTenantId, poId: detailPo.value.id })
      useFaToast().success('已审核通过')
    }
    else {
      await apiInventory.cancelPurchaseOrder({ tenantId: tenantStore.currentTenantId, poId: detailPo.value.id })
      useFaToast().success('已取消')
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
  if (!detailPo.value) {
    return
  }
  actionLoading.value = true
  try {
    await apiInventory.submitPurchaseOrder({ tenantId: tenantStore.currentTenantId, poId: detailPo.value.id })
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

async function onEditDraft() {
  if (!detailPo.value) {
    return
  }
  const po = detailPo.value
  createForm.supplierId = po.supplier_id ?? ''
  createForm.warehouseId = po.warehouse_id
  createForm.expectedAt = po.expected_at ?? ''
  createForm.note = po.note ?? ''
  createItems.value = detailItems.value.map(i => ({
    catalogItemId: i.catalog_item_id,
    orderedQty: Number(i.ordered_qty),
    unitCost: Number(i.unit_cost),
  }))
  warehouses.value = []
  suppliers.value = []
  try {
    const [whRes, supRes] = await Promise.all([
      apiInventory.listWarehouses(tenantStore.currentStoreId || undefined),
      apiInventory.listSuppliers(tenantStore.currentTenantId),
    ])
    warehouses.value = whRes.data.list
    suppliers.value = supRes.filter(s => s.status === 'active')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载基础数据失败')
  }
  editingPoId.value = po.id
  createVisible.value = true
}

async function onCreateSubmitOrUpdate() {
  if (!createForm.supplierId) {
    useFaToast().warning('请选择供应商')
    return
  }
  if (!createForm.warehouseId) {
    useFaToast().warning('请选择仓库')
    return
  }
  if (createItems.value.length === 0 || createItems.value.some(i => !i.catalogItemId)) {
    useFaToast().warning('请添加至少一项有效商品')
    return
  }
  createSubmitting.value = true
  const payload = {
    tenantId: tenantStore.currentTenantId,
    warehouseId: createForm.warehouseId,
    supplierId: createForm.supplierId,
    expectedAt: createForm.expectedAt || undefined,
    note: createForm.note.trim() || undefined,
    items: createItems.value.map(i => ({ catalogItemId: i.catalogItemId, orderedQty: i.orderedQty, unitCost: i.unitCost ?? 0 })),
  }
  try {
    if (editingPoId.value) {
      await apiInventory.updatePurchaseOrderDraft({ ...payload, poId: editingPoId.value })
      useFaToast().success('草稿已更新')
    }
    else {
      await apiInventory.createPurchaseOrder({ ...payload, storeId: tenantStore.currentStoreId })
      useFaToast().success('采购单已创建(草稿)')
    }
    createVisible.value = false
    editingPoId.value = ''
    await loadList()
    if (detailVisible.value) {
      await reloadDetail()
    }
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    createSubmitting.value = false
  }
}

async function onPost() {
  if (!detailPo.value) {
    return
  }
  actionLoading.value = true
  const idempotencyKey = generateIdempotencyKey()
  try {
    await apiInventory.postPurchaseOrder({ tenantId: tenantStore.currentTenantId, poId: detailPo.value.id }, idempotencyKey)
    useFaToast().success('过账成功,库存已入库')
    await reloadDetail()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    actionLoading.value = false
  }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 注释掉标题和描述区域(参考优惠券界面布局) -->
    <!--
    <EntityPageHeader compact title="采购管理" description="供应商 → 草稿 → 提交 → 审核 → 收货 → 过账入库">
      <template #actions>
        <FaButton v-if="auth(PURCHASE_PERMISSIONS.create)" @click="openCreate">
          <FaIcon name="i-lucide:plus" />
          新建采购单
        </FaButton>
      </template>
    </EntityPageHeader>
    -->
    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <!-- 工具栏:左筛选/搜索,右功能按钮 -->
        <div class="px-4 pt-3 border-b">
          <div class="pb-3 flex items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaSelect
                v-model="statusFilter"
                :options="[{ label: '全部状态', value: '' }, ...Object.entries(PURCHASE_ORDER_STATUS_LABELS).map(([value, label]) => ({ label, value }))]"
                class="w-36"
                @update:model-value="page = 1"
              />
              <FaInput v-model="keyword" placeholder="搜索单号/供应商" clearable class="w-52" @update:model-value="page = 1" />
              <span class="text-sm text-muted-foreground">共 {{ filteredList.length }} 个采购单</span>
            </div>
            <div class="flex gap-2">
              <FaButton v-if="auth(PURCHASE_PERMISSIONS.create)" @click="openCreate">
                <FaIcon name="i-lucide:plus" />
                新建采购单
              </FaButton>
            </div>
          </div>
        </div>
        <!-- 表格区 -->
        <div class="flex-1 min-h-0 overflow-auto">
          <FaTable
            v-loading="loading"
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="columns"
            :data="pagedList"
            empty-text="暂无采购单"
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
          class="mt-2 px-4 pb-3"
          @page-change="p => { page = p }"
          @size-change="s => { pageSize = s; page = 1 }"
        />
      </div>
    </div>

    <!-- 采购详情 -->
    <FaDrawer v-model="detailVisible" :title="detailPo?.po_no ?? '采购详情'" width="720px" :footer="false">
      <template v-if="detailPo">
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
          采购明细
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
          <template v-if="detailPo.status === 'draft'">
            <FaButton v-if="auth(PURCHASE_PERMISSIONS.create)" :disabled="actionLoading" variant="outline" @click="onEditDraft">
              编辑草稿
            </FaButton>
            <FaButton v-if="auth(PURCHASE_PERMISSIONS.submit)" :disabled="actionLoading" @click="onSubmit">
              提交审核
            </FaButton>
            <FaButton v-if="auth(PURCHASE_PERMISSIONS.submit)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="detailPo.status === 'submitted'">
            <FaButton v-if="auth(PURCHASE_PERMISSIONS.approve)" :disabled="actionLoading" @click="openConfirm('approve')">
              审核通过
            </FaButton>
            <FaButton v-if="auth(PURCHASE_PERMISSIONS.submit)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="detailPo.status === 'approved'">
            <FaButton v-if="auth(PURCHASE_PERMISSIONS.receive)" :disabled="actionLoading" @click="openReceive">
              收货
            </FaButton>
          </template>
          <template v-else-if="detailPo.status === 'received'">
            <FaButton v-if="auth(PURCHASE_PERMISSIONS.receive)" :disabled="actionLoading" variant="outline" @click="openReceive">
              调整收货
            </FaButton>
            <FaButton v-if="auth(PURCHASE_PERMISSIONS.post)" :disabled="actionLoading" @click="onPost">
              过账入库
            </FaButton>
          </template>
        </div>
      </template>
    </FaDrawer>

    <!-- 新建/编辑草稿 -->
    <FaModal v-model="createVisible" :title="editingPoId ? '编辑采购单' : '新建采购单'" :footer="false" :close-on-click-overlay="false" width="760px">
      <div class="py-2 space-y-4">
        <div class="gap-x-4 gap-y-3 grid grid-cols-3">
          <FaLabel label="供应商 *" class="block">
            <FaSelect
              v-model="createForm.supplierId"
              placeholder="选择供应商"
              class="w-full"
              :options="suppliers.map(s => ({ label: s.name, value: s.id }))"
            />
          </FaLabel>
          <FaLabel label="仓库 *" class="block">
            <FaSelect
              v-model="createForm.warehouseId"
              placeholder="选择仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
            />
          </FaLabel>
          <FaLabel label="预计到货" class="block">
            <FaInput v-model="createForm.expectedAt" type="date" class="w-full" />
          </FaLabel>
        </div>

        <div class="text-sm font-medium">
          采购明细
        </div>
        <div class="space-y-2">
          <div class="text-xs text-muted-foreground px-1 gap-2 grid grid-cols-12">
            <span class="col-span-5">商品</span>
            <span class="col-span-2">订购数量</span>
            <span class="col-span-2">采购价</span>
            <span class="col-span-2">金额</span>
            <span class="col-span-1" />
          </div>
          <div v-for="(item, idx) in createItems" :key="idx" class="gap-2 grid grid-cols-12 items-center">
            <div class="col-span-5">
              <BusinessCatalogItemPicker v-model="item.catalogItemId" placeholder="搜索选择商品" />
            </div>
            <div class="col-span-2">
              <FaInputNumber v-model="item.orderedQty" :min="1" class="w-full" />
            </div>
            <div class="col-span-2">
              <FaInputNumber v-model="item.unitCost" :min="0" :precision="2" class="w-full" />
            </div>
            <div class="text-sm col-span-2 tabular-nums">
              ¥{{ (item.orderedQty * (item.unitCost ?? 0)).toFixed(2) }}
            </div>
            <div class="flex col-span-1 justify-end">
              <FaButton size="sm" variant="ghost" @click="removeItem(idx)">
                <FaIcon name="i-lucide:trash-2" />
              </FaButton>
            </div>
          </div>
          <FaButton variant="outline" size="sm" @click="addItem">
            <FaIcon name="i-lucide:plus" />
            添加商品
          </FaButton>
        </div>

        <FaLabel label="备注" class="block">
          <FaTextarea v-model="createForm.note" placeholder="备注(可选)" class="w-full" :rows="2" />
        </FaLabel>

        <div class="pt-2 flex items-center justify-between">
          <span class="text-sm">
            合计:
            <span class="font-medium tabular-nums">¥{{ createTotal.toFixed(2) }}</span>
          </span>
          <div class="flex gap-2">
            <FaButton variant="outline" @click="createVisible = false; editingPoId = ''">
              取消
            </FaButton>
            <FaButton :loading="createSubmitting" @click="onCreateSubmitOrUpdate">
              {{ editingPoId ? '保存草稿' : '创建草稿' }}
            </FaButton>
          </div>
        </div>
      </div>
    </FaModal>

    <!-- 收货 -->
    <FaModal v-model="receiveVisible" title="采购收货" :footer="false" :close-on-click-overlay="false" width="720px">
      <div class="py-2 space-y-3">
        <div class="space-y-2">
          <div class="text-xs text-muted-foreground px-1 gap-2 grid grid-cols-12">
            <span class="col-span-3">商品</span>
            <span class="col-span-2">订购</span>
            <span class="col-span-2">实收 *</span>
            <span class="col-span-2">批次</span>
            <span class="col-span-3">效期</span>
          </div>
          <div v-for="row in receiveForm" :key="row.id" class="gap-2 grid grid-cols-12 items-center">
            <div class="text-sm col-span-3 truncate">
              {{ nameOf(detailItems.find(i => i.id === row.id)?.catalog_item_id) }}
            </div>
            <div class="text-sm col-span-2 tabular-nums">
              {{ row.orderedQty }}
            </div>
            <div class="col-span-2">
              <FaInputNumber v-model="row.receivedQty" :min="0" :max="row.orderedQty" class="w-full" />
            </div>
            <div class="col-span-2">
              <FaInput v-model="row.batchNo" placeholder="批次(可选)" class="w-full" />
            </div>
            <div class="col-span-3">
              <FaInput v-model="row.expiresAt" type="date" class="w-full" />
            </div>
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

    <!-- 审核/取消确认 -->
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
