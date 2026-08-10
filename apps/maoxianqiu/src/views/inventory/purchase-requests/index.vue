<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { PurchaseRequestRow } from '@/api/modules/inventory'
import type { PurchaseRequest, PurchaseRequestItem, PurchaseRequestItemInput, Supplier, Warehouse } from '@/types/inventory'
import apiInventory from '@/api/modules/inventory'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { PURCHASE_REQUEST_PERMISSIONS, PURCHASE_REQUEST_STATUS_LABELS } from '@/types/inventory'

defineOptions({
  name: 'InventoryPurchaseRequests',
})

const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()

const loading = ref(false)
const list = ref<PurchaseRequestRow[]>([])

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

const columns = computed<TableColumn<PurchaseRequestRow>[]>(() => [
  {
    accessorKey: 'request_no',
    header: '申请单号',
    cell: (info: any) => {
      const row = info.row.original as PurchaseRequestRow
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-sm font-medium' }, row.request_no),
        h('div', { class: 'text-xs text-muted-foreground' }, row.stores?.name ?? '-'),
      ])
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const status = info.getValue() as PurchaseRequest['status']
      return h('span', { class: statusLabelClass(status) }, PURCHASE_REQUEST_STATUS_LABELS[status] ?? status)
    },
  },
  {
    accessorKey: 'requesters',
    header: '申请人',
    cell: (info: any) => {
      const v = info.getValue()
      if (Array.isArray(v)) {
        return (v[0] as { real_name?: string } | undefined)?.real_name ?? '-'
      }
      return (v as { real_name?: string } | null)?.real_name ?? '-'
    },
  },
  { accessorKey: 'warehouses', header: '仓库', cell: (info: any) => embedName(info.getValue()) },
  { accessorKey: 'suppliers', header: '供应商', cell: (info: any) => embedName(info.getValue()) },
  {
    accessorKey: 'required_at',
    header: '需求日期',
    cell: (info: any) => info.getValue() ?? '-',
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

function statusLabelClass(status: PurchaseRequest['status']): string[] {
  const base = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs'
  const map: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    submitted: 'bg-blue-500/10 text-blue-600',
    approved: 'bg-cyan-500/10 text-cyan-600',
    rejected: 'bg-red-500/10 text-red-600',
    converted_to_po: 'bg-green-500/10 text-green-600',
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
    list.value = await apiInventory.listPurchaseRequests(tenantStore.currentStoreId)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载采购申请失败')
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

/** 状态 + 关键词(单号/仓库/供应商)过滤采购申请 */
const filteredList = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return list.value.filter((row) => {
    if (statusFilter.value && row.status !== statusFilter.value) {
      return false
    }
    if (!kw) {
      return true
    }
    return [row.request_no, embedName(row.warehouses), embedName(row.suppliers)]
      .some(v => (v ?? '').toLowerCase().includes(kw))
  })
})
/** 当前分页的采购申请(前端分页) */
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
const detailReq = ref<PurchaseRequestRow | null>(null)
const detailItems = ref<PurchaseRequestItem[]>([])
const actionLoading = ref(false)

const detailDescriptions = computed(() => detailReq.value
  ? [
      { label: '申请单号', value: detailReq.value.request_no },
      { label: '门店', value: embedName(detailReq.value.stores) },
      { label: '仓库', value: embedName(detailReq.value.warehouses) },
      { label: '供应商', value: embedName(detailReq.value.suppliers) },
      { label: '需求日期', value: detailReq.value.required_at ?? '-' },
      { label: '原因', value: detailReq.value.reason ?? '-' },
      { label: '驳回原因', value: detailReq.value.reject_reason ?? '-' },
    ]
  : [])

/** 状态时间线节点(仅展示已发生/当前节点) */
const timeline = computed(() => {
  const req = detailReq.value
  if (!req) {
    return []
  }
  const steps: Array<{ label: string, at: string, active: boolean }> = [
    { label: '草稿', at: req.created_at, active: true },
    { label: '待审核', at: req.submitted_at ?? '', active: req.status !== 'draft' },
    { label: '已审核', at: req.approved_at ?? '', active: ['approved', 'converted_to_po'].includes(req.status) },
    { label: '已转采购单', at: req.converted_at ?? '', active: req.status === 'converted_to_po' },
  ]
  if (req.status === 'cancelled') {
    return [{ label: '已取消', at: req.cancelled_at ?? '', active: true }]
  }
  if (req.status === 'rejected') {
    return [{ label: '已驳回', at: req.rejected_at ?? '', active: true }]
  }
  return steps
})

