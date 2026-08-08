<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  CreateInvoiceItemInput,
  InvoiceItemCategory,
  PaymentMethod,
  ReceiptData,
} from '@/types/billing'
import apiBilling, { generateIdempotencyKey } from '@/api/modules/billing'
import apiOperations from '@/api/modules/operations'
import apiSettings from '@/api/modules/settings'
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
const keyword = ref('')

// C1(审计 29-30):记录「已创建但未完成确认/支付」的发票 id。
// 结算重试时若存在该值,跳过 Create 直接重试 Confirm,避免重复生成多个草稿发票。
// 页面加载/重置时初始为 null;支付成功或用户清空购物车(草稿废弃)时清空。
const pendingInvoiceId = ref<string | null>(null)

// 未保存保护:购物车/已选客户被视为 dirty(在 form 声明后 watch)
const cashierGuard = usePageUnsavedGuard('billing-cashier')

const form = reactive({
  customerId: '',
  petId: '',
  encounterId: '',
  discountAmount: 0,
  discountReason: '',
  taxAmount: 0,
})

watch(
  [cart, () => form.customerId, () => form.petId],
  () => {
    cashierGuard.setDirty(cart.value.length > 0 || !!form.customerId || !!form.petId)
  },
  { immediate: true },
)

const payment = reactive({
  amount: 0,
  method: 'cash' as PaymentMethod,
  transactionNo: '',
})

const receiptVisible = ref(false)
const receiptData = ref<ReceiptData | null>(null)
const receiptLoading = ref(false)

// P0-16:支付方式来自系统设置(payment_contexts),不再前端静态硬编码
const paymentMethods = ref<Array<{ method: PaymentMethod, label: string }>>([])
// P0-10:加载成功但 0 个启用支付方式时置 true,禁止结算并提示联系管理员
const paymentMethodsDisabled = ref(false)
const PAYMENT_METHOD_FALLBACK = (Object.entries(PAYMENT_METHOD_LABELS) as Array<[PaymentMethod, string]>)
  .map(([method, label]) => ({ method, label }))

async function loadPaymentMethods() {
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    paymentMethods.value = PAYMENT_METHOD_FALLBACK
    paymentMethodsDisabled.value = false
    return
  }
  try {
    const list: any[] = await apiSettings.listPaymentContexts(tenantStore.currentTenantId, tenantStore.currentStoreId)
    const active = list.filter(c => c.is_active)
    if (active.length === 0) {
      // P0-10:加载成功但 0 个启用 → 不允许结算,不回退静态默认(管理员可能已停用现金)
      paymentMethods.value = []
      paymentMethodsDisabled.value = true
      return
    }
    paymentMethodsDisabled.value = false
    paymentMethods.value = active.map(c => ({ method: c.method as PaymentMethod, label: c.label }))
    const def = active.find(c => c.is_default)
    if (def) {
      payment.method = def.method as PaymentMethod
    }
    else if (!active.some(c => c.method === payment.method)) {
      payment.method = active[0].method as PaymentMethod
    }
  }
  catch {
    // 仅加载失败(网络/异常)才回退静态默认;成功但停用全部不回退
    paymentMethods.value = PAYMENT_METHOD_FALLBACK
    paymentMethodsDisabled.value = false
  }
}

const cartColumns = computed<TableColumn<CartItem>[]>(() => [
  { accessorKey: 'name', header: '项目' },
  {
    accessorKey: 'category',
    header: '分类',
    cell: info => INVOICE_ITEM_CATEGORY_LABELS[info.getValue() as InvoiceItemCategory] ?? info.getValue(),
  },
  { accessorKey: 'unitPrice', header: '单价', cell: info => formatMoney(info.getValue() as number) },
  { accessorKey: 'quantity', header: '数量' },
  { accessorKey: 'amount', header: '小计', cell: info => formatMoney(info.getValue() as number) },
  {
    id: 'operation',
    header: '操作',
    width: 80,
    align: 'center',
  },
])

const filteredCatalog = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) {
    return catalogList.value
  }
  return catalogList.value.filter(item =>
    item.name.toLowerCase().includes(kw)
    || (INVOICE_ITEM_CATEGORY_LABELS[item.billing_type as InvoiceItemCategory] ?? '').toLowerCase().includes(kw),
  )
})

function formatMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) {
    return '-'
  }
  return `¥${Number(v).toFixed(2)}`
}

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

function recalcItemAmount(item: CartItem): number {
  const amount = Number(item.unitPrice) * Number(item.quantity) - Number(item.discountAmount || 0)
  return Math.max(amount, 0)
}

function onItemChange(row: CartItem) {
  row.amount = recalcItemAmount(row)
}

function onRemoveItem(row: CartItem) {
  cart.value = cart.value.filter(item => item.key !== row.key)
}

const subtotal = computed(() => {
  return cart.value.reduce((sum, item) => sum + Number(item.amount), 0)
})

const total = computed(() => {
  // S3.1:有会员折扣时,应收 = 原价 - 手动折扣 - 会员折扣(与服务端快照一致)
  return Math.max(subtotal.value - Number(form.discountAmount || 0) - memberDiscount.value + Number(form.taxAmount || 0), 0)
})

const discountPercent = computed(() => {
  if (subtotal.value <= 0) {
    return 0
  }
  return (Number(form.discountAmount || 0) / subtotal.value) * 100
})

// P0-10:审批阈值从生效配置读取(UI 提示用),不再硬编码 10%;最终判定由服务端 create_invoice 执行
const approvalThreshold = ref(10)

async function loadApprovalThreshold() {
  try {
    const eff = await apiSettings.getEffectiveSettings(tenantStore.currentTenantId, tenantStore.currentStoreId || undefined, 'business')
    const items = (eff as any)?.items ?? []
    const hit = items.find((i: any) => i.key === 'discount.approval.threshold')
    if (hit && Number(hit.value) > 0) {
      approvalThreshold.value = Number(hit.value)
    }
  }
  catch {
    // 读取失败用默认 10,不影响主流程
  }
}

const needsApproval = computed(() => discountPercent.value > approvalThreshold.value)

const change = computed(() => {
  if (payment.method !== 'cash') {
    return 0
  }
  return Math.max(payment.amount - total.value, 0)
})

// S3.1 会员折扣:选客户后预览会员折扣,提交时由服务端权威计算写入快照
const memberDiscount = ref(0)
const memberTierName = ref('')
const memberDiscountLoading = ref(false)

async function loadMemberDiscountPreview() {
  memberDiscount.value = 0
  memberTierName.value = ''
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId || !form.customerId || cart.value.length === 0) {
    return
  }
  memberDiscountLoading.value = true
  try {
    const res: any = await apiOperations.previewMembershipPricing({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId,
      customerId: form.customerId,
      items: cart.value.map(item => ({
        catalogItemId: item.catalogItemId,
        catalogType: (item as any).category ?? undefined,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        name: item.name,
      })),
    })
    const data = res?.data
    memberDiscount.value = Number(data?.memberDiscountTotal ?? 0)
    const tierName = data?.items?.find((i: any) => i.tier_name)?.tier_name
    memberTierName.value = tierName ?? ''
  }
  catch {
    memberDiscount.value = 0
    memberTierName.value = ''
  }
  finally {
    memberDiscountLoading.value = false
  }
}

watch([() => form.customerId, cart], () => {
  loadMemberDiscountPreview()
})

