<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  BillingType,
  CatalogCategory,
  CatalogItemWithRelations,
  DiagnosisDict,
  IntakeQuestion,
  LabPanel,
  LabPanelCategory,
  StoreCatalogItemWithCatalog,
} from '@/types/catalog'
import { FaInput } from '@fantastic-admin/components'
import apiCatalog from '@/api/modules/catalog'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  BILLING_TYPE_LABELS,
  LAB_PANEL_CATEGORY_LABELS,
} from '@/types/catalog'
import CatalogItemForm from './components/CatalogItemForm.vue'

defineOptions({
  name: 'CatalogManagement',
})

const tenantStore = useAppTenantStore()
const tabActive = ref<'items' | 'store' | 'intake' | 'diagnosis' | 'lab'>('items')

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
  { accessorKey: 'code', header: '编码', width: 120 },
  { accessorKey: 'name', header: '名称' },
  {
    accessorKey: 'category',
    header: '类目',
    cell: (info: any) => info.getValue()?.name ?? '未分类',
  },
  {
    accessorKey: 'billing_type',
    header: '收费类型',
    cell: (info: any) => BILLING_TYPE_LABELS[info.getValue() as BillingType] ?? info.getValue(),
  },
  { accessorKey: 'unit', header: '单位', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'default_price',
    header: '默认售价',
    cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: (info: any) => info.getValue() ? '启用' : '停用',
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
    return
  }
  itemLoading.value = true
  try {
    const res = await apiCatalog.listItems({
      tenantId: tenantStore.currentTenantId,
      categoryId: selectedCategoryId.value || undefined,
      keyword: itemFilters.value.keyword || undefined,
      billingType: itemFilters.value.billingType || undefined,
      isActive: itemFilters.value.isActive === '' ? undefined : itemFilters.value.isActive === 'true',
    })
    itemList.value = (res.data.list ?? []) as CatalogItemWithRelations[]
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载目录项失败')
  }
  finally {
    itemLoading.value = false
  }
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

// ==================== 门店价格覆盖 ====================
const storeItemLoading = ref(false)
const storeItemList = ref<StoreCatalogItemWithCatalog[]>([])
const storeFilters = ref({ keyword: '', isActive: '' as string })

const storeItemColumns = computed<TableColumn<StoreCatalogItemWithCatalog>[]>(() => [
  {
    accessorKey: 'catalog_item',
    header: '编码',
    cell: (info: any) => info.getValue()?.code ?? '-',
  },
  {
    accessorKey: 'catalog_item',
    header: '名称',
    cell: (info: any) => info.getValue()?.name ?? '-',
  },
  {
    accessorKey: 'custom_name',
    header: '门店自定义名称',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'custom_price',
    header: '门店价格',
    cell: (info: any) => {
      const v = info.getValue()
      return v != null ? `¥${Number(v).toFixed(2)}` : '-'
    },
  },
  {
    accessorKey: 'catalog_item',
    header: '默认售价',
    cell: (info: any) => {
      const v = info.getValue()?.default_price
      return v != null ? `¥${Number(v).toFixed(2)}` : '-'
    },
  },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: (info: any) => info.getValue() ? '启用' : '停用',
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
    return
  }
  storeItemLoading.value = true
  try {
    const res = await apiCatalog.listStoreItems({
      storeId: tenantStore.currentStoreId,
      keyword: storeFilters.value.keyword || undefined,
      isActive: storeFilters.value.isActive === '' ? undefined : storeFilters.value.isActive === 'true',
    })
    storeItemList.value = (res.data.list ?? []) as StoreCatalogItemWithCatalog[]
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载门店目录项失败')
  }
  finally {
    storeItemLoading.value = false
  }
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
    cell: (info: any) => info.getValue() ? '启用' : '停用',
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
    return
  }
  intakeLoading.value = true
  try {
    const res = await apiCatalog.listIntakeQuestions({
      tenantId: tenantStore.currentTenantId,
      category: intakeFilters.value.category || undefined,
      isActive: intakeFilters.value.isActive === '' ? undefined : intakeFilters.value.isActive === 'true',
    })
    intakeList.value = (res.data.list ?? []) as IntakeQuestion[]
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载问诊问题失败')
  }
  finally {
    intakeLoading.value = false
  }
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
  { accessorKey: 'category', header: '分类', width: 120, cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: (info: any) => info.getValue() ? '启用' : '停用',
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
    return
  }
  diagnosisLoading.value = true
  try {
    const res = await apiCatalog.listDiagnosisDict({
      tenantId: tenantStore.currentTenantId,
      keyword: diagnosisFilters.value.keyword || undefined,
      category: diagnosisFilters.value.category || undefined,
      isActive: diagnosisFilters.value.isActive === '' ? undefined : diagnosisFilters.value.isActive === 'true',
    })
    diagnosisList.value = (res.data.list ?? []) as DiagnosisDict[]
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载诊断字典失败')
  }
  finally {
    diagnosisLoading.value = false
  }
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
const labPanelList = ref<LabPanel[]>([])
const labFilters = ref({ category: '' as '' | LabPanelCategory, isActive: '' as string })

const labPanelColumns = computed<TableColumn<LabPanel>[]>(() => [
  { accessorKey: 'code', header: '编码', width: 120 },
  { accessorKey: 'name', header: '名称' },
  {
    accessorKey: 'category',
    header: '分类',
    cell: (info: any) => LAB_PANEL_CATEGORY_LABELS[info.getValue() as LabPanelCategory] ?? info.getValue(),
  },
  { accessorKey: 'sample_type', header: '样本类型', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: (info: any) => info.getValue() ? '启用' : '停用',
  },
  {
    id: 'operation',
    header: '操作',
    width: 140,
    align: 'center',
    fixed: 'right',
  },
])

