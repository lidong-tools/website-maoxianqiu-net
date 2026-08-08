<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  ClosingAdjustmentRecord,
  ClosingAdjustmentType,
  DailyClosingRecord,
  DailyClosingStatus,
} from '@/types/closing'
import apiClosing from '@/api/modules/closing'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  ADJUSTMENT_TYPE_LABELS,
  DAILY_CLOSING_STATUS_LABELS,
} from '@/types/closing'
import { formatDate, formatDateTime, formatMoney } from '@/utils/format'

defineOptions({
  name: 'BillingClosing',
})

/** 列表展示行 */
interface DisplayRow {
  id: string
  storeName: string
  businessDate: string
  status: DailyClosingStatus
  grossAmount: number
  paidAmount: number
  refundAmount: number
  receivableAmount: number
  invoiceCount: number
  closedAt: string | null
  adjustedAt: string | null
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<DailyClosingRecord[]>([])
// 复审审计(S3.1-Fix-Reaudit-v3 §6):computed 而非 ref+onMounted,切租户即时响应,不保留旧 Tenant 快照
const currentTenantId = computed(() => tenantStore.currentTenantId)
const searchStoreId = ref('')
const platformUiDeferred = computed(() => !tenantStore.currentTenantId)

/** 列表列配置 */
const tableColumns = computed<TableColumn<DisplayRow>[]>(() => [
  {
    accessorKey: 'storeName',
    header: '门店',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'businessDate',
    header: '业务日期',
    cell: info => formatDate(info.getValue() as string),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: info => DAILY_CLOSING_STATUS_LABELS[info.getValue() as DailyClosingStatus] ?? '-',
  },
  {
    accessorKey: 'grossAmount',
    header: '应收(gross)',
    cell: info => formatMoney(info.getValue() as number),
  },
  {
    accessorKey: 'paidAmount',
    header: '实收(paid)',
    cell: info => formatMoney(info.getValue() as number),
  },
  {
    accessorKey: 'refundAmount',
    header: '退款(refund)',
    cell: info => formatMoney(info.getValue() as number),
  },
  {
    accessorKey: 'receivableAmount',
    header: '应收余额',
    cell: info => formatMoney(info.getValue() as number),
  },
  {
    accessorKey: 'invoiceCount',
    header: '发票数',
  },
  {
    accessorKey: 'closedAt',
    header: '关账时间',
    cell: info => formatDateTime(info.getValue() as string),
  },
  {
    id: 'operation',
    header: '操作',
    width: 200,
    align: 'center',
    fixed: 'right',
  },
])

/** 行 → 展示结构 */
function toDisplayRow(row: DailyClosingRecord): DisplayRow {
  return {
    id: row.id,
    storeName: row.stores?.name ?? '-',
    businessDate: row.business_date,
    status: row.status,
    grossAmount: Number(row.gross_amount),
    paidAmount: Number(row.paid_amount),
    refundAmount: Number(row.refund_amount),
    receivableAmount: Number(row.receivable_amount),
    invoiceCount: Number(row.invoice_count),
    closedAt: row.closed_at,
    adjustedAt: row.adjusted_at,
  }
}

/**
 * 加载日结列表(浏览器直连,RLS 兜底)
 */
async function getDataList() {
  if (!currentTenantId.value) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiClosing.listDailyClosings(
      currentTenantId.value,
      searchStoreId.value || undefined,
    )
    dataList.value = res.data.list ?? []
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载失败')
  }
  finally {
    loading.value = false
  }
}

// ============================================================
// 执行日结(走 Hono Command,权限 daily_closing.close)
// ============================================================
const closeVisible = ref(false)
const closeSubmitting = ref(false)
const closeForm = reactive({
  storeId: '',
  businessDate: formatDate(new Date()),
})

/** 打开执行日结抽屉(默认选中筛选门店,业务日期默认今天) */
function openCloseDrawer() {
  closeForm.storeId = searchStoreId.value || ''
  closeForm.businessDate = formatDate(new Date())
  closeVisible.value = true
}

/**
 * 提交执行日结:幂等键由前端生成,重复点击返回原结果不重算
 */
async function onSubmitClose() {
  if (!closeForm.storeId) {
    useFaToast().warning('请选择门店')
    return
  }
  if (!closeForm.businessDate) {
    useFaToast().warning('请选择业务日期')
    return
  }
  if (closeSubmitting.value) {
    return
  }
  closeSubmitting.value = true
  try {
    await apiClosing.closeDailyBusiness({
      storeId: closeForm.storeId,
      businessDate: closeForm.businessDate,
      idempotencyKey: crypto.randomUUID(),
    })
    closeVisible.value = false
    useFaToast().success('日结已完成')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '执行日结失败')
  }
  finally {
    closeSubmitting.value = false
  }
}

