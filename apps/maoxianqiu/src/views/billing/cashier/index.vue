<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  CreateInvoiceItemInput,
  InvoiceItemCategory,
  PaymentMethod,
  ReceiptData,
} from '@/types/billing'
import apiBilling, { generateIdempotencyKey } from '@/api/modules/billing'
import BusinessCustomerPicker from '@/components/business/CustomerPicker/index.vue'
import BusinessPetPicker from '@/components/business/PetPicker/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  INVOICE_ITEM_CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
} from '@/types/billing'

defineOptions({
  name: 'BillingCashier',
})

interface CartItem extends CreateInvoiceItemInput {
  key: string
}

interface CatalogRow {
  id: string
  name: string
  default_price: number
  unit: string | null
  billing_type: string
}

const tenantStore = useAppTenantStore()
const submitting = ref(false)
const catalogLoading = ref(false)
const catalogList = ref<CatalogRow[]>([])
const cart = ref<CartItem[]>([])

const form = reactive({
  customerId: '',
  petId: '',
  encounterId: '',
  discountAmount: 0,
  discountReason: '',
  taxAmount: 0,
  paymentMethod: 'cash' as PaymentMethod,
})

const payment = reactive({
  amount: 0,
  method: 'cash' as PaymentMethod,
  transactionNo: '',
})

const receiptVisible = ref(false)
const receiptData = ref<ReceiptData | null>(null)
const receiptLoading = ref(false)

const cartColumns = computed<TableColumn<CartItem>[]>(() => [
  { accessorKey: 'name', header: '项目' },
  {
    accessorKey: 'category',
    header: '分类',
    cell: info => INVOICE_ITEM_CATEGORY_LABELS[info.getValue() as InvoiceItemCategory] ?? info.getValue(),
  },
  { accessorKey: 'unitPrice', header: '单价', cell: info => formatMoney(info.getValue() as number) },
  { accessorKey: 'quantity', header: '数量' },
  { accessorKey: 'discountAmount', header: '折扣', cell: info => formatMoney(info.getValue() as number) },
  { accessorKey: 'amount', header: '小计', cell: info => formatMoney(info.getValue() as number) },
  {
    id: 'operation',
    header: '操作',
    width: 80,
    align: 'center',
  },
])

/** 金额格式化 */
function formatMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) {
    return '-'
  }
  return `¥${Number(v).toFixed(2)}`
}

/** 加载门店目录(浏览器直连,RLS 兜底) */
async function loadCatalog() {
  if (!tenantStore.currentStoreId) {
    return
  }
  catalogLoading.value = true
  try {
    const { supabase } = await import('@/lib/supabase')
    const { data, error } = await supabase
      .from('store_catalog_items')
      .select(`
        id,
        catalog_item_id,
        custom_name,
        custom_price,
        catalog:catalog_items(name, default_price, unit, billing_type)
      `)
      .eq('store_id', tenantStore.currentStoreId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })

    if (error) {
      throw new Error(error.message)
    }

    catalogList.value = (data ?? []).map((row: any) => ({
      id: row.catalog_item_id,
      name: row.custom_name || row.catalog?.name || '未命名',
      default_price: row.custom_price !== null ? Number(row.custom_price) : Number(row.catalog?.default_price ?? 0),
      unit: row.catalog?.unit ?? null,
      billing_type: row.catalog?.billing_type ?? 'service',
    }))
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '加载目录失败')
  }
  finally {
    catalogLoading.value = false
  }
}

/** 添加目录项到购物车 */
function addToCart(row: CatalogRow) {
  const existing = cart.value.find(item => item.catalogItemId === row.id)
  if (existing) {
    existing.quantity += 1
    existing.amount = recalcItemAmount(existing)
    return
  }
  cart.value.push({
    key: crypto.randomUUID(),
    catalogItemId: row.id,
    name: row.name,
    unitPrice: row.default_price,
    quantity: 1,
    discountAmount: 0,
    amount: row.default_price,
    sortOrder: cart.value.length,
    category: (row.billing_type as InvoiceItemCategory) || 'service',
  })
}

/** 重新计算单项金额 = unitPrice * quantity - discountAmount */
function recalcItemAmount(item: CartItem): number {
  const amount = Number(item.unitPrice) * Number(item.quantity) - Number(item.discountAmount || 0)
  return Math.max(amount, 0)
}

/** 购物车数量/折扣变更时重算 */
function onItemChange(row: CartItem) {
  row.amount = recalcItemAmount(row)
}

