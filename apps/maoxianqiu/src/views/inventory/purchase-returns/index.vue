<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { PurchaseReturnRow } from '@/api/modules/inventory'
import type { PurchaseReturn, PurchaseReturnItem, PurchaseReturnItemInput, Supplier, Warehouse } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { PURCHASE_RETURN_PERMISSIONS, PURCHASE_RETURN_STATUS_LABELS } from '@/types/inventory'

defineOptions({
  name: 'InventoryPurchaseReturns',
})

const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()

const loading = ref(false)
const list = ref<PurchaseReturnRow[]>([])

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

/** 可退批次(active 且有余量;按仓库 + 可选商品过滤) */
interface ReturnableBatch {
  id: string
  batch_no: string | null
  quantity_remaining: number
  unit_cost: number
  expiry_date: string | null
  catalog_item_id: string
}
const returnableBatches = ref<ReturnableBatch[]>([])

const columns = computed<TableColumn<PurchaseReturnRow>[]>(() => [
  {
    accessorKey: 'return_no',
    header: '退货单号',
    cell: (info: any) => {
      const row = info.row.original as PurchaseReturnRow
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-sm font-medium' }, row.return_no),
        h('div', { class: 'text-xs text-muted-foreground' }, row.stores?.name ?? '-'),
      ])
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const status = info.getValue() as PurchaseReturn['status']
      return h('span', { class: statusLabelClass(status) }, PURCHASE_RETURN_STATUS_LABELS[status] ?? status)
    },
  },
  { accessorKey: 'suppliers', header: '供应商', cell: (info: any) => embedName(info.getValue()) },
  { accessorKey: 'warehouses', header: '仓库', cell: (info: any) => embedName(info.getValue()) },
  {
    accessorKey: 'purchase_orders',
    header: '来源采购单',
    cell: (info: any) => {
      const v = info.getValue()
      if (Array.isArray(v)) {
        return (v[0] as { po_no?: string } | undefined)?.po_no ?? '-'
      }
      return (v as { po_no?: string } | null)?.po_no ?? '-'
    },
  },
  {
    accessorKey: 'return_amount_snapshot',
    header: '退货金额',
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

function statusLabelClass(status: PurchaseReturn['status']): string[] {
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

async function loadList() {
  if (!tenantStore.currentStoreId) {
    list.value = []
    return
  }
  loading.value = true
  try {
    list.value = await apiInventory.listPurchaseReturns(tenantStore.currentStoreId)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载采购退货失败')
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

/** 状态 + 关键词(单号/供应商)过滤采购退货 */
const filteredList = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return list.value.filter((row) => {
    if (statusFilter.value && row.status !== statusFilter.value) {
      return false
    }
    if (!kw) {
      return true
    }
    return [row.return_no, embedName(row.suppliers)]
      .some(v => (v ?? '').toLowerCase().includes(kw))
  })
})
/** 当前分页的采购退货(前端分页) */
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
const detailRet = ref<PurchaseReturnRow | null>(null)
const detailItems = ref<PurchaseReturnItem[]>([])
const actionLoading = ref(false)

const detailDescriptions = computed(() => detailRet.value
  ? [
      { label: '退货单号', value: detailRet.value.return_no },
      { label: '门店', value: embedName(detailRet.value.stores) },
      { label: '仓库', value: embedName(detailRet.value.warehouses) },
      { label: '供应商', value: embedName(detailRet.value.suppliers) },
      { label: '来源采购单', value: embedName(detailRet.value.purchase_orders) },
      { label: '退货金额', value: `¥${Number(detailRet.value.return_amount_snapshot).toFixed(2)}` },
      { label: '原因', value: detailRet.value.reason ?? '-' },
    ]
  : [])

/** 状态时间线节点(仅展示已发生/当前节点) */
const timeline = computed(() => {
  const ret = detailRet.value
  if (!ret) {
    return []
  }
  const steps: Array<{ label: string, at: string, active: boolean }> = [
    { label: '草稿', at: ret.created_at, active: true },
    { label: '待审核', at: ret.submitted_at ?? '', active: ret.status !== 'draft' },
    { label: '已审核', at: ret.approved_at ?? '', active: ['approved', 'posted'].includes(ret.status) },
    { label: '已过账', at: ret.posted_at ?? '', active: ret.status === 'posted' },
  ]
  if (ret.status === 'cancelled') {
    return [{ label: '已取消', at: ret.cancelled_at ?? '', active: true }]
  }
  return steps
})

const itemColumns = computed<TableColumn<PurchaseReturnItem>[]>(() => [
  { id: 'catalog', header: '商品', cell: (info: any) => nameOf((info.row.original as PurchaseReturnItem).catalog_item_id) },
  {
    id: 'batch',
    header: '批次',
    cell: (info: any) => {
      const row = info.row.original as PurchaseReturnItem
      const batch = (row as any).inventory_batches as { batch_no?: string | null } | null | undefined
      return batch?.batch_no ?? '-'
    },
  },
  { accessorKey: 'quantity', header: '退货数量', cell: (info: any) => info.getValue() },
  {
    id: 'amount',
    header: '金额',
    cell: (info: any) => {
      const row = info.row.original as PurchaseReturnItem
      return `¥${Number(row.amount).toFixed(2)}`
    },
  },
  { accessorKey: 'note', header: '备注', cell: (info: any) => info.getValue() ?? '-' },
])

async function openDetail(row: PurchaseReturnRow) {
  detailRet.value = row
  detailVisible.value = true
  detailLoading.value = true
  detailItems.value = []
  try {
    const items = await apiInventory.listPurchaseReturnItems(row.id)
    detailItems.value = items
    await enrichCatalog(items)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载退货明细失败')
  }
  finally {
    detailLoading.value = false
  }
}

async function reloadDetail() {
  if (!detailRet.value) {
    return
  }
  const [ret] = await Promise.all([
    apiInventory.listPurchaseReturns(detailRet.value.store_id).then(rows => rows.find(r => r.id === detailRet.value?.id) ?? null),
  ])
  if (ret) {
    detailRet.value = ret
  }
  await loadList()
}

// ===== 新建/编辑草稿 =====
const createVisible = ref(false)
const createSubmitting = ref(false)
const warehouses = ref<Warehouse[]>([])
const suppliers = ref<Supplier[]>([])
const editingRetId = ref('')
const createForm = reactive({
  warehouseId: '',
  supplierId: '',
  sourcePoId: '',
  reason: '',
})
const createItems = ref<Array<PurchaseReturnItemInput & { maxQty?: number }>>([])

/** 按仓库加载可退批次(active 且有余量) */
async function loadReturnableBatches(warehouseId: string) {
  if (!warehouseId) {
    returnableBatches.value = []
    return
  }
  const { data, error } = await supabase
    .from('inventory_batches')
    .select('id, batch_no, quantity_remaining, unit_cost, expiry_date, catalog_item_id')
    .eq('warehouse_id', warehouseId)
    .eq('status', 'active')
    .gt('quantity_remaining', 0)
    .order('expiry_date', { ascending: true, nullsFirst: false })
  if (error) {
    returnableBatches.value = []
    useFaToast().error('加载批次失败')
    return
  }
  returnableBatches.value = (data ?? []) as ReturnableBatch[]
}

async function openCreate() {
  editingRetId.value = ''
  createForm.warehouseId = ''
  createForm.supplierId = ''
  createForm.sourcePoId = ''
  createForm.reason = ''
  createItems.value = []
  returnableBatches.value = []
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
  createItems.value.push({ catalogItemId: '', batchId: '', quantity: 1, unitCost: 0 })
}
function removeItem(idx: number) {
  createItems.value.splice(idx, 1)
}

/** 行内批次选项(按所选商品过滤可退批次) */
function batchOptions(item: { catalogItemId: string }) {
  if (!item.catalogItemId) {
    return []
  }
  return returnableBatches.value
    .filter(b => b.catalog_item_id === item.catalogItemId)
    .map(b => ({
      label: `${b.batch_no ?? '无批次号'} · 余${b.quantity_remaining}`,
      value: b.id,
    }))
}

/** 商品变更后清除批次选择,并回填该批次单价 */
function onCatalogChange(item: { catalogItemId: string, batchId: string, unitCost?: number }) {
  item.batchId = ''
  item.unitCost = 0
}

function onBatchChange(item: { batchId: string, unitCost?: number }) {
  const b = returnableBatches.value.find(x => x.id === item.batchId)
  if (b) {
    item.unitCost = Number(b.unit_cost ?? 0)
  }
}

const createTotal = computed(() => createItems.value.reduce((sum, i) => sum + i.quantity * (i.unitCost ?? 0), 0))

// ===== 流转操作:提交 / 审核 / 取消 / 过账 =====
const confirmVisible = ref(false)
const confirmAction = ref<'approve' | 'cancel'>('approve')
const confirmTitle = computed(() => confirmAction.value === 'approve' ? '审核采购退货' : '取消采购退货')
const confirmText = computed(() => confirmAction.value === 'approve' ? '确认通过该退货单审核?' : '确认取消该退货单?(取消后不可恢复)')

function openConfirm(action: 'approve' | 'cancel') {
  confirmAction.value = action
  confirmVisible.value = true
}

async function onConfirmSubmit() {
  if (!detailRet.value) {
    return
  }
  actionLoading.value = true
  try {
    if (confirmAction.value === 'approve') {
      await apiInventory.approvePurchaseReturn({ tenantId: tenantStore.currentTenantId, returnId: detailRet.value.id })
      useFaToast().success('已审核通过')
    }
    else {
      await apiInventory.cancelPurchaseReturn({ tenantId: tenantStore.currentTenantId, returnId: detailRet.value.id })
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
  if (!detailRet.value) {
    return
  }
  actionLoading.value = true
  try {
    await apiInventory.submitPurchaseReturn({ tenantId: tenantStore.currentTenantId, returnId: detailRet.value.id })
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
  if (!detailRet.value) {
    return
  }
  const ret = detailRet.value
  editingRetId.value = ret.id
  createForm.warehouseId = ret.warehouse_id
  createForm.supplierId = ret.supplier_id ?? ''
  createForm.sourcePoId = ret.source_po_id ?? ''
  createForm.reason = ret.reason ?? ''
  createItems.value = detailItems.value.map(i => ({
    catalogItemId: i.catalog_item_id,
    batchId: i.batch_id ?? '',
    quantity: Number(i.quantity),
    unitCost: Number(i.unit_cost),
    note: i.note ?? undefined,
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
    await loadReturnableBatches(ret.warehouse_id)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载基础数据失败')
  }
  createVisible.value = true
}

async function onCreateSubmitOrUpdate() {
  if (!createForm.warehouseId) {
    useFaToast().warning('请选择仓库')
    return
  }
  if (createItems.value.length === 0 || createItems.value.some(i => !i.catalogItemId || !i.batchId)) {
    useFaToast().warning('请添加至少一项有效退货明细(商品 + 批次)')
    return
  }
  if (createItems.value.some(i => i.quantity <= 0)) {
    useFaToast().warning('退货数量必须大于 0')
    return
  }
  createSubmitting.value = true
  const payload = {
    tenantId: tenantStore.currentTenantId,
    warehouseId: createForm.warehouseId,
    supplierId: createForm.supplierId || undefined,
    sourcePoId: createForm.sourcePoId || undefined,
    reason: createForm.reason.trim() || undefined,
    items: createItems.value.map(i => ({
      catalogItemId: i.catalogItemId,
      batchId: i.batchId,
      quantity: i.quantity,
      unitCost: i.unitCost ?? 0,
      note: i.note || undefined,
    })),
  }
  try {
    if (editingRetId.value) {
      await apiInventory.updatePurchaseReturnDraft({ ...payload, returnId: editingRetId.value })
      useFaToast().success('草稿已更新')
    }
    else {
      await apiInventory.createPurchaseReturn({ ...payload, storeId: tenantStore.currentStoreId })
      useFaToast().success('采购退货已创建(草稿)')
    }
    createVisible.value = false
    editingRetId.value = ''
    await loadList()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    createSubmitting.value = false
  }
}

async function onPost() {
  if (!detailRet.value) {
    return
  }
  actionLoading.value = true
  const idempotencyKey = generateIdempotencyKey()
  try {
    await apiInventory.postPurchaseReturn({ tenantId: tenantStore.currentTenantId, returnId: detailRet.value.id }, idempotencyKey)
    useFaToast().success('过账成功,库存已扣减')
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
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(参考优惠券界面布局) -->
    <!--
    <EntityPageHeader compact title="采购退货" description="草稿 → 提交 → 审核 → 过账扣库存">
      <template #actions>
        <FaButton v-if="auth(PURCHASE_RETURN_PERMISSIONS.create)" @click="openCreate">
          <FaIcon name="i-lucide:plus" />
          新建采购退货
        </FaButton>
      </template>
    </EntityPageHeader>
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 工具栏:左筛选/搜索,右功能按钮 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 flex items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaSelect
                v-model="statusFilter"
                :options="[{ label: '全部状态', value: '' }, ...Object.entries(PURCHASE_RETURN_STATUS_LABELS).map(([value, label]) => ({ label, value }))]"
                class="w-36"
                @update:model-value="page = 1"
              />
              <FaInput
                v-model="keyword"
                placeholder="搜索单号/供应商"
                clearable
                class="w-52"
                @update:model-value="page = 1"
              />
              <span class="text-sm text-muted-foreground">
                共 {{ filteredList.length }} 个退货单
              </span>
            </div>
            <div class="flex gap-2">
              <FaButton v-if="auth(PURCHASE_RETURN_PERMISSIONS.create)" @click="openCreate">
                <FaIcon name="i-lucide:plus" />
                新建采购退货
              </FaButton>
            </div>
          </div>
        </div>
        <!-- 表格区 -->
        <div class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            v-loading="loading"
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="columns"
            :data="pagedList"
            empty-text="暂无采购退货"
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

    <!-- 退货详情 -->
    <FaDrawer v-model="detailVisible" :title="detailRet?.return_no ?? '采购退货详情'" width="720px" :footer="false">
      <template v-if="detailRet">
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
          退货明细
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
          <template v-if="detailRet.status === 'draft'">
            <FaButton v-if="auth(PURCHASE_RETURN_PERMISSIONS.create)" :disabled="actionLoading" variant="outline" @click="onEditDraft">
              编辑草稿
            </FaButton>
            <FaButton v-if="auth(PURCHASE_RETURN_PERMISSIONS.submit)" :disabled="actionLoading" @click="onSubmit">
              提交审核
            </FaButton>
            <FaButton v-if="auth(PURCHASE_RETURN_PERMISSIONS.submit)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="detailRet.status === 'submitted'">
            <FaButton v-if="auth(PURCHASE_RETURN_PERMISSIONS.approve)" :disabled="actionLoading" @click="openConfirm('approve')">
              审核通过
            </FaButton>
            <FaButton v-if="auth(PURCHASE_RETURN_PERMISSIONS.submit)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="detailRet.status === 'approved'">
            <FaButton v-if="auth(PURCHASE_RETURN_PERMISSIONS.post)" :disabled="actionLoading" @click="onPost">
              过账扣库存
            </FaButton>
          </template>
        </div>
      </template>
    </FaDrawer>

    <!-- 新建/编辑草稿 -->
    <FaModal v-model="createVisible" :title="editingRetId ? '编辑采购退货' : '新建采购退货'" :footer="false" :close-on-click-overlay="false" width="820px">
      <div class="py-2 space-y-4">
        <div class="gap-x-4 gap-y-3 grid grid-cols-3">
          <FaLabel label="仓库 *" class="block">
            <FaSelect
              v-model="createForm.warehouseId"
              placeholder="选择仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
              @update:model-value="(v: unknown) => loadReturnableBatches(String(v ?? ''))"
            />
          </FaLabel>
          <FaLabel label="供应商(可选)" class="block">
            <FaSelect
              v-model="createForm.supplierId"
              placeholder="选择供应商"
              class="w-full"
              clearable
              :options="suppliers.map(s => ({ label: s.name, value: s.id }))"
            />
          </FaLabel>
          <FaLabel label="来源采购单(可选)" class="block">
            <FaInput v-model="createForm.sourcePoId" placeholder="粘贴采购单 id(可选)" class="w-full" />
          </FaLabel>
        </div>

        <div class="text-sm font-medium">
          退货明细
        </div>
        <div class="space-y-2">
          <div class="text-xs text-muted-foreground px-1 gap-2 grid grid-cols-12">
            <span class="col-span-3">商品</span>
            <span class="col-span-3">批次</span>
            <span class="col-span-2">数量</span>
            <span class="col-span-2">金额</span>
            <span class="col-span-1" />
          </div>
          <div v-for="(item, idx) in createItems" :key="idx" class="gap-2 grid grid-cols-12 items-center">
            <div class="col-span-3">
              <BusinessCatalogItemPicker v-model="item.catalogItemId" placeholder="搜索选择商品" @update:model-value="onCatalogChange(item)" />
            </div>
            <div class="col-span-3">
              <FaSelect
                v-model="item.batchId"
                placeholder="选择批次"
                class="w-full"
                :options="batchOptions(item)"
                @update:model-value="onBatchChange(item)"
              />
            </div>
            <div class="col-span-2">
              <FaInputNumber v-model="item.quantity" :min="1" class="w-full" />
            </div>
            <div class="text-sm col-span-2 tabular-nums">
              ¥{{ (item.quantity * (item.unitCost ?? 0)).toFixed(2) }}
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

        <FaLabel label="退货原因" class="block">
          <FaTextarea v-model="createForm.reason" placeholder="原因(可选)" class="w-full" :rows="2" />
        </FaLabel>

        <div class="pt-2 flex items-center justify-between">
          <span class="text-sm">
            合计:
            <span class="font-medium tabular-nums">¥{{ createTotal.toFixed(2) }}</span>
          </span>
          <div class="flex gap-2">
            <FaButton variant="outline" @click="createVisible = false; editingRetId = ''">
              取消
            </FaButton>
            <FaButton :loading="createSubmitting" @click="onCreateSubmitOrUpdate">
              {{ editingRetId ? '保存草稿' : '创建草稿' }}
            </FaButton>
          </div>
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