const itemColumns = computed<TableColumn<PurchaseRequestItem>[]>(() => [
  { id: 'catalog', header: '商品', cell: (info: any) => nameOf((info.row.original as PurchaseRequestItem).catalog_item_id) },
  { accessorKey: 'requested_qty', header: '申请数量', cell: (info: any) => info.getValue() },
  { accessorKey: 'unit', header: '单位', cell: (info: any) => info.getValue() ?? '-' },
  {
    id: 'amount',
    header: '预估金额',
    cell: (info: any) => {
      const row = info.row.original as PurchaseRequestItem
      return `¥${(Number(row.requested_qty) * Number(row.estimated_unit_cost)).toFixed(2)}`
    },
  },
  { accessorKey: 'note', header: '备注', cell: (info: any) => info.getValue() ?? '-' },
])

async function openDetail(row: PurchaseRequestRow) {
  detailReq.value = row
  detailVisible.value = true
  detailLoading.value = true
  detailItems.value = []
  try {
    const items = await apiInventory.listPurchaseRequestItems(row.id)
    detailItems.value = items
    await enrichCatalog(items)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载申请明细失败')
  }
  finally {
    detailLoading.value = false
  }
}

async function reloadDetail() {
  if (!detailReq.value) {
    return
  }
  const [req] = await Promise.all([
    apiInventory.listPurchaseRequests(detailReq.value.store_id).then(rows => rows.find(r => r.id === detailReq.value?.id) ?? null),
  ])
  if (req) {
    detailReq.value = req
  }
  await loadList()
}

// ===== 新建/编辑草稿 =====
const createVisible = ref(false)
const createSubmitting = ref(false)
const warehouses = ref<Warehouse[]>([])
const suppliers = ref<Supplier[]>([])
const editingReqId = ref('')
const createForm = reactive({
  warehouseId: '',
  supplierId: '',
  requiredAt: '',
  reason: '',
})
const createItems = ref<PurchaseRequestItemInput[]>([])

async function openCreate() {
  editingReqId.value = ''
  createForm.warehouseId = ''
  createForm.supplierId = ''
  createForm.requiredAt = ''
  createForm.reason = ''
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
  createItems.value.push({ catalogItemId: '', requestedQty: 1, estimatedUnitCost: 0 })
}
function removeItem(idx: number) {
  createItems.value.splice(idx, 1)
}

const createTotal = computed(() => createItems.value.reduce((sum, i) => sum + i.requestedQty * (i.estimatedUnitCost ?? 0), 0))

// ===== 流转操作:提交 / 审核 / 驳回 / 取消 / 转采购单 =====
const confirmVisible = ref(false)
const confirmAction = ref<'approve' | 'reject' | 'cancel'>('approve')
const rejectReason = ref('')
const confirmTitle = computed(() => {
  const map = { approve: '审核采购申请', reject: '驳回采购申请', cancel: '取消采购申请' }
  return map[confirmAction.value]
})
const confirmText = computed(() => {
  const map: Record<string, string> = {
    approve: '确认通过该采购申请审核?',
    reject: '确认驳回该采购申请?',
    cancel: '确认取消该采购申请?(取消后不可恢复)',
  }
  return map[confirmAction.value]
})

function openConfirm(action: 'approve' | 'reject' | 'cancel') {
  confirmAction.value = action
  rejectReason.value = ''
  confirmVisible.value = true
}