/** 加载检验 panel 列表 */
async function loadLabPanels() {
  if (!tenantStore.currentTenantId) {
    labPanelList.value = []
    return
  }
  labLoading.value = true
  try {
    const res = await apiCatalog.listLabPanels({
      tenantId: tenantStore.currentTenantId,
      category: labFilters.value.category || undefined,
      isActive: labFilters.value.isActive === '' ? undefined : labFilters.value.isActive === 'true',
    })
    labPanelList.value = (res.data.list ?? []) as LabPanel[]
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载检验 panel 失败')
  }
  finally {
    labLoading.value = false
  }
}

/** 新增检验 panel */
function onCreateLabPanel() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  openSimpleFormModal('新增检验 panel', [
    { key: 'code', label: '编码', placeholder: '如 LP-001', required: true },
    { key: 'name', label: '名称', placeholder: '如 血常规', required: true },
    { key: 'sampleType', label: '样本类型', placeholder: '如 全血/血清/尿液' },
  ], async () => {
    try {
      await apiCatalog.createLabPanel({
        tenantId: tenantStore.currentTenantId,
        code: simpleFormState.value.code.trim(),
        name: simpleFormState.value.name.trim(),
        category: labFilters.value.category || undefined,
        sampleType: simpleFormState.value.sampleType?.trim() || undefined,
      })
      useFaToast().success('已创建')
      loadLabPanels()
      return true
    }
    catch (e: unknown) {
      useFaToast().error((e as Error)?.message || '创建失败')
      return false
    }
  })
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
  <div>
    <FaPageHeader title="目录管理" class="mb-0">
      <template #description>
        统一目录(类目/项目/药品疫苗扩展)、门店价格覆盖、问诊问题、诊断字典、检验 panel
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaTabs
        v-model="tabActive"
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
          <div class="flex gap-4">
            <!-- 类目树 -->
            <div class="p-3 border rounded-lg shrink-0 w-56">
              <div class="mb-2 flex items-center justify-between">
                <span class="font-medium">类目</span>
                <FaTag variant="outline" size="sm">
                  {{ categories.length }}
                </FaTag>
              </div>
              <div v-loading="categoryLoading" class="flex flex-col gap-1">
                <div
                  class="text-sm px-2 py-1.5 rounded cursor-pointer hover:bg-gray-100"
                  :class="selectedCategoryId === '' ? 'bg-primary-50 text-primary' : ''"
                  @click="onSelectCategory('')"
                >
                  全部
                </div>
                <div
                  v-for="c in categories"
                  :key="c.id"
                  class="text-sm px-2 py-1.5 rounded cursor-pointer hover:bg-gray-100"
                  :class="selectedCategoryId === c.id ? 'bg-primary-50 text-primary' : ''"
                  @click="onSelectCategory(c.id)"
                >
                  <FaIcon
                    :name="c.is_active ? 'i-ri:folder-line' : 'i-ri:folder-forbid-line'"
                    class="mr-1"
                    :class="c.is_active ? '' : 'text-gray-400'"
                  />
                  {{ c.name }}
                  <span class="text-xs text-gray-400">({{ c.code }})</span>
                </div>
              </div>
            </div>

            <!-- 目录项列表 -->
            <div class="flex-1 min-w-0">
              <FaSearchBar :show-toggle="false">
                <template #default>
                  <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
                    <FaLabel label="关键词" class="col-span-1">
                      <FaInput
                        v-model="itemFilters.keyword"
                        placeholder="名称/编码"
                        clearable
                        class="w-full"
                        @keydown.enter="loadItems"
                        @clear="loadItems"
                      />
                    </FaLabel>
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
                    <div class="flex gap-2 col-end--1 justify-end">
                      <FaButton variant="outline" @click="onResetItems">
                        重置
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
              <FaTable
                v-loading="itemLoading"
                table-root-class="rounded-lg overflow-hidden"
                row-key="id"
                stripe
                border
                :columns="itemColumns"
                :data="itemList"
              >
                <template #toolbar>
                  <FaButton type="primary" @click="onCreateItem">
                    <FaIcon name="i-ri:add-line" />
                    新增目录项
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
              </FaTable>
            </div>
          </div>
        </template>

        <!-- ==================== 门店价格 ==================== -->
        <template #store>
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
          <FaTable
            v-loading="storeItemLoading"
            table-root-class="rounded-lg overflow-hidden"
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
          </FaTable>
        </template>

        <!-- ==================== 问诊问题 ==================== -->
        <template #intake>
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
          <FaTable
            v-loading="intakeLoading"
            table-root-class="rounded-lg overflow-hidden"
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
          </FaTable>
        </template>

        <!-- ==================== 诊断字典 ==================== -->
        <template #diagnosis>
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
          <FaTable
            v-loading="diagnosisLoading"
            table-root-class="rounded-lg overflow-hidden"
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
          </FaTable>
        </template>

        <!-- ==================== 检验 panel ==================== -->
        <template #lab>
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
          <FaTable
            v-loading="labLoading"
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="labPanelColumns"
            :data="labPanelList"
          >
            <template #toolbar>
              <FaButton type="primary" @click="onCreateLabPanel">
                <FaIcon name="i-ri:add-line" />
                新增 panel
              </FaButton>
            </template>
            <template #cell-operation="{ row }">
              <div class="flex-center gap-2">
                <FaDropdown
                  :items="[[
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
          </FaTable>
        </template>
      </FaTabs>
    </FaPageMain>
  </div>
</template>
