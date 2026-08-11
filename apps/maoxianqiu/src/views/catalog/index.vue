<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  BillingType,
  CatalogCategory,
  CatalogItemWithRelations,
  DiagnosisDict,
  IntakeQuestion,
  LabAnalyte,
  LabPanel,
  LabPanelCategory,
  LabPanelWithAnalytes,
  StoreCatalogItemWithCatalog,
} from '@/types/catalog'
import { FaInput } from '@fantastic-admin/components'
import apiCatalog from '@/api/modules/catalog'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  BILLING_TYPE_LABELS,
  LAB_PANEL_CATEGORY_LABELS,
} from '@/types/catalog'
import CatalogCategoryTree from './components/CatalogCategoryTree.vue'
import CatalogItemForm from './components/CatalogItemForm.vue'

defineOptions({
  name: 'CatalogManagement',
})

const tenantStore = useAppTenantStore()
const tabActive = ref<'items' | 'store' | 'intake' | 'diagnosis' | 'lab'>('items')

// ==================== 分页状态(每个 tab 独立,避免切换时互相干扰) ====================
const { pagination: itemPagination, getParams: getItemParams, onSizeChange: onItemSizeChange, onCurrentChange: onItemCurrentChange } = usePagination()
const { pagination: storePagination, getParams: getStoreParams, onSizeChange: onStoreSizeChange, onCurrentChange: onStoreCurrentChange } = usePagination()
const { pagination: intakePagination, getParams: getIntakeParams, onSizeChange: onIntakeSizeChange, onCurrentChange: onIntakeCurrentChange } = usePagination()
const { pagination: diagnosisPagination, getParams: getDiagnosisParams, onSizeChange: onDiagnosisSizeChange, onCurrentChange: onDiagnosisCurrentChange } = usePagination()
const { pagination: labPagination, getParams: getLabParams, onSizeChange: onLabSizeChange, onCurrentChange: onLabCurrentChange } = usePagination()

// ==================== 类目与目录项 ====================
const categoryLoading = ref(false)
const categories = ref<CatalogCategory[]>([])
const selectedCategoryId = ref<string>('')
const itemLoading = ref(false)
const itemList = ref<CatalogItemWithRelations[]>([])
const itemFilters = ref({
  keyword: '',
  billingType: '' as '' | BillingType,
  isActive: '' as string,
})

const itemColumns = computed<TableColumn<CatalogItemWithRelations>[]>(() => [
  // B-R-1:批量迁移需要勾选项目,增加选择列
  { id: '__selection__', type: 'selection' },
  { accessorKey: 'code', header: '编码', width: 120 },
  { accessorKey: 'name', header: '名称' },
  {
    accessorKey: 'category',
    header: '类目',
    cell: info => (info.getValue() as { name?: string } | undefined)?.name ?? '未分类',
  },
  {
    accessorKey: 'billing_type',
    header: '收费类型',
    cell: info => BILLING_TYPE_LABELS[info.getValue() as BillingType] ?? info.getValue(),
  },
  { accessorKey: 'unit', header: '单位', cell: info => info.getValue() ?? '-' },
  {
    accessorKey: 'default_price',
    header: '默认售价',
    cell: info => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: info => info.getValue() ? '启用' : '停用',
  },
  {
    id: 'operation',
    header: '操作',
    width: 160,
    align: 'center',
    fixed: 'right',
  },
])

/** 加载类目列表 */
async function loadCategories() {
  if (!tenantStore.currentTenantId) {
    categories.value = []
    return
  }
  categoryLoading.value = true
  try {
    const res = await apiCatalog.listCategories({ tenantId: tenantStore.currentTenantId })
    categories.value = (res.data ?? []) as CatalogCategory[]
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载类目失败')
  }
  finally {
    categoryLoading.value = false
  }
}

/** 加载目录项列表 */
async function loadItems() {
  if (!tenantStore.currentTenantId) {
    itemList.value = []
    itemPagination.value.total = 0
    return
  }
  itemLoading.value = true
  try {
    const { from, limit } = getItemParams()
    const res = await apiCatalog.listItems({
      tenantId: tenantStore.currentTenantId,
      categoryId: selectedCategoryId.value || undefined,
      keyword: itemFilters.value.keyword || undefined,
      billingType: itemFilters.value.billingType || undefined,
      isActive: itemFilters.value.isActive === '' ? undefined : itemFilters.value.isActive === 'true',
      from,
      limit,
    })
    itemList.value = (res.data.list ?? []) as CatalogItemWithRelations[]
    itemPagination.value.total = res.data.total ?? 0
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载目录项失败')
  }
  finally {
    itemLoading.value = false
  }
}

/** 目录项分页切换(页码/每页条数变化后重新加载) */
function onItemPageChange(page: number) {
  onItemCurrentChange(page).then(() => loadItems())
}

/** 目录项每页条数切换 */
function onItemSizeChangeFn(size: number) {
  onItemSizeChange(size).then(() => loadItems())
}

/** 按类目筛选 */
function onSelectCategory(id: string) {
  selectedCategoryId.value = id
  loadItems()
}

/** 重置筛选 */
function onResetItems() {
  itemFilters.value.keyword = ''
  itemFilters.value.billingType = ''
  itemFilters.value.isActive = ''
  selectedCategoryId.value = ''
  loadItems()
}

// 目录项表单弹窗
const itemFormRef = ref<InstanceType<typeof CatalogItemForm>>()
const editingItem = ref<{ id: string, data: Record<string, unknown> } | null>(null)

const { open: openItemModal, update: updateItemModal } = useFaModal().create({
  destroyOnClose: true,
  closeOnClickOverlay: false,
  closeOnPressEscape: false,
  beforeClose: (action, done) => {
    if (action === 'confirm') {
      itemFormRef.value?.submit().then((success) => {
        if (!success) {
          return
        }
        loadItems()
        done()
      })
    }
    else {
      done()
    }
  },
  content: () => h(CatalogItemForm, {
    ref: itemFormRef,
    id: editingItem.value?.id,
    tenantId: tenantStore.currentTenantId,
    categoryId: selectedCategoryId.value || null,
    categories: categories.value,
    initialData: editingItem.value?.data,
  }),
})

/** 新增目录项 */
function onCreateItem() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  editingItem.value = null
  updateItemModal({ title: '新增目录项' })
  openItemModal()
}

/** 编辑目录项 */
function onEditItem(row: CatalogItemWithRelations) {
  editingItem.value = { id: row.id, data: row as unknown as Record<string, unknown> }
  updateItemModal({ title: '编辑目录项' })
  openItemModal()
}

/** 切换目录项启停状态(状态机:active ↔ inactive) */
function onToggleItemActive(row: CatalogItemWithRelations) {
  const next = !row.is_active
  apiCatalog.toggleItemActive(row.id, next).then(() => {
    useFaToast().success(next ? '已启用' : '已停用')
    loadItems()
  }).catch((e: unknown) => {
    useFaToast().error((e as Error)?.message || '操作失败')
  })
}

/** 删除目录项 */
function onDeleteItem(row: CatalogItemWithRelations) {
  useFaModal().confirm({
    title: '确认删除',
    content: `确认删除目录项「${row.name}」吗？关联的药品/疫苗扩展将一并删除。`,
    onConfirm: () => {
      apiCatalog.deleteItem(row.id).then(() => {
        useFaToast().success('删除成功')
        loadItems()
      }).catch((e: unknown) => {
        useFaToast().error((e as Error)?.message || '删除失败')
      })
    },
  })
}