// ============================================================
// 日结快照详情(历史读取快照,不重新实时计算)
// ============================================================
const detailVisible = ref(false)
const detailRow = ref<DailyClosingRecord | null>(null)
const snapshotItems = computed(() => {
  const row = detailRow.value
  if (!row) {
    return []
  }
  const s = row.snapshot ?? {}
  const totals = s.totals ?? {}
  const pm = s.payment_method_breakdown ?? {}
  return [
    { label: '业务日期', value: formatDate(row.business_date) },
    { label: '状态', value: DAILY_CLOSING_STATUS_LABELS[row.status] ?? '-' },
    { label: '应收(gross)', value: formatMoney(totals.gross_amount) },
    { label: '实收(paid)', value: formatMoney(totals.paid_amount) },
    { label: '退款(refund)', value: formatMoney(totals.refund_amount) },
    { label: '应收余额', value: formatMoney(totals.receivable_amount) },
    { label: '发票数', value: totals.invoice_count ?? '-' },
    { label: '现金', value: formatMoney(pm.cash) },
    { label: '银行卡', value: formatMoney(pm.card) },
    { label: '微信', value: formatMoney(pm.wechat) },
    { label: '支付宝', value: formatMoney(pm.alipay) },
    { label: '储值卡', value: formatMoney(pm.stored_value) },
    { label: '其他', value: formatMoney(pm.other) },
    { label: '关账时间', value: formatDateTime(row.closed_at) },
    { label: '调整时间', value: formatDateTime(row.adjusted_at) },
  ]
})

/** 调整流水列配置 */
const adjustmentColumns = computed<TableColumn<ClosingAdjustmentRecord>[]>(() => [
  {
    accessorKey: 'adjustment_type',
    header: '类型',
    cell: info => ADJUSTMENT_TYPE_LABELS[info.getValue() as ClosingAdjustmentType] ?? '-',
  },
  {
    accessorKey: 'amount',
    header: '金额',
    cell: info => formatMoney(info.getValue() as number),
  },
  { accessorKey: 'reason', header: '原因' },
  {
    accessorKey: 'created_at',
    header: '时间',
    cell: info => formatDateTime(info.getValue() as string),
  },
])

/** 打开快照详情并加载调整流水 */
function openDetail(row: DisplayRow) {
  const src = dataList.value.find(r => r.id === row.id)
  if (!src) {
    return
  }
  detailRow.value = src
  detailVisible.value = true
  loadAdjustments(src.id)
}

// ============================================================
// 调整流水(浏览器直连 closing_adjustments)
// ============================================================
const adjustments = ref<ClosingAdjustmentRecord[]>([])

/** 加载日结调整流水 */
async function loadAdjustments(closingId: string) {
  try {
    const res: any = await apiClosing.listClosingAdjustments(closingId)
    adjustments.value = res.data.list ?? []
  }
  catch {
    adjustments.value = []
  }
}

// ============================================================
// 调整日结(走 Hono Command,权限 daily_closing.adjust)
// ============================================================
const adjustVisible = ref(false)
const adjustSubmitting = ref(false)
const adjustTarget = ref<DailyClosingRecord | null>(null)
const adjustForm = reactive<{
  adjustmentType: ClosingAdjustmentType
  amount: string
  reason: string
}>({
  adjustmentType: 'cash_short',
  amount: '',
  reason: '',
})

/** 打开调整抽屉(仅 closed/adjusted 状态可调整) */
function openAdjust(row: DisplayRow) {
  const src = dataList.value.find(r => r.id === row.id)
  if (!src) {
    return
  }
  adjustTarget.value = src
  Object.assign(adjustForm, { adjustmentType: 'cash_short', amount: '', reason: '' })
  adjustVisible.value = true
}

/**
 * 提交调整:追加调整流水 + adjustment_summary,状态流转 closed -> adjusted
 */
async function onSubmitAdjust() {
  const target = adjustTarget.value
  if (!target) {
    return
  }
  const amount = Number(adjustForm.amount)
  if (!Number.isFinite(amount) || amount === 0) {
    useFaToast().warning('调整金额不可为 0')
    return
  }
  if (!adjustForm.reason.trim()) {
    useFaToast().warning('请填写调整原因')
    return
  }
  if (adjustSubmitting.value) {
    return
  }
  adjustSubmitting.value = true
  try {
    await apiClosing.adjustDailyClosing({
      closingId: target.id,
      adjustmentType: adjustForm.adjustmentType,
      amount,
      reason: adjustForm.reason.trim(),
    })
    adjustVisible.value = false
    useFaToast().success('日结已调整')
    getDataList()
    loadAdjustments(target.id)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '调整失败')
  }
  finally {
    adjustSubmitting.value = false
  }
}

/** 调整类型选择项 */
const adjustmentTypeOptions = Object.entries(ADJUSTMENT_TYPE_LABELS).map(([value, label]) => ({ value, label }))

