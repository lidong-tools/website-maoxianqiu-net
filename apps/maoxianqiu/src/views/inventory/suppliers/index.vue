<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { PurchaseOrderRow } from '@/api/modules/inventory'
import type { Supplier } from '@/types/inventory'
import apiInventory from '@/api/modules/inventory'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { SUPPLIER_PERMISSIONS, SUPPLIER_STATUS_LABELS } from '@/types/inventory'

defineOptions({
  name: 'InventorySuppliers',
})

const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()

const loading = ref(false)
const suppliers = ref<Supplier[]>([])
const keyword = ref('')

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) {
    return suppliers.value
  }
  return suppliers.value.filter(s =>
    s.name.toLowerCase().includes(kw)
    || (s.contact_name ?? '').toLowerCase().includes(kw)
    || (s.phone ?? '').includes(kw),
  )
})

const page = ref(1)
const pageSize = ref(20)

/** 当前分页的供应商(前端分页) */
const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

// 过滤结果变化时修正越界页码
watch(filtered, () => {
  const maxPage = Math.max(1, Math.ceil(filtered.value.length / pageSize.value))
  if (page.value > maxPage) {
    page.value = maxPage
  }
})

const columns = computed<TableColumn<Supplier>[]>(() => [
  { accessorKey: 'supplier_no', header: '编码', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'name',
    header: '名称',
    cell: (info: any) => {
      const row = info.row.original as Supplier
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-sm font-medium' }, row.name),
        h('div', { class: 'text-xs text-muted-foreground' }, (row.categories ?? []).join(' / ') || '-'),
      ])
    },
  },
  { accessorKey: 'contact_name', header: '联系人', cell: (info: any) => info.getValue() ?? '-' },
  { accessorKey: 'phone', header: '电话', cell: (info: any) => info.getValue() ?? '-' },
  { accessorKey: 'payment_terms', header: '账期', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const status = info.getValue() as Supplier['status']
      return h('span', {
        class: ['inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs', status === 'active' ? 'bg-green-500/10 text-green-600' : 'bg-muted text-muted-foreground'],
      }, SUPPLIER_STATUS_LABELS[status])
    },
  },
  { accessorKey: 'created_at', header: '创建时间', cell: (info: any) => info.getValue()?.slice(0, 10) },
  {
    id: 'operation',
    header: '操作',
    width: 140,
    align: 'center',
    fixed: 'right',
  },
])

async function load() {
  loading.value = true
  try {
    suppliers.value = await apiInventory.listSuppliers(tenantStore.currentTenantId)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载供应商失败')
  }
  finally {
    loading.value = false
  }
}

/** 归一化内嵌门店字段(PostgREST to-one 返回单对象;类型推断可能为数组) */
function storeNameOf(po: PurchaseOrderRow): string {
  const s = po.stores as unknown
  if (Array.isArray(s)) {
    return (s[0] as { name?: string } | undefined)?.name ?? '-'
  }
  return (s as { name?: string } | null)?.name ?? '-'
}

// 供应商为租户级主数据;切换租户后重载
watch(() => tenantStore.currentTenantId, () => {
  if (tenantStore.isReady) {
    load()
  }
})

onMounted(load)

// ===== 详情抽屉 =====
const detailVisible = ref(false)
const detailItem = ref<Supplier | null>(null)
const historyLoading = ref(false)
const purchaseHistory = ref<PurchaseOrderRow[]>([])

const detailDescriptions = computed(() => detailItem.value
  ? [
      { label: '供应商编码', value: detailItem.value.supplier_no },
      { label: '名称', value: detailItem.value.name },
      { label: '联系人', value: detailItem.value.contact_name ?? '-' },
      { label: '电话', value: detailItem.value.phone ?? '-' },
      { label: '地址', value: detailItem.value.address ?? '-' },
      { label: '统一社会信用代码', value: detailItem.value.unified_credit_code ?? '-' },
      { label: '账期', value: detailItem.value.payment_terms ?? '-' },
      { label: '类别', value: (detailItem.value.categories ?? []).join(' / ') || '-' },
      { label: '备注', value: detailItem.value.notes ?? '-' },
    ]
  : [])