// ==================== 目录项跨类目批量迁移(B-R-1) ====================
const selectedItemIds = ref<string[]>([])
const migrateModalVisible = ref(false)
const migrateTargetCategoryId = ref('')
const migrateSubmitting = ref(false)

/** 目录表格勾选变化时收集选中的项目 id(B-R-1) */
function onItemSelectionChange(rows: CatalogItemWithRelations[]) {
  selectedItemIds.value = rows.map(r => r.id)
}

/** 打开批量迁移弹窗:勾选项目 → 选择目标类目 → 确认执行(B-R-1) */
function onOpenMigrateItems() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  if (!selectedCategoryId.value) {
    useFaToast().warning('请先在左侧类目树选择来源类目')
    return
  }
  if (selectedItemIds.value.length === 0) {
    useFaToast().warning('请先勾选要迁移的项目')
    return
  }
  migrateTargetCategoryId.value = ''
  migrateModalVisible.value = true
}

/** 确认执行批量迁移(B-R-1,走 Hono Command + catalog_items_bulk_migrate RPC) */
async function onConfirmMigrateItems() {
  if (!migrateTargetCategoryId.value) {
    useFaToast().warning('请选择目标类目')
    return
  }
  migrateSubmitting.value = true
  try {
    const res = await apiCatalog.migrateItems({
      tenantId: tenantStore.currentTenantId,
      sourceCategoryId: selectedCategoryId.value,
      itemIds: selectedItemIds.value,
      targetCategoryId: migrateTargetCategoryId.value,
    })
    const result = res.data ?? res
    useFaToast().success(`迁移完成:成功 ${result.migratedCount ?? 0} 项,跳过 ${result.skippedCount ?? 0} 项`)
    migrateModalVisible.value = false
    selectedItemIds.value = []
    loadItems()
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '迁移失败')
  }
  finally {
    migrateSubmitting.value = false
  }
}

/** 导出目录 CSV(B-R-3,按当前筛选条件) */
async function onExportItems() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  try {
    await apiCatalog.exportItems({
      tenantId: tenantStore.currentTenantId,
      categoryId: selectedCategoryId.value || undefined,
      keyword: itemFilters.value.keyword || undefined,
      billingType: itemFilters.value.billingType || undefined,
    })
    useFaToast().success('导出成功')
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '导出失败')
  }
}

// ==================== 门店价格覆盖 ====================
const storeItemLoading = ref(false)
const storeItemList = ref<StoreCatalogItemWithCatalog[]>([])
const storeFilters = ref({ keyword: '', isActive: '' as string })

const storeItemColumns = computed<TableColumn<StoreCatalogItemWithCatalog>[]>(() => [
  {
    accessorKey: 'catalog_item',
    header: '编码',
    cell: info => (info.getValue() as { code?: string } | undefined)?.code ?? '-',
  },
  {
    accessorKey: 'catalog_item',
    header: '名称',
    cell: info => (info.getValue() as { name?: string } | undefined)?.name ?? '-',
  },
  {
    accessorKey: 'custom_name',
    header: '门店自定义名称',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'custom_price',
    header: '门店价格',
    cell: (info) => {
      const v = info.getValue()
      return v != null ? `¥${Number(v).toFixed(2)}` : '-'
    },
  },
  {
    accessorKey: 'catalog_item',
    header: '默认售价',
    cell: (info) => {
      const v = (info.getValue() as { default_price?: number } | undefined)?.default_price
      return v != null ? `¥${Number(v).toFixed(2)}` : '-'
    },
  },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: info => info.getValue() ? '启用' : '停用',
  },
  {
    id: 'operation',
    header: '操作',
    width: 140,
    align: 'center',
    fixed: 'right',
  },
])

/** 加载门店目录项列表 */
async function loadStoreItems() {
  if (!tenantStore.currentStoreId) {
    storeItemList.value = []
    storePagination.value.total = 0
    return
  }
  storeItemLoading.value = true
  try {
    const { from, limit } = getStoreParams()
    const res = await apiCatalog.listStoreItems({
      storeId: tenantStore.currentStoreId,
      keyword: storeFilters.value.keyword || undefined,
      isActive: storeFilters.value.isActive === '' ? undefined : storeFilters.value.isActive === 'true',
      from,
      limit,
    })
    storeItemList.value = (res.data.list ?? []) as StoreCatalogItemWithCatalog[]
    storePagination.value.total = res.data.total ?? 0
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载门店目录项失败')
  }
  finally {
    storeItemLoading.value = false
  }
}

/** 门店目录项分页切换 */
function onStorePageChange(page: number) {
  onStoreCurrentChange(page).then(() => loadStoreItems())
}

/** 门店目录项每页条数切换 */
function onStoreSizeChangeFn(size: number) {
  onStoreSizeChange(size).then(() => loadStoreItems())
}

/** 切换门店目录项启停状态 */
function onToggleStoreItemActive(row: StoreCatalogItemWithCatalog) {
  const next = !row.is_active
  apiCatalog.toggleStoreItemActive(row.id, next).then(() => {
    useFaToast().success(next ? '已启用' : '已停用')
    loadStoreItems()
  }).catch((e: unknown) => {
    useFaToast().error((e as Error)?.message || '操作失败')
  })
}

/** 删除门店目录项 */
function onDeleteStoreItem(row: StoreCatalogItemWithCatalog) {
  useFaModal().confirm({
    title: '确认删除',
    content: `确认删除门店目录项「${row.catalog_item?.name ?? ''}」吗？`,
    onConfirm: () => {
      apiCatalog.deleteStoreItem(row.id).then(() => {
        useFaToast().success('删除成功')
        loadStoreItems()
      }).catch((e: unknown) => {
        useFaToast().error((e as Error)?.message || '删除失败')
      })
    },
  })
}

/** 批量迁移租户目录到门店(MXQ-6005,走 Hono Command + RPC) */
function onMigrateToStore() {
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择租户与门店')
    return
  }
  useFaModal().confirm({
    title: '批量迁移到门店',
    content: '将租户目录下所有启用状态的目录项批量创建为门店项目(已存在的将跳过),是否继续？',
    onConfirm: () => {
      apiCatalog.migrateToStore({
        tenantId: tenantStore.currentTenantId,
        storeId: tenantStore.currentStoreId,
      }).then((res: any) => {
        const result = res.data ?? res
        useFaToast().success(`迁移完成:新增 ${result.insertedCount ?? 0} 项,总计 ${result.totalCount ?? 0} 项`)
        loadStoreItems()
      }).catch((e: unknown) => {
        useFaToast().error((e as Error)?.message || '迁移失败')
      })
    },
  })
}

// ==================== 简单表单弹窗(供问诊/诊断/panel 创建) ====================
interface SimpleFormField {
  key: string
  label: string
  placeholder?: string
  required?: boolean
}

const simpleFormState = ref<Record<string, string>>({})

/**
 * 打开简单表单弹窗(支持 1~N 个文本字段)
 * @param title 弹窗标题
 * @param fields 字段定义
 * @param onSubmit 提交回调,返回 true 关闭弹窗
 */
