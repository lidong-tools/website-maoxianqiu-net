<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { StockCountItemRowWithCatalog, StockCountRow } from '@/api/modules/inventory'
import type { StockCount, StockCountScope, Warehouse } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { INVENTORY_PERMISSIONS, STOCK_COUNT_STATUS_LABELS } from '@/types/inventory'

defineOptions({
  name: 'InventoryCount',
})

const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()
const loading = ref(false)
const list = ref<StockCountRow[]>([])

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

/** 盘点范围标签 */
const SCOPE_LABELS: Record<StockCountScope, string> = {
  all: '全部',
  category: '品类',
  item: '指定商品',
}

/** 盘点单状态标签样式 */
function scStatusClass(status: StockCount['status']): string[] {
  const base = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs'
  const map: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground',
    counting: 'bg-amber-500/10 text-amber-600',
    submitted: 'bg-blue-500/10 text-blue-600',
    approved: 'bg-cyan-500/10 text-cyan-600',
    posted: 'bg-green-500/10 text-green-600',
    cancelled: 'bg-red-500/10 text-red-600',
  }
  return [base, map[status] ?? 'bg-muted text-muted-foreground']
}

const columns = computed<TableColumn<StockCountRow>[]>(() => [
  {
    accessorKey: 'count_no',
    header: '盘点单号',
    cell: (info: any) => {
      const row = info.row.original as StockCountRow
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-sm font-medium' }, row.count_no),
        h('div', { class: 'text-xs text-muted-foreground' }, embedName(row.stores)),
      ])
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const status = info.getValue() as StockCount['status']
      return h('span', { class: scStatusClass(status) }, STOCK_COUNT_STATUS_LABELS[status] ?? status)
    },
  },
  { accessorKey: 'warehouses', header: '仓库', cell: (info: any) => embedName(info.getValue()) },
  {
    accessorKey: 'scope',
    header: '盘点范围',
    cell: (info: any) => SCOPE_LABELS[info.getValue() as StockCountScope] ?? info.getValue(),
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

async function loadList() {
  if (!tenantStore.currentStoreId) {
    list.value = []
    return
  }
  loading.value = true
  try {
    list.value = await apiInventory.listStockCounts(tenantStore.currentStoreId)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载盘点单失败')
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

/** 状态 + 关键词(单号)过滤盘点单 */
const filteredList = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return list.value.filter((row) => {
    if (statusFilter.value && row.status !== statusFilter.value) {
      return false
    }
    if (!kw) {
      return true
    }
    return row.count_no.toLowerCase().includes(kw)
  })
})
/** 当前分页的盘点单(前端分页) */
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
const detail = ref<StockCountRow | null>(null)
/** 实盘录入用可变副本(catalog_item_id → countedQuantity) */
const detailItems = ref<StockCountItemRowWithCatalog[]>([])
const actionLoading = ref(false)

const detailDescriptions = computed(() => detail.value
  ? [
      { label: '盘点单号', value: detail.value.count_no },
      { label: '门店', value: embedName(detail.value.stores) },
      { label: '仓库', value: embedName(detail.value.warehouses) },
      { label: '盘点范围', value: SCOPE_LABELS[detail.value.scope] ?? detail.value.scope },
      { label: '备注', value: detail.value.note ?? '-' },
    ]
  : [])

/** 盘点单状态时间线(仅展示已发生/当前节点) */
const timeline = computed(() => {
  const sc = detail.value
  if (!sc) {
    return []
  }
  const steps: Array<{ label: string, at: string, active: boolean }> = [
    { label: '草稿', at: sc.created_at, active: true },
    { label: '盘点中', at: sc.submitted_at ?? '', active: sc.status === 'counting' },
    { label: '待审核', at: sc.submitted_at ?? '', active: ['submitted', 'approved', 'posted'].includes(sc.status) },
    { label: '已审核', at: sc.approved_at ?? '', active: ['approved', 'posted'].includes(sc.status) },
    { label: '已过账', at: sc.posted_at ?? '', active: sc.status === 'posted' },
  ]
  if (sc.status === 'cancelled') {
    return [{ label: '已取消', at: sc.cancelled_at ?? '', active: true }]
  }
  return steps
})

/** 明细表(实盘数量列在 draft/counting 状态可编辑) */
const itemColumns = computed<TableColumn<StockCountItemRowWithCatalog>[]>(() => [
  { id: 'catalog', header: '商品', cell: (info: any) => nameOf((info.row.original as StockCountItemRowWithCatalog).catalog_item_id) },
  { accessorKey: 'book_quantity', header: '账面数量' },
  {
    id: 'counted',
    header: '实盘数量',
    cell: (info: any) => {
      const row = info.row.original as StockCountItemRowWithCatalog
      const status = detail.value?.status
      if (status === 'draft' || status === 'counting') {
        return h('input', {
          type: 'number',
          value: row.counted_quantity ?? row.book_quantity,
          min: 0,
          class: 'w-24 px-2 py-1 border rounded',
          onInput: (e: Event) => {
            const val = Number((e.target as HTMLInputElement).value)
            row.counted_quantity = Number.isFinite(val) && val >= 0 ? val : 0
          },
        })
      }
      return row.counted_quantity ?? '-'
    },
  },
  {
    id: 'diff',
    header: '差异',
    cell: (info: any) => {
      const row = info.row.original as StockCountItemRowWithCatalog
      const counted = row.counted_quantity
      if (counted === null || counted === undefined) {
        return '-'
      }
      const diff = Number(counted) - Number(row.book_quantity)
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

async function openDetail(row: StockCountRow) {
  detail.value = row
  detailVisible.value = true
  detailLoading.value = true
  detailItems.value = []
  try {
    detailItems.value = await apiInventory.listStockCountItems(row.id)
    await enrichCatalog(detailItems.value)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载盘点明细失败')
  }
  finally {
    detailLoading.value = false
  }
}

async function reloadDetail() {
  if (!detail.value) {
    return
  }
  const rows = await apiInventory.listStockCounts(detail.value.store_id)
  const found = rows.find(r => r.id === detail.value?.id) ?? null
  if (found) {
    detail.value = found
  }
  await loadList()
}

// ===== 新建盘点单草稿 =====
const createVisible = ref(false)
const createSubmitting = ref(false)
const warehouses = ref<Warehouse[]>([])
const categories = ref<Array<{ id: string, name: string }>>([])
const createForm = reactive({
  warehouseId: '',
  scope: 'all' as StockCountScope,
  categoryId: '',
  note: '',
})
const createItemIds = ref<string[]>([])
const pickerModel = ref('')

/** 品类选项(scope=category 时展示) */
const categoryOptions = computed(() => categories.value.map(c => ({ label: c.name, value: c.id })))

/** 盘点范围选项 */
const scopeOptions = [
  { label: '全部商品', value: 'all' },
  { label: '按品类', value: 'category' },
  { label: '指定商品', value: 'item' },
]

/** 选择器选中后加入指定商品清单(scope=item) */
watch(pickerModel, (v) => {
  if (v && !createItemIds.value.includes(v)) {
    createItemIds.value.push(v)
  }
  pickerModel.value = ''
})

function removeCreateItem(id: string) {
  createItemIds.value = createItemIds.value.filter(x => x !== id)
}

async function openCreate() {
  createForm.warehouseId = ''
  createForm.scope = 'all'
  createForm.categoryId = ''
  createForm.note = ''
  createItemIds.value = []
  pickerModel.value = ''
  try {
    const [whRes, catRes] = await Promise.all([
      apiInventory.listWarehouses(tenantStore.currentStoreId || undefined),
      supabase.from('catalog_categories').select('id, name').order('name', { ascending: true }),
    ])
    warehouses.value = whRes.data.list
    categories.value = (catRes.data ?? []) as Array<{ id: string, name: string }>
    if (warehouses.value.length > 0) {
      createForm.warehouseId = warehouses.value[0].id
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载基础数据失败')
  }
  createVisible.value = true
}

async function onCreateSubmit() {
  if (!createForm.warehouseId) {
    useFaToast().warning('请选择仓库')
    return
  }
  if (createForm.scope === 'category' && !createForm.categoryId) {
    useFaToast().warning('请选择盘点品类')
    return
  }
  if (createForm.scope === 'item' && createItemIds.value.length === 0) {
    useFaToast().warning('请至少选择一个盘点商品')
    return
  }
  createSubmitting.value = true
  try {
    await apiInventory.createStockCount({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId,
      warehouseId: createForm.warehouseId,
      scope: createForm.scope,
      categoryId: createForm.scope === 'category' ? createForm.categoryId : undefined,
      itemIds: createForm.scope === 'item' ? createItemIds.value : undefined,
      note: createForm.note.trim() || undefined,
    })
    useFaToast().success('盘点单已创建(草稿)')
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

// ===== 盘点单流转:保存实盘 / 提交 / 审核 / 取消 / 过账 =====
const confirmVisible = ref(false)
const confirmAction = ref<'approve' | 'cancel'>('approve')
const confirmTitle = computed(() => confirmAction.value === 'approve' ? '审核盘点单' : '取消盘点单')
const confirmText = computed(() => confirmAction.value === 'approve' ? '确认通过该盘点单审核?' : '确认取消该盘点单?(取消后不可恢复)')

function openConfirm(action: 'approve' | 'cancel') {
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
      await apiInventory.approveStockCount({ tenantId: tenantStore.currentTenantId, countId: detail.value.id })
      useFaToast().success('已审核通过')
    }
    else {
      await apiInventory.cancelStockCount({ tenantId: tenantStore.currentTenantId, countId: detail.value.id })
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

async function onSaveCounting() {
  if (!detail.value) {
    return
  }
  if (detailItems.value.some(i => (i.counted_quantity === null || i.counted_quantity === undefined))) {
    useFaToast().warning('尚有商品未录入实盘数量')
    return
  }
  actionLoading.value = true
  try {
    await apiInventory.updateStockCountCounting({
      tenantId: tenantStore.currentTenantId,
      countId: detail.value.id,
      items: detailItems.value.map(i => ({
        catalogItemId: i.catalog_item_id,
        countedQuantity: Number(i.counted_quantity),
      })),
    })
    useFaToast().success('实盘数量已保存')
    await reloadDetail()
    await openDetail(detail.value)
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
    await apiInventory.submitStockCount({ tenantId: tenantStore.currentTenantId, countId: detail.value.id })
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

async function onPost() {
  if (!detail.value) {
    return
  }
  actionLoading.value = true
  const idempotencyKey = generateIdempotencyKey()
  try {
    await apiInventory.postStockCountDoc({ tenantId: tenantStore.currentTenantId, countId: detail.value.id }, idempotencyKey)
    useFaToast().success('过账成功,库存已按实盘调整')
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
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 工具栏:左筛选/搜索,右功能按钮 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 flex items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaSelect
                v-model="statusFilter"
                :options="[{ label: '全部状态', value: '' }, ...Object.entries(STOCK_COUNT_STATUS_LABELS).map(([value, label]) => ({ label, value }))]"
                class="w-32"
                @update:model-value="page = 1"
              />
              <FaInput
                v-model="keyword"
                placeholder="搜索盘点单号"
                clearable
                class="w-48"
                @update:model-value="page = 1"
              />
              <span class="text-sm text-muted-foreground">
                共 {{ filteredList.length }} 个盘点单
              </span>
            </div>
            <div class="flex gap-2">
              <FaButton v-if="auth(INVENTORY_PERMISSIONS.count)" @click="openCreate">
                <FaIcon name="i-lucide:plus" />
                新建盘点单
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
            empty-text="暂无盘点单"
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

    <!-- 盘点单详情 -->
    <FaDrawer v-model="detailVisible" :title="detail?.count_no ?? '盘点单详情'" width="860px" :footer="false">
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
          盘点明细
          <span v-if="detail.status === 'draft' || detail.status === 'counting'" class="text-xs text-muted-foreground font-normal">
            (可直接修改实盘数量后保存)
          </span>
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
          <template v-if="detail.status === 'draft' || detail.status === 'counting'">
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.count)" :disabled="actionLoading" @click="onSaveCounting">
              保存实盘
            </FaButton>
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.count)" :disabled="actionLoading" @click="onSubmit">
              提交审核
            </FaButton>
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.count)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="detail.status === 'submitted'">
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.count)" :disabled="actionLoading" @click="openConfirm('approve')">
              审核通过
            </FaButton>
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.count)" :disabled="actionLoading" variant="outline" class="text-red-600" @click="openConfirm('cancel')">
              取消
            </FaButton>
          </template>
          <template v-else-if="detail.status === 'approved'">
            <FaButton v-if="auth(INVENTORY_PERMISSIONS.count)" :disabled="actionLoading" @click="onPost">
              过账调整库存
            </FaButton>
          </template>
        </div>
      </template>
    </FaDrawer>

    <!-- 新建盘点单草稿 -->
    <FaModal v-model="createVisible" title="新建盘点单" :footer="false" :close-on-click-overlay="false" width="720px">
      <div class="py-2 space-y-4">
        <div class="gap-x-4 gap-y-3 grid grid-cols-2">
          <FaLabel label="仓库 *" class="block">
            <FaSelect
              v-model="createForm.warehouseId"
              placeholder="选择仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
            />
          </FaLabel>
          <FaLabel label="盘点范围 *" class="block">
            <FaSelect
              v-model="createForm.scope"
              class="w-full"
              :options="scopeOptions"
            />
          </FaLabel>
          <FaLabel v-if="createForm.scope === 'category'" label="品类 *" class="block">
            <FaSelect
              v-model="createForm.categoryId"
              placeholder="选择品类"
              class="w-full"
              :options="categoryOptions"
            />
          </FaLabel>
          <FaLabel v-if="createForm.scope === 'item'" label="指定商品 *" class="block">
            <BusinessCatalogItemPicker v-model="pickerModel" placeholder="搜索选择商品,可连续添加" />
          </FaLabel>
        </div>

        <div v-if="createForm.scope === 'item' && createItemIds.length" class="flex flex-wrap gap-2">
          <span
            v-for="id in createItemIds"
            :key="id"
            class="inline-flex gap-1 px-2 py-1 border rounded-md text-xs items-center"
          >
            {{ nameOf(id) }}
            <FaButton size="icon-sm" variant="ghost" @click="removeCreateItem(id)">
              <FaIcon name="i-lucide:x" />
            </FaButton>
          </span>
        </div>

        <FaLabel label="备注(可选)" class="block">
          <FaTextarea v-model="createForm.note" placeholder="备注(可选)" class="w-full" :rows="2" />
        </FaLabel>

        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="createVisible = false">
            取消
          </FaButton>
          <FaButton :loading="createSubmitting" @click="onCreateSubmit">
            创建草稿
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
