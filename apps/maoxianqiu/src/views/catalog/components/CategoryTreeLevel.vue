<script setup lang="ts">
import type { CatalogCategoryNode } from '@/types/catalog'

defineOptions({ name: 'CategoryTreeLevel' })

const props = defineProps<{
  nodes: CatalogCategoryNode[]
  level: number
  parentId: string | null
  selectedId: string
  busy?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  create: [parent: CatalogCategoryNode]
  edit: [node: CatalogCategoryNode]
  remove: [node: CatalogCategoryNode]
  move: [payload: { categoryId: string, parentId: string | null, position: number }]
}>()

const listRef = useTemplateRef<HTMLElement>('listRef')
const expanded = reactive<Record<string, boolean>>({})
const dropTarget = ref<{ id: string, placement: 'before' | 'inside' | 'after' } | null>(null)

const CATEGORY_DRAG_TYPE = 'application/x-maoxianqiu-category'

interface DraggedCategory {
  id: string
  parentId: string | null
  sourceIndex: number
}

watch(() => props.nodes, (nodes) => {
  for (const node of nodes) {
    if (expanded[node.id] === undefined) {
      expanded[node.id] = true
    }
  }
}, { immediate: true, deep: true })

/** 仅接受本类目树产生的拖拽数据。 */
function isCategoryDrag(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes(CATEGORY_DRAG_TYPE)
}

/** 写入源节点位置，供跨父级和同级排序统一计算最终插入点。 */
function startDrag(event: DragEvent, node: CatalogCategoryNode, sourceIndex: number) {
  if (!event.dataTransfer || props.busy) {
    event.preventDefault()
    return
  }
  const payload: DraggedCategory = { id: node.id, parentId: node.parent_id, sourceIndex }
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData(CATEGORY_DRAG_TYPE, JSON.stringify(payload))
  event.dataTransfer.setData('text/plain', node.name)
}

/** 根据指针位于节点的上/中/下区域判定排序或换父级。 */
function resolvePlacement(event: DragEvent): 'before' | 'inside' | 'after' {
  const element = event.currentTarget as HTMLElement
  const rect = element.getBoundingClientRect()
  const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
  if (ratio < 0.25) {
    return 'before'
  }
  if (ratio > 0.75 || props.level >= 3) {
    return 'after'
  }
  return 'inside'
}

/** 标记当前精确落点并允许浏览器执行 move drop。 */
function dragOverNode(event: DragEvent, node: CatalogCategoryNode) {
  if (!isCategoryDrag(event)) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  dropTarget.value = { id: node.id, placement: resolvePlacement(event) }
}

/** 解析拖拽源，并按“移除源节点后的下标”修正同级插入位置。 */
function emitMove(event: DragEvent, parentId: string | null, rawPosition: number) {
  const raw = event.dataTransfer?.getData(CATEGORY_DRAG_TYPE)
  if (!raw) {
    return
  }
  const dragged = JSON.parse(raw) as DraggedCategory
  let position = rawPosition
  if (dragged.parentId === parentId && dragged.sourceIndex < position) {
    position -= 1
  }
  emit('move', { categoryId: dragged.id, parentId, position: Math.max(0, position) })
  dropTarget.value = null
}

/** 节点中部表示成为其子类目，上下边缘表示在该节点前后排序。 */
function dropOnNode(event: DragEvent, node: CatalogCategoryNode, targetIndex: number) {
  if (!isCategoryDrag(event)) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  const placement = resolvePlacement(event)
  const draggedRaw = event.dataTransfer?.getData(CATEGORY_DRAG_TYPE)
  const dragged = draggedRaw ? JSON.parse(draggedRaw) as DraggedCategory : null
  if (!dragged || dragged.id === node.id) {
    dropTarget.value = null
    return
  }
  if (placement === 'inside' && props.level < 3) {
    expanded[node.id] = true
    emitMove(event, node.id, node.children?.length ?? 0)
    return
  }
  emitMove(event, node.parent_id, targetIndex + (placement === 'after' ? 1 : 0))
}

/** 空白子列表也是有效接收区，可直接拖入没有子节点的父类目。 */
function dragOverList(event: DragEvent) {
  if (!isCategoryDrag(event)) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
}

function dropIntoList(event: DragEvent) {
  if (!isCategoryDrag(event)) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  emitMove(event, props.parentId, props.nodes.length)
}