function openSimpleFormModal(
  title: string,
  fields: SimpleFormField[],
  onSubmit: () => Promise<boolean>,
) {
  simpleFormState.value = fields.reduce((acc, f) => {
    acc[f.key] = ''
    return acc
  }, {} as Record<string, string>)
  const { open } = useFaModal().create({
    title,
    closeOnClickOverlay: false,
    closeOnPressEscape: false,
    destroyOnClose: true,
    beforeClose: (action, done) => {
      if (action === 'confirm') {
        for (const f of fields) {
          if (f.required && !simpleFormState.value[f.key]?.trim()) {
            useFaToast().warning(`${f.label}不能为空`)
            return
          }
        }
        onSubmit().then((success) => {
          if (success) {
            done()
          }
        })
      }
      else {
        done()
      }
    },
    content: () => h('div', { class: 'flex flex-col gap-3 py-2' }, fields.map(f => h('div', { class: 'flex items-center gap-2' }, [
      h('label', { class: 'w-24 shrink-0 text-sm text-right' }, f.label),
      h(FaInput, {
        'modelValue': simpleFormState.value[f.key],
        'onUpdate:modelValue': (v: string | number | undefined) => { simpleFormState.value[f.key] = String(v ?? '') },
        'placeholder': f.placeholder ?? '',
        'class': 'flex-1',
      }),
    ]))),
  })
  open()
}

// ==================== 问诊问题库 ====================
const intakeLoading = ref(false)
const intakeList = ref<IntakeQuestion[]>([])
const intakeFilters = ref({ category: '', isActive: '' as string })

const intakeColumns = computed<TableColumn<IntakeQuestion>[]>(() => [
  { accessorKey: 'category', header: '分类', width: 120 },
  { accessorKey: 'question', header: '问题' },
  { accessorKey: 'sort_order', header: '排序', width: 80 },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: info => info.getValue() ? '启用' : '停用',
  },
  {
    id: 'operation',
    header: '操作',
    width: 140,
    align: 'center',
    fixed: 'right',
  },
])

/** 加载问诊问题列表 */
async function loadIntakeQuestions() {
  if (!tenantStore.currentTenantId) {
    intakeList.value = []
    intakePagination.value.total = 0
    return
  }
  intakeLoading.value = true
  try {
    const { page, size } = getIntakeParams()
    const res = await apiCatalog.listIntakeQuestions({
      tenantId: tenantStore.currentTenantId,
      category: intakeFilters.value.category || undefined,
      isActive: intakeFilters.value.isActive === '' ? undefined : intakeFilters.value.isActive === 'true',
      page,
      pageSize: size,
    })
    intakeList.value = (res.data.list ?? []) as IntakeQuestion[]
    intakePagination.value.total = res.data.total ?? 0
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载问诊问题失败')
  }
  finally {
    intakeLoading.value = false
  }
}

/** 问诊问题分页切换 */
function onIntakePageChange(page: number) {
  onIntakeCurrentChange(page).then(() => loadIntakeQuestions())
}

/** 问诊问题每页条数切换 */
function onIntakeSizeChangeFn(size: number) {
  onIntakeSizeChange(size).then(() => loadIntakeQuestions())
}

/** 新增问诊问题 */
function onCreateIntake() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  openSimpleFormModal('新增问诊问题', [
    { key: 'category', label: '分类', placeholder: '如 general/history/symptom' },
    { key: 'question', label: '问题', placeholder: '请输入问诊问题内容', required: true },
  ], async () => {
    try {
      await apiCatalog.createIntakeQuestion({
        tenantId: tenantStore.currentTenantId,
        category: simpleFormState.value.category?.trim() || intakeFilters.value.category || 'general',
        question: simpleFormState.value.question.trim(),
      })
      useFaToast().success('已创建')
      loadIntakeQuestions()
      return true
    }
    catch (e: unknown) {
      useFaToast().error((e as Error)?.message || '创建失败')
      return false
    }
  })
}

/** 切换问诊问题启停 */
function onToggleIntakeActive(row: IntakeQuestion) {
  apiCatalog.updateIntakeQuestion(row.id, { isActive: !row.is_active }).then(() => {
    useFaToast().success(row.is_active ? '已停用' : '已启用')
    loadIntakeQuestions()
  }).catch((e: unknown) => {
    useFaToast().error((e as Error)?.message || '操作失败')
  })
}

/** 删除问诊问题 */
function onDeleteIntake(row: IntakeQuestion) {
  useFaModal().confirm({
    title: '确认删除',
    content: `确认删除问诊问题「${row.question}」吗？`,
    onConfirm: () => {
      apiCatalog.deleteIntakeQuestion(row.id).then(() => {
        useFaToast().success('删除成功')
        loadIntakeQuestions()
      }).catch((e: unknown) => {
        useFaToast().error((e as Error)?.message || '删除失败')
      })
    },
  })
}

// ==================== 诊断字典 ====================
const diagnosisLoading = ref(false)
const diagnosisList = ref<DiagnosisDict[]>([])
const diagnosisFilters = ref({ keyword: '', category: '', isActive: '' as string })

const diagnosisColumns = computed<TableColumn<DiagnosisDict>[]>(() => [
  { accessorKey: 'code', header: '编码', width: 120 },
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'category', header: '分类', width: 120, cell: info => info.getValue() ?? '-' },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: info => info.getValue() ? '启用' : '停用',
  },
  {
    id: 'operation',
    header: '操作',
    width: 140,
    align: 'center',
    fixed: 'right',
  },
])

/** 加载诊断字典列表 */
async function loadDiagnosisDict() {
  if (!tenantStore.currentTenantId) {
    diagnosisList.value = []
    diagnosisPagination.value.total = 0
    return
  }
  diagnosisLoading.value = true
  try {
    const { page, size } = getDiagnosisParams()
    const res = await apiCatalog.listDiagnosisDict({
      tenantId: tenantStore.currentTenantId,
      keyword: diagnosisFilters.value.keyword || undefined,
      category: diagnosisFilters.value.category || undefined,
      isActive: diagnosisFilters.value.isActive === '' ? undefined : diagnosisFilters.value.isActive === 'true',
      page,
      pageSize: size,
    })
    diagnosisList.value = (res.data.list ?? []) as DiagnosisDict[]
    diagnosisPagination.value.total = res.data.total ?? 0
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载诊断字典失败')
  }
  finally {
    diagnosisLoading.value = false
  }
}

/** 诊断字典分页切换 */
function onDiagnosisPageChange(page: number) {
  onDiagnosisCurrentChange(page).then(() => loadDiagnosisDict())
}

/** 诊断字典每页条数切换 */
function onDiagnosisSizeChangeFn(size: number) {
  onDiagnosisSizeChange(size).then(() => loadDiagnosisDict())
}

/** 新增诊断 */
function onCreateDiagnosis() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  openSimpleFormModal('新增诊断', [
    { key: 'code', label: '编码', placeholder: '如 DX-001', required: true },
    { key: 'name', label: '名称', placeholder: '如 犬瘟热', required: true },
    { key: 'category', label: '分类', placeholder: '如 内科/外科/传染' },
  ], async () => {
    try {
      await apiCatalog.createDiagnosis({
        tenantId: tenantStore.currentTenantId,
        code: simpleFormState.value.code.trim(),
        name: simpleFormState.value.name.trim(),
        category: simpleFormState.value.category?.trim() || diagnosisFilters.value.category || undefined,
      })
      useFaToast().success('已创建')
      loadDiagnosisDict()
      return true
    }
    catch (e: unknown) {
      useFaToast().error((e as Error)?.message || '创建失败')
      return false
    }
  })
}