async function onConfirmSubmit() {
  if (!detailReq.value) {
    return
  }
  actionLoading.value = true
  try {
    const base = { tenantId: tenantStore.currentTenantId, requestId: detailReq.value.id }
    if (confirmAction.value === 'approve') {
      await apiInventory.approvePurchaseRequest(base)
      useFaToast().success('已审核通过')
    }
    else if (confirmAction.value === 'reject') {
      if (!rejectReason.value.trim()) {
        useFaToast().warning('请填写驳回原因')
        return
      }
      await apiInventory.rejectPurchaseRequest({ ...base, rejectReason: rejectReason.value.trim() })
      useFaToast().success('已驳回')
    }
    else {
      await apiInventory.cancelPurchaseRequest(base)
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
  if (!detailReq.value) {
    return
  }
  actionLoading.value = true
  try {
    await apiInventory.submitPurchaseRequest({ tenantId: tenantStore.currentTenantId, requestId: detailReq.value.id })
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
  if (!detailReq.value) {
    return
  }
  const req = detailReq.value
  editingReqId.value = req.id
  createForm.warehouseId = req.warehouse_id
  createForm.supplierId = req.supplier_id ?? ''
  createForm.requiredAt = req.required_at ?? ''
  createForm.reason = req.reason ?? ''
  createItems.value = detailItems.value.map(i => ({
    catalogItemId: i.catalog_item_id,
    requestedQty: Number(i.requested_qty),
    unit: i.unit ?? undefined,
    estimatedUnitCost: Number(i.estimated_unit_cost),
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
  if (createItems.value.length === 0 || createItems.value.some(i => !i.catalogItemId)) {
    useFaToast().warning('请添加至少一项有效商品')
    return
  }
  createSubmitting.value = true
  const payload = {
    tenantId: tenantStore.currentTenantId,
    warehouseId: createForm.warehouseId,
    supplierId: createForm.supplierId || undefined,
    requiredAt: createForm.requiredAt || undefined,
    reason: createForm.reason.trim() || undefined,
    items: createItems.value.map(i => ({
      catalogItemId: i.catalogItemId,
      requestedQty: i.requestedQty,
      unit: i.unit || undefined,
      estimatedUnitCost: i.estimatedUnitCost ?? 0,
      note: i.note || undefined,
    })),
  }
  try {
    if (editingReqId.value) {
      await apiInventory.updatePurchaseRequestDraft({ ...payload, requestId: editingReqId.value })
      useFaToast().success('草稿已更新')
    }
    else {
      await apiInventory.createPurchaseRequest({ ...payload, storeId: tenantStore.currentStoreId })
      useFaToast().success('采购申请已创建(草稿)')
    }
    createVisible.value = false
    editingReqId.value = ''
    await loadList()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    createSubmitting.value = false
  }
}

async function onConvert() {
  if (!detailReq.value) {
    return
  }
  actionLoading.value = true
  try {
    const res: any = await apiInventory.convertPurchaseRequestToPo({
      tenantId: tenantStore.currentTenantId,
      requestId: detailReq.value.id,
    })
    useFaToast().success(res?.poNo ? `已生成采购单 ${res.poNo}` : '已转换为采购单')
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
    <EntityPageHeader compact title="采购申请" description="草稿 → 提交 → 审核 → 转换为采购单">
      <template #actions>
        <FaButton v-if="auth(PURCHASE_REQUEST_PERMISSIONS.create)" @click="openCreate">
          <FaIcon name="i-lucide:plus" />
          新建采购申请
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
                :options="[{ label: '全部状态', value: '' }, ...Object.entries(PURCHASE_REQUEST_STATUS_LABELS).map(([value, label]) => ({ label, value }))]"
                class="w-36"
                @update:model-value="page = 1"
              />
              <FaInput
                v-model="keyword"
                placeholder="搜索单号/仓库/供应商"
                clearable
                class="w-52"
                @update:model-value="page = 1"
              />
              <span class="text-sm text-muted-foreground">
                共 {{ filteredList.length }} 个申请
              </span>
            </div>
            <div class="flex gap-2">
              <FaButton v-if="auth(PURCHASE_REQUEST_PERMISSIONS.create)" @click="openCreate">
                <FaIcon name="i-lucide:plus" />
                新建采购申请
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
            empty-text="暂无采购申请"
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

    <!-- 申请详情 -->
    <FaDrawer v-model="detailVisible" :title="detailReq?.request_no ?? '采购申请详情'" width="720px" :footer="false">
      <template v-if="detailReq">
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
          申请明细
        </div>
        <div v-loading="detailLoading">
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="itemColumns"
            :data="detailItems ?? []"
            empty-text="暂无明细"
          />
        </div>

        <!-- 状态流转操作 -->
        <div class="mt-5 pt-5 border-t flex flex-wrap gap-2 justify-end">
          <template v-if="detailReq.status === 'draft'">
            <FaButton v-if="auth(PURCHASE_REQUEST_PERMISSIONS.create)" :disabled="actionLoading" variant="outline" @click="onEditDraft">
              编辑草稿
            </FaButton>
            <FaButton v-if="auth(PURCHASE_REQUEST_PERMISSIONS.submit)" :disabled="actionLoading" @click="onSubmit">
              提交审核
            </FaButton>
            <FaButton v-if="auth(PURCHASE_REQUEST_PERMISSIONS.submit)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="detailReq.status === 'submitted'">
            <FaButton v-if="auth(PURCHASE_REQUEST_PERMISSIONS.approve)" :disabled="actionLoading" @click="openConfirm('approve')">
              审核通过
            </FaButton>
            <FaButton v-if="auth(PURCHASE_REQUEST_PERMISSIONS.approve)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('reject')">
              驳回
            </FaButton>
            <FaButton v-if="auth(PURCHASE_REQUEST_PERMISSIONS.submit)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="detailReq.status === 'approved'">
            <FaButton v-if="auth(PURCHASE_REQUEST_PERMISSIONS.convert)" :disabled="actionLoading" @click="onConvert">
              转换为采购单
            </FaButton>
          </template>
        </div>
      </template>
    </FaDrawer>

    <!-- 新建/编辑草稿 -->
    <FaModal v-model="createVisible" :title="editingReqId ? '编辑采购申请' : '新建采购申请'" :footer="false" :close-on-click-overlay="false" width="760px">
      <div class="py-2 space-y-4">
        <div class="gap-x-4 gap-y-3 grid grid-cols-3">
          <FaLabel label="仓库 *" class="block">
            <FaSelect
              v-model="createForm.warehouseId"
              placeholder="选择仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
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
          <FaLabel label="需求日期" class="block">
            <FaInput v-model="createForm.requiredAt" type="date" class="w-full" />
          </FaLabel>
        </div>

        <div class="text-sm font-medium">
          申请明细
        </div>
        <div class="space-y-2">
          <div class="text-xs text-muted-foreground px-1 gap-2 grid grid-cols-12">
            <span class="col-span-4">商品</span>
            <span class="col-span-2">申请数量</span>
            <span class="col-span-2">预估单价</span>
            <span class="col-span-3">预估金额</span>
            <span class="col-span-1" />
          </div>
          <div v-for="(item, idx) in createItems" :key="idx" class="gap-2 grid grid-cols-12 items-center">
            <div class="col-span-4">
              <BusinessCatalogItemPicker v-model="item.catalogItemId" placeholder="搜索选择商品" />
            </div>
            <div class="col-span-2">
              <FaInputNumber v-model="item.requestedQty" :min="1" class="w-full" />
            </div>
            <div class="col-span-2">
              <FaInputNumber v-model="item.estimatedUnitCost" :min="0" :precision="2" class="w-full" />
            </div>
            <div class="text-sm col-span-3 tabular-nums">
              ¥{{ (item.requestedQty * (item.estimatedUnitCost ?? 0)).toFixed(2) }}
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

        <FaLabel label="申请原因" class="block">
          <FaTextarea v-model="createForm.reason" placeholder="原因(可选)" class="w-full" :rows="2" />
        </FaLabel>

        <div class="pt-2 flex items-center justify-between">
          <span class="text-sm">
            合计:
            <span class="font-medium tabular-nums">¥{{ createTotal.toFixed(2) }}</span>
          </span>
          <div class="flex gap-2">
            <FaButton variant="outline" @click="createVisible = false; editingReqId = ''">
              取消
            </FaButton>
            <FaButton :loading="createSubmitting" @click="onCreateSubmitOrUpdate">
              {{ editingReqId ? '保存草稿' : '创建草稿' }}
            </FaButton>
          </div>
        </div>
      </div>
    </FaModal>

    <!-- 审核/驳回/取消确认 -->
    <FaModal v-model="confirmVisible" :title="confirmTitle" :footer="false" :close-on-click-overlay="false">
      <div class="py-3 space-y-3">
        <p class="text-sm text-muted-foreground">
          {{ confirmText }}
        </p>
        <FaLabel v-if="confirmAction === 'reject'" label="驳回原因 *" class="block">
          <FaTextarea v-model="rejectReason" placeholder="请填写驳回原因" class="w-full" :rows="2" />
        </FaLabel>
        <div class="pt-2 flex gap-2 justify-end">
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
