<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  PaymentChannel,
  PaymentChannelSummary,
  ReconciliationRecord,
  ReconciliationStatus,
} from '@/types/closing'
import apiClosing from '@/api/modules/closing'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  PAYMENT_CHANNEL_LABELS,
  RECONCILIATION_STATUS_LABELS,
} from '@/types/closing'
import { formatDate, formatDateTime, formatMoney } from '@/utils/format'

defineOptions({
  name: 'BillingReconciliation',
})

/** 列表展示行 */
interface DisplayRow {
  id: string
  storeName: string
  businessDate: string
  channel: PaymentChannel
  systemExpected: number
  actualAmount: number
  difference: number
  differenceReason: string | null
  status: ReconciliationStatus
  confirmedAt: string | null
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const summaryLoading = ref(false)
const dataList = ref<ReconciliationRecord[]>([])
const channelSummary = ref<PaymentChannelSummary | null>(null)
// 复审审计(S3.1-Fix-Reaudit-v3 §6):computed 而非 ref+onMounted,切租户即时响应,不保留旧 Tenant 快照
const currentTenantId = computed(() => tenantStore.currentTenantId)
const searchStoreId = ref('')
const searchBusinessDate = ref('')
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
    accessorKey: 'channel',
    header: '渠道',
    cell: info => PAYMENT_CHANNEL_LABELS[info.getValue() as PaymentChannel] ?? '-',
  },
  {
    accessorKey: 'systemExpected',
    header: '系统期望',
    cell: info => formatMoney(info.getValue() as number),
  },
  {
    accessorKey: 'actualAmount',
    header: '实际金额',
    cell: info => formatMoney(info.getValue() as number),
  },
  {
    accessorKey: 'difference',
    header: '差异',
    cell: (info) => {
      const v = Number(info.getValue())
      return formatMoney(v)
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: info => RECONCILIATION_STATUS_LABELS[info.getValue() as ReconciliationStatus] ?? '-',
  },
  {
    accessorKey: 'differenceReason',
    header: '差异原因',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'confirmedAt',
    header: '确认时间',
    cell: info => formatDateTime(info.getValue() as string),
  },
  {
    id: 'operation',
    header: '操作',
    width: 180,
    align: 'center',
    fixed: 'right',
  },
])

/** 行 → 展示结构 */
function toDisplayRow(row: ReconciliationRecord): DisplayRow {
  return {
    id: row.id,
    storeName: row.stores?.name ?? '-',
    businessDate: row.business_date,
    channel: row.channel,
    systemExpected: Number(row.system_expected),
    actualAmount: Number(row.actual_amount),
    difference: Number(row.difference),
    differenceReason: row.difference_reason,
    status: row.status,
    confirmedAt: row.confirmed_at,
  }
}

/**
 * 加载对账记录列表(浏览器直连,RLS 兜底)
 */
