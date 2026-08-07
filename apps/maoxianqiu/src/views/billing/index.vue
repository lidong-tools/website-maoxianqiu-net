<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { Invoice, InvoiceStatus, PaymentMethod } from '@/types/billing'
import apiBilling, { generateIdempotencyKey } from '@/api/modules/billing'
import BusinessStorePicker from '@/components/business/StorePicker/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  INVOICE_STATUS_COLORS,
  INVOICE_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
} from '@/types/billing'

defineOptions({
  name: 'BillingInvoices',
})

interface InvoiceRow extends Invoice {
  customer_name?: string
  pet_name?: string
}

/** 退款弹窗状态 */
const refundVisible = ref(false)
const refundTarget = ref<InvoiceRow | null>(null)
const refundSubmitting = ref(false)
const refundForm = ref({
  amount: 0,
  reason: '',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<InvoiceRow[]>([])
const total = ref(0)
const search = ref({
  keyword: '',
  status: '' as InvoiceStatus | '',
  storeId: '',
})

const statusOptions = computed(() => [
  { label: '全部状态', value: '' },
  ...Object.entries(INVOICE_STATUS_LABELS).map(([value, label]) => ({
    label,
    value: value as InvoiceStatus,
  })),
])

const tableColumns = computed<TableColumn<InvoiceRow>[]>(() => [
  { accessorKey: 'invoice_no', header: '发票号' },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const status = info.getValue() as InvoiceStatus
      return h('span', { class: `fa-tag fa-tag-${INVOICE_STATUS_COLORS[status]}` }, INVOICE_STATUS_LABELS[status])
    },
  },
  {
    accessorKey: 'subtotal',
    header: '小计',
    cell: info => formatMoney(info.getValue() as number),
  },
  {
    accessorKey: 'discount_amount',
    header: '折扣',
    cell: info => formatMoney(info.getValue() as number),
  },
  {
    accessorKey: 'total',
    header: '应收',
    cell: info => formatMoney(info.getValue() as number),
  },
  {
    accessorKey: 'paid_amount',
    header: '已收',
    cell: info => formatMoney(info.getValue() as number),
  },
  {
    accessorKey: 'payment_method',
    header: '支付方式',
    cell: (info) => {
      const v = info.getValue() as PaymentMethod | null
      return v ? PAYMENT_METHOD_LABELS[v] : '-'
    },
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: info => (info.getValue() as string | undefined)?.slice(0, 19).replace('T', ' '),
  },
  {
    id: 'operation',
    header: '操作',
    width: 200,
    align: 'center',
    fixed: 'right',
  },
])

/** 金额格式化 */
function formatMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) {
    return '-'
  }
  return `¥${Number(v).toFixed(2)}`
}

/** 加载发票列表 */
function getDataList() {
  loading.value = true
  apiBilling
    .listInvoices({
      tenantId: tenantStore.currentTenantId || undefined,
      storeId: search.value.storeId || tenantStore.currentStoreId || undefined,
      status: search.value.status || undefined,
      keyword: search.value.keyword || undefined,
    })
    .then((res: any) => {
      dataList.value = res.data.list ?? []
      total.value = res.data.total ?? 0
    })
    .finally(() => {
      loading.value = false
    })
}

/** 确认发票 */
function onConfirm(row: InvoiceRow) {
  useFaModal().confirm({
    title: '确认发票',
    content: `确认发票「${row.invoice_no}」吗?确认后客户可进行支付。`,
    onConfirm: () => {
      apiBilling.confirmInvoice(row.id).then(() => {
        useFaToast().success('已确认')
        getDataList()
      })
    },
  })
}

/** 取消发票 */
function onCancel(row: InvoiceRow) {
  useFaModal().confirm({
    title: '取消发票',
    content: `确认取消发票「${row.invoice_no}」吗?取消后不可恢复。`,
    onConfirm: () => {
      apiBilling.cancelInvoice(row.id, '用户取消').then(() => {
        useFaToast().success('已取消')
        getDataList()
      })
    },
  })
}

/**
 * 打开退款弹窗(MXQ-8004)
 * 仅 paid / partially_paid 状态可退款,默认退款金额为剩余可退金额
 * @param row 目标发票
 */
function openRefund(row: InvoiceRow) {
  refundTarget.value = row
  refundForm.value = {
    amount: Number(row.paid_amount ?? 0),
    reason: '',
  }
  refundVisible.value = true
}

/**
 * 执行退款(走 Hono Command + process_refund RPC)
 * 带幂等键防止重复请求导致重复扣减
 */