/** 切换诊断启停 */
function onToggleDiagnosisActive(row: DiagnosisDict) {
  apiCatalog.updateDiagnosis(row.id, { isActive: !row.is_active }).then(() => {
    useFaToast().success(row.is_active ? '已停用' : '已启用')
    loadDiagnosisDict()
  }).catch((e: unknown) => {
    useFaToast().error((e as Error)?.message || '操作失败')
  })
}

/** 删除诊断 */
function onDeleteDiagnosis(row: DiagnosisDict) {
  useFaModal().confirm({
    title: '确认删除',
    content: `确认删除诊断「${row.name}」吗？`,
    onConfirm: () => {
      apiCatalog.deleteDiagnosis(row.id).then(() => {
        useFaToast().success('删除成功')
        loadDiagnosisDict()
      }).catch((e: unknown) => {
        useFaToast().error((e as Error)?.message || '删除失败')
      })
    },
  })
}

// ==================== 检验 panel ====================
const labLoading = ref(false)
const labPanelList = ref<LabPanelWithAnalytes[]>([])
const labFilters = ref({ category: '' as '' | LabPanelCategory, isActive: '' as string })

const labPanelColumns = computed<TableColumn<LabPanelWithAnalytes>[]>(() => [
  { accessorKey: 'code', header: '编码', width: 120 },
  { accessorKey: 'name', header: '名称' },
  {
    accessorKey: 'category',
    header: '分类',
    cell: info => LAB_PANEL_CATEGORY_LABELS[info.getValue() as LabPanelCategory] ?? info.getValue(),
  },
  { accessorKey: 'sample_type', header: '样本类型', cell: info => info.getValue() ?? '-' },
  // B-R-5:展示关联收费项(编码/名称)
  {
    accessorKey: 'catalog_item',
    header: '关联收费项',
    cell: (info) => {
      const v = info.getValue() as { code?: string, name?: string } | null | undefined
      return v ? `${v.code ?? ''} ${v.name ?? ''}`.trim() : '-'
    },
  },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: info => info.getValue() ? '启用' : '停用',
  },
  {
    id: 'operation',
    header: '操作',
    width: 180,
    align: 'center',
    fixed: 'right',
  },
])

// exam 类型目录项(panel 关联收费项下拉,B-R-5)
const examItems = ref<CatalogItemWithRelations[]>([])

/** 加载 exam 类型目录项,供 panel 关联收费项下拉选择(B-R-5) */
async function loadExamItems() {
  if (!tenantStore.currentTenantId) {
    examItems.value = []
    return
  }
  try {
    const res = await apiCatalog.listItems({
      tenantId: tenantStore.currentTenantId,
      billingType: 'exam',
      limit: 500,
    })
    examItems.value = (res.data.list ?? []) as CatalogItemWithRelations[]
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载检验收费项失败')
  }
}

// panel 新增/编辑弹窗(B-R-5)
const panelModalVisible = ref(false)
const panelEditingId = ref<string | null>(null)
const panelForm = ref({ code: '', name: '', sampleType: '', catalogItemId: '' as string })
const panelSubmitting = ref(false)

/** 打开新增/编辑检验 panel 弹窗(含关联收费项下拉,B-R-5) */
function onOpenLabPanelModal(row?: LabPanelWithAnalytes) {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  if (examItems.value.length === 0) {
    loadExamItems()
  }
  panelEditingId.value = row?.id ?? null
  panelForm.value = {
    code: row?.code ?? '',
    name: row?.name ?? '',
    sampleType: row?.sample_type ?? '',
    catalogItemId: row?.catalog_item_id ?? '',
  }
  panelModalVisible.value = true
}

/** 确认保存检验 panel(新增/编辑,B-R-5) */
async function onConfirmLabPanel() {
  if (!panelForm.value.code.trim() || !panelForm.value.name.trim()) {
    useFaToast().warning('编码和名称不能为空')
    return
  }
  panelSubmitting.value = true
  try {
    const payload = {
      name: panelForm.value.name.trim(),
      sampleType: panelForm.value.sampleType?.trim() || undefined,
      catalogItemId: panelForm.value.catalogItemId || null,
    }
    if (panelEditingId.value) {
      await apiCatalog.updateLabPanel(panelEditingId.value, payload)
      useFaToast().success('已更新')
    }
    else {
      await apiCatalog.createLabPanel({
        tenantId: tenantStore.currentTenantId,
        code: panelForm.value.code.trim(),
        ...payload,
        category: labFilters.value.category || undefined,
      })
      useFaToast().success('已创建')
    }
    panelModalVisible.value = false
    loadLabPanels()
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '保存失败')
  }
  finally {
    panelSubmitting.value = false
  }
}

// ==================== analyte 管理(B-R-9 + G-R-4) ====================
const analyteModalVisible = ref(false)
const analytePanel = ref<LabPanelWithAnalytes | null>(null)
const analyteList = ref<LabAnalyte[]>([])
const analyteLoading = ref(false)

/** analyte 表格列(B-R-9;报告模板/外送标记为 G-R-4 字段) */
const analyteColumns = computed<TableColumn<LabAnalyte>[]>(() => [
  { accessorKey: 'code', header: '编码', width: 100 },
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'unit', header: '单位', width: 90, cell: info => info.getValue() ?? '-' },
  {
    accessorKey: 'ref_range_text',
    header: '参考范围',
    width: 110,
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'is_critical',
    header: '危急值',
    width: 80,
    cell: info => info.getValue() ? '是' : '否',
  },
  {
    accessorKey: 'is_outsourced',
    header: '外送',
    width: 80,
    cell: info => info.getValue() ? '是' : '否',
  },
  {
    accessorKey: 'report_template',
    header: '报告模板',
    cell: info => info.getValue() ?? '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 90,
    align: 'center',
    fixed: 'right',
  },
])

/** 打开 panel 的 analyte 明细管理弹窗(B-R-9,含报告模板/外送标记 G-R-4) */
async function onOpenAnalyteModal(row: LabPanelWithAnalytes) {
  analytePanel.value = row
  analyteModalVisible.value = true
  await loadAnalytes(row.id)
}

/** 加载 panel 下的 analyte 列表 */
async function loadAnalytes(panelId: string) {
  analyteLoading.value = true
  try {
    const res = await apiCatalog.listLabAnalytes({ panelId })
    analyteList.value = (res.data.list ?? []) as LabAnalyte[]
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载检验指标失败')
  }
  finally {
    analyteLoading.value = false
  }
}

// analyte 新增/编辑弹窗
const analyteFormVisible = ref(false)
const analyteEditingId = ref<string | null>(null)
const analyteForm = ref({
  code: '',
  name: '',
  unit: '',
  refRangeLow: undefined as number | undefined,
  refRangeHigh: undefined as number | undefined,
  refRangeText: '',
  isCritical: false,
  reportTemplate: '',
  isOutsourced: false,
})
const analyteSubmitting = ref(false)

/** 打开新增/编辑 analyte 弹窗 */
function onOpenAnalyteForm(row?: LabAnalyte) {
  analyteEditingId.value = row?.id ?? null
  analyteForm.value = {
    code: row?.code ?? '',
    name: row?.name ?? '',
    unit: row?.unit ?? '',
    refRangeLow: row?.ref_range_low ?? undefined,
    refRangeHigh: row?.ref_range_high ?? undefined,
    refRangeText: row?.ref_range_text ?? '',
    isCritical: row?.is_critical ?? false,
    reportTemplate: row?.report_template ?? '',
    isOutsourced: row?.is_outsourced ?? false,
  }
  analyteFormVisible.value = true
}

