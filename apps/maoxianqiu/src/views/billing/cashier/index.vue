<script setup lang="ts">
import type {
  CreateInvoiceItemInput,
  InvoiceItemCategory,
  PaymentMethod,
  ReceiptData,
} from '@/types/billing'
import apiBilling, { generateIdempotencyKey } from '@/api/modules/billing'
import apiCustomer from '@/api/modules/customer'
import apiOperations from '@/api/modules/operations'
import apiSettings from '@/api/modules/settings'
import BusinessCustomerPicker from '@/components/business/CustomerPicker/index.vue'
import BusinessPetPicker from '@/components/business/PetPicker/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { INVOICE_ITEM_CATEGORY_LABELS, PAYMENT_METHOD_LABELS } from '@/types/billing'

defineOptions({
  name: 'BillingCashier',
})

interface CartItem extends CreateInvoiceItemInput {
  key: string
}

interface CatalogRow {
  id: string
  storeCatalogItemId: string
  name: string
  code: string
  default_price: number
  unit: string | null
  billing_type: string
  categoryId: string | null
  categoryName: string
}

interface PaymentAllocation {
  method: PaymentMethod
  label: string
  enabled: boolean
  amount: number
  transactionNo: string
}

const tenantStore = useAppTenantStore()
const submitting = ref(false)
const catalogLoading = ref(false)
const catalogList = ref<CatalogRow[]>([])
const cart = ref<CartItem[]>([])
const keyword = ref('')
const catalogCategory = ref('all')

// C1(审计 29-30):记录「已创建但未完成确认/支付」的发票 id。
// 结算重试时若存在该值,跳过 Create 直接重试 Confirm,避免重复生成多个草稿发票。
// 页面加载/重置时初始为 null;支付成功或用户清空购物车(草稿废弃)时清空。
const pendingInvoiceId = ref<string | null>(null)
const pendingInvoiceConfirmed = ref(false)
const pendingPaymentKeys = ref<Partial<Record<PaymentMethod, string>>>({})

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

const supportedPaymentMethods: PaymentMethod[] = ['stored_value', 'cash', 'alipay', 'wechat']
const paymentAllocations = ref<PaymentAllocation[]>(supportedPaymentMethods.map((method, index) => ({
  method,
  label: PAYMENT_METHOD_LABELS[method],
  enabled: index === 0,
  amount: 0,
  transactionNo: '',
})))
const customerPetVisible = ref(false)
const selectedCustomerName = ref('')
const selectedPetName = ref('')

const enabledPayments = computed(() => paymentAllocations.value.filter(item => item.enabled))
const activePayments = computed(() => enabledPayments.value.filter(item => Number(item.amount) > 0))
const selectedPaymentLabel = computed(() => {
  if (enabledPayments.value.length > 1) {
    return '组合支付'
  }
  return enabledPayments.value[0]?.label ?? '选择支付方式'
})

/** 加载门店支付方式名称；收银台固定支持储值、现金、支付宝、微信组合支付。 */
async function loadPaymentMethods() {
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    return
  }
  try {
    const list: any[] = await apiSettings.listPaymentContexts(tenantStore.currentTenantId, tenantStore.currentStoreId)
    const configuredLabels = new Map(
      list
        .filter(item => item.is_active && supportedPaymentMethods.includes(item.method as PaymentMethod))
        .map(item => [item.method as PaymentMethod, item.label]),
    )
    paymentAllocations.value.forEach((item) => {
      item.label = configuredLabels.get(item.method) ?? PAYMENT_METHOD_LABELS[item.method]
    })
  }
  catch {
    paymentAllocations.value.forEach((item) => {
      item.label = PAYMENT_METHOD_LABELS[item.method]
    })
  }
}

// Agent-03 储值支付:选择 stored_value 时展示客户储值余额与扣款预览(权威校验在服务端 process_payment)
const walletBalance = ref(0)
const walletLoading = ref(false)

/**
 * 加载当前客户储值余额(浏览器直连 supabase,RLS 租户成员可读;余额真源在服务端)
 * 仅当客户已选且支付方式为 stored_value 时加载
 */