async function onSubmit() {
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择租户与门店')
    return
  }
  if (cart.value.length === 0) {
    useFaToast().warning('请添加收费项目')
    return
  }
  // P0-14:应付金额为 0 不允许结算(产品当前不支持挂账,须实收 > 0)
  if (total.value <= 0) {
    useFaToast().warning('应付金额为 0,请检查项目或折扣')
    return
  }
  // P0-13:现金实收(客户递入金额)须覆盖应收,找零 = 实收 - 应收
  if (payment.method === 'cash' && payment.amount < total.value) {
    useFaToast().warning(`现金实收金额不足,应收金额为 ${formatMoney(total.value)}`)
    return
  }

  submitting.value = true
  try {
    // C1(审计 29-30):已有未完成确认的草稿发票时,跳过 Create 直接重试 Confirm(不重新 Create,避免多个草稿发票)
    let invoiceId = pendingInvoiceId.value
    if (!invoiceId) {
      const createKey = generateIdempotencyKey()
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
        paymentMethod: payment.method,
        // P0-10:已选客户即交由服务端判断是否应用会员折扣,避免前端 Preview 决定真实收费
        applyMembershipDiscount: !!form.customerId,
      }, createKey)

      invoiceId = (createRes as any).data?.invoiceId
      if (!invoiceId) {
        throw new Error('创建发票失败')
      }
      // C1:Create 成功后记录待确认发票 id,后续 Confirm 失败时保留,供下次结算重试 Confirm
      pendingInvoiceId.value = invoiceId
    }

    try {
      await apiBilling.confirmInvoice(invoiceId)
    }
    catch (e: any) {
      // P0-15:仅明确的审批错误进入 pending approval 流程;其他异常保留购物车与发票(草稿)允许重试
      const code = e?.response?.data?.error?.code
      if (code === 'DISCOUNT_APPROVAL_REQUIRED' || code === 'DISCOUNT_APPROVAL_PENDING') {
        // 审批 pending:发票已进入审批流,草稿由收银台在审批通过后重新结算,此发票不再复用 → 清空并重置
        useFaToast().warning('发票已创建,但需先完成大额折扣审批才能确认与支付')
        resetCart()
        return
      }
      // C1:Confirm 网络/500 等失败:保留 pendingInvoiceId 与购物车,提示可重试确认,不重新 Create
      useFaToast().warning('发票已创建(草稿),可重试确认')
      return
    }

    // P0-13:应用支付金额 = 应收(total);找零(change)仅现金展示用,不传给 RPC
    const appliedAmount = total.value
    const paymentKey = generateIdempotencyKey()
    await apiBilling.processPayment({
      invoiceId,
      amount: appliedAmount,
      method: payment.method,
      transactionNo: payment.transactionNo || undefined,
    }, paymentKey)

    // C1:Confirm 成功且支付成功 → 发票已闭环,清空 pendingInvoiceId(草稿不再需要)
    pendingInvoiceId.value = null
    useFaToast().success('收银成功')
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

function resetCart() {
  // C1(审计 29-30):清空购物车视为明确废弃当前草稿发票(支付成功/审批 pending/用户手动清空均走此处),
  // 一并清空 pendingInvoiceId,避免下次结算复用已进入审批或已作废的发票。
  // 注意:仅「Confirm 网络/500 失败」路径不调用 resetCart,从而保留 pendingInvoiceId 供重试。
  pendingInvoiceId.value = null
  cart.value = []
  form.discountAmount = 0
  form.discountReason = ''
  form.taxAmount = 0
  payment.amount = 0
  payment.transactionNo = ''
  memberDiscount.value = 0
  memberTierName.value = ''
  cashierGuard.setDirty(false)
}

// P0-06:切店后清空当前购物车并重载目录/支付方式(切店前 ToolbarStart 已做 dirty 确认)
useStoreScopedPage({
  load: async () => {
    await loadCatalog()
    await loadPaymentMethods()
  },
  reset: resetCart,
})