/** 移除购物车项 */
function onRemoveItem(row: CartItem) {
  cart.value = cart.value.filter(item => item.key !== row.key)
}

/** 小计 = sum(items.amount) */
const subtotal = computed(() => {
  return cart.value.reduce((sum, item) => sum + Number(item.amount), 0)
})

/** 应收总额 = subtotal - discount + tax */
const total = computed(() => {
  return Math.max(subtotal.value - Number(form.discountAmount || 0) + Number(form.taxAmount || 0), 0)
})

/** 折扣比例(用于判断是否需要审批) */
const discountPercent = computed(() => {
  if (subtotal.value <= 0) {
    return 0
  }
  return (Number(form.discountAmount || 0) / subtotal.value) * 100
})

/** 折扣是否需要审批(>10%) */
const needsApproval = computed(() => discountPercent.value > 10)

/** 找零(现金支付时) */
const change = computed(() => {
  if (payment.method !== 'cash') {
    return 0
  }
  return Math.max(payment.amount - total.value, 0)
})

/** 提交创建发票 + 确认 + 支付(三步原子序列) */
async function onSubmit() {
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择租户与门店')
    return
  }
  if (cart.value.length === 0) {
    useFaToast().warning('请添加收费项目')
    return
  }

  submitting.value = true
  const createKey = generateIdempotencyKey()
  try {
    // 1. 创建发票
    const createRes = await apiBilling.createInvoice({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId,
      customerId: form.customerId || undefined,
      petId: form.petId || undefined,
      encounterId: form.encounterId || undefined,
      items: cart.value.map(item => ({
        catalogItemId: item.catalogItemId,
        name: item.name,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        discountAmount: item.discountAmount,
        amount: item.amount,
        sortOrder: item.sortOrder,
        category: item.category,
      })),
      discountAmount: form.discountAmount,
      discountReason: form.discountReason || undefined,
      taxAmount: form.taxAmount,
      paymentMethod: form.paymentMethod,
    }, createKey)

    const invoiceId = (createRes as any).data?.invoiceId
    if (!invoiceId) {
      throw new Error('创建发票失败')
    }

    // 2. 确认发票(大额折扣可能审批拒绝)
    try {
      await apiBilling.confirmInvoice(invoiceId)
    }
    catch {
      useFaToast().warning('发票已创建,但需先完成大额折扣审批才能确认与支付')
      resetCart()
      return
    }

    // 3. 支付(若用户填了支付金额)
    if (payment.amount > 0) {
      const paymentKey = generateIdempotencyKey()
      await apiBilling.processPayment({
        invoiceId,
        amount: payment.amount,
        method: payment.method,
        transactionNo: payment.transactionNo || undefined,
      }, paymentKey)
    }

    useFaToast().success('收银成功')

    // 4. 生成小票预览
    await showReceipt(invoiceId)
    resetCart()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    submitting.value = false
  }
}

/** 显示小票 */
async function showReceipt(invoiceId: string) {
  receiptLoading.value = true
  receiptVisible.value = true
  try {
    const res = await apiBilling.generateReceipt(invoiceId)
    receiptData.value = (res as any).data
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '生成小票失败')
  }
  finally {
    receiptLoading.value = false
  }
}

/** 重置购物车与表单 */
function resetCart() {
  cart.value = []
  form.discountAmount = 0
  form.discountReason = ''
  form.taxAmount = 0
  payment.amount = 0
  payment.transactionNo = ''
}

onMounted(loadCatalog)
</script>