// 复审审计 §6:切租户时重置门店筛选并重载,避免残留旧租户数据
watch(currentTenantId, () => {
  searchStoreId.value = ''
  getDataList()
})

onMounted(() => {
  // 审计 S3.1 P0-03:统一使用全局 Tenant Store 上下文,不再自行从 memberships 推导当前租户
  getDataList()
})
</script>

<template>
  <div>
    <EntityPageHeader compact title="每日日结" description="按业务日期(Asia/Shanghai)固化门店每日经营快照:应收/实收/退款/渠道拆分,关闭后历史读取快照" />
    <FaPageMain>
      <div
        v-if="platformUiDeferred"
        class="text-sm text-amber-700 mb-3 px-4 py-3 border border-amber-200 rounded-md bg-amber-50"
      >
        当前账号无租户成员关系,无法确定租户上下文。平台管理员跨租户日结的界面将在后续版本提供。
      </div>
      <div class="mb-3 flex flex-wrap gap-2 items-center">
        <BusinessStorePicker v-model="searchStoreId" placeholder="选择门店(可选)" class="w-56" />
        <FaButton variant="outline" @click="getDataList">
          查询
        </FaButton>
      </div>
      <FaTable
        v-loading="loading"
        table-root-class="rounded-lg overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="tableColumns"
        :data="dataList.map(toDisplayRow)"
      >
        <template #toolbar>
          <PermissionButton permission="daily_closing.close" @click="openCloseDrawer">
            执行日结
          </PermissionButton>
        </template>
        <template #cell-operation="{ row }">
          <FaButton size="sm" variant="outline" class="mr-1" @click="openDetail(row.original)">
            快照
          </FaButton>
          <PermissionButton
            v-if="['closed', 'adjusted'].includes(row.original.status)"
            permission="daily_closing.adjust"
            size="sm"
            variant="outline"
            @click="openAdjust(row.original)"
          >
            调整
          </PermissionButton>
        </template>
      </FaTable>
    </FaPageMain>

    <!-- 执行日结抽屉 -->
    <FaDrawer v-model="closeVisible" title="执行日结" :width="480">
      <div class="space-y-3">
        <FaLabel label="门店">
          <BusinessStorePicker v-model="closeForm.storeId" class="w-full" />
        </FaLabel>
        <FaLabel label="业务日期">
          <FaInput v-model="closeForm.businessDate" type="date" class="w-full" />
        </FaLabel>
        <div class="text-xs text-gray-500">
          将按 Asia/Shanghai 时区当日 00:00~24:00 的发票/支付/退款实时计算并固化快照;
          同一门店同一业务日期只能存在一份正式日结,重复执行返回已存在快照。
        </div>
      </div>
      <template #footer>
        <div class="flex gap-2 justify-end">
          <FaButton variant="outline" @click="closeVisible = false">
            取消
          </FaButton>
          <FaButton type="primary" :loading="closeSubmitting" @click="onSubmitClose">
            执行日结
          </FaButton>
        </div>
      </template>
    </FaDrawer>

    <!-- 快照详情抽屉 -->
    <FaDrawer v-model="detailVisible" title="日结快照" :width="560">
      <div v-if="detailRow" class="text-sm space-y-3">
        <FaDescriptions :items="snapshotItems" :column="2" />
        <FaDivider />
        <div class="font-medium">
          调整流水
        </div>
        <FaTable
          row-key="id"
          stripe
          border
          :columns="adjustmentColumns"
          :data="adjustments"
        />
        <div v-if="adjustments.length === 0" class="text-xs text-gray-400">
          暂无调整记录
        </div>
      </div>
    </FaDrawer>

    <!-- 调整日结抽屉 -->
    <FaDrawer v-model="adjustVisible" title="调整日结" :width="480">
      <div v-if="adjustTarget" class="space-y-3">
        <div class="text-xs text-gray-500">
          调整对象:{{ formatDate(adjustTarget.business_date) }} · 当前应收余额
          {{ formatMoney(adjustTarget.receivable_amount) }}
        </div>
        <FaLabel label="调整类型">
          <FaSelect v-model="adjustForm.adjustmentType" :options="adjustmentTypeOptions" class="w-full" />
        </FaLabel>
        <FaLabel label="调整金额">
          <FaInput v-model="adjustForm.amount" type="number" placeholder="正数=加计,负数=冲减" class="w-full" />
        </FaLabel>
        <FaLabel label="调整原因">
          <FaInput v-model="adjustForm.reason" type="textarea" placeholder="必须填写调整原因(审计要求)" class="w-full" />
        </FaLabel>
      </div>
      <template #footer>
        <div class="flex gap-2 justify-end">
          <FaButton variant="outline" @click="adjustVisible = false">
            取消
          </FaButton>
          <FaButton type="primary" :loading="adjustSubmitting" @click="onSubmitAdjust">
            确认调整
          </FaButton>
        </div>
      </template>
    </FaDrawer>
  </div>
</template>
