<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { PetRecord } from '@/types/customer'
import type { PaymentMethod, SettlementStatus } from '@/types/inpatient'
import apiInpatient from '@/api/modules/inpatient'
import apiStore from '@/api/modules/store'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { PAYMENT_METHOD_LABELS, SETTLEMENT_STATUS_LABELS } from '@/types/inpatient'

defineOptions({
  name: 'InpatientSettlement',
})

interface SettlementRow {
  id: string
  pet_id: string
  customer_id: string | null
  settlement_no: string | null
  settlement_status: SettlementStatus
  deposit_amount: number
  receivable_amount: number
  paid_amount: number
  waived_amount: number
  payment_method: PaymentMethod | null
  prepared_at: string | null
  settled_at: string | null
  waived_at: string | null
  finalized_at: string | null
  total_charge: number
  store_id: string | null
}

const tenantStore = useAppTenantStore()
const { pagination, onSizeChange, onCurrentChange } = usePagination()

const loading = ref(false)
const dataList = ref<SettlementRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  storeId: '',
  settlementStatus: '',
})
const petMap = ref<Record<string, PetRecord>>({})

const settleVisible = ref(false)
const settleTarget = ref<SettlementRow | null>(null)
const settleForm = reactive({
  paidAmount: 0,
  paymentMethod: 'cash' as PaymentMethod,
})
const settling = ref(false)

const waiveVisible = ref(false)
const waiveTarget = ref<SettlementRow | null>(null)
const waiveForm = reactive({
  amount: 0,
  reason: '',
})
const waiving = ref(false)

const pendingSettleCount = computed(() => dataList.value.filter(r => r.settlement_status === 'unsettled').length)
const preparedCount = computed(() => dataList.value.filter(r => r.settlement_status === 'prepared').length)
const finalizedCount = computed(() => dataList.value.filter(r => r.settlement_status === 'finalized').length)

async function loadStoreOptions() {
  try {
    const res: any = await apiStore.list()
    const stores = res.data.list ?? []
    storeOptions.value = [
      { label: '全部门店', value: '' },
      ...stores.map((s: any) => ({ label: s.name, value: s.id })),
    ]
  }
  catch {
    storeOptions.value = [{ label: '全部门店', value: '' }]
  }
}

async function enrichPets(rows: SettlementRow[]) {
  const ids = [...new Set(rows.map(r => r.pet_id).filter(Boolean))]
  if (!ids.length) {
    return
  }
  const { data } = await supabase.from('pets').select('*').in('id', ids)
  data?.forEach((p) => { petMap.value[p.id] = p as PetRecord })
}

async function getDataList() {
  loading.value = true
  try {
    const res: any = await apiInpatient.listAdmissions(search.value.storeId || undefined)
    let list = res.data.list ?? []
    if (search.value.settlementStatus) {
      list = list.filter((a: any) => a.settlement_status === search.value.settlementStatus)
    }
    const page = pagination.value.page
    const size = pagination.value.size
    pagination.value.total = list.length
    dataList.value = list.slice((page - 1) * size, page * size)
    await enrichPets(dataList.value)
  }
  catch {
    dataList.value = []
  }
  finally {
    loading.value = false
  }
}

// P1(审计 25):未保存内容保护 - 收款/减免金额相对打开时默认值有改动或填写了减免原因时视为 dirty
const settleGuard = usePageUnsavedGuard('inpatient-settlement')
const settleBaseline = ref<{ paid: number, amount: number }>({ paid: 0, amount: 0 })
function refreshSettleDirty() {
  settleGuard.setDirty(
    settleForm.paidAmount !== settleBaseline.value.paid
    || waiveForm.amount !== settleBaseline.value.amount
    || !!waiveForm.reason,
  )
}
watch(settleVisible, (v) => {
  if (v) { settleBaseline.value = { ...settleBaseline.value, paid: settleForm.paidAmount } }
  else { settleGuard.setDirty(false) }
})
watch(waiveVisible, (v) => {
  if (v) { settleBaseline.value = { ...settleBaseline.value, amount: waiveForm.amount } }
  else { settleGuard.setDirty(false) }
})
watch([() => settleForm.paidAmount, () => waiveForm.amount, () => waiveForm.reason], refreshSettleDirty)

// P0-06:切店后重置分页与门店筛选并重载
useStoreScopedPage({
  load: getDataList,
  reset: () => {
    search.value.storeId = tenantStore.currentStoreId
    onCurrentChange(1)
  },
})