async function loadWalletBalance() {
  walletBalance.value = 0
  if (!tenantStore.currentTenantId || !form.customerId) {
    return
  }
  walletLoading.value = true
  try {
    const { supabase } = await import('@/lib/supabase')
    const { data, error } = await supabase
      .from('stored_value_accounts')
      .select('balance, status')
      .eq('tenant_id', tenantStore.currentTenantId)
      .eq('customer_id', form.customerId)
      .eq('currency', 'CNY')
      .maybeSingle()
    if (error) {
      throw new Error(error.message)
    }
    // 仅正常状态账户计入可用余额
    walletBalance.value = data && data.status === 'active' ? Number(data.balance) : 0
  }
  catch {
    walletBalance.value = 0
  }
  finally {
    walletLoading.value = false
  }
}

watch(() => form.customerId, async (customerId) => {
  form.petId = ''
  selectedCustomerName.value = ''
  selectedPetName.value = ''
  loadWalletBalance()
  if (!customerId) {
    return
  }
  try {
    const result = await apiCustomer.detail(customerId)
    selectedCustomerName.value = result.data.customer.name
  }
  catch {
    selectedCustomerName.value = '已选客户'
  }
})

watch(() => form.petId, async (petId) => {
  selectedPetName.value = ''
  if (!petId) {
    return
  }
  try {
    const result = await apiCustomer.detail(form.customerId)
    selectedPetName.value = result.data.pets.find(pet => pet.id === petId)?.name ?? '已选宠物'
  }
  catch {
    selectedPetName.value = '已选宠物'
  }
})

const receiptVisible = ref(false)
const receiptData = ref<ReceiptData | null>(null)
const receiptLoading = ref(false)

const filteredCatalog = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return catalogList.value.filter((item) => {
    const matchesCategory = catalogCategory.value === 'all' || item.categoryId === catalogCategory.value
    const matchesKeyword = !kw
      || item.name.toLowerCase().includes(kw)
      || item.code.toLowerCase().includes(kw)
      || item.categoryName.toLowerCase().includes(kw)
      || (INVOICE_ITEM_CATEGORY_LABELS[item.billing_type as InvoiceItemCategory] ?? '').toLowerCase().includes(kw)
    return matchesCategory && matchesKeyword
  })
})

