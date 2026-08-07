<script setup lang="ts">
import type { InventoryBalance, Warehouse } from '@/types/inventory'
import apiInventory, { generateIdempotencyKey } from '@/api/modules/inventory'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'
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

const form = reactive({
  fromWarehouseId: '',
  toWarehouseId: '',
  catalogItemId: '',
  quantity: 1,
})

/** 加载仓库列表 */
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

/** 加载源/目标仓库余额 */
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
  loading.value = false
}

/** 源仓库选中商品的当前在库量 */
const fromOnHand = computed(() => {
  const bal = fromBalances.value.find(b => b.catalog_item_id === form.catalogItemId)
  return bal?.quantity_on_hand ?? 0
})

/** 提交调拨(走 Hono Command + transfer_inventory RPC,原子事务幂等) */
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

onMounted(loadWarehouses)
</script>

<template>
  <div>
    <FaPageHeader title="调拨" class="mb-0">
      <template #description>
        调拨走 Hono Command + transfer_inventory RPC,原子扣源增目标,写两条流水,幂等防重复
      </template>
    </FaPageHeader>
    <FaPageMain>
      <!-- 调拨表单 -->
      <div class="mb-6 p-4 border rounded-lg">
        <div class="text-lg font-bold mb-3">
          调拨登记
        </div>
        <div class="gap-x-8 gap-y-3 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
          <FaLabel label="源仓库" class="col-span-1">
            <FaSelect
              v-model="form.fromWarehouseId"
              placeholder="选择源仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
            />
          </FaLabel>
          <FaLabel label="目标仓库" class="col-span-1">
            <FaSelect
              v-model="form.toWarehouseId"
              placeholder="选择目标仓库"
              class="w-full"
              :options="warehouses.map(w => ({ label: w.name, value: w.id }))"
            />
          </FaLabel>
          <FaLabel label="商品" class="col-span-1">
            <BusinessCatalogItemPicker v-model="form.catalogItemId" placeholder="搜索选择服务/药品" />
          </FaLabel>
          <FaLabel label="数量" class="col-span-1">
            <FaInputNumber
              v-model="form.quantity"
              :min="1"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="源仓库在库量" class="col-span-1">
            <FaInput
              :model-value="fromOnHand"
              disabled
              class="w-full"
            />
          </FaLabel>
        </div>
        <div class="mt-4 flex gap-2">
          <FaButton type="primary" :loading="submitting" @click="onSubmit">
            <FaIcon name="i-ri:exchange-line" />
            确认调拨
          </FaButton>
        </div>
      </div>

      <!-- 余额对比 -->
      <div class="gap-4 grid grid-cols-1 md:grid-cols-2">
        <div>
          <div class="mb-2 flex gap-2 items-center">
            <FaIcon name="i-ri:export-line" class="text-red-500" />
            <span class="text-lg font-bold">源仓库余额</span>
          </div>
          <div class="border rounded-lg overflow-hidden">
            <table class="text-sm w-full">
              <thead class="bg-gray-1">
                <tr>
                  <th class="px-3 py-2 text-left">
                    商品 ID
                  </th>
                  <th class="px-3 py-2 text-right">
                    在库量
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="bal in fromBalances"
                  :key="bal.id"
                  class="border-t"
                >
                  <td class="px-3 py-2">
                    {{ bal.catalog_item_id.slice(0, 8) }}
                  </td>
                  <td class="px-3 py-2 text-right">
                    {{ bal.quantity_on_hand }}
                  </td>
                </tr>
                <tr v-if="fromBalances.length === 0">
                  <td colspan="2" class="text-gray-4 px-3 py-4 text-center">
                    暂无余额
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div class="mb-2 flex gap-2 items-center">
            <FaIcon name="i-ri:import-line" class="text-green-500" />
            <span class="text-lg font-bold">目标仓库余额</span>
          </div>
          <div class="border rounded-lg overflow-hidden">
            <table class="text-sm w-full">
              <thead class="bg-gray-1">
                <tr>
                  <th class="px-3 py-2 text-left">
                    商品 ID
                  </th>
                  <th class="px-3 py-2 text-right">
                    在库量
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="bal in toBalances"
                  :key="bal.id"
                  class="border-t"
                >
                  <td class="px-3 py-2">
                    {{ bal.catalog_item_id.slice(0, 8) }}
                  </td>
                  <td class="px-3 py-2 text-right">
                    {{ bal.quantity_on_hand }}
                  </td>
                </tr>
                <tr v-if="toBalances.length === 0">
                  <td colspan="2" class="text-gray-4 px-3 py-4 text-center">
                    暂无余额
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </FaPageMain>
  </div>
</template>