onMounted(async () => {
  await loadStoreOptions()
  if (tenantStore.currentStoreId) {
    search.value.storeId = tenantStore.currentStoreId
  }
  getDataList()
})

function sizeChange(size: number) {
  onSizeChange(size).then(() => getDataList())
}

function currentChange(page = 1) {
  onCurrentChange(page).then(() => getDataList())
}

function searchReset() {
  search.value.settlementStatus = ''
  currentChange()
}

async function onPrepare(row: SettlementRow) {
  try {
    const res: any = await apiInpatient.prepareSettlement(row.id)
    useFaToast().success(`结算单已生成(${res.data?.settlementNo ?? ''})`)
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '生成失败')
  }
}

function openSettle(row: SettlementRow) {
  settleTarget.value = row
  settleForm.paidAmount = Math.max(row.receivable_amount - row.deposit_amount - row.waived_amount, 0)
  settleForm.paymentMethod = 'cash'
  settleVisible.value = true
}

async function onSettle() {
  if (!settleTarget.value) {
    return
  }
  if (!settleForm.paidAmount || settleForm.paidAmount <= 0) {
    useFaToast().warning('请填写实收金额')
    return
  }
  settling.value = true
  try {
    await apiInpatient.settleAdmission(settleTarget.value.id, settleForm.paidAmount, settleForm.paymentMethod)
    useFaToast().success('收款成功')
    settleVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '收款失败')
  }
  finally {
    settling.value = false
  }
}

function openWaive(row: SettlementRow) {
  waiveTarget.value = row
  waiveForm.amount = Math.max(row.receivable_amount - row.deposit_amount - row.waived_amount, 0)
  waiveForm.reason = ''
  waiveVisible.value = true
}

async function onWaive() {
  if (!waiveTarget.value) {
    return
  }
  if (!waiveForm.amount || waiveForm.amount <= 0) {
    useFaToast().warning('请填写减免金额')
    return
  }
  if (!waiveForm.reason.trim()) {
    useFaToast().warning('请填写减免原因')
    return
  }
  waiving.value = true
  try {
    await apiInpatient.waiveAdmissionCharge(waiveTarget.value.id, waiveForm.amount, waiveForm.reason.trim())
    useFaToast().success('已减免')
    waiveVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '减免失败')
  }
  finally {
    waiving.value = false
  }
}

async function onFinalize(row: SettlementRow) {
  useFaModal().confirm({
    title: '完成结算并出院',
    content: '确认完成结算并办理出院?将释放笼位并归档费用记录',
    onConfirm: async () => {
      try {
        await apiInpatient.finalizeSettlement(row.id)
        useFaToast().success('结算完成,已办理出院')
        getDataList()
      }
      catch (e: any) {
        useFaToast().error(e?.message || '操作失败')
      }
    },
  })
}

function moreFor(row: SettlementRow) {
  const items: any[] = []
  if (row.settlement_status === 'unsettled') {
    items.push({ label: '生成结算单', onClick: () => onPrepare(row) })
  }
  if (row.settlement_status === 'prepared') {
    items.push({ label: '收款', onClick: () => openSettle(row) })
    items.push({ label: '减免', onClick: () => openWaive(row) })
  }
  return items
}

function statusVariant(s: SettlementStatus): 'success' | 'info' | 'warning' | 'danger' {
  if (s === 'finalized') { return 'success' }
  if (s === 'settled') { return 'info' }
  if (s === 'waived') { return 'warning' }
  if (s === 'prepared') { return 'warning' }
  return 'danger'
}

