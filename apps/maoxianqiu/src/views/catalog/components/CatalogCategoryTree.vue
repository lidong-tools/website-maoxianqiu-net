<script setup lang="ts">
import type { FormExpose } from '@fantastic-admin/components'
import type { CatalogCategory, CatalogCategoryNode } from '@/types/catalog'
import apiCatalog from '@/api/modules/catalog'
import CategoryTreeLevel from './CategoryTreeLevel.vue'

defineOptions({ name: 'CatalogCategoryTree' })

const props = defineProps<{
  tenantId: string
  categories: CatalogCategory[]
  loading?: boolean
  selectedId: string
}>()

const emit = defineEmits<{
  select: [id: string]
  updated: []
}>()

const commandLoading = ref(false)
const modalVisible = ref(false)
const editingCategory = ref<CatalogCategory | null>(null)
const targetParent = ref<CatalogCategoryNode | null>(null)
const formRef = useTemplateRef<FormExpose>('formRef')
const form = ref({ code: '', name: '', isActive: true })

const validationSchema = {
  code(value: string) {
    if (editingCategory.value) {
      return true
    }
    if (!value?.trim()) {
      return '请输入类目编码'
    }
    return /^[a-z0-9][\w-]*$/i.test(value.trim()) || '仅支持字母、数字、下划线和连字符'
  },
  name(value: string) {
    return value?.trim() ? true : '请输入类目名称'
  },
}

/** 将后端扁平记录稳定组装为最多三级的渲染树。 */
const categoryTree = computed<CatalogCategoryNode[]>(() => {
  const map = new Map<string, CatalogCategoryNode>()
  for (const row of props.categories) {
    map.set(row.id, { ...row, children: [] })
  }
  const roots: CatalogCategoryNode[] = []
  for (const node of map.values()) {
    const parent = node.parent_id ? map.get(node.parent_id) : undefined
    if (parent) {
      parent.children!.push(node)
    }
    else {
      roots.push(node)
    }
  }
  const sortNodes = (nodes: CatalogCategoryNode[]) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    nodes.forEach(node => sortNodes(node.children ?? []))
  }
  sortNodes(roots)
  return roots
})

/** 为每次类目写操作生成独立幂等键。 */
function newIdempotencyKey(action: string) {
  return `catalog-category:${action}:${crypto.randomUUID()}`
}

/** 打开新增类目弹窗,父节点为空时创建顶级类目。 */
function openCreate(parent: CatalogCategoryNode | null = null) {
  editingCategory.value = null
  targetParent.value = parent
  form.value = { code: '', name: '', isActive: true }
  modalVisible.value = true
}

/** 打开编辑弹窗,编码和树位置保持只读。 */
function openEdit(node: CatalogCategoryNode) {
  editingCategory.value = node
  targetParent.value = null
  form.value = { code: node.code, name: node.name, isActive: node.is_active }
  modalVisible.value = true
}

/** 校验并提交新增或编辑命令。 */
async function submitCategory() {
  const validation = await formRef.value?.validate()
  if (!validation?.valid || !props.tenantId) {
    return
  }
  commandLoading.value = true
  try {
    if (editingCategory.value) {
      await apiCatalog.updateCategory({
        id: editingCategory.value.id,
        tenantId: props.tenantId,
        name: form.value.name.trim(),
        isActive: form.value.isActive,
        idempotencyKey: newIdempotencyKey('update'),
      })
      useFaToast().success('类目已更新')
    }
    else {
      await apiCatalog.createCategory({
        tenantId: props.tenantId,
        code: form.value.code.trim(),
        name: form.value.name.trim(),
        parentId: targetParent.value?.id ?? null,
        idempotencyKey: newIdempotencyKey('create'),
      })
      useFaToast().success('类目已新增')
    }
    modalVisible.value = false
    emit('updated')
  }
  catch (error: unknown) {
    useFaToast().error((error as Error)?.message || '保存类目失败')
  }
  finally {
    commandLoading.value = false
  }
}

/** 删除前明确提示非空类目不会被级联删除。 */
function removeCategory(node: CatalogCategoryNode) {
  useFaModal().confirm({
    title: '删除类目',
    content: `确认删除“${node.name}”吗？含有子类目或目录项时系统会拒绝删除。`,
    onConfirm: async () => {
      commandLoading.value = true
      try {
        await apiCatalog.deleteCategory({
          id: node.id,
          tenantId: props.tenantId,
          idempotencyKey: newIdempotencyKey('delete'),
        })
        if (props.selectedId === node.id) {
          emit('select', '')
        }
        emit('updated')
        useFaToast().success('类目已删除')
      }
      catch (error: unknown) {
        useFaToast().error((error as Error)?.message || '删除类目失败')
      }
      finally {
        commandLoading.value = false
      }
    },
  })
}

