<script setup lang="ts">
import type { InventoryBalance, Warehouse } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'
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

const form = reactive({
  fromWarehouseId: '',
  toWarehouseId: '',
  catalogItemId: '',
  quantity: 1,
})

async function enrichCatalog(rows: Array<{ catalog_item_id: string }>) {
  const ids = [...new Set(rows.map(r => r.catalog_item_id).filter(Boolean))]
  if (!ids.length) {
    return
  }
  const { data } = await supabase.from('catalog_items').select('id, name').in('id', ids)
  data?.forEach((c: any) => { catalogNameMap.value[c.id] = c.name })
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
  if (form.toWarehouseId) {
    tasks.push(
      apiInventory.listBalances(form.toWarehouseId)
        .then((res) => { toBalances.value = res.data.list })
        .catch((e: any) => { useFaToast().error(e?.message || '加载目标仓库余额失败') }),
    )
  }
  loading.value = true
  await Promise.all(tasks)
  await enrichCatalog([...fromBalances.value, ...toBalances.value])
  loading.value = false
}

const fromOnHand = computed(() => {
  const bal = fromBalances.value.find(b => b.catalog_item_id === form.catalogItemId)
  return bal?.quantity_on_hand ?? 0
})

async function onSubmit() {
  if (!form.fromWarehouseId || !form.toWarehouseId) {
    useFaToast().warning('请选择源仓库与目标仓库')
    return
  }
  if (form.fromWarehouseId === form.toWarehouseId) {
    useFaToast().warning('源仓库与目标仓库不能相同')
    return
  }
  if (!form.catalogItemId) {
    useFaToast().warning('请选择商品')
    return
  }
  if (form.quantity <= 0) {
    useFaToast().warning('数量必须大于 0')
    return
  }
  if (form.quantity > fromOnHand.value) {
    useFaToast().warning(`库存不足,源仓库在库量仅 ${fromOnHand.value}`)
    return
  }
  submitting.value = true
  const idempotencyKey = generateIdempotencyKey()
  try {
    await apiInventory.transfer({
      tenantId: tenantStore.currentTenantId,
      fromWarehouseId: form.fromWarehouseId,
      toWarehouseId: form.toWarehouseId,
      catalogItemId: form.catalogItemId,
      quantity: form.quantity,
    }, idempotencyKey)
    useFaToast().success('调拨成功')
    form.catalogItemId = ''
    form.quantity = 1
    await loadBalances()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    submitting.value = false
  }
}

watch(() => [form.fromWarehouseId, form.toWarehouseId], () => {
  loadBalances()
})

// P1(审计 25):未保存内容保护 - 已选商品或修改数量时视为 dirty(源/目标仓库为自动选中项不计入)
const transferGuard = usePageUnsavedGuard('inventory-transfer')
watch([() => form.catalogItemId, () => form.quantity], () => {
  transferGuard.setDirty(!!form.catalogItemId || form.quantity !== 1)
}, { immediate: true })

// P0-06:切店后清空仓库选择并按新门店重载
useStoreScopedPage({
  load: loadWarehouses,
  reset: () => {
    form.fromWarehouseId = ''
    form.toWarehouseId = ''
  },
})

onMounted(loadWarehouses)
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="调拨管理" description="源仓 → 目标仓 · 原子扣增 · 幂等防重复">
      <template #actions>
        <FaSelect
          v-model="form.fromWarehouseId"
          placeholder="源仓库"
          class="w-36"
          :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
        />
        <FaIcon name="i-lucide:arrow-right" class="text-muted-foreground" />
        <FaSelect
          v-model="form.toWarehouseId"
          placeholder="目标仓库"
          class="w-36"
          :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
        />
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <div class="flex-1 gap-4 grid grid-cols-1 lg:grid-cols-2">
        <div class="border rounded-lg bg-card flex flex-col min-h-0">
          <div class="px-4 py-2.5 border-b flex gap-2 items-center">
            <FaIcon name="i-lucide:arrow-up-right" class="text-red-500" />
            <span class="text-sm font-medium">源仓库余额</span>
            <span class="text-xs text-muted-foreground ml-auto">{{ fromBalances.length }} 项</span>
          </div>
          <div v-loading="loading" class="flex-1 min-h-0 overflow-auto">
            <table class="text-sm w-full">
              <tbody>
                <tr v-for="bal in fromBalances" :key="bal.id" class="border-b">
                  <td class="px-4 py-2">
                    <div class="text-xs font-medium">
                      {{ nameOf(bal.catalog_item_id) }}
                    </div>
                    <div class="text-xs text-muted-foreground">
                      {{ bal.catalog_item_id.slice(0, 8) }}
                    </div>
                  </td>
                  <td class="px-4 py-2 text-right tabular-nums">
                    {{ bal.quantity_on_hand }}
                  </td>
                </tr>
                <tr v-if="fromBalances.length === 0">
                  <td class="text-muted-foreground px-4 py-8 text-center">
                    暂无余额
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="border rounded-lg bg-card flex flex-col min-h-0">
          <div class="px-4 py-2.5 border-b flex gap-2 items-center">
            <FaIcon name="i-lucide:arrow-down-left" class="text-green-500" />
            <span class="text-sm font-medium">目标仓库余额</span>
            <span class="text-xs text-muted-foreground ml-auto">{{ toBalances.length }} 项</span>
          </div>
          <div v-loading="loading" class="flex-1 min-h-0 overflow-auto">
            <table class="text-sm w-full">
              <tbody>
                <tr v-for="bal in toBalances" :key="bal.id" class="border-b">
                  <td class="px-4 py-2">
                    <div class="text-xs font-medium">
                      {{ nameOf(bal.catalog_item_id) }}
                    </div>
                    <div class="text-xs text-muted-foreground">
                      {{ bal.catalog_item_id.slice(0, 8) }}
                    </div>
                  </td>
                  <td class="px-4 py-2 text-right tabular-nums">
                    {{ bal.quantity_on_hand }}
                  </td>
                </tr>
                <tr v-if="toBalances.length === 0">
                  <td class="text-muted-foreground px-4 py-8 text-center">
                    暂无余额
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="p-4 border rounded-lg bg-card">
        <div class="gap-4 grid sm:grid-cols-3">
          <FaLabel label="商品">
            <BusinessCatalogItemPicker v-model="form.catalogItemId" placeholder="搜索选择服务/药品" />
          </FaLabel>
          <FaLabel label="数量">
            <FaInputNumber v-model="form.quantity" :min="1" class="w-full" />
          </FaLabel>
          <FaLabel label="源仓库在库量">
            <FaInput :model-value="fromOnHand" disabled class="w-full" />
          </FaLabel>
        </div>
      </div>
    </div>

    <WorkflowFixedBar>
      <template #left>
        <span class="text-sm text-muted-foreground">
          已选商品: <span class="text-foreground font-medium">{{ nameOf(form.catalogItemId) }}</span>
          <template v-if="form.catalogItemId"> · 源仓在库 {{ fromOnHand }}</template>
        </span>
      </template>
      <template #right>
        <FaButton size="sm" :loading="submitting" @click="onSubmit">
          <FaIcon name="i-lucide:arrow-left-right" />
          确认调拨
        </FaButton>
      </template>
    </WorkflowFixedBar>
  </div>
</template>