async function openDetail(row: Supplier) {
  detailItem.value = row
  detailVisible.value = true
  historyLoading.value = true
  purchaseHistory.value = []
  try {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('id, po_no, status, total_cost, expected_at, created_at, stores(name)')
      .eq('supplier_id', row.id)
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) {
      throw new Error(error.message)
    }
    purchaseHistory.value = (data ?? []) as unknown as PurchaseOrderRow[]
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载采购历史失败')
  }
  finally {
    historyLoading.value = false
  }
}

// ===== 新建/编辑 =====
const formVisible = ref(false)
const editingId = ref('')
const submitting = ref(false)
const form = reactive({
  name: '',
  contactName: '',
  phone: '',
  address: '',
  unifiedCreditCode: '',
  paymentTerms: '',
  categories: '',
  notes: '',
})

function openCreate() {
  editingId.value = ''
  Object.assign(form, {
    name: '',
    contactName: '',
    phone: '',
    address: '',
    unifiedCreditCode: '',
    paymentTerms: '',
    categories: '',
    notes: '',
  })
  formVisible.value = true
}

function openEdit(row: Supplier) {
  editingId.value = row.id
  Object.assign(form, {
    name: row.name,
    contactName: row.contact_name ?? '',
    phone: row.phone ?? '',
    address: row.address ?? '',
    unifiedCreditCode: row.unified_credit_code ?? '',
    paymentTerms: row.payment_terms ?? '',
    categories: (row.categories ?? []).join(','),
    notes: row.notes ?? '',
  })
  formVisible.value = true
}

async function onSubmit() {
  if (!form.name.trim()) {
    useFaToast().warning('请填写供应商名称')
    return
  }
  submitting.value = true
  const payload = {
    tenantId: tenantStore.currentTenantId,
    name: form.name.trim(),
    contactName: form.contactName.trim() || undefined,
    phone: form.phone.trim() || undefined,
    address: form.address.trim() || undefined,
    unifiedCreditCode: form.unifiedCreditCode.trim() || undefined,
    paymentTerms: form.paymentTerms.trim() || undefined,
    categories: form.categories.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    notes: form.notes.trim() || undefined,
  }
  try {
    if (editingId.value) {
      await apiInventory.updateSupplier({ ...payload, id: editingId.value })
      useFaToast().success('供应商已更新')
    }
    else {
      await apiInventory.createSupplier(payload)
      useFaToast().success('供应商已创建')
    }
    formVisible.value = false
    await load()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    submitting.value = false
  }
}