onMounted(async () => {
  await loadCatalog()
  await loadPaymentMethods()
  await loadApprovalThreshold()
})
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="快速收银" description="选客户/宠物 → 选项目 → 结算支付(幂等防重复)">
      <template #actions>
        <FaButton size="sm" variant="outline" @click="resetCart">
          <FaIcon name="i-lucide:rotate-ccw" />
          清空
        </FaButton>
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 gap-4 min-h-0">
      <!-- 左:收费项目 -->
      <div class="border rounded-lg bg-card flex flex-[2] flex-col min-w-0">
        <div class="px-4 py-2.5 border-b flex gap-2 items-center">
          <span class="text-sm font-medium">收费项目</span>
          <div class="ml-auto px-2 border rounded-md flex gap-2 w-56 items-center">
            <FaIcon name="i-lucide:search" class="text-muted-foreground shrink-0 size-3.5" />
            <FaInput v-model="keyword" placeholder="搜索项目名称/分类" class="border-0 w-full shadow-none" />
          </div>
        </div>
        <div v-loading="catalogLoading" class="p-3 flex-1 min-h-0 overflow-auto">
          <div
            v-for="item in filteredCatalog"
            :key="item.id"
            class="mb-2 p-3 border rounded-md flex cursor-pointer transition items-center justify-between hover:bg-gray-50"
            @click="addToCart(item)"
          >
            <div>
              <div class="text-sm font-medium">
                {{ item.name }}
              </div>
              <div class="text-xs text-muted-foreground">
                {{ INVOICE_ITEM_CATEGORY_LABELS[item.billing_type as InvoiceItemCategory] ?? item.billing_type }} · 单位 {{ item.unit || '-' }}
              </div>
            </div>
            <div class="text-sm text-primary font-bold">
              {{ formatMoney(item.default_price) }}
            </div>
          </div>
          <EmptyState v-if="!catalogLoading && filteredCatalog.length === 0" compact title="暂无可用收费项目" description="请先在「目录价目」中维护" />
        </div>
      </div>

      <!-- 右:结算清单 -->
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-w-0 overflow-auto">
        <div class="px-4 py-2.5 border-b flex items-center justify-between">
          <span class="text-sm font-medium">结算清单({{ cart.length }} 项)</span>
          <span v-if="needsApproval" class="text-xs text-amber-600">
            折扣 {{ discountPercent.toFixed(2) }}% 超 {{ approvalThreshold }}% 需审批
          </span>
        </div>
        <div class="p-4 flex-1">
          <div class="mb-3 gap-x-4 gap-y-2 grid grid-cols-2">
            <FaLabel label="客户">
              <BusinessCustomerPicker v-model="form.customerId" placeholder="搜索选择客户(可选)" />
            </FaLabel>
            <FaLabel label="宠物">
              <BusinessPetPicker v-model="form.petId" :customer-id="form.customerId || undefined" placeholder="搜索选择宠物(可选)" />
            </FaLabel>
          </div>

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
                class="w-20"
                @update:model-value="onItemChange(row.original)"
              />
            </template>
            <template #cell-operation="{ row }">
              <FaButton variant="outline" size="icon-sm" @click="onRemoveItem(row.original)">
                <FaIcon name="i-lucide:trash-2" />
              </FaButton>
            </template>
          </FaTable>

          <div class="mt-3 gap-x-4 gap-y-2 grid grid-cols-2">
            <FaLabel label="发票折扣">
              <FaInputNumber v-model="form.discountAmount" :min="0" :precision="2" class="w-full" />
            </FaLabel>
            <FaLabel label="折扣原因">
              <FaInput v-model="form.discountReason" :placeholder="`折扣理由(>${approvalThreshold}% 需审批)`" class="w-full" />
            </FaLabel>
            <FaLabel label="税费">
              <FaInputNumber v-model="form.taxAmount" :min="0" :precision="2" class="w-full" />
            </FaLabel>
            <FaLabel label="实收金额">
              <FaInputNumber v-model="payment.amount" :min="0" :precision="2" class="w-full" />
            </FaLabel>
            <FaLabel label="支付方式">
              <FaSelect
                v-model="payment.method"
                class="w-full"
                :options="paymentMethods.map(({ method, label }) => ({ label, value: method }))"
              />
              <span v-if="paymentMethodsDisabled" class="text-xs text-destructive mt-1 inline-block">
                当前门店没有可用支付方式,请联系管理员。
              </span>
            </FaLabel>
            <FaLabel label="交易号">
              <FaInput v-model="payment.transactionNo" placeholder="外部交易号(可选)" class="w-full" />
            </FaLabel>
          </div>
        </div>
      </div>
    </div>

    <WorkflowFixedBar>
      <template #left>
        <span class="text-sm text-muted-foreground">件数 <span class="text-foreground font-semibold">{{ cart.length }}</span></span>
        <span class="text-sm text-muted-foreground">应收 <span class="text-foreground font-semibold">{{ formatMoney(total) }}</span></span>
        <span v-if="memberDiscount > 0" class="text-sm text-green-600">
          会员折扣 -{{ formatMoney(memberDiscount) }}<span v-if="memberTierName">({{ memberTierName }})</span>
        </span>
        <span class="text-sm text-muted-foreground">实收 <span class="text-foreground font-semibold">{{ formatMoney(payment.amount) }}</span></span>
        <span class="text-sm text-muted-foreground">找零 <span class="text-foreground font-semibold">{{ formatMoney(change) }}</span></span>
      </template>
      <template #right>
        <FaButton size="sm" variant="outline" @click="resetCart">
          清空
        </FaButton>
        <FaButton size="sm" :loading="submitting" :disabled="paymentMethodsDisabled" @click="onSubmit">
          <FaIcon name="i-lucide:banknote" />
          结算
        </FaButton>
      </template>
    </WorkflowFixedBar>

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
  </div>
</template>