async function getDataList() {
  if (!currentTenantId.value) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiClosing.listReconciliationRecords(
      currentTenantId.value,
      searchStoreId.value || undefined,
      searchBusinessDate.value || undefined,
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

/**
 * 加载支付渠道汇总(走 Hono Command,服务端聚合真实 payments/refunds)
 * 需先选定门店 + 业务日期
 */
async function loadChannelSummary() {
  if (!searchStoreId.value || !searchBusinessDate.value) {
    channelSummary.value = null
    return
  }
  summaryLoading.value = true
  try {
    const res = await apiClosing.getChannelSummary(searchStoreId.value, searchBusinessDate.value)
    channelSummary.value = res.data
  }
  catch (e: any) {
    channelSummary.value = null
    useFaToast().error(e?.message || '渠道汇总加载失败')
  }
  finally {
    summaryLoading.value = false
  }
}

/** 查询(列表 + 渠道汇总一起刷新) */
function onSearch() {
  getDataList()
  loadChannelSummary()
}

// ============================================================
// 录入实际金额(走 Hono Command,权限 reconciliation.edit)
// ============================================================
const saveVisible = ref(false)
const saveSubmitting = ref(false)
const saveForm = reactive<{
  channel: PaymentChannel | ''
  actualAmount: string
}>({
  channel: '',
  actualAmount: '',
})

/** 打开录入抽屉(渠道默认现金) */
function openSaveDrawer() {
  Object.assign(saveForm, { channel: 'cash', actualAmount: '' })
  saveVisible.value = true
}

/**
 * 提交录入:system_expected 由日结快照推导(服务端),不信任客户端;
 * difference = actual - expected,0 -> matched,否则 pending
 */
async function onSubmitSave() {
  if (!searchStoreId.value || !searchBusinessDate.value) {
    useFaToast().warning('请先选择门店与业务日期')
    return
  }
  if (!saveForm.channel) {
    useFaToast().warning('请选择渠道')
    return
  }
  const amount = Number(saveForm.actualAmount)
  if (!Number.isFinite(amount) || amount < 0) {
    useFaToast().warning('实际金额必须大于等于 0')
    return
  }
  if (saveSubmitting.value) {
    return
  }
  saveSubmitting.value = true
  try {
    await apiClosing.saveReconciliationActual({
      storeId: searchStoreId.value,
      businessDate: searchBusinessDate.value,
      channel: saveForm.channel as PaymentChannel,
      actualAmount: amount,
    })
    saveVisible.value = false
    useFaToast().success('对账金额已录入')
    getDataList()
    loadChannelSummary()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '录入失败')
  }
  finally {
    saveSubmitting.value = false
  }
}

/** 渠道选择项 */
const channelOptions = Object.entries(PAYMENT_CHANNEL_LABELS).map(([value, label]) => ({ value, label }))

// ============================================================
// 差异确认(走 Hono Command,权限 reconciliation.confirm)
// ============================================================
const confirmVisible = ref(false)
const confirmSubmitting = ref(false)
const confirmTarget = ref<ReconciliationRecord | null>(null)
const confirmForm = reactive<{ differenceReason: string }>({
  differenceReason: '',
})

/** 打开差异确认弹窗(差异≠0 必须填原因) */
function openConfirm(row: DisplayRow) {
  const src = dataList.value.find(r => r.id === row.id)
  if (!src) {
    return
  }
  confirmTarget.value = src
  confirmForm.differenceReason = src.difference_reason ?? ''
  confirmVisible.value = true
}

/**
 * 提交差异确认:差异=0 -> confirmed,否则 difference_confirmed(必须填原因);
 * 审计含 reason/actor/timestamp/request_id(服务端生成)
 */
async function onSubmitConfirm() {
  const target = confirmTarget.value
  if (!target) {
    return
  }
  if (Number(target.difference) !== 0 && !confirmForm.differenceReason.trim()) {
    useFaToast().warning('存在差异,必须填写差异原因')
    return
  }
  if (confirmSubmitting.value) {
    return
  }
  confirmSubmitting.value = true
  try {
    await apiClosing.confirmReconciliation(target.id, {
      differenceReason: confirmForm.differenceReason.trim() || null,
    })
    confirmVisible.value = false
    useFaToast().success('对账已确认')
    getDataList()
    loadChannelSummary()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '确认失败')
  }
  finally {
    confirmSubmitting.value = false
  }
}

/** 渠道汇总卡片(实收/退款/净额/快照期望) */
const summaryCards = computed(() => {
  const s = channelSummary.value
  if (!s) {
    return []
  }
  return s.channels.map(ch => ({
    channel: ch.channel,
    label: PAYMENT_CHANNEL_LABELS[ch.channel] ?? ch.channel,
    payment: Number(ch.payment),
    refund: Number(ch.refund),
    net: Number(ch.net),
    expected: Number(ch.closingExpected),
  }))
})

// 复审审计 §6:切租户时重置门店筛选并刷新列表+渠道汇总,避免残留旧租户数据
watch(currentTenantId, () => {
  searchStoreId.value = ''
  onSearch()
})

onMounted(() => {
  // 审计 S3.1 P0-03:统一使用全局 Tenant Store 上下文,不再自行从 memberships 推导当前租户
  getDataList()
})
</script>