async function onToggleStatus(row: Supplier) {
  const next = row.status === 'active' ? 'inactive' : 'active'
  try {
    await apiInventory.setSupplierStatus({
      id: row.id,
      tenantId: tenantStore.currentTenantId,
      status: next,
    })
    useFaToast().success(next === 'active' ? '已恢复使用' : '已停用')
    await load()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
}
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(参考优惠券界面布局) -->
    <!--
    <EntityPageHeader compact title="供应商管理" description="供应商主数据 · 采购来源">
      <template #actions>
        <FaInput v-model="keyword" placeholder="搜索名称/联系人/电话" class="w-56" clearable />
        <FaButton v-if="auth(SUPPLIER_PERMISSIONS.manage)" @click="openCreate">
          <FaIcon name="i-lucide:plus" />
          新增供应商
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
              <FaInput v-model="keyword" placeholder="搜索名称/联系人/电话" clearable class="w-52" @update:model-value="page = 1" />
              <span class="text-sm text-muted-foreground">共 {{ filtered.length }} 个供应商</span>
            </div>
            <div class="flex gap-2">
              <FaButton v-if="auth(SUPPLIER_PERMISSIONS.manage)" @click="openCreate">
                <FaIcon name="i-lucide:plus" />
                新增供应商
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
            :data="paged"
            empty-text="暂无供应商"
            @row-click="openDetail"
          >
            <template #cell-operation="{ row }">
              <div class="flex-center gap-1">
                <FaButton variant="outline" size="sm" :disabled="!auth(SUPPLIER_PERMISSIONS.manage)" @click.stop="openEdit(row.original)">
                  编辑
                </FaButton>
                <FaButton
                  variant="outline"
                  size="sm"
                  :disabled="!auth(SUPPLIER_PERMISSIONS.manage)"
                  :class="row.original.status === 'active' ? 'text-red-600' : 'text-green-600'"
                  @click.stop="onToggleStatus(row.original)"
                >
                  {{ row.original.status === 'active' ? '停用' : '启用' }}
                </FaButton>
              </div>
            </template>
          </FaTable>
        </div>
        <!-- 分页区 -->
        <FaPagination
          :page="page"
          :size="pageSize"
          :total="filtered.length"
          class="mt-2 px-4 pb-3 shrink-0"
          @page-change="p => { page = p }"
          @size-change="s => { pageSize = s; page = 1 }"
        />
      </div>
    </div>

    <!-- 详情抽屉 -->
    <FaDrawer v-model="detailVisible" :title="detailItem?.name ?? '供应商详情'" width="560px" :footer="false">
      <template v-if="detailItem">
        <FaDescriptions :items="detailDescriptions" label-width="120px" :column="1" />
        <div class="text-sm font-medium mb-2 mt-5">
          采购历史
        </div>
        <div v-loading="historyLoading" class="space-y-2">
          <div
            v-for="po in purchaseHistory"
            :key="po.id"
            class="text-sm px-3 py-2 border rounded-md flex items-center justify-between"
          >
            <div>
              <div class="font-medium">
                {{ po.po_no }}
              </div>
              <div class="text-xs text-muted-foreground">
                {{ storeNameOf(po) }} · {{ po.created_at?.slice(0, 10) }}
              </div>
            </div>
            <div class="text-right">
              <div class="text-xs text-muted-foreground">
                {{ po.status }}
              </div>
              <div class="font-medium tabular-nums">
                ¥{{ Number(po.total_cost).toFixed(2) }}
              </div>
            </div>
          </div>
          <EmptyState v-if="!historyLoading && purchaseHistory.length === 0" compact title="暂无采购记录" />
        </div>
      </template>
    </FaDrawer>

    <!-- 新建/编辑弹窗 -->
    <FaModal v-model="formVisible" :title="editingId ? '编辑供应商' : '新增供应商'" :footer="false" :close-on-click-overlay="false">
      <div class="py-2 space-y-4">
        <div class="gap-x-6 gap-y-4 grid grid-cols-2">
          <FaLabel label="名称 *" class="block">
            <FaInput v-model="form.name" placeholder="供应商名称" class="w-full" />
          </FaLabel>
          <FaLabel label="联系人" class="block">
            <FaInput v-model="form.contactName" placeholder="联系人(可选)" class="w-full" />
          </FaLabel>
          <FaLabel label="电话" class="block">
            <FaInput v-model="form.phone" placeholder="电话(可选)" class="w-full" />
          </FaLabel>
          <FaLabel label="账期" class="block">
            <FaInput v-model="form.paymentTerms" placeholder="如 月结 30 天(可选)" class="w-full" />
          </FaLabel>
          <FaLabel label="统一社会信用代码" class="block">
            <FaInput v-model="form.unifiedCreditCode" placeholder="信用代码(可选)" class="w-full" />
          </FaLabel>
          <FaLabel label="类别" class="block">
            <FaInput v-model="form.categories" placeholder="如 药品,耗材(逗号分隔)" class="w-full" />
          </FaLabel>
        </div>
        <FaLabel label="地址" class="block">
          <FaInput v-model="form.address" placeholder="地址(可选)" class="w-full" />
        </FaLabel>
        <FaLabel label="备注" class="block">
          <FaTextarea v-model="form.notes" placeholder="备注(可选)" class="w-full" :rows="2" />
        </FaLabel>
        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="formVisible = false">
            取消
          </FaButton>
          <FaButton :loading="submitting" @click="onSubmit">
            保存
          </FaButton>
        </div>
      </div>
    </FaModal>
  </div>
</template>
