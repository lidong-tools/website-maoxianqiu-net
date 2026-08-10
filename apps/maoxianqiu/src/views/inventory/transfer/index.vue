<script setup lang="ts">
import type { InventoryBalance, Warehouse } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'InventoryTransfer',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const submitting = ref(false)
const warehouses = ref<Warehouse[]>([])
const fromBalances = ref<InventoryBalance[]>([])
const toBalances = ref<InventoryBalance[]>([])
const catalogNameMap = ref<Record<string, string>>({})
const keyword = ref('')
const leftSelectedIds = ref<string[]>([])
const rightSelectedIds = ref<string[]>([])

interface TransferItem {
  catalogItemId: string
  quantity: number
}

const transferItems = ref<TransferItem[]>([])

const form = reactive({
  fromWarehouseId: '',
  toWarehouseId: '',
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

async function loadWarehouses() {
  try {
    const res = await apiInventory.listWarehouses(tenantStore.currentStoreId || undefined)
    warehouses.value = res.data.list
    if (warehouses.value.length > 0 && !form.fromWarehouseId) {
      form.fromWarehouseId = warehouses.value[0].id
    }
    if (warehouses.value.length > 1 && !form.toWarehouseId) {
      form.toWarehouseId = warehouses.value[1].id
    }
    await loadBalances()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载仓库失败')
  }
}

async function loadBalances() {
  const tasks: Promise<void>[] = []
  if (form.fromWarehouseId) {
    tasks.push(
      apiInventory.listBalances(form.fromWarehouseId)
        .then((res) => { fromBalances.value = res.data.list })
        .catch((e: any) => { useFaToast().error(e?.message || '加载源仓库余额失败') }),
    )
  }
  else {
    fromBalances.value = []
  }
  if (form.toWarehouseId) {
    tasks.push(
      apiInventory.listBalances(form.toWarehouseId)
        .then((res) => { toBalances.value = res.data.list })
        .catch((e: any) => { useFaToast().error(e?.message || '加载目标仓库余额失败') }),
    )
  }
  else {
    toBalances.value = []
  }
  loading.value = true
  await Promise.all(tasks)
  await enrichCatalog([...fromBalances.value, ...toBalances.value])
  const sourceCatalogItemIds = new Set(fromBalances.value.map(item => item.catalog_item_id))
  transferItems.value = transferItems.value.filter(item => sourceCatalogItemIds.has(item.catalogItemId))
  leftSelectedIds.value = []
  rightSelectedIds.value = rightSelectedIds.value.filter(id => sourceCatalogItemIds.has(id))
  loading.value = false
}

/** 获取指定商品的源仓可用库存 */
function sourceOnHand(catalogItemId: string) {
  const bal = fromBalances.value.find(b => b.catalog_item_id === catalogItemId)
  return bal?.quantity_on_hand ?? 0
}

/** 获取指定商品的目标仓当前库存 */
function targetOnHand(catalogItemId: string) {
  const bal = toBalances.value.find(b => b.catalog_item_id === catalogItemId)
  return bal?.quantity_on_hand ?? 0
}

const totalTransferQuantity = computed(() => transferItems.value.reduce((total, item) => total + item.quantity, 0))

/** 校验并逐项提交多商品调拨 */
async function onSubmit() {
  if (!form.fromWarehouseId || !form.toWarehouseId) {
    useFaToast().warning('请选择源仓库与目标仓库')
    return
  }
  if (form.fromWarehouseId === form.toWarehouseId) {
    useFaToast().warning('源仓库与目标仓库不能相同')
    return
  }
  if (!transferItems.value.length) {
    useFaToast().warning('请选择待调拨商品')
    return
  }
  const invalidQuantityItem = transferItems.value.find(item => item.quantity <= 0)
  if (invalidQuantityItem) {
    useFaToast().warning(`${nameOf(invalidQuantityItem.catalogItemId)} 的调拨数量必须大于 0`)
    return
  }
  const insufficientItem = transferItems.value.find(item => item.quantity > sourceOnHand(item.catalogItemId))
  if (insufficientItem) {
    useFaToast().warning(`${nameOf(insufficientItem.catalogItemId)} 库存不足，源仓仅 ${sourceOnHand(insufficientItem.catalogItemId)}`)
    return
  }
  submitting.value = true
  const succeededIds: string[] = []
  try {
    for (const item of transferItems.value) {
      try {
        await apiInventory.transfer({
          tenantId: tenantStore.currentTenantId,
          fromWarehouseId: form.fromWarehouseId,
          toWarehouseId: form.toWarehouseId,
          catalogItemId: item.catalogItemId,
          quantity: item.quantity,
        }, generateIdempotencyKey())
        succeededIds.push(item.catalogItemId)
      }
      catch {
        // 单项失败时继续提交其余商品，失败项保留在待调拨区
      }
    }
    transferItems.value = transferItems.value.filter(item => !succeededIds.includes(item.catalogItemId))
    rightSelectedIds.value = []
    if (succeededIds.length) {
      useFaToast().success(`已成功调拨 ${succeededIds.length} 项商品`)
    }
    if (transferItems.value.length) {
      useFaToast().warning(`${transferItems.value.length} 项商品调拨失败，已保留在待调拨区`)
    }
    await loadBalances()
  }
  finally {
    submitting.value = false
  }
}

// ===== 穿梭选择:源仓库存筛选 + 多商品调拨 =====
const fromPage = ref(1)
const fromSize = ref(10)

/** 按商品名称或编号筛选源仓库存 */
const filteredFromBalances = computed(() => {
  const transferredCatalogItemIds = new Set(transferItems.value.map(item => item.catalogItemId))
  const normalizedKeyword = keyword.value.trim().toLowerCase()
  return fromBalances.value.filter((balance) => {
    if (transferredCatalogItemIds.has(balance.catalog_item_id)) {
      return false
    }
    if (!normalizedKeyword) {
      return true
    }
    const catalogItemId = balance.catalog_item_id.toLowerCase()
    const catalogName = nameOf(balance.catalog_item_id).toLowerCase()
    return catalogItemId.includes(normalizedKeyword) || catalogName.includes(normalizedKeyword)
  })
})

/** 源仓库余额(前端分页) */
const pagedFromBalances = computed(() => {
  const start = (fromPage.value - 1) * fromSize.value
  return filteredFromBalances.value.slice(start, start + fromSize.value)
})

const leftPageCheckState = computed<boolean | 'indeterminate'>(() => {
  const pageIds = pagedFromBalances.value.map(item => item.catalog_item_id)
  const selectedCount = pageIds.filter(id => leftSelectedIds.value.includes(id)).length
  if (!selectedCount) {
    return false
  }
  return selectedCount === pageIds.length ? true : 'indeterminate'
})

const rightCheckState = computed<boolean | 'indeterminate'>(() => {
  const selectedCount = transferItems.value.filter(item => rightSelectedIds.value.includes(item.catalogItemId)).length
  if (!selectedCount) {
    return false
  }
  return selectedCount === transferItems.value.length ? true : 'indeterminate'
})

/** 切换左侧商品的勾选状态 */
function toggleLeftSelection(catalogItemId: string, checked: boolean) {
  leftSelectedIds.value = checked
    ? [...new Set([...leftSelectedIds.value, catalogItemId])]
    : leftSelectedIds.value.filter(id => id !== catalogItemId)
}

/** 切换右侧商品的勾选状态 */
function toggleRightSelection(catalogItemId: string, checked: boolean) {
  rightSelectedIds.value = checked
    ? [...new Set([...rightSelectedIds.value, catalogItemId])]
    : rightSelectedIds.value.filter(id => id !== catalogItemId)
}

/** 全选或取消全选当前页源仓商品 */
function toggleCurrentSourcePage(checked: boolean) {
  const pageIds = pagedFromBalances.value.map(item => item.catalog_item_id)
  leftSelectedIds.value = checked
    ? [...new Set([...leftSelectedIds.value, ...pageIds])]
    : leftSelectedIds.value.filter(id => !pageIds.includes(id))
}

/** 全选或取消全选待调拨商品 */
function toggleAllTransferItems(checked: boolean) {
  rightSelectedIds.value = checked ? transferItems.value.map(item => item.catalogItemId) : []
}

/** 将勾选的源仓商品批量加入待调拨区 */
function addSelectedItems(catalogItemIds = leftSelectedIds.value) {
  const existingIds = new Set(transferItems.value.map(item => item.catalogItemId))
  const newItems = catalogItemIds
    .filter(id => !existingIds.has(id))
    .map(catalogItemId => ({ catalogItemId, quantity: 1 }))
  transferItems.value.push(...newItems)
  leftSelectedIds.value = leftSelectedIds.value.filter(id => !catalogItemIds.includes(id))
}

/** 将右侧勾选商品批量移回源仓列表 */
function removeSelectedItems(catalogItemIds = rightSelectedIds.value) {
  transferItems.value = transferItems.value.filter(item => !catalogItemIds.includes(item.catalogItemId))
  rightSelectedIds.value = rightSelectedIds.value.filter(id => !catalogItemIds.includes(id))
}

// 数据变化时修正越界页码
watch(filteredFromBalances, () => {
  const maxPage = Math.max(1, Math.ceil(filteredFromBalances.value.length / fromSize.value))
  if (fromPage.value > maxPage) {
    fromPage.value = maxPage
  }
})

watch(() => [form.fromWarehouseId, form.toWarehouseId], () => {
  loadBalances()
})

// P1(审计 25):未保存内容保护 - 待调拨区存在商品时视为 dirty
const transferGuard = usePageUnsavedGuard('inventory-transfer')
watch(transferItems, items => transferGuard.setDirty(items.length > 0), { deep: true, immediate: true })

// P0-06:切店后清空仓库选择并按新门店重载
useStoreScopedPage({
  load: loadWarehouses,
  reset: () => {
    form.fromWarehouseId = ''
    form.toWarehouseId = ''
    leftSelectedIds.value = []
    rightSelectedIds.value = []
    transferItems.value = []
  },
})

onMounted(loadWarehouses)
</script>

<template>
  <!-- 绝对定位占满父容器,与回访任务等列表页保持内容区高度一致 -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <!-- 调拨内容保持为与其他业务列表一致的单块主区域 -->
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 穿梭选择区:左侧筛选源仓商品，右侧编辑待调拨商品 -->
        <div v-loading="loading" class="p-4 flex flex-1 flex-col gap-3 min-h-0 lg:flex-row">
          <section class="border rounded-lg flex flex-1 flex-col min-h-[360px] min-w-0 overflow-hidden">
            <div class="p-3 border-b bg-muted/30 flex gap-3 items-center justify-between">
              <div class="flex gap-3 items-center">
                <FaCheckbox
                  :model-value="leftPageCheckState"
                  :disabled="pagedFromBalances.length === 0"
                  @change="checked => toggleCurrentSourcePage(checked === true)"
                />
                <div>
                  <div class="text-sm font-medium">
                    源仓可调拨商品
                  </div>
                  <div class="text-xs text-muted-foreground">
                    可勾选多个商品批量加入
                  </div>
                </div>
              </div>
              <span class="text-xs text-muted-foreground">
                已选 {{ leftSelectedIds.length }} / {{ filteredFromBalances.length }} 项
              </span>
            </div>
            <div class="p-3 border-b">
              <FaInput
                v-model="keyword"
                placeholder="搜索商品名称或编号"
                clearable
                class="w-full"
                @update:model-value="fromPage = 1"
              >
                <template #start>
                  <FaIcon name="i-lucide:search" class="text-muted-foreground" />
                </template>
              </FaInput>
            </div>
            <div class="flex-1 min-h-0 overflow-auto">
              <div
                v-for="balance in pagedFromBalances"
                :key="balance.id"
                role="button"
                tabindex="0"
                class="px-4 py-3 border-b flex cursor-pointer transition-colors items-center hover:bg-muted/50"
                :class="leftSelectedIds.includes(balance.catalog_item_id) ? 'bg-primary/8' : ''"
                @click="toggleLeftSelection(balance.catalog_item_id, !leftSelectedIds.includes(balance.catalog_item_id))"
                @dblclick="addSelectedItems([balance.catalog_item_id])"
                @keydown.enter="toggleLeftSelection(balance.catalog_item_id, !leftSelectedIds.includes(balance.catalog_item_id))"
                @keydown.space.prevent="toggleLeftSelection(balance.catalog_item_id, !leftSelectedIds.includes(balance.catalog_item_id))"
              >
                <FaCheckbox
                  :model-value="leftSelectedIds.includes(balance.catalog_item_id)"
                  class="mr-3 shrink-0"
                  @click.stop
                  @change="checked => toggleLeftSelection(balance.catalog_item_id, checked === true)"
                />
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium truncate">
                    {{ nameOf(balance.catalog_item_id) }}
                  </div>
                  <div class="text-xs text-muted-foreground">
                    {{ balance.catalog_item_id.slice(0, 8) }}
                  </div>
                </div>
                <div class="ml-auto pl-4 text-right">
                  <div class="text-sm font-semibold tabular-nums">
                    {{ balance.quantity_on_hand }}
                  </div>
                  <div class="text-xs text-muted-foreground">
                    可用库存
                  </div>
                </div>
              </div>
              <FaEmpty
                v-if="filteredFromBalances.length === 0"
                title="暂无可调拨商品"
                description="请更换源仓库或调整搜索条件"
                class="py-12"
              />
            </div>
            <FaPagination
              :page="fromPage"
              :size="fromSize"
              :total="filteredFromBalances.length"
              layout="total, sizes, ->, pager"
              class="p-3 border-t"
              @page-change="p => { fromPage = p }"
              @size-change="s => { fromSize = s; fromPage = 1 }"
            />
          </section>

          <div class="flex shrink-0 gap-2 items-center justify-center lg:flex-col lg:w-12">
            <FaButton
              size="icon-sm"
              :disabled="leftSelectedIds.length === 0"
              :title="`加入 ${leftSelectedIds.length} 项商品`"
              @click="addSelectedItems()"
            >
              <FaIcon name="i-lucide:chevron-right" class="hidden lg:block" />
              <FaIcon name="i-lucide:chevron-down" class="lg:hidden" />
            </FaButton>
            <FaButton
              size="icon-sm"
              variant="outline"
              :disabled="rightSelectedIds.length === 0"
              :title="`移回 ${rightSelectedIds.length} 项商品`"
              @click="removeSelectedItems()"
            >
              <FaIcon name="i-lucide:chevron-left" class="hidden lg:block" />
              <FaIcon name="i-lucide:chevron-up" class="lg:hidden" />
            </FaButton>
          </div>

          <section class="border rounded-lg flex flex-1 flex-col min-h-[360px] min-w-0 overflow-hidden">
            <div class="p-3 border-b bg-muted/30 flex items-center justify-between">
              <div class="flex gap-3 items-center">
                <FaCheckbox
                  :model-value="rightCheckState"
                  :disabled="transferItems.length === 0"
                  @change="checked => toggleAllTransferItems(checked === true)"
                />
                <div>
                  <div class="text-sm font-medium">
                    待调拨商品
                  </div>
                  <div class="text-xs text-muted-foreground">
                    分别设置本次调拨数量
                  </div>
                </div>
              </div>
              <span class="text-xs text-muted-foreground">
                已选 {{ rightSelectedIds.length }} / {{ transferItems.length }} 项
              </span>
            </div>

            <div v-if="transferItems.length" class="flex-1 min-h-0 overflow-auto">
              <div
                v-for="item in transferItems"
                :key="item.catalogItemId"
                class="p-4 border-b transition-colors"
                :class="rightSelectedIds.includes(item.catalogItemId) ? 'bg-primary/8' : ''"
              >
                <div class="flex gap-3 items-start">
                  <FaCheckbox
                    :model-value="rightSelectedIds.includes(item.catalogItemId)"
                    class="mt-2 shrink-0"
                    @change="checked => toggleRightSelection(item.catalogItemId, checked === true)"
                  />
                  <div class="rounded-md bg-primary/10 flex shrink-0 h-10 w-10 items-center justify-center">
                    <FaIcon name="i-lucide:package" class="text-primary" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-semibold truncate">
                      {{ nameOf(item.catalogItemId) }}
                    </div>
                    <div class="text-xs text-muted-foreground">
                      {{ item.catalogItemId.slice(0, 8) }}
                    </div>
                  </div>
                  <FaButton size="icon-sm" variant="ghost" title="移除" @click="removeSelectedItems([item.catalogItemId])">
                    <FaIcon name="i-lucide:x" />
                  </FaButton>
                </div>

                <div class="mt-3 pl-13 gap-3 grid grid-cols-[minmax(0,1fr)_auto] items-end">
                  <FaLabel label="调拨数量">
                    <FaInputNumber
                      v-model="item.quantity"
                      :min="1"
                      :max="sourceOnHand(item.catalogItemId)"
                      class="w-full"
                    />
                  </FaLabel>
                  <div class="text-xs text-muted-foreground pb-2 whitespace-nowrap">
                    源仓 {{ sourceOnHand(item.catalogItemId) }} · 目标仓 {{ targetOnHand(item.catalogItemId) }}
                    <span class="text-primary font-medium">→ {{ targetOnHand(item.catalogItemId) + item.quantity }}</span>
                  </div>
                </div>
              </div>
            </div>
            <FaEmpty
              v-else
              title="尚未选择商品"
              description="从左侧勾选一个或多个商品加入待调拨区"
              class="py-12 flex-1"
            />
          </section>
        </div>
      </div>
    </div>

    <WorkflowFixedBar>
      <template #left>
        <div class="flex gap-2 items-center">
          <FaIcon name="i-lucide:warehouse" class="text-muted-foreground" />
          <span class="text-sm font-medium whitespace-nowrap">源仓库</span>
          <FaSelect
            v-model="form.fromWarehouseId"
            placeholder="选择源仓"
            class="w-40"
            :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
          />
          <FaIcon name="i-lucide:arrow-right" class="text-primary" />
          <span class="text-sm font-medium whitespace-nowrap">目标仓库</span>
          <FaSelect
            v-model="form.toWarehouseId"
            placeholder="选择目标仓"
            class="w-40"
            :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
          />
          <span class="text-sm text-muted-foreground ml-2">
            待调拨 <span class="text-foreground font-semibold">{{ transferItems.length }}</span> 项
            <template v-if="transferItems.length"> · 合计 {{ totalTransferQuantity }}</template>
          </span>
        </div>
      </template>
      <template #right>
        <FaButton size="sm" variant="outline" @click="loadBalances">
          <FaIcon name="i-lucide:refresh-cw" />
          刷新库存
        </FaButton>
        <FaButton size="sm" :loading="submitting" :disabled="transferItems.length === 0" @click="onSubmit">
          <FaIcon name="i-lucide:arrow-left-right" />
          确认调拨（{{ transferItems.length }}）
        </FaButton>
      </template>
    </WorkflowFixedBar>
  </div>
</template>