const tableColumns = computed<TableColumn<SettlementRow>[]>(() => [
  {
    id: 'pet',
    header: '宠物',
    cell: (info: any) => petMap.value[info.row.original.pet_id]?.name ?? (info.row.original.pet_id?.slice(0, 8) ?? '-'),
  },
  { accessorKey: 'settlement_no', header: '结算单号', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'settlement_status',
    header: '结算状态',
    cell: (info: any) => {
      const v = info.getValue() as SettlementStatus
      return h(EntityStatusTag, { label: SETTLEMENT_STATUS_LABELS[v] ?? v, variant: statusVariant(v), dot: true })
    },
  },
  { accessorKey: 'receivable_amount', header: '应收', cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}` },
  { accessorKey: 'deposit_amount', header: '押金', cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}` },
  { accessorKey: 'paid_amount', header: '实收', cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}` },
  { accessorKey: 'waived_amount', header: '减免', cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}` },
  {
    accessorKey: 'payment_method',
    header: '支付方式',
    cell: (info: any) => info.getValue() ? PAYMENT_METHOD_LABELS[info.getValue() as PaymentMethod] ?? info.getValue() : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 180,
    align: 'right',
    fixed: 'right',
  },
])
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <EntityPageHeader compact title="出院结算" description="生成结算单 → 收款/减免 → 完成出院">
      <template #actions>
        <FaSelect v-model="search.storeId" :options="storeOptions" class="w-36" @change="currentChange()" />
        <FaSelect
          v-model="search.settlementStatus"
          :options="[
            { label: '全部状态', value: '' },
            { label: '未结算', value: 'unsettled' },
            { label: '已生成结算单', value: 'prepared' },
            { label: '已收款', value: 'settled' },
            { label: '已减免', value: 'waived' },
            { label: '已完成出院', value: 'finalized' },
          ]"
          class="w-40"
          @change="currentChange()"
        />
        <FaButton size="sm" variant="outline" @click="searchReset">
          重置
        </FaButton>
      </template>
    </EntityPageHeader>

    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <!-- 状态摘要 -->
      <div class="shrink-0 gap-4 grid grid-cols-3">
        <div class="p-3 border border-amber-200 rounded-lg bg-amber-50">
          <div class="text-2xl text-amber-600 font-semibold tabular-nums">
            {{ pendingSettleCount }}
          </div>
          <div class="text-xs text-amber-600/70 font-medium">
            未结算
          </div>
        </div>
        <div class="p-3 border border-blue-200 rounded-lg bg-blue-50">
          <div class="text-2xl text-blue-600 font-semibold tabular-nums">
            {{ preparedCount }}
          </div>
          <div class="text-xs text-blue-600/70 font-medium">
            待收款/减免
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ finalizedCount }}
          </div>
          <div class="text-xs text-muted-foreground">
            已完成出院
          </div>
        </div>
      </div>

      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="tableColumns"
            :data="dataList"
          >
            <template #cell-operation="{ row }">
              <TablePrimaryAction
                v-if="row.original.settlement_status === 'prepared'"
                primary-label="收款"
                primary-icon="i-lucide:banknote"
                :more="moreFor(row.original)"
                @primary="openSettle(row.original)"
              />
              <FaButton v-else-if="row.original.settlement_status === 'settled' || row.original.settlement_status === 'waived'" size="sm" @click="onFinalize(row.original)">
                完成出院
              </FaButton>
              <FaButton v-else size="sm" variant="outline" @click="onPrepare(row.original)">
                生成结算单
              </FaButton>
            </template>
          </FaTable>
        </div>
        <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2 px-4 pb-3 shrink-0" @page-change="currentChange" @size-change="sizeChange" />
      </div>
    </div>

    <!-- 收款弹窗 -->
    <FaModal v-model:visible="settleVisible" title="收款结算" :loading="settling" @confirm="onSettle">
      <div class="space-y-3">
        <FaAlert type="info" :closable="false">
          应付 = 应收 ¥{{ settleTarget?.receivable_amount ?? 0 }} - 押金 ¥{{ settleTarget?.deposit_amount ?? 0 }} - 已减免 ¥{{ settleTarget?.waived_amount ?? 0 }}
        </FaAlert>
        <FaLabel label="实收金额" required>
          <FaInputNumber v-model="settleForm.paidAmount" :min="0" class="w-full" />
        </FaLabel>
        <FaLabel label="支付方式">
          <FaSelect
            v-model="settleForm.paymentMethod"
            :options="[
              { label: '现金', value: 'cash' },
              { label: '刷卡', value: 'card' },
              { label: '微信', value: 'wechat' },
              { label: '支付宝', value: 'alipay' },
              { label: '储值', value: 'stored_value' },
              { label: '其他', value: 'other' },
            ]"
            class="w-full"
          />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 减免弹窗 -->
    <FaModal v-model:visible="waiveVisible" title="减免/挂账" :loading="waiving" @confirm="onWaive">
      <div class="space-y-3">
        <FaAlert type="warning" :closable="false">
          减免金额不可超过应付金额,且须填写减免原因
        </FaAlert>
        <FaLabel label="减免金额" required>
          <FaInputNumber v-model="waiveForm.amount" :min="0" class="w-full" />
        </FaLabel>
        <FaLabel label="减免原因" required>
          <FaInput v-model="waiveForm.reason" placeholder="如:医疗纠纷减免 / 优惠券抵扣" class="w-full" />
        </FaLabel>
      </div>
    </FaModal>
  </div>
</template>