/** 新增子类目时先展开目标节点,让创建结果立即可见。 */
function createChild(node: CatalogCategoryNode) {
  expanded[node.id] = true
  emit('create', node)
}
</script>

<template>
  <div
    ref="listRef"
    class="category-tree-list flex flex-col gap-1 min-h-8"
    :class="level > 1 ? 'ml-4 border-l border-default pl-2' : ''"
    :data-parent-id="parentId ?? ''"
    @dragover="dragOverList"
    @drop="dropIntoList"
  >
    <div v-if="nodes.length === 0 && level > 1" class="text-[11px] text-muted-foreground/70 px-2 py-1 pointer-events-none">
      拖到此处作为子类目
    </div>
    <div
      v-for="(node, nodeIndex) in nodes"
      :key="node.id"
      class="category-tree-node"
      :data-category-id="node.id"
      :draggable="!busy"
      @dragstart.stop="startDrag($event, node, nodeIndex)"
      @dragend="dropTarget = null"
    >
      <div
        class="group px-1.5 rounded-md flex gap-1 min-h-9 cursor-pointer transition-colors items-center"
        :class="[
          selectedId === node.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
          dropTarget?.id === node.id && dropTarget.placement === 'inside' ? 'ring-2 ring-primary bg-primary/10' : '',
          dropTarget?.id === node.id && dropTarget.placement === 'before' ? 'border-t-2 border-t-primary' : '',
          dropTarget?.id === node.id && dropTarget.placement === 'after' ? 'border-b-2 border-b-primary' : '',
        ]"
        @click="emit('select', node.id)"
        @dragover="dragOverNode($event, node)"
        @drop="dropOnNode($event, node, nodeIndex)"
        @dragleave="dropTarget?.id === node.id && (dropTarget = null)"
      >
        <FaButton
          v-if="level < 3"
          variant="ghost"
          size="icon"
          class="shrink-0 h-6 w-6"
          :aria-label="expanded[node.id] ? '收起子类目' : '展开子类目'"
          @click.stop="expanded[node.id] = !expanded[node.id]"
        >
          <FaIcon
            name="i-ri:arrow-right-s-line"
            class="transition-transform"
            :class="expanded[node.id] ? 'rotate-90' : ''"
          />
        </FaButton>
        <span v-else class="shrink-0 w-6" />

        <FaButton
          variant="ghost"
          size="icon"
          class="category-drag-handle shrink-0 h-6 w-6 cursor-grab active:cursor-grabbing"
          aria-label="拖拽类目"
          :disabled="busy"
          @click.stop
        >
          <FaIcon name="i-ri:draggable" />
        </FaButton>

        <FaIcon
          :name="node.is_active ? 'i-ri:folder-line' : 'i-ri:folder-forbid-line'"
          class="shrink-0"
          :class="node.is_active ? '' : 'text-muted-foreground'"
        />
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium truncate">
            {{ node.name }}
          </div>
          <div class="text-[11px] text-muted-foreground truncate">
            {{ node.code }} · 第 {{ level }} 级
          </div>
        </div>

        <div class="opacity-0 flex shrink-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <FaButton
            v-if="level < 3"
            variant="ghost"
            size="icon"
            class="h-7 w-7"
            aria-label="新增子类目"
            :disabled="busy"
            @click.stop="createChild(node)"
          >
            <FaIcon name="i-ri:add-line" />
          </FaButton>
          <FaButton
            variant="ghost"
            size="icon"
            class="h-7 w-7"
            aria-label="编辑类目"
            :disabled="busy"
            @click.stop="emit('edit', node)"
          >
            <FaIcon name="i-ri:edit-line" />
          </FaButton>
          <FaButton
            variant="ghost"
            size="icon"
            class="text-destructive h-7 w-7"
            aria-label="删除类目"
            :disabled="busy"
            @click.stop="emit('remove', node)"
          >
            <FaIcon name="i-ri:delete-bin-line" />
          </FaButton>
        </div>
      </div>

      <FaCollapsible v-if="level < 3" v-model="expanded[node.id]">
        <CategoryTreeLevel
          :nodes="node.children ?? []"
          :level="level + 1"
          :parent-id="node.id"
          :selected-id="selectedId"
          :busy="busy"
          @select="emit('select', $event)"
          @create="emit('create', $event)"
          @edit="emit('edit', $event)"
          @remove="emit('remove', $event)"
          @move="emit('move', $event)"
        />
      </FaCollapsible>
    </div>
  </div>
</template>