<template>
  <div>
    <FaPageHeader title="收银工作台" class="mb-0">
      <template #description>
        选客户/宠物 → 选项目 → 计算金额 → 确认 → 支付;支付与退款走 Hono Command + RPC,幂等防重复
      </template>
    </FaPageHeader>
    <FaPageMain>
      <div class="gap-4 grid grid-cols-1 lg:grid-cols-2">
        <!-- 左侧:目录选择 -->
        <div class="p-4 border rounded-lg">
          <div class="mb-3 flex gap-2 items-center">
            <FaIcon name="i-ri:archive-line" />
            <span class="text-lg font-bold">收费项目</span>
          </div>
          <div v-loading="catalogLoading" class="max-h-[480px] overflow-y-auto">
            <div v-if="catalogList.length === 0 && !catalogLoading" class="text-secondary-foreground/60 py-8 text-center">
              暂无可用收费项目,请先在「目录价目」中维护
            </div>
            <div
              v-for="item in catalogList"
              :key="item.id"
              class="mb-2 p-3 border rounded flex cursor-pointer items-center justify-between hover:bg-secondary-foreground/5"
              @click="addToCart(item)"
            >
              <div>
                <div class="font-medium">
                  {{ item.name }}
                </div>
                <div class="text-xs text-secondary-foreground/60">
                  {{ INVOICE_ITEM_CATEGORY_LABELS[item.billing_type as InvoiceItemCategory] ?? item.billing_type }} · 单位 {{ item.unit || '-' }}
                </div>
              </div>
              <div class="text-primary font-bold">
                {{ formatMoney(item.default_price) }}
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧:购物车与结算 -->
        <div class="p-4 border rounded-lg">
          <div class="mb-3 flex gap-2 items-center">
            <FaIcon name="i-ri:shopping-cart-line" />
            <span class="text-lg font-bold">结算清单</span>
          </div>

          <!-- 客户信息 -->
          <div class="mb-3 gap-x-4 gap-y-2 grid grid-cols-2">
            <FaLabel label="客户" class="col-span-1">
              <BusinessCustomerPicker v-model="form.customerId" placeholder="搜索选择客户(可选)" />
            </FaLabel>
            <FaLabel label="宠物" class="col-span-1">
              <BusinessPetPicker v-model="form.petId" :customer-id="form.customerId || undefined" placeholder="搜索选择宠物(可选)" />
            </FaLabel>
          </div>

          <!-- 购物车列表 -->
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="key"
            stripe
            border
            :columns="cartColumns"
            :data="cart"
          >
            <template #cell-quantity="{ row }">
              <FaInputNumber
                v-model="row.original.quantity"
                :min="0.01"
                :precision="2"
                class="w-24"
                @update:model-value="onItemChange(row.original)"
              />
            </template>
            <template #cell-discountAmount="{ row }">
              <FaInputNumber
                v-model="row.original.discountAmount"
                :min="0"
                :precision="2"
                class="w-24"
                @update:model-value="onItemChange(row.original)"
              />
            </template>
            <template #cell-operation="{ row }">
              <FaButton variant="outline" size="icon-sm" @click="onRemoveItem(row.original)">
                <FaIcon name="i-ri:delete-bin-line" />
              </FaButton>
            </template>
          </FaTable>

          <!-- 折扣与税费 -->
          <div class="mt-3 gap-x-4 gap-y-2 grid grid-cols-2">
            <FaLabel label="发票折扣" class="col-span-1">
              <FaInputNumber
                v-model="form.discountAmount"
                :min="0"
                :precision="2"
                class="w-full"
              />
            </FaLabel>
            <FaLabel label="折扣原因" class="col-span-1">
              <FaInput
                v-model="form.discountReason"
                placeholder="折扣理由(>10% 需审批)"
                class="w-full"
              />
            </FaLabel>
            <FaLabel label="税费" class="col-span-1">
              <FaInputNumber
                v-model="form.taxAmount"
                :min="0"
                :precision="2"
                class="w-full"
              />
            </FaLabel>
            <FaLabel label="支付方式" class="col-span-1">
              <FaSelect
                v-model="form.paymentMethod"
                class="w-full"
                :options="Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => ({ label, value }))"
              />
            </FaLabel>
          </div>

          <!-- 金额合计 -->
          <div class="text-sm mt-4 p-3 rounded bg-secondary-foreground/5">
            <div class="mb-1 flex justify-between">
              <span>小计:</span>
              <span>{{ formatMoney(subtotal) }}</span>
            </div>
            <div class="mb-1 flex justify-between">
              <span>折扣:</span>
              <span>-{{ formatMoney(form.discountAmount) }}</span>
            </div>
            <div v-if="needsApproval" class="text-warning text-xs mb-1">
              折扣比例 {{ discountPercent.toFixed(2) }}% 超过 10%,提交后将创建审批记录,需 manager 审批通过后才能确认
            </div>
            <div class="mb-1 flex justify-between">
              <span>税费:</span>
              <span>+{{ formatMoney(form.taxAmount) }}</span>
            </div>
            <div class="text-lg font-bold pt-2 border-t border-dashed flex justify-between">
              <span>应收:</span>
              <span class="text-primary">{{ formatMoney(total) }}</span>
            </div>
          </div>

          <!-- 支付信息 -->
          <div class="mt-3 gap-x-4 gap-y-2 grid grid-cols-2">
            <FaLabel label="支付金额" class="col-span-1">
              <FaInputNumber
                v-model="payment.amount"
                :min="0"
                :precision="2"
                class="w-full"
              />
            </FaLabel>
            <FaLabel label="支付方式" class="col-span-1">
              <FaSelect
                v-model="payment.method"
                class="w-full"
                :options="Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => ({ label, value }))"
              />
            </FaLabel>
            <FaLabel label="交易号" class="col-span-2">
              <FaInput
                v-model="payment.transactionNo"
                placeholder="外部交易号(微信/支付宝等,可选)"
                class="w-full"
              />
            </FaLabel>
          </div>

          <div class="text-sm mt-2 p-2 rounded bg-secondary-foreground/5 flex justify-between">
            <span>找零:</span>
            <span class="font-bold">{{ formatMoney(change) }}</span>
          </div>

          <div class="mt-4 flex gap-2">
            <FaButton variant="outline" @click="resetCart">
              清空
            </FaButton>
            <FaButton type="primary" :loading="submitting" @click="onSubmit">
              <FaIcon name="i-ri:bank-card-line" />
              确认收银
            </FaButton>
          </div>
        </div>
      </div>

      <!-- 小票预览弹窗 -->
      <FaModal
        v-model="receiptVisible"
        title="小票预览"
        :closable="true"
        :show-cancel="false"
        confirm-text="关闭"
      >
        <div v-loading="receiptLoading" class="text-sm mx-auto p-4 max-w-md">
          <template v-if="receiptData">
            <div class="mb-3 text-center">
              <div class="text-base font-bold">
                {{ receiptData.store.name }}
              </div>
              <div v-if="receiptData.store.address" class="text-xs text-secondary-foreground/60">
                {{ receiptData.store.address }}
              </div>
              <div v-if="receiptData.store.phone" class="text-xs text-secondary-foreground/60">
                电话:{{ receiptData.store.phone }}
              </div>
            </div>
            <div class="pb-2 pt-2 border-t border-dashed">
              <div>发票号:{{ receiptData.invoiceNo }}</div>
              <div>创建时间:{{ receiptData.createdAt?.slice(0, 19).replace('T', ' ') }}</div>
            </div>
            <div class="pb-2 pt-2 border-t border-dashed">
              <div class="text-xs font-bold grid grid-cols-12">
                <div class="col-span-6">
                  项目
                </div>
                <div class="text-right col-span-2">
                  数量
                </div>
                <div class="text-right col-span-4">
                  金额
                </div>
              </div>
              <div
                v-for="item in receiptData.items"
                :key="item.id"
                class="text-xs py-1 grid grid-cols-12"
              >
                <div class="col-span-6 truncate">
                  {{ item.name }}
                </div>
                <div class="text-right col-span-2">
                  {{ item.quantity }}
                </div>
                <div class="text-right col-span-4">
                  {{ formatMoney(item.amount) }}
                </div>
              </div>
            </div>
            <div class="text-xs pt-2 border-t border-dashed space-y-1">
              <div class="flex justify-between">
                <span>小计:</span>
                <span>{{ formatMoney(receiptData.subtotal) }}</span>
              </div>
              <div class="flex justify-between">
                <span>折扣:</span>
                <span>-{{ formatMoney(receiptData.discountAmount) }}</span>
              </div>
              <div v-if="receiptData.taxAmount > 0" class="flex justify-between">
                <span>税费:</span>
                <span>+{{ formatMoney(receiptData.taxAmount) }}</span>
              </div>
              <div class="text-base font-bold flex justify-between">
                <span>应收:</span>
                <span>{{ formatMoney(receiptData.total) }}</span>
              </div>
              <div class="flex justify-between">
                <span>已收:</span>
                <span>{{ formatMoney(receiptData.paidAmount) }}</span>
              </div>
              <div v-if="receiptData.change > 0" class="flex justify-between">
                <span>找零:</span>
                <span>{{ formatMoney(receiptData.change) }}</span>
              </div>
            </div>
            <div class="text-xs text-secondary-foreground/60 mt-2 pt-2 text-center border-t border-dashed">
              感谢惠顾,欢迎下次光临!
            </div>
          </template>
          <div v-else-if="!receiptLoading" class="text-secondary-foreground/60 py-8 text-center">
            暂无小票数据
          </div>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