/** 确认保存 analyte(新增/编辑) */
async function onConfirmAnalyte() {
  if (!analytePanel.value) {
    return
  }
  if (!analyteForm.value.code.trim() || !analyteForm.value.name.trim()) {
    useFaToast().warning('编码和名称不能为空')
    return
  }
  analyteSubmitting.value = true
  try {
    const payload = {
      name: analyteForm.value.name.trim(),
      unit: analyteForm.value.unit?.trim() || undefined,
      refRangeLow: analyteForm.value.refRangeLow,
      refRangeHigh: analyteForm.value.refRangeHigh,
      refRangeText: analyteForm.value.refRangeText?.trim() || undefined,
      isCritical: analyteForm.value.isCritical,
      reportTemplate: analyteForm.value.reportTemplate?.trim() || undefined,
      isOutsourced: analyteForm.value.isOutsourced,
    }
    if (analyteEditingId.value) {
      await apiCatalog.updateLabAnalyte(analyteEditingId.value, payload)
      useFaToast().success('已更新')
    }
    else {
      await apiCatalog.createLabAnalyte({
        panelId: analytePanel.value.id,
        code: analyteForm.value.code.trim(),
        ...payload,
      })
      useFaToast().success('已创建')
    }
    analyteFormVisible.value = false
    await loadAnalytes(analytePanel.value.id)
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '保存失败')
  }
  finally {
    analyteSubmitting.value = false
  }
}

/** 删除 analyte */
function onDeleteAnalyte(row: LabAnalyte) {
  useFaModal().confirm({
    title: '确认删除',
    content: `确认删除检验指标「${row.name}」吗？`,
    onConfirm: () => {
      apiCatalog.deleteLabAnalyte(row.id).then(() => {
        useFaToast().success('删除成功')
        if (analytePanel.value) {
          loadAnalytes(analytePanel.value.id)
        }
      }).catch((e: unknown) => {
        useFaToast().error((e as Error)?.message || '删除失败')
      })
    },
  })
}

/** 加载检验 panel 列表 */
async function loadLabPanels() {
  if (!tenantStore.currentTenantId) {
    labPanelList.value = []
    labPagination.value.total = 0
    return
  }
  labLoading.value = true
  try {
    const { page, size } = getLabParams()
    const res = await apiCatalog.listLabPanels({
      tenantId: tenantStore.currentTenantId,
      category: labFilters.value.category || undefined,
      isActive: labFilters.value.isActive === '' ? undefined : labFilters.value.isActive === 'true',
      page,
      pageSize: size,
    })
    labPanelList.value = (res.data.list ?? []) as LabPanelWithAnalytes[]
    labPagination.value.total = res.data.total ?? 0
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载检验 panel 失败')
  }
  finally {
    labLoading.value = false
  }
}

/** 检验 panel 分页切换 */
function onLabPageChange(page: number) {
  onLabCurrentChange(page).then(() => loadLabPanels())
}

/** 检验 panel 每页条数切换 */
function onLabSizeChangeFn(size: number) {
  onLabSizeChange(size).then(() => loadLabPanels())
}

/** 切换 panel 启停 */
function onToggleLabPanelActive(row: LabPanel) {
  apiCatalog.updateLabPanel(row.id, { isActive: !row.is_active }).then(() => {
    useFaToast().success(row.is_active ? '已停用' : '已启用')
    loadLabPanels()
  }).catch((e: unknown) => {
    useFaToast().error((e as Error)?.message || '操作失败')
  })
}

/** 删除 panel(级联删除 analytes) */
function onDeleteLabPanel(row: LabPanel) {
  useFaModal().confirm({
    title: '确认删除',
    content: `确认删除检验 panel「${row.name}」吗？其下所有 analyte 将一并删除。`,
    onConfirm: () => {
      apiCatalog.deleteLabPanel(row.id).then(() => {
        useFaToast().success('删除成功')
        loadLabPanels()
      }).catch((e: unknown) => {
        useFaToast().error((e as Error)?.message || '删除失败')
      })
    },
  })
}

// ==================== 生命周期 ====================
watch(() => tenantStore.currentTenantId, () => {
  loadCategories()
  loadItems()
  loadIntakeQuestions()
  loadDiagnosisDict()
  loadLabPanels()
})

watch(() => tenantStore.currentStoreId, () => {
  if (tabActive.value === 'store') {
    loadStoreItems()
  }
})

watch(tabActive, (val) => {
  if (val === 'store' && storeItemList.value.length === 0) {
    loadStoreItems()
  }
})

onMounted(() => {
  loadCategories()
  loadItems()
})
</script>