<template>
  <!-- 标准布局:外层固定高度容器,撑满视口 -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域 -->
    <!--
    <EntityPageHeader compact title="渠道对账" description="系统账面金额 vs 人工录入实际金额:录入后自动比对差异,确认时差异必须填写原因(审计留痕)" />
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <!-- 无租户上下文警告条 -->
      <div
        v-if="platformUiDeferred"
        class="text-sm text-amber-700 px-4 py-3 border border-amber-200 rounded-md bg-amber-50 shrink-0"
      >
        当前账号无租户成员关系,无法确定租户上下文。
      </div>
      <!-- 主内容白底卡片 -->
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 卡片顶部筛选区:筛选控件左、功能按钮右 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 flex flex-wrap gap-3 items-center">
            <BusinessStorePicker v-model="searchStoreId" placeholder="选择门店" class="w-56" />
            <FaInput v-model="searchBusinessDate" type="date" placeholder="业务日期" class="w-44" />
            <FaButton variant="outline" @click="onSearch">
              查询
            </FaButton>
            <div class="ml-auto flex gap-2 items-center">
              <PermissionButton permission="reconciliation.edit" @click="openSaveDrawer">
                录入实际金额
              </PermissionButton>
            </div>
          </div>
        </div>
        <!-- 渠道汇总卡片(服务端聚合真实 payments/refunds) -->
        <div v-loading="summaryLoading" class="px-4 py-3 border-b shrink-0">
          <template v-if="channelSummary">
          <div class="text-xs text-gray-500 mb-2">
            门店实收汇总({{ formatDate(channelSummary.businessDate) }})· 日结状态:
            {{ channelSummary.closingStatus ? (channelSummary.closingStatus === 'adjusted' ? '已调整' : '已关闭') : '未关账' }}
          </div>
          <div class="gap-3 grid grid-cols-2 lg:grid-cols-6 md:grid-cols-3">
            <div
              v-for="card in summaryCards"
              :key="card.channel"
              class="p-3 border border-gray-200 rounded-lg bg-white"
            >
              <div class="text-xs text-gray-500 mb-1">
                {{ card.label }}
              </div>
              <div class="text-sm font-medium">
                实收 {{ formatMoney(card.payment) }}
              </div>
              <div class="text-xs text-gray-400">
                退款 {{ formatMoney(card.refund) }} · 净额 {{ formatMoney(card.net) }}
              </div>
              <div class="text-xs text-blue-600">
                快照期望 {{ formatMoney(card.expected) }}
              </div>
            </div>
          </div>
        </template>
        <div v-else-if="!searchStoreId || !searchBusinessDate" class="text-xs text-gray-400">
          请选择门店与业务日期后查看渠道实收汇总
        </div>
        </div>
        <!-- 中部表格区 -->
        <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="tableColumns"
            :data="dataList.map(toDisplayRow)"
          >
            <template #cell-operation="{ row }">
          <PermissionButton
            v-if="!['confirmed', 'difference_confirmed'].includes(row.original.status)"
            permission="reconciliation.confirm"
            size="sm"
            variant="outline"
            @click="openConfirm(row.original)"
          >
            确认
          </PermissionButton>
          <span v-else class="text-xs text-gray-400">
            已确认
          </span>
          </template>
          </FaTable>
        </div>
      </div>
    </div>

    <!-- 录入实际金额抽屉 -->
    <FaDrawer v-model="saveVisible" title="录入实际金额" :width="480">
      <div class="space-y-3">
        <div class="text-xs text-gray-500">
          门店:{{ searchStoreId ? '已选择' : '未选择' }} · 业务日期:{{ searchBusinessDate || '-' }}
        </div>
        <FaLabel label="渠道">
          <FaSelect v-model="saveForm.channel" :options="channelOptions" class="w-full" />
        </FaLabel>
        <FaLabel label="实际金额">
          <FaInput v-model="saveForm.actualAmount" type="number" placeholder="门店核账后的实际金额(元)" class="w-full" />
        </FaLabel>
        <div class="text-xs text-gray-500">
          系统期望金额由已关账的日结快照推导,录入后自动计算差异;差异为 0 状态变为「无差异」,否则进入「待确认」。
        </div>
      </div>
      <template #footer>
        <div class="flex gap-2 justify-end">
          <FaButton variant="outline" @click="saveVisible = false">
            取消
          </FaButton>
          <FaButton type="primary" :loading="saveSubmitting" @click="onSubmitSave">
            保存
          </FaButton>
        </div>
      </template>
    </FaDrawer>

    <!-- 差异确认弹窗 -->
    <FaModal
      v-model="confirmVisible"
      title="确认对账"
      :loading="confirmSubmitting"
      confirm-text="确认"
      @confirm="onSubmitConfirm"
    >
      <div v-if="confirmTarget" class="space-y-3">
        <div class="text-sm">
          {{ PAYMENT_CHANNEL_LABELS[confirmTarget.channel] ?? confirmTarget.channel }} 渠道
          · 期望 {{ formatMoney(confirmTarget.system_expected) }}
          · 实际 {{ formatMoney(confirmTarget.actual_amount) }}
          · 差异
          <span :class="Number(confirmTarget.difference) === 0 ? '' : 'text-red-600'">
            {{ formatMoney(confirmTarget.difference) }}
          </span>
        </div>
        <FaLabel v-if="Number(confirmTarget.difference) !== 0" label="差异原因">
          <FaInput
            v-model="confirmForm.differenceReason"
            type="textarea"
            placeholder="存在差异必须填写差异原因(审计要求)"
            class="w-full"
          />
        </FaLabel>
        <div v-else class="text-xs text-gray-500">
          无差异,确认后状态为「已确认」。
        </div>
      </div>
    </FaModal>
  </div>
</template>