function onRefund() {
  const target = refundTarget.value
  if (!target) {
    return
  }
  const amount = Number(refundForm.value.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    useFaToast().warning('请输入有效的退款金额')
    return
  }
  if (amount > Number(target.paid_amount ?? 0)) {
    useFaToast().warning(`退款金额不能超过已收金额 ¥${Number(target.paid_amount).toFixed(2)}`)
    return
  }
  if (!refundForm.value.reason.trim()) {
    useFaToast().warning('请填写退款原因')
    return
  }
  refundSubmitting.value = true
  apiBilling
    .processRefund(
      {
        invoiceId: target.id,
        amount,
        reason: refundForm.value.reason.trim(),
      },
      generateIdempotencyKey(),
    )
    .then(() => {
      useFaToast().success('退款成功')
      refundVisible.value = false
      getDataList()
    })
    .finally(() => {
      refundSubmitting.value = false
    })
}

/** 跳转收银台 */
function onGotoCashier() {
  useRouter().push({ name: 'billingCashier' })
}

onMounted(getDataList)
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="发票列表" class="mb-0">
      <template #description>
        收费收银:发票状态机 draft → confirmed → paid → refunded;大额折扣需 manager 审批
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
            <FaLabel label="发票号" class="col-span-1">
              <FaInput
                v-model="search.keyword"
                placeholder="按发票号搜索"
                clearable
                class="w-full"
                @keydown.enter="getDataList"
                @clear="getDataList"
              />
            </FaLabel>
            <FaLabel label="状态" class="col-span-1">
              <FaSelect
                v-model="search.status"
                placeholder="全部状态"
                class="w-full"
                :options="statusOptions"
                @change="getDataList"
              />
            </FaLabel>
            <FaLabel label="门店" class="col-span-1">
              <BusinessStorePicker v-model="search.storeId" placeholder="选择门店(可选)" />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton variant="outline" @click="search.keyword = ''; search.status = ''; search.storeId = ''; getDataList()">
                重置
              </FaButton>
              <FaButton type="primary" @click="getDataList">
                <FaIcon name="i-ri:search-line" />
                筛选
              </FaButton>
            </div>
          </div>
        </template>
      </FaSearchBar>
      <div class="mx--4 my-3 border-t border-t-dashed" />
      <FaTable
        v-loading="loading"
        table-root-class="rounded-lg overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="tableColumns"
        :data="dataList"
      >
        <template #toolbar>
          <FaButton type="primary" @click="onGotoCashier">
            <FaIcon name="i-ri:add-line" />
            新建收银
          </FaButton>
        </template>
        <template #cell-operation="{ row }">
          <div class="flex-center gap-2">
            <FaButton
              v-if="row.original.status === 'draft'"
              variant="outline"
              size="icon-sm"
              @click="onConfirm(row.original)"
            >
              <FaIcon name="i-ri:check-line" />
            </FaButton>
            <FaButton
              v-if="row.original.status === 'draft' || row.original.status === 'confirmed'"
              variant="outline"
              size="icon-sm"
              @click="onCancel(row.original)"
            >
              <FaIcon name="i-ri:close-line" />
            </FaButton>
            <FaButton
              v-if="row.original.status === 'paid' || row.original.status === 'partially_paid'"
              variant="outline"
              size="icon-sm"
              @click="openRefund(row.original)"
            >
              <FaIcon name="i-ri:refund-2-line" />
            </FaButton>
            <FaButton
              variant="outline"
              size="icon-sm"
              @click="onGotoCashier"
            >
              <FaIcon name="i-ri:eye-line" />
            </FaButton>
          </div>
        </template>
      </FaTable>
      <div v-if="total > 0" class="text-sm text-secondary-foreground/60 mt-2">
        共 {{ total }} 条
      </div>

      <!-- 退款弹窗(MXQ-8004) -->
      <FaModal
        v-model="refundVisible"
        title="退款"
        confirm-text="确认退款"
        :loading="refundSubmitting"
        @confirm="onRefund"
      >
        <div class="space-y-4">
          <div v-if="refundTarget" class="text-sm text-secondary-foreground/70">
            发票:{{ refundTarget.invoice_no }} | 已收:{{ formatMoney(refundTarget.paid_amount) }}
          </div>
          <FaLabel label="退款金额">
            <FaInput
              v-model.number="refundForm.amount"
              type="number"
              :min="0.01"
              class="w-full"
              placeholder="请输入退款金额"
            />
          </FaLabel>
          <FaLabel label="退款原因">
            <FaInput
              v-model="refundForm.reason"
              type="textarea"
              class="w-full"
              placeholder="请输入退款原因(必填)"
            />
          </FaLabel>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