const catalogCategories = computed(() => {
  const categoryMap = new Map<string, string>()
  catalogList.value.forEach((item) => {
    if (item.categoryId) {
      categoryMap.set(item.categoryId, item.categoryName)
    }
  })
  return [
    { label: '全部', value: 'all' },
    ...Array.from(categoryMap, ([value, label]) => ({ label, value })),
  ]
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
        catalog:catalog_items(name, code, default_price, unit, billing_type, category_id, category:catalog_categories(id, name))
      `)
      .eq('store_id', tenantStore.currentStoreId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })

    if (error) {
      throw new Error(error.message)
    }

    catalogList.value = (data ?? []).map((row: any) => ({
      id: row.catalog_item_id,
      storeCatalogItemId: row.id,
      name: row.custom_name || row.catalog?.name || '未命名',
      code: row.catalog?.code ?? '',
      default_price: row.custom_price !== null ? Number(row.custom_price) : Number(row.catalog?.default_price ?? 0),
      unit: row.catalog?.unit ?? null,
      billing_type: row.catalog?.billing_type ?? 'service',
      categoryId: row.catalog?.category_id ?? null,
      categoryName: row.catalog?.category?.name ?? INVOICE_ITEM_CATEGORY_LABELS[row.catalog?.billing_type as InvoiceItemCategory] ?? '其他',
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
    storeCatalogItemId: row.storeCatalogItemId,
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

function onRemoveItem(row: CartItem) {
  cart.value = cart.value.filter(item => item.key !== row.key)
}

// S3.1 会员折扣:选客户后预览会员折扣,提交时由服务端权威计算写入快照
const memberDiscount = ref(0)
const memberTierName = ref('')
const memberDiscountLoading = ref(false)

const subtotal = computed(() => {
  return cart.value.reduce((sum, item) => sum + Number(item.amount), 0)
})

const cartQuantity = computed(() => cart.value.reduce((sum, item) => sum + Number(item.quantity), 0))

/** 返回收费项目当前已加入清单的数量,用于项目区即时反馈。 */
function getCatalogQuantity(catalogItemId: string): number {
  return cart.value.find(item => item.catalogItemId === catalogItemId)?.quantity ?? 0
}

/** 数量展示保留必要的小数,整数不显示小数位。 */
function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

const total = computed(() => {
  // S3.1:有会员折扣时,应收 = 原价 - 手动折扣 - 会员折扣(与服务端快照一致)
  return Math.max(subtotal.value - Number(form.discountAmount || 0) - memberDiscount.value + Number(form.taxAmount || 0), 0)
})

const storedValuePayment = computed(() => paymentAllocations.value.find(item => item.method === 'stored_value'))

// 扣后余额按本次储值分配金额预览，实际扣减由服务端权威计算。
const walletBalanceAfter = computed(() => Math.max(walletBalance.value - Number(storedValuePayment.value?.amount ?? 0), 0))

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

watch(total, (value) => {
  if (enabledPayments.value.length === 1) {
    enabledPayments.value[0].amount = value
  }
}, { immediate: true })

const paymentAllocatedTotal = computed(() => activePayments.value.reduce((sum, item) => sum + Number(item.amount), 0))
const paymentOutstanding = computed(() => Math.max(total.value - paymentAllocatedTotal.value, 0))
const cashPayment = computed(() => paymentAllocations.value.find(item => item.method === 'cash'))
const paymentChange = computed(() => {
  if (!cashPayment.value?.enabled) {
    return 0
  }
  return Math.max(paymentAllocatedTotal.value - total.value, 0)
})

const canSettle = computed(() => {
  return cart.value.length > 0 && total.value > 0
})

/** 切换支付方式；新增方式默认承接尚未分配的应收金额。 */
function togglePaymentMethod(method: PaymentMethod) {
  const target = paymentAllocations.value.find(item => item.method === method)
  if (!target) {
    return
  }
  target.enabled = !target.enabled
  if (target.enabled) {
    target.amount = paymentOutstanding.value
    if (method === 'stored_value') {
      loadWalletBalance()
    }
  }
  else {
    target.amount = 0
    target.transactionNo = ''
  }
}

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
  if (activePayments.value.length === 0) {
    useFaToast().warning('请选择支付方式并填写支付金额')
    return
  }
  const storedPayment = activePayments.value.find(item => item.method === 'stored_value')
  if (storedPayment && !form.customerId) {
    useFaToast().warning('使用储值支付必须先选择客户')
    return
  }
  if (storedPayment && walletBalance.value + 0.01 < storedPayment.amount) {
    useFaToast().warning(`储值余额不足,当前余额 ${formatMoney(walletBalance.value)},本次扣款 ${formatMoney(storedPayment.amount)}`)
    return
  }
  const nonCashTotal = activePayments.value
    .filter(item => item.method !== 'cash')
    .reduce((sum, item) => sum + Number(item.amount), 0)
  if (nonCashTotal > total.value + 0.01) {
    useFaToast().warning('非现金支付金额不能超过应收金额')
    return
  }
  if (paymentAllocatedTotal.value + 0.01 < total.value) {
    useFaToast().warning(`还需分配 ${formatMoney(paymentOutstanding.value)}`)
    return
  }
  if (!cashPayment.value?.enabled && paymentAllocatedTotal.value > total.value + 0.01) {
    useFaToast().warning('支付金额不能超过应收金额')
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
          storeCatalogItemId: item.storeCatalogItemId,
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
        paymentMethod: activePayments.value.length === 1 ? activePayments.value[0].method : undefined,
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
      if (!pendingInvoiceConfirmed.value) {
        await apiBilling.confirmInvoice(invoiceId)
        pendingInvoiceConfirmed.value = true
      }
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

    // 组合支付逐笔入账；非现金先处理，现金最后处理并只入账剩余应收，超出部分作为找零。
    const paymentPlans = [
      ...activePayments.value.filter(item => item.method !== 'cash'),
      ...activePayments.value.filter(item => item.method === 'cash'),
    ]
    let appliedTotal = 0
    for (const plan of paymentPlans) {
      const remaining = Math.max(total.value - appliedTotal, 0)
      const appliedAmount = Math.min(Number(plan.amount), remaining)
      if (appliedAmount <= 0) {
        continue
      }
      if (!pendingPaymentKeys.value[plan.method]) {
        pendingPaymentKeys.value[plan.method] = generateIdempotencyKey()
      }
      try {
        await apiBilling.processPayment({
          invoiceId,
          amount: appliedAmount,
          method: plan.method,
          transactionNo: plan.transactionNo || undefined,
        }, pendingPaymentKeys.value[plan.method]!)
        appliedTotal += appliedAmount
      }
      catch (paymentError) {
        // 网络中断时服务端可能已完成本笔或全部扣款；按发票真源确认最终结果。
        const detail = await apiBilling.getInvoiceDetail(invoiceId)
        if (detail.data?.status !== 'paid') {
          throw paymentError
        }
        appliedTotal = total.value
        break
      }
    }

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
  pendingInvoiceConfirmed.value = false
  pendingPaymentKeys.value = {}
  cart.value = []
  form.customerId = ''
  form.petId = ''
  form.encounterId = ''
  form.discountAmount = 0
  form.discountReason = ''
  form.taxAmount = 0
  paymentAllocations.value.forEach((item, index) => {
    item.enabled = index === 0
    item.amount = 0
    item.transactionNo = ''
  })
  walletBalance.value = 0
  memberDiscount.value = 0
  memberTierName.value = ''
  cashierGuard.setDirty(false)
}

// P0-06:切店后清空当前购物车并重载目录(切店前 ToolbarStart 已做 dirty 确认)
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
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉 快速收银 界面标题和描述区域
    <EntityPageHeader compact title="快速收银" description="选客户/宠物 → 选项目 → 结算支付(幂等防重复)">
      <template #actions>
        <FaButton size="sm" variant="outline" @click="resetCart">
          <FaIcon name="i-lucide:rotate-ccw" />
          清空
        </FaButton>
      </template>
    </EntityPageHeader>
    -->

    <div class="p-2 flex-1 gap-2 grid grid-cols-[minmax(0,1.55fr)_minmax(390px,1fr)] h-full min-h-0 overflow-hidden">
      <!-- 左:收费项目 -->
      <div class="border rounded-lg bg-card flex flex-col min-h-0 min-w-0 overflow-hidden">
        <div class="px-3 py-2 border-b flex gap-2 items-center">
          <div class="text-sm font-semibold shrink-0">
            收费项目
          </div>
          <FaSelect
            v-model="catalogCategory"
            :options="catalogCategories"
            class="shrink-0 w-32"
            placeholder="全部分类"
          />
          <div class="ml-auto px-2 border rounded-md flex flex-1 gap-2 max-w-72 items-center">
            <FaIcon name="i-lucide:search" class="text-muted-foreground shrink-0 size-3.5" />
            <FaInput v-model="keyword" placeholder="名称、编码或分类" class="border-0 w-full shadow-none" />
          </div>
        </div>
        <div v-loading="catalogLoading" class="p-2 flex-1 min-h-0 overflow-x-hidden overflow-y-auto">
          <div class="gap-1.5 grid grid-cols-2">
            <FaButton
              v-for="item in filteredCatalog"
              :key="item.storeCatalogItemId"
              variant="outline"
              class="px-2.5 py-2 text-left rounded-md flex gap-2 h-auto min-w-0 justify-start hover:border-primary/50 hover:bg-primary/5"
              @click="addToCart(item)"
            >
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">
                  {{ item.name }}
                </div>
                <div class="text-xs text-muted-foreground truncate">
                  {{ item.categoryName }} · {{ item.unit || '项' }}
                </div>
              </div>
              <div class="text-right shrink-0">
                <div class="text-sm text-primary font-bold">
                  {{ formatMoney(item.default_price) }}
                </div>
                <div v-if="getCatalogQuantity(item.id) > 0" class="text-xs text-primary font-medium">
                  已选 × {{ formatQuantity(getCatalogQuantity(item.id)) }}
                </div>
              </div>
            </FaButton>
          </div>
          <EmptyState v-if="!catalogLoading && filteredCatalog.length === 0" compact title="没有匹配的收费项目" description="请调整分类或检索关键词" />
        </div>
      </div>

      <!-- 右:结算清单 -->
      <div class="border rounded-lg bg-card flex flex-col min-h-0 min-w-0 overflow-hidden">
        <div class="px-3 py-2 border-b flex items-center justify-between">
          <div class="min-w-0">
            <div class="text-sm font-semibold">
              结算清单
            </div>
            <div class="text-xs text-muted-foreground">
              {{ cart.length }} 项 / {{ formatQuantity(cartQuantity) }} 件 · {{ selectedPaymentLabel }}
            </div>
          </div>
          <span v-if="needsApproval" class="text-xs text-amber-600">
            折扣 {{ discountPercent.toFixed(2) }}% 超 {{ approvalThreshold }}% 需审批
          </span>
          <FaButton size="sm" variant="outline" class="ml-2 max-w-52" @click="customerPetVisible = true">
            <FaIcon name="i-lucide:user-round-search" />
            <span class="truncate">
              {{ selectedCustomerName || '选择客户' }}<template v-if="selectedPetName"> · {{ selectedPetName }}</template>
            </span>
          </FaButton>
        </div>
        <div class="p-2 flex flex-1 flex-col gap-2 min-h-0 overflow-hidden">
          <div class="flex flex-1 flex-col min-h-0 overflow-hidden">
            <div v-if="cart.length === 0" class="text-sm text-muted-foreground py-6 text-center border rounded-md border-dashed">
              暂未添加收费项目
            </div>
            <div v-else class="pr-1 flex-1 min-h-0 overflow-x-hidden overflow-y-auto space-y-1">
              <div class="text-xs text-muted-foreground px-2 pb-1 bg-card gap-2 grid grid-cols-[minmax(0,1fr)_68px_48px_72px_28px] top-0 sticky z-1">
                <span>收费条目</span>
                <span class="text-right">单价</span>
                <span class="text-center">数量</span>
                <span class="text-right">小计</span>
                <span />
              </div>
              <div
                v-for="item in cart"
                :key="item.key"
                class="px-2 py-1 border rounded-md gap-2 grid grid-cols-[minmax(0,1fr)_68px_48px_72px_28px] min-w-0 items-center"
              >
                <div class="flex gap-1.5 min-w-0 items-center">
                  <span class="text-sm font-medium truncate">{{ item.name }}</span>
                  <span class="text-[11px] text-muted-foreground shrink-0">{{ INVOICE_ITEM_CATEGORY_LABELS[item.category || 'service'] }}</span>
                </div>
                <div class="text-xs text-right">
                  {{ formatMoney(item.unitPrice) }}
                </div>
                <div class="text-sm font-semibold text-center">
                  {{ formatQuantity(item.quantity) }}
                </div>
                <div class="text-sm font-semibold text-right">
                  {{ formatMoney(item.amount) }}
                </div>
                <FaButton variant="ghost" size="icon-sm" @click="onRemoveItem(item)">
                  <FaIcon name="i-lucide:trash-2" />
                </FaButton>
              </div>
            </div>
          </div>

          <!-- 金额带：固定单行，不因折扣与税费变化增高。 -->
          <div class="px-2 py-1 border rounded-md bg-muted/20 shrink-0 gap-2 grid grid-cols-4 items-center">
            <div class="min-w-0">
              <div class="text-[10px] text-muted-foreground leading-3">
                项目金额
              </div>
              <div class="text-xs leading-4 font-semibold">
                {{ formatMoney(subtotal) }}
              </div>
            </div>
            <FaPopover align="center" class="p-3 w-72">
              <FaButton variant="ghost" class="p-0 text-left h-auto min-w-0 justify-start">
                <span class="min-w-0">
                  <span class="text-[10px] text-muted-foreground leading-3 block">整单折扣</span>
                  <span class="text-xs leading-4 font-semibold block">-{{ formatMoney(form.discountAmount) }}</span>
                </span>
              </FaButton>
              <template #panel>
                <div class="space-y-3">
                  <FaLabel label="整单折扣">
                    <FaNumberField v-model="form.discountAmount" :min="0" :max="subtotal" :step="0.01" class="w-full" />
                  </FaLabel>
                  <FaLabel label="折扣原因">
                    <FaInput v-model="form.discountReason" :placeholder="`折扣超过 ${approvalThreshold}% 需审批`" class="w-full" />
                  </FaLabel>
                </div>
              </template>
            </FaPopover>
            <FaPopover align="center" class="p-3 w-72">
              <FaButton variant="ghost" class="p-0 text-left h-auto min-w-0 justify-start">
                <span class="min-w-0">
                  <span class="text-[10px] text-muted-foreground leading-3 block">税费</span>
                  <span class="text-xs leading-4 font-semibold block">+{{ formatMoney(form.taxAmount) }}</span>
                </span>
              </FaButton>
              <template #panel>
                <FaLabel label="税费">
                  <FaNumberField v-model="form.taxAmount" :min="0" :step="0.01" class="w-full" />
                </FaLabel>
              </template>
            </FaPopover>
            <div class="text-right min-w-0">
              <div class="text-[10px] text-muted-foreground leading-3">
                应收金额
              </div>
              <div class="text-sm text-primary leading-4 font-bold">
                {{ formatMoney(total) }}
              </div>
            </div>
          </div>

          <!-- 支付带：主界面只保留四个金额入口，具体设置在弹层中完成。 -->
          <div class="text-sm px-2 py-1.5 border rounded-md bg-card shrink-0">
            <div class="gap-1.5 grid grid-cols-4">
              <FaPopover
                v-for="method in paymentAllocations"
                :key="method.method"
                align="center"
                class="p-3 w-72"
              >
                <FaButton
                  size="sm"
                  :variant="method.enabled ? 'default' : 'outline'"
                  class="px-1.5 h-7 min-w-0 w-full justify-center"
                  @click="!method.enabled && togglePaymentMethod(method.method)"
                >
                  <span class="text-xs truncate">{{ method.label }} {{ formatMoney(method.amount) }}</span>
                </FaButton>
                <template #panel>
                  <div class="space-y-3">
                    <div class="flex items-center justify-between">
                      <span class="text-sm font-semibold">{{ method.label }}</span>
                      <FaButton size="sm" :variant="method.enabled ? 'outline' : 'default'" @click="togglePaymentMethod(method.method)">
                        {{ method.enabled ? '移除' : '启用' }}
                      </FaButton>
                    </div>
                    <FaLabel :label="method.method === 'cash' ? '实收金额' : '支付金额'">
                      <FaNumberField v-model="method.amount" :min="0" :step="0.01" :disabled="!method.enabled" class="w-full" />
                    </FaLabel>
                    <div class="text-xs text-muted-foreground">
                      <template v-if="method.method === 'stored_value'">
                        余额 {{ formatMoney(walletBalance) }} · 扣款 {{ formatMoney(method.amount) }} · 扣后 {{ formatMoney(walletBalanceAfter) }}
                      </template>
                      <template v-else-if="method.method === 'cash'">
                        找零 {{ formatMoney(paymentChange) }}
                      </template>
                      <template v-else>
                        {{ method.transactionNo ? '已填写交易流水号' : '可选填交易流水号' }}
                      </template>
                    </div>
                    <FaLabel v-if="method.method === 'alipay' || method.method === 'wechat'" label="交易流水号（可选）">
                      <FaInput v-model="method.transactionNo" placeholder="请输入交易流水号" class="w-full" />
                    </FaLabel>
                  </div>
                </template>
              </FaPopover>
            </div>
            <div class="text-[11px] mt-1 px-0.5 flex h-4 items-center justify-between">
              <span class="text-muted-foreground">支持组合支付 · 已分配 {{ formatMoney(paymentAllocatedTotal) }}</span>
              <span :class="paymentOutstanding > 0 ? 'text-amber-600' : 'text-green-600'">
                {{ paymentOutstanding > 0 ? `待分配 ${formatMoney(paymentOutstanding)}` : '金额已分配完成' }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <FaModal
      v-model="customerPetVisible"
      title="选择结算客户与宠物"
      description="先选择客户,再选择其名下宠物;现金及线上支付允许不绑定客户。"
      align-center
      :show-cancel-button="true"
      confirm-button-text="完成选择"
      @confirm="customerPetVisible = false"
    >
      <div class="py-2 gap-4 grid grid-cols-2">
        <FaLabel label="客户">
          <BusinessCustomerPicker
            v-model="form.customerId"
            :store-id="tenantStore.currentStoreId || undefined"
            placeholder="姓名、手机号或客户编号"
            class="w-full"
          />
        </FaLabel>
        <FaLabel label="宠物">
          <BusinessPetPicker
            v-model="form.petId"
            :customer-id="form.customerId || undefined"
            :disabled="!form.customerId"
            :placeholder="form.customerId ? '选择该客户名下宠物' : '请先选择客户'"
            class="w-full"
          />
        </FaLabel>
      </div>
    </FaModal>

    <WorkflowFixedBar>
      <template #left>
        <span class="text-sm text-muted-foreground">条目 <span class="text-foreground font-semibold">{{ cart.length }}</span></span>
        <span class="text-sm text-muted-foreground">数量 <span class="text-foreground font-semibold">{{ formatQuantity(cartQuantity) }}</span></span>
        <span v-if="memberDiscount > 0" class="text-sm text-green-600">
          会员折扣 -{{ formatMoney(memberDiscount) }}<span v-if="memberTierName">({{ memberTierName }})</span>
        </span>
        <span class="text-sm text-muted-foreground">应收 <span class="text-base text-primary font-bold">{{ formatMoney(total) }}</span></span>
      </template>
      <template #right>
        <FaButton size="sm" variant="outline" @click="resetCart">
          清空
        </FaButton>
        <FaButton size="sm" :loading="submitting" :disabled="!canSettle" @click="onSubmit">
          <FaIcon name="i-lucide:banknote" />
          {{ selectedPaymentLabel }}结算
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
