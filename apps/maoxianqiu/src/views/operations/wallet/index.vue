<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  StoredValueAccount,
  StoredValueLedgerEntry,
} from '@/types/wallet'
import {
  ACCOUNT_STATUS_LABELS,
  LEDGER_TYPE_LABELS,
  WALLET_PERMISSIONS,
} from '@/types/wallet'
import apiWallet from '@/api/modules/wallet'
import BusinessCustomerPicker from '@/components/business/CustomerPicker/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'OperationsWallet',
})

const tenantStore = useAppTenantStore()

function tenantId(): string {
  return tenantStore.currentTenantId || ''
}

function storeId(): string {
  return tenantStore.currentStoreId || ''
}

function requireTenant(): boolean {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户与门店')
    return false
  }
  return true
}

function formatMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) {
    return '-'
  }
  return `¥${Number(v).toFixed(2)}`
}

// ===== 账户列表 =====
const accounts = ref<StoredValueAccount[]>([])
const loading = ref(false)
const keyword = ref('')
const statusFilter = ref('')
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const accountColumns = computed<TableColumn<StoredValueAccount>[]>(() => [
  {
    accessorKey: 'customer.name',
    header: '客户',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'customer.phone',
    header: '手机号',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'balance',
    header: '储值余额',
    cell: info => formatMoney(Number(info.getValue())),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: info => ACCOUNT_STATUS_LABELS[info.getValue() as keyof typeof ACCOUNT_STATUS_LABELS] ?? info.getValue(),
  },
  {
    accessorKey: 'opened_at',
    header: '开户时间',
    cell: info => String(info.getValue() ?? '-').slice(0, 10),
  },
  {
    id: 'operation',
    header: '操作',
    width: 220,
    align: 'center',
    fixed: 'right',
  },
])

/**
 * 加载储值账户列表(Hono 只读路由,租户 + 门店作用域)
 */