/** 持久化同级排序或跨父级拖拽,失败后刷新恢复数据库状态。 */
async function moveCategory(payload: { categoryId: string, parentId: string | null, position: number }) {
  commandLoading.value = true
  try {
    await apiCatalog.moveCategory({
      tenantId: props.tenantId,
      ...payload,
      idempotencyKey: newIdempotencyKey('move'),
    })
    emit('updated')
    useFaToast().success('类目顺序已保存')
  }
  catch (error: unknown) {
    emit('updated')
    useFaToast().error((error as Error)?.message || '移动类目失败')
  }
  finally {
    commandLoading.value = false
  }
}
</script>

<template>
  <!-- content-class 需 flex-1 min-h-0,否则 CardContent 高度跟随内容,树列表滚动容器无参照高度 -->
  <FaCard class="shrink-0 h-full min-h-96 w-full xl:w-80" content-class="p-3 flex-1 min-h-0">
    <!-- 树内容:头部固定,类目列表区占满剩余高度并独立滚动,避免超出组件 -->
    <div v-loading="loading || commandLoading" class="flex h-full min-h-0 flex-col">
      <div
        class="text-sm mb-2 pr-2 rounded-md flex gap-1 min-h-9 transition-colors items-center shrink-0"
        :class="selectedId === '' ? 'bg-primary/10 text-primary' : 'hover:bg-muted'"
      >
        <FaButton
          variant="ghost"
          class="px-2 flex-1 gap-2 min-h-9 min-w-0 justify-start"
          @click="emit('select', '')"
        >
          <FaIcon name="i-ri:apps-line" />
          <span class="font-medium truncate">全部类目</span>
        </FaButton>
        <FaButton
          variant="ghost"
          size="icon-sm"
          aria-label="新增顶级类目"
          title="新增顶级类目"
          :disabled="!tenantId || commandLoading"
          @click.stop="openCreate()"
        >
          <FaIcon name="i-ri:add-line" />
        </FaButton>
        <FaTag variant="outline" size="sm">
          {{ categories.length }}
        </FaTag>
      </div>

      <!-- 类目树滚动区:内容超出高度时在卡片内滚动 -->
      <div class="flex-1 min-h-0 overflow-auto">
        <CategoryTreeLevel
          v-if="categoryTree.length"
          :nodes="categoryTree"
          :level="1"
          :parent-id="null"
          :selected-id="selectedId"
          :busy="commandLoading"
          @select="emit('select', $event)"
          @create="openCreate"
          @edit="openEdit"
          @remove="removeCategory"
          @move="moveCategory"
        />
        <FaEmpty v-else title="暂无类目" description="点击新增创建第一个顶级类目" />
      </div>
    </div>
  </FaCard>

  <FaModal
    v-model="modalVisible"
    :title="editingCategory ? '编辑类目' : '新增类目'"
    :description="editingCategory ? '名称和状态可修改，层级请通过树节点拖拽调整。' : `将创建在${targetParent ? `“${targetParent.name}”下` : '顶级'}。`"
    :show-confirm-button="false"
    :show-cancel-button="false"
    :close-on-click-overlay="false"
    :loading="commandLoading"
    align-center
  >
    <FaForm
      ref="formRef"
      :model="form"
      :validation-schema="validationSchema"
      label-placement="top"
      @submit="submitCategory"
    >
      <FaFormItem name="code" label="类目编码" required>
        <FaInput v-model="form.code" :disabled="!!editingCategory" placeholder="如 surgery_service" />
      </FaFormItem>
      <FaFormItem name="name" label="类目名称" required>
        <FaInput v-model="form.name" placeholder="如 外科服务" />
      </FaFormItem>
      <FaFormItem v-if="editingCategory" name="isActive" label="启用状态" :auto-bind="false">
        <div class="border-default px-3 py-2 border rounded-md flex items-center justify-between">
          <span class="text-sm text-muted-foreground">停用后保留数据，但不建议用于新目录项</span>
          <FaSwitch v-model="form.isActive" />
        </div>
      </FaFormItem>
    </FaForm>
    <template #footer>
      <div class="flex gap-2 justify-end">
        <FaButton variant="outline" :disabled="commandLoading" @click="modalVisible = false">
          取消
        </FaButton>
        <FaButton :loading="commandLoading" @click="submitCategory">
          保存
        </FaButton>
      </div>
    </template>
  </FaModal>
</template>