<template>
  <!-- 绝对定位占满父容器,与回访任务等列表页保持内容区高度一致 -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告) -->
    <!--
    <EntityPageHeader compact title="目录管理" description="统一目录(类目/项目/药品疫苗扩展)、门店价格覆盖、问诊问题、诊断字典、检验 panel" />
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 左侧类目树 + 右侧内容区(tabs 标签位于右侧栏上方) -->
        <div class="p-4 flex flex-1 gap-4 min-h-0 xl:flex-row">
          <!-- 类目树:仅在"统一目录"tab 显示 -->
          <CatalogCategoryTree
            v-if="tabActive === 'items'"
            :tenant-id="tenantStore.currentTenantId"
            :categories="categories"
            :loading="categoryLoading"
            :selected-id="selectedCategoryId"
            @select="onSelectCategory"
            @updated="loadCategories"
          />
          <!-- 右侧栏:FaTabs 标签 + 各 tab 内容 -->
          <div class="flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
            <FaTabs
              v-model="tabActive"
              class="flex-1 min-h-0"
              content-class="flex-1 min-h-0 flex flex-col"
              :list="[
                { label: '统一目录', value: 'items' },
                { label: '门店价格', value: 'store' },
                { label: '问诊问题', value: 'intake' },
                { label: '诊断字典', value: 'diagnosis' },
                { label: '检验 panel', value: 'lab' },
              ]"
            >
              <!-- ==================== 统一目录 ==================== -->
              <template #items>
                <!-- 查询区固定,表格区占满剩余高度滚动 -->
                <div class="p-4 flex flex-1 flex-col min-h-0">
                  <FaSearchBar :show-toggle="false">
                    <template #default>
                      <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
                        <div class="flex gap-2 col-span-1 items-end">
                          <FaLabel label="关键词" class="flex-1">
                            <FaInput
                              v-model="itemFilters.keyword"
                              placeholder="名称/编码"
                              clearable
                              class="w-full"
                              @keydown.enter="loadItems"
                              @clear="loadItems"
                            />
                          </FaLabel>
                          <FaButton type="primary" class="shrink-0" @click="onCreateItem">
                            <FaIcon name="i-ri:add-line" />
                            新增目录项
                          </FaButton>
                        </div>
                        <!-- 注释掉收费类型筛选选择器(UI界面-人工测试报告) -->
                        <!--
                    <FaLabel label="收费类型" class="col-span-1">
                      <FaSelect
                        v-model="itemFilters.billingType"
                        :options="[
                          { label: '全部', value: '' },
                          { label: '服务', value: 'service' },
                          { label: '商品', value: 'product' },
                          { label: '药品', value: 'drug' },
                          { label: '疫苗', value: 'vaccine' },
                          { label: '检验', value: 'exam' },
                        ]"
                        class="w-full"
                        @change="loadItems"
                      />
                    </FaLabel>
                    <FaLabel label="状态" class="col-span-1">
                      <FaSelect
                        v-model="itemFilters.isActive"
                        :options="[
                          { label: '全部', value: '' },
                          { label: '启用', value: 'true' },
                          { label: '停用', value: 'false' },
                        ]"
                        class="w-full"
                        @change="loadItems"
                      />
                    </FaLabel>
                    -->
                        <div class="flex gap-2 col-end--1 justify-end">
                          <FaButton variant="outline" @click="onResetItems">
                            重置
                          </FaButton>
                          <!-- B-R-3:按当前筛选条件导出 CSV -->
                          <FaButton variant="outline" @click="onExportItems">
                            <FaIcon name="i-ri:download-2-line" />
                            导出
                          </FaButton>
                          <FaButton type="primary" @click="loadItems">
                            <FaIcon name="i-ri:search-line" />
                            筛选
                          </FaButton>
                        </div>
                      </div>
                    </template>
                  </FaSearchBar>
                  <div class="mx--4 my-3 border-t border-t-dashed" />
                  <!-- 表格区占满剩余高度,内部滚动 -->
                  <div v-loading="itemLoading" class="flex-1 min-h-0 overflow-hidden">
                    <FaTable
                      class="h-full min-h-0"
                      table-root-class="overflow-hidden"
                      row-key="id"
                      stripe
                      border
                      :columns="itemColumns"
                      :data="itemList"
                      :selectable="true"
                      :multiple="true"
                      @selection-change="onItemSelectionChange"
                    >
                      <template #toolbar>
                        <!-- B-R-1:勾选项目后批量迁移到目标类目 -->
                        <FaButton type="primary" variant="secondary" @click="onOpenMigrateItems">
                          <FaIcon name="i-ri:node-tree" />
                          批量迁移
                        </FaButton>
                      </template>
                      <template #cell-operation="{ row }">
                        <div class="flex-center gap-2">
                          <FaButton variant="outline" size="icon-sm" @click="onEditItem(row.original)">
                            <FaIcon name="i-ri:edit-line" />
                          </FaButton>
                          <FaDropdown
                            :items="[[
                              { label: row.original.is_active ? '停用' : '启用', handle: () => onToggleItemActive(row.original) },
                              { label: '删除', variant: 'destructive', handle: () => onDeleteItem(row.original) },
                            ]]"
                          >
                            <FaButton variant="outline" size="icon-sm">
                              <FaIcon name="i-ri:more-line" />
                            </FaButton>
                          </FaDropdown>
                        </div>
                      </template>
                      <template #empty>
                        <FaEmptyState description="暂无目录项" />
                      </template>
                    </FaTable>
                  </div>
                  <FaPagination :page="itemPagination.page" :size="itemPagination.size" :total="itemPagination.total" class="mt-2 shrink-0" @page-change="onItemPageChange" @size-change="onItemSizeChangeFn" />
                </div>
                <!-- B-R-1:目录项跨类目批量迁移弹窗 -->
                <FaModal v-model="migrateModalVisible" title="批量迁移目录项" :loading="migrateSubmitting" @confirm="onConfirmMigrateItems">
                  <div class="space-y-3 py-1">
                    <FaAlert type="info" :closable="false">
                      已勾选 <b>{{ selectedItemIds.length }}</b> 个目录项,将把当前类目下勾选的项目迁移到目标类目。
                    </FaAlert>
                    <FaLabel label="目标类目" required>
                      <FaSelect
                        v-model="migrateTargetCategoryId"
                        :options="[
                          { label: '请选择目标类目', value: '' },
                          ...categories.filter(c => c.id !== selectedCategoryId).map(c => ({ label: `${c.name}(${c.code})`, value: c.id })),
                        ]"
                        class="w-full"
                      />
                    </FaLabel>
                  </div>
                </FaModal>
              </template>

              <!-- ==================== 门店价格 ==================== -->
              <template #store>
                <!-- 查询区固定,表格区占满卡片剩余高度滚动 -->
                <div class="p-4 flex flex-1 flex-col min-h-0">
                  <FaSearchBar :show-toggle="false">
                    <template #default>
                      <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
                        <FaLabel label="当前门店" class="col-span-1">
                          <FaTag variant="default">
                            {{ tenantStore.currentStoreId ? '已选门店' : '未选择门店' }}
                          </FaTag>
                        </FaLabel>
                        <FaLabel label="关键词" class="col-span-1">
                          <FaInput
                            v-model="storeFilters.keyword"
                            placeholder="自定义名称/目录项名称"
                            clearable
                            class="w-full"
                            @keydown.enter="loadStoreItems"
                            @clear="loadStoreItems"
                          />
                        </FaLabel>
                        <FaLabel label="状态" class="col-span-1">
                          <FaSelect
                            v-model="storeFilters.isActive"
                            :options="[
                              { label: '全部', value: '' },
                              { label: '启用', value: 'true' },
                              { label: '停用', value: 'false' },
                            ]"
                            class="w-full"
                            @change="loadStoreItems"
                          />
                        </FaLabel>
                        <div class="flex gap-2 col-end--1 justify-end">
                          <FaButton variant="outline" @click="storeFilters.keyword = ''; storeFilters.isActive = ''; loadStoreItems()">
                            重置
                          </FaButton>
                          <FaButton type="primary" @click="loadStoreItems">
                            <FaIcon name="i-ri:search-line" />
                            筛选
                          </FaButton>
                        </div>
                      </div>
                    </template>
                  </FaSearchBar>
                  <div class="mx--4 my-3 border-t border-t-dashed" />
                  <!-- 表格区占满剩余高度,内部滚动 -->
                  <div v-loading="storeItemLoading" class="flex-1 min-h-0 overflow-hidden">
                    <FaTable
                      class="h-full min-h-0"
                      table-root-class="overflow-hidden"
                      row-key="id"
                      stripe
                      border
                      :columns="storeItemColumns"
                      :data="storeItemList"
                    >
                      <template #toolbar>
                        <FaButton type="primary" @click="onMigrateToStore">
                          <FaIcon name="i-ri:download-cloud-2-line" />
                          批量迁移到门店
                        </FaButton>
                        <FaButton variant="outline" @click="loadStoreItems">
                          <FaIcon name="i-ri:refresh-line" />
                          刷新
                        </FaButton>
                      </template>
                      <template #cell-operation="{ row }">
                        <div class="flex-center gap-2">
                          <FaDropdown
                            :items="[[
                              { label: row.original.is_active ? '停用' : '启用', handle: () => onToggleStoreItemActive(row.original) },
                              { label: '删除', variant: 'destructive', handle: () => onDeleteStoreItem(row.original) },
                            ]]"
                          >
                            <FaButton variant="outline" size="icon-sm">
                              <FaIcon name="i-ri:more-line" />
                            </FaButton>
                          </FaDropdown>
                        </div>
                      </template>
                      <template #empty>
                        <FaEmptyState description="暂无门店目录项" />
                      </template>
                    </FaTable>
                  </div>
                  <FaPagination :page="storePagination.page" :size="storePagination.size" :total="storePagination.total" class="mt-2 shrink-0" @page-change="onStorePageChange" @size-change="onStoreSizeChangeFn" />
                </div>
              </template>

              <!-- ==================== 问诊问题 ==================== -->
              <template #intake>
                <!-- 查询区固定,表格区占满卡片剩余高度滚动 -->
                <div class="p-4 flex flex-1 flex-col min-h-0">
                  <FaSearchBar :show-toggle="false">
                    <template #default>
                      <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
                        <FaLabel label="分类" class="col-span-1">
                          <FaInput
                            v-model="intakeFilters.category"
                            placeholder="如 general/history/symptom"
                            clearable
                            class="w-full"
                            @keydown.enter="loadIntakeQuestions"
                            @clear="loadIntakeQuestions"
                          />
                        </FaLabel>
                        <FaLabel label="状态" class="col-span-1">
                          <FaSelect
                            v-model="intakeFilters.isActive"
                            :options="[
                              { label: '全部', value: '' },
                              { label: '启用', value: 'true' },
                              { label: '停用', value: 'false' },
                            ]"
                            class="w-full"
                            @change="loadIntakeQuestions"
                          />
                        </FaLabel>
                        <div class="flex gap-2 col-end--1 justify-end">
                          <FaButton variant="outline" @click="intakeFilters.category = ''; intakeFilters.isActive = ''; loadIntakeQuestions()">
                            重置
                          </FaButton>
                          <FaButton type="primary" @click="loadIntakeQuestions">
                            <FaIcon name="i-ri:search-line" />
                            筛选
                          </FaButton>
                        </div>
                      </div>
                    </template>
                  </FaSearchBar>
                  <div class="mx--4 my-3 border-t border-t-dashed" />
                  <!-- 表格区占满剩余高度,内部滚动 -->
                  <div v-loading="intakeLoading" class="flex-1 min-h-0 overflow-hidden">
                    <FaTable
                      class="h-full min-h-0"
                      table-root-class="overflow-hidden"
                      row-key="id"
                      stripe
                      border
                      :columns="intakeColumns"
                      :data="intakeList"
                    >
                      <template #toolbar>
                        <FaButton type="primary" @click="onCreateIntake">
                          <FaIcon name="i-ri:add-line" />
                          新增问诊问题
                        </FaButton>
                      </template>
                      <template #cell-operation="{ row }">
                        <div class="flex-center gap-2">
                          <FaDropdown
                            :items="[[
                              { label: row.original.is_active ? '停用' : '启用', handle: () => onToggleIntakeActive(row.original) },
                              { label: '删除', variant: 'destructive', handle: () => onDeleteIntake(row.original) },
                            ]]"
                          >
                            <FaButton variant="outline" size="icon-sm">
                              <FaIcon name="i-ri:more-line" />
                            </FaButton>
                          </FaDropdown>
                        </div>
                      </template>
                      <template #empty>
                        <FaEmptyState description="暂无问诊问题" />
                      </template>
                    </FaTable>
                  </div>
                  <FaPagination :page="intakePagination.page" :size="intakePagination.size" :total="intakePagination.total" class="mt-2 shrink-0" @page-change="onIntakePageChange" @size-change="onIntakeSizeChangeFn" />
                </div>
              </template>

              <!-- ==================== 诊断字典 ==================== -->
              <template #diagnosis>
                <!-- 查询区固定,表格区占满卡片剩余高度滚动 -->
                <div class="p-4 flex flex-1 flex-col min-h-0">
                  <FaSearchBar :show-toggle="false">
                    <template #default>
                      <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
                        <FaLabel label="关键词" class="col-span-1">
                          <FaInput
                            v-model="diagnosisFilters.keyword"
                            placeholder="名称/编码"
                            clearable
                            class="w-full"
                            @keydown.enter="loadDiagnosisDict"
                            @clear="loadDiagnosisDict"
                          />
                        </FaLabel>
                        <FaLabel label="分类" class="col-span-1">
                          <FaInput
                            v-model="diagnosisFilters.category"
                            placeholder="如 内科/外科/传染"
                            clearable
                            class="w-full"
                            @keydown.enter="loadDiagnosisDict"
                            @clear="loadDiagnosisDict"
                          />
                        </FaLabel>
                        <FaLabel label="状态" class="col-span-1">
                          <FaSelect
                            v-model="diagnosisFilters.isActive"
                            :options="[
                              { label: '全部', value: '' },
                              { label: '启用', value: 'true' },
                              { label: '停用', value: 'false' },
                            ]"
                            class="w-full"
                            @change="loadDiagnosisDict"
                          />
                        </FaLabel>
                        <div class="flex gap-2 col-end--1 justify-end">
                          <FaButton
                            variant="outline"
                            @click="diagnosisFilters.keyword = ''; diagnosisFilters.category = ''; diagnosisFilters.isActive = ''; loadDiagnosisDict()"
                          >
                            重置
                          </FaButton>
                          <FaButton type="primary" @click="loadDiagnosisDict">
                            <FaIcon name="i-ri:search-line" />
                            筛选
                          </FaButton>
                        </div>
                      </div>
                    </template>
                  </FaSearchBar>
                  <div class="mx--4 my-3 border-t border-t-dashed" />
                  <!-- 表格区占满剩余高度,内部滚动 -->
                  <div v-loading="diagnosisLoading" class="flex-1 min-h-0 overflow-hidden">
                    <FaTable
                      class="h-full min-h-0"
                      table-root-class="overflow-hidden"
                      row-key="id"
                      stripe
                      border
                      :columns="diagnosisColumns"
                      :data="diagnosisList"
                    >
                      <template #toolbar>
                        <FaButton type="primary" @click="onCreateDiagnosis">
                          <FaIcon name="i-ri:add-line" />
                          新增诊断
                        </FaButton>
                      </template>
                      <template #cell-operation="{ row }">
                        <div class="flex-center gap-2">
                          <FaDropdown
                            :items="[[
                              { label: row.original.is_active ? '停用' : '启用', handle: () => onToggleDiagnosisActive(row.original) },
                              { label: '删除', variant: 'destructive', handle: () => onDeleteDiagnosis(row.original) },
                            ]]"
                          >
                            <FaButton variant="outline" size="icon-sm">
                              <FaIcon name="i-ri:more-line" />
                            </FaButton>
                          </FaDropdown>
                        </div>
                      </template>
                      <template #empty>
                        <FaEmptyState description="暂无诊断" />
                      </template>
                    </FaTable>
                  </div>
                  <FaPagination :page="diagnosisPagination.page" :size="diagnosisPagination.size" :total="diagnosisPagination.total" class="mt-2 shrink-0" @page-change="onDiagnosisPageChange" @size-change="onDiagnosisSizeChangeFn" />
                </div>
              </template>

              <!-- ==================== 检验 panel ==================== -->
              <template #lab>
                <!-- 查询区固定,表格区占满卡片剩余高度滚动 -->
                <div class="p-4 flex flex-1 flex-col min-h-0">
                  <FaSearchBar :show-toggle="false">
                    <template #default>
                      <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
                        <FaLabel label="分类" class="col-span-1">
                          <FaSelect
                            v-model="labFilters.category"
                            :options="[
                              { label: '全部', value: '' },
                              { label: '血液', value: 'blood' },
                              { label: '尿液', value: 'urine' },
                              { label: '生化', value: 'biochem' },
                              { label: '内分泌', value: 'endocrine' },
                              { label: '其他', value: 'other' },
                            ]"
                            class="w-full"
                            @change="loadLabPanels"
                          />
                        </FaLabel>
                        <FaLabel label="状态" class="col-span-1">
                          <FaSelect
                            v-model="labFilters.isActive"
                            :options="[
                              { label: '全部', value: '' },
                              { label: '启用', value: 'true' },
                              { label: '停用', value: 'false' },
                            ]"
                            class="w-full"
                            @change="loadLabPanels"
                          />
                        </FaLabel>
                        <div class="flex gap-2 col-end--1 justify-end">
                          <FaButton
                            variant="outline"
                            @click="labFilters.category = ''; labFilters.isActive = ''; loadLabPanels()"
                          >
                            重置
                          </FaButton>
                          <FaButton type="primary" @click="loadLabPanels">
                            <FaIcon name="i-ri:search-line" />
                            筛选
                          </FaButton>
                        </div>
                      </div>
                    </template>
                  </FaSearchBar>
                  <div class="mx--4 my-3 border-t border-t-dashed" />
                  <!-- 表格区占满剩余高度,内部滚动 -->
                  <div v-loading="labLoading" class="flex-1 min-h-0 overflow-hidden">
                    <FaTable
                      class="h-full min-h-0"
                      table-root-class="overflow-hidden"
                      row-key="id"
                      stripe
                      border
                      :columns="labPanelColumns"
                      :data="labPanelList"
                    >
                      <template #toolbar>
                        <FaButton type="primary" @click="onOpenLabPanelModal()">
                          <FaIcon name="i-ri:add-line" />
                          新增 panel
                        </FaButton>
                      </template>
                      <template #cell-operation="{ row }">
                        <div class="flex-center gap-2">
                          <FaButton variant="outline" size="icon-sm" @click="onOpenLabPanelModal(row.original)">
                            <FaIcon name="i-ri:edit-line" />
                          </FaButton>
                          <FaDropdown
                            :items="[[
                              { label: '指标明细', handle: () => onOpenAnalyteModal(row.original) },
                              { label: row.original.is_active ? '停用' : '启用', handle: () => onToggleLabPanelActive(row.original) },
                              { label: '删除', variant: 'destructive', handle: () => onDeleteLabPanel(row.original) },
                            ]]"
                          >
                            <FaButton variant="outline" size="icon-sm">
                              <FaIcon name="i-ri:more-line" />
                            </FaButton>
                          </FaDropdown>
                        </div>
                      </template>
                      <template #empty>
                        <FaEmptyState description="暂无检验 panel" />
                      </template>
                    </FaTable>
                  </div>
                  <FaPagination :page="labPagination.page" :size="labPagination.size" :total="labPagination.total" class="mt-2 shrink-0" @page-change="onLabPageChange" @size-change="onLabSizeChangeFn" />
                </div>

                <!-- B-R-5:panel 新增/编辑弹窗(含关联收费项下拉) -->
                <FaModal v-model="panelModalVisible" :title="panelEditingId ? '编辑检验 panel' : '新增检验 panel'" :loading="panelSubmitting" @confirm="onConfirmLabPanel">
                  <div class="gap-x-4 gap-y-3 grid grid-cols-2">
                    <FaLabel label="编码" required>
                      <FaInput v-model="panelForm.code" :disabled="!!panelEditingId" placeholder="如 LP-001" class="w-full" />
                    </FaLabel>
                    <FaLabel label="名称" required>
                      <FaInput v-model="panelForm.name" placeholder="如 血常规" class="w-full" />
                    </FaLabel>
                    <FaLabel label="样本类型">
                      <FaInput v-model="panelForm.sampleType" placeholder="如 全血/血清/尿液" class="w-full" />
                    </FaLabel>
                    <FaLabel label="关联收费项">
                      <FaSelect
                        v-model="panelForm.catalogItemId"
                        :options="[
                          { label: '不关联', value: '' },
                          ...examItems.map(i => ({ label: `${i.code} ${i.name}`, value: i.id })),
                        ]"
                        class="w-full"
                        placeholder="选择 exam 收费项"
                      />
                    </FaLabel>
                  </div>
                </FaModal>

                <!-- B-R-9/G-R-4:panel 指标明细(analyte)管理弹窗 -->
                <FaModal v-model="analyteModalVisible" :title="`指标明细 - ${analytePanel?.name ?? ''}`" :footer="false" width="820px">
                  <div class="flex flex-col gap-3">
                    <div class="flex justify-end">
                      <FaButton type="primary" @click="onOpenAnalyteForm()">
                        <FaIcon name="i-ri:add-line" />
                        新增指标
                      </FaButton>
                    </div>
                    <div v-loading="analyteLoading" class="max-h-96 overflow-auto">
                      <FaTable
                        row-key="id"
                        stripe
                        border
                        :columns="analyteColumns"
                        :data="analyteList"
                      >
                        <template #cell-operation="{ row }">
                          <div class="flex-center gap-2">
                            <FaButton variant="outline" size="icon-sm" @click="onOpenAnalyteForm(row.original)">
                              <FaIcon name="i-ri:edit-line" />
                            </FaButton>
                            <FaButton variant="outline" size="icon-sm" @click="onDeleteAnalyte(row.original)">
                              <FaIcon name="i-ri:delete-bin-line" />
                            </FaButton>
                          </div>
                        </template>
                        <template #empty>
                          <FaEmptyState description="暂无检验指标" />
                        </template>
                      </FaTable>
                    </div>
                  </div>
                </FaModal>

                <!-- analyte 新增/编辑弹窗(G-R-4:含报告模板/外送检测) -->
                <FaModal v-model="analyteFormVisible" :title="analyteEditingId ? '编辑检验指标' : '新增检验指标'" :loading="analyteSubmitting" @confirm="onConfirmAnalyte">
                  <div class="gap-x-4 gap-y-3 grid grid-cols-2">
                    <FaLabel label="编码" required>
                      <FaInput v-model="analyteForm.code" :disabled="!!analyteEditingId" placeholder="如 AT-001" class="w-full" />
                    </FaLabel>
                    <FaLabel label="名称" required>
                      <FaInput v-model="analyteForm.name" placeholder="如 WBC" class="w-full" />
                    </FaLabel>
                    <FaLabel label="单位">
                      <FaInput v-model="analyteForm.unit" placeholder="如 ×10⁹/L" class="w-full" />
                    </FaLabel>
                    <FaLabel label="参考范围(低)">
                      <FaInput v-model="analyteForm.refRangeLow" type="number" placeholder="如 4" class="w-full" />
                    </FaLabel>
                    <FaLabel label="参考范围(高)">
                      <FaInput v-model="analyteForm.refRangeHigh" type="number" placeholder="如 10" class="w-full" />
                    </FaLabel>
                    <FaLabel label="参考范围(文本)">
                      <FaInput v-model="analyteForm.refRangeText" placeholder="如 4-10" class="w-full" />
                    </FaLabel>
                    <FaLabel label="危急值">
                      <FaSwitch v-model="analyteForm.isCritical" />
                    </FaLabel>
                    <FaLabel label="外送检测">
                      <FaSwitch v-model="analyteForm.isOutsourced" />
                    </FaLabel>
                    <FaLabel label="报告模板" class="col-span-2">
                      <FaInput v-model="analyteForm.reportTemplate" placeholder="报告展示时的文本模板" class="w-full" />
                    </FaLabel>
                  </div>
                </FaModal>
              </template>
            </FaTabs>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