async function loadAccounts() {
  if (!requireTenant()) {
    return
  }
  loading.value = true
  try {
    const res = await apiWallet.listAccounts({
      tenantId: tenantId(),
      storeId: storeId() || undefined,
      keyword: keyword.value.trim() || undefined,
      status: statusFilter.value || undefined,
      from: (page.value - 1) * pageSize.value,
      limit: pageSize.value,
    })
    accounts.value = res.list ?? []
    total.value = res.total ?? 0
  }
  catch (e) {
    useFaToast().error('加载储值账户失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    loading.value = false
  }
}

function onSearch() {
  page.value = 1
  loadAccounts()
}

// ===== 开户 =====
const openVisible = ref(false)
const openSaving = ref(false)
const openForm = reactive({ customerId: '' })

/**
 * 打开开户对话框(需先选客户)
 */
function openOpenDialog() {
  openForm.customerId = ''
  openVisible.value = true
}

/**
 * 提交开户(幂等:同客户同币种唯一账户)
 */
async function submitOpen() {
  if (!openForm.customerId) {
    useFaToast().warning('请选择客户')
    return
  }
  openSaving.value = true
  try {
    await apiWallet.openAccount({
      tenantId: tenantId(),
      storeId: storeId() || undefined,
      customerId: openForm.customerId,
    })
    useFaToast().success('开户成功')
    openVisible.value = false
    await loadAccounts()
  }
  catch (e) {
    useFaToast().error('开户失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    openSaving.value = false
  }
}

// ===== 充值 =====
const rechargeVisible = ref(false)
const rechargeSaving = ref(false)
const rechargeTarget = ref<StoredValueAccount | null>(null)
const RECHARGE_SOURCES = [
  { label: '现金', value: 'cash' },
  { label: '微信', value: 'wechat' },
  { label: '支付宝', value: 'alipay' },
  { label: '银行卡', value: 'card' },
  { label: '其他', value: 'other' },
]
const rechargeForm = reactive({
  amount: 0,
  bonusAmount: 0,
  source: 'cash',
  externalMethod: '',
  externalTxnNo: '',
  reason: '',
})

/**
 * 打开充值对话框
 * @param row 目标账户
 */
function openRechargeDialog(row: StoredValueAccount) {
  rechargeTarget.value = row
  Object.assign(rechargeForm, {
    amount: 0, bonusAmount: 0, source: 'cash', externalMethod: '', externalTxnNo: '', reason: '',
  })
  rechargeVisible.value = true
}

/**
 * 提交充值(本金 + 赠送金记账区分,幂等)
 */
async function submitRecharge() {
  if (!rechargeTarget.value) {
    return
  }
  if (rechargeForm.amount <= 0 && rechargeForm.bonusAmount <= 0) {
    useFaToast().warning('本金或赠送金额至少一项大于 0')
    return
  }
  rechargeSaving.value = true
  try {
    await apiWallet.recharge(rechargeTarget.value.id, {
      tenantId: tenantId(),
      storeId: storeId() || undefined,
      amount: rechargeForm.amount,
      bonusAmount: rechargeForm.bonusAmount,
      source: rechargeForm.source,
      externalMethod: rechargeForm.externalMethod || undefined,
      externalTxnNo: rechargeForm.externalTxnNo || undefined,
      reason: rechargeForm.reason || undefined,
    })
    useFaToast().success('充值成功')
    rechargeVisible.value = false
    await loadAccounts()
  }
  catch (e) {
    useFaToast().error('充值失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    rechargeSaving.value = false
  }
}

// ===== 人工调整(±) =====
const adjustVisible = ref(false)
const adjustSaving = ref(false)
const adjustTarget = ref<StoredValueAccount | null>(null)
const adjustForm = reactive({ delta: 0, reason: '' })

/**
 * 打开调整对话框(仅管理角色有 wallet.adjust 权限)
 * @param row 目标账户
 */
function openAdjustDialog(row: StoredValueAccount) {
  adjustTarget.value = row
  Object.assign(adjustForm, { delta: 0, reason: '' })
  adjustVisible.value = true
}

/**
 * 提交人工调整(±,reason 必填,幂等)
 */
async function submitAdjust() {
  if (!adjustTarget.value) {
    return
  }
  if (adjustForm.delta === 0) {
    useFaToast().warning('调整金额不能为 0')
    return
  }
  if (!adjustForm.reason.trim()) {
    useFaToast().warning('请填写调整原因')
    return
  }
  adjustSaving.value = true
  try {
    await apiWallet.adjust(adjustTarget.value.id, {
      tenantId: tenantId(),
      storeId: storeId() || undefined,
      delta: adjustForm.delta,
      reason: adjustForm.reason.trim(),
    })
    useFaToast().success('调整成功')
    adjustVisible.value = false
    await loadAccounts()
  }
  catch (e) {
    useFaToast().error('调整失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    adjustSaving.value = false
  }
}

// ===== 冻结/解冻/销户 =====
const statusVisible = ref(false)
const statusSaving = ref(false)
const statusTarget = ref<StoredValueAccount | null>(null)
const statusForm = reactive({ status: 'frozen' as 'active' | 'frozen' | 'closed', reason: '' })

/**
 * 打开状态变更对话框(冻结/销户须填原因;销户须余额清零)
 * @param row 目标账户
 * @param nextStatus 目标状态
 */
function openStatusDialog(row: StoredValueAccount, nextStatus: 'frozen' | 'active' | 'closed') {
  statusTarget.value = row
  Object.assign(statusForm, { status: nextStatus, reason: '' })
  statusVisible.value = true
}

/**
 * 提交状态变更(冻结/解冻/销户)
 */
async function submitStatus() {
  if (!statusTarget.value) {
    return
  }
  if (statusForm.status !== 'active' && !statusForm.reason.trim()) {
    useFaToast().warning('请填写操作原因')
    return
  }
  statusSaving.value = true
  try {
    await apiWallet.setStatus(statusTarget.value.id, {
      tenantId: tenantId(),
      storeId: storeId() || undefined,
      status: statusForm.status,
      reason: statusForm.reason.trim() || undefined,
    })
    useFaToast().success('操作成功')
    statusVisible.value = false
    await loadAccounts()
  }
  catch (e) {
    useFaToast().error('操作失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    statusSaving.value = false
  }
}

// ===== 流水(不可变,只读) =====
const ledgerVisible = ref(false)
const ledgerLoading = ref(false)
const ledgerTarget = ref<StoredValueAccount | null>(null)
const ledgerEntries = ref<StoredValueLedgerEntry[]>([])
const ledgerTotal = ref(0)
const ledgerPage = ref(1)
const ledgerPageSize = ref(20)

const ledgerColumns = computed<TableColumn<StoredValueLedgerEntry>[]>(() => [
  {
    accessorKey: 'direction',
    header: '方向',
    width: 80,
    cell: info => (info.getValue() === 'credit' ? '<span class="text-green-600">入账</span>' : '<span class="text-red-600">出账</span>'),
  },
  {
    accessorKey: 'type',
    header: '类型',
    cell: info => LEDGER_TYPE_LABELS[info.getValue() as keyof typeof LEDGER_TYPE_LABELS] ?? info.getValue(),
  },
  {
    accessorKey: 'amount',
    header: '金额',
    cell: info => formatMoney(Number(info.getValue())),
  },
  {
    accessorKey: 'balance_after',
    header: '变动后余额',
    cell: info => formatMoney(Number(info.getValue())),
  },
  { accessorKey: 'reason', header: '说明', cell: info => (info.getValue() as string | null) ?? '-' },
  {
    accessorKey: 'created_at',
    header: '时间',
    cell: info => String(info.getValue() ?? '-').slice(0, 19).replace('T', ' '),
  },
])

/**
 * 打开流水对话框并加载第一页
 * @param row 目标账户
 */
function openLedgerDialog(row: StoredValueAccount) {
  ledgerTarget.value = row
  ledgerPage.value = 1
  ledgerVisible.value = true
  loadLedger()
}

/**
 * 加载账户流水(不可变记录,仅返回)
 */
async function loadLedger() {
  if (!ledgerTarget.value) {
    return
  }
  ledgerLoading.value = true
  try {
    const res = await apiWallet.listLedger(ledgerTarget.value.id, {
      tenantId: tenantId(),
      storeId: storeId() || undefined,
      from: (ledgerPage.value - 1) * ledgerPageSize.value,
      limit: ledgerPageSize.value,
    })
    ledgerEntries.value = res.list ?? []
    ledgerTotal.value = res.total ?? 0
  }
  catch (e) {
    useFaToast().error('加载流水失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    ledgerLoading.value = false
  }
}

// ===== 页面生命周期:初始加载 + 切店刷新 =====
function load() {
  page.value = 1
  loadAccounts()
}
useStoreScopedPage({ load })
onMounted(load)
</script>

<template>
  <div>
    <EntityPageHeader compact title="储值账户">
      <template #description>
        客户储值账户、充值(本金+赠送)、消费扣款、退款返还、人工调整与冻结的统一管理;
        余额由服务端原子记账维护,流水不可修改。收银结算时可选储值支付方式。
      </template>
    </EntityPageHeader>
    <FaPageMain>
      <div class="mb-3 flex gap-2 items-center">
        <FaInput v-model="keyword" placeholder="按客户姓名/手机号搜索" class="w-64" @keyup.enter="onSearch" />
        <FaSelect
          v-model="statusFilter"
          :options="[
            { label: '全部状态', value: '' },
            { label: '正常', value: 'active' },
            { label: '已冻结', value: 'frozen' },
            { label: '已销户', value: 'closed' },
          ]"
          class="w-36"
        />
        <FaButton size="sm" variant="outline" @click="onSearch">
          <FaIcon name="i-ri:search-line" />
          查询
        </FaButton>
        <div class="flex-1" />
        <PermissionButton permission="wallet.recharge" size="sm" @click="openOpenDialog">
          <FaIcon name="i-ri:add-line" />
          开户
        </PermissionButton>
      </div>

      <FaTable
        v-loading="loading"
        table-root-class="rounded-lg overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="accountColumns"
        :data="accounts"
        empty-text="暂无储值账户"
      >
        <template #cell-operation="{ row }">
          <div class="flex-center gap-1">
            <PermissionButton permission="wallet.recharge" variant="outline" size="sm" @click="openRechargeDialog(row.original)">
              充值
            </PermissionButton>
            <PermissionButton permission="wallet.adjust" variant="outline" size="sm" @click="openAdjustDialog(row.original)">
              调整
            </PermissionButton>
            <PermissionButton
              v-if="row.original.status === 'active'"
              permission="wallet.freeze"
              variant="outline"
              size="sm"
              @click="openStatusDialog(row.original, 'frozen')"
            >
              冻结
            </PermissionButton>
            <PermissionButton
              v-else-if="row.original.status === 'frozen'"
              permission="wallet.freeze"
              variant="outline"
              size="sm"
              @click="openStatusDialog(row.original, 'active')"
            >
              解冻
            </PermissionButton>
            <FaButton variant="outline" size="sm" @click="openLedgerDialog(row.original)">
              流水
            </FaButton>
          </div>
        </template>
      </FaTable>
      <FaPagination
        :page="page"
        :size="pageSize"
        :total="total"
        class="mt-2 px-4 pb-3"
        @page-change="p => { page = p; loadAccounts() }"
        @size-change="s => { pageSize = s; page = 1; loadAccounts() }"
      />
    </FaPageMain>

    <!-- 开户 -->
    <FaModal v-model="openVisible" title="储值开户" :show-cancel="true" confirm-text="开户" :loading="openSaving" @confirm="submitOpen">
      <div class="grid grid-cols-1 gap-3 p-2">
        <FaLabel label="客户(必选)">
          <BusinessCustomerPicker v-model="openForm.customerId" placeholder="搜索选择客户" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 充值 -->
    <FaModal
      v-model="rechargeVisible"
      :title="`储值充值 · ${rechargeTarget?.customer?.name ?? '客户'}`"
      :show-cancel="true"
      confirm-text="确认充值"
      :loading="rechargeSaving"
      @confirm="submitRecharge"
    >
      <div class="grid grid-cols-2 gap-3 p-2">
        <FaLabel label="充值本金(元)">
          <FaInputNumber v-model="rechargeForm.amount" :min="0" :precision="2" placeholder="0.00" />
        </FaLabel>
        <FaLabel label="赠送金额(元)">
          <FaInputNumber v-model="rechargeForm.bonusAmount" :min="0" :precision="2" placeholder="0.00" />
        </FaLabel>
        <FaLabel label="充值来源">
          <FaSelect v-model="rechargeForm.source" :options="RECHARGE_SOURCES" />
        </FaLabel>
        <FaLabel label="外部收款方式">
          <FaInput v-model="rechargeForm.externalMethod" placeholder="如 微信/支付宝(可选)" />
        </FaLabel>
        <FaLabel label="外部交易号">
          <FaInput v-model="rechargeForm.externalTxnNo" placeholder="外部交易号(可选)" />
        </FaLabel>
        <FaLabel label="备注">
          <FaInput v-model="rechargeForm.reason" placeholder="备注(可选)" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 人工调整 -->
    <FaModal
      v-model="adjustVisible"
      :title="`人工调整 · ${adjustTarget?.customer?.name ?? '客户'}`"
      :show-cancel="true"
      confirm-text="确认调整"
      :loading="adjustSaving"
      @confirm="submitAdjust"
    >
      <div class="grid grid-cols-1 gap-3 p-2">
        <FaLabel label="调整金额(元,正数=增加,负数=减少)">
          <FaInputNumber v-model="adjustForm.delta" :precision="2" placeholder="如 100 或 -50" />
        </FaLabel>
        <FaLabel label="调整原因(必填)">
          <FaInput v-model="adjustForm.reason" placeholder="请填写调整原因" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 冻结/解冻/销户 -->
    <FaModal
      v-model="statusVisible"
      :title="`${statusForm.status === 'frozen' ? '冻结' : statusForm.status === 'active' ? '解冻' : '销户'} · ${statusTarget?.customer?.name ?? '客户'}`"
      :show-cancel="true"
      confirm-text="确认"
      :loading="statusSaving"
      @confirm="submitStatus"
    >
      <div class="grid grid-cols-1 gap-3 p-2">
        <p class="text-sm text-muted-foreground">
          当前余额 {{ formatMoney(statusTarget?.balance) }};{{ statusForm.status === 'closed' ? '销户须余额为 0。' : '' }}该操作会立即生效。
        </p>
        <FaLabel label="操作原因(冻结/销户必填)">
          <FaInput v-model="statusForm.reason" placeholder="请填写操作原因" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 流水(不可变,只读) -->
    <FaModal
      v-model="ledgerVisible"
      :title="`储值流水 · ${ledgerTarget?.customer?.name ?? '客户'}`"
      :show-footer="false"
      modal-class="max-w-4xl"
    >
      <FaTable
        v-loading="ledgerLoading"
        table-root-class="rounded-lg overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="ledgerColumns"
        :data="ledgerEntries"
        empty-text="暂无流水"
      />
      <FaPagination
        :page="ledgerPage"
        :size="ledgerPageSize"
        :total="ledgerTotal"
        class="mt-2 px-4 pb-3"
        @page-change="p => { ledgerPage = p; loadLedger() }"
        @size-change="s => { ledgerPageSize = s; ledgerPage = 1; loadLedger() }"
      />
    </FaModal>
  </div>
</template>
