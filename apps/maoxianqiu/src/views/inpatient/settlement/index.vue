<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { PaymentMethod, SettlementStatus } from '@/types/inpatient'
import apiInpatient from '@/api/modules/inpatient'
import apiStore from '@/api/modules/store'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { PAYMENT_METHOD_LABELS, SETTLEMENT_STATUS_COLORS, SETTLEMENT_STATUS_LABELS } from '@/types/inpatient'

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

/** 收款弹窗 */
const settleVisible = ref(false)
const settleTarget = ref<SettlementRow | null>(null)
const settleForm = reactive({
  paidAmount: 0,
  paymentMethod: 'cash' as PaymentMethod,
})
const settling = ref(false)

/** 减免弹窗 */
const waiveVisible = ref(false)
const waiveTarget = ref<SettlementRow | null>(null)
const waiveForm = reactive({
  amount: 0,
  reason: '',
})
const waiving = ref(false)

/**
 * 加载门店选项
 */
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

/**
 * 获取住院结算列表(浏览器直连 admissions,RLS 兜底)
 */
async function getDataList() {
  loading.value = true
  try {
    const res: any = await apiInpatient.listAdmissions(search.value.storeId || undefined)
    let list = res.data.list ?? []
    if (search.value.settlementStatus) {
      list = list.filter((a: any) => a.settlement_status === search.value.settlementStatus)
    }
    // 前端分页(admissions 直连接口无分页参数)
    const page = pagination.value.page
    const size = pagination.value.size
    pagination.value.total = list.length
    dataList.value = list.slice((page - 1) * size, page * size)
  }
  catch {
    dataList.value = []
  }
  finally {
    loading.value = false
  }
}

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

/**
 * 生成结算单(S3.1-C,走 prepare_settlement RPC,幂等)
 */
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

/**
 * 打开收款弹窗
 */
function openSettle(row: SettlementRow) {
  settleTarget.value = row
  settleForm.paidAmount = Math.max(row.receivable_amount - row.deposit_amount - row.waived_amount, 0)
  settleForm.paymentMethod = 'cash'
  settleVisible.value = true
}

/**
 * 收款结算(S3.1-C,prepared→settled,实收不可超过应付)
 */
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

/**
 * 打开减免弹窗
 */
function openWaive(row: SettlementRow) {
  waiveTarget.value = row
  waiveForm.amount = Math.max(row.receivable_amount - row.deposit_amount - row.waived_amount, 0)
  waiveForm.reason = ''
  waiveVisible.value = true
}

/**
 * 减免/挂账(S3.1-C,prepared/settled→waived)
 */
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

/**
 * 完成结算并出院(S3.1-C,settled/waived→finalized,联动出院释放笼位)
 */
async function onFinalize(row: SettlementRow) {
  useFaModal().confirm({
    title: '完成结算并出院',
    content: `确认完成结算并办理出院?将释放笼位并归档费用记录`,
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

const tableColumns = computed<TableColumn<SettlementRow>[]>(() => [
  {
    accessorKey: 'pet_id',
    header: '宠物 ID',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-',
  },
  { accessorKey: 'settlement_no', header: '结算单号', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'settlement_status',
    header: '结算状态',
    cell: (info: any) => {
      const v = info.getValue()
      const label = SETTLEMENT_STATUS_LABELS[v as keyof typeof SETTLEMENT_STATUS_LABELS] ?? v
      return h('span', { class: `px-2 py-0.5 rounded text-xs bg-${SETTLEMENT_STATUS_COLORS[v as SettlementStatus] ?? 'default'}-100` }, label)
    },
  },
  {
    accessorKey: 'receivable_amount',
    header: '应收',
    cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  {
    accessorKey: 'deposit_amount',
    header: '押金',
    cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  {
    accessorKey: 'paid_amount',
    header: '实收',
    cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  {
    accessorKey: 'waived_amount',
    header: '减免',
    cell: (info: any) => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  {
    accessorKey: 'payment_method',
    header: '支付方式',
    cell: (info: any) => info.getValue() ? PAYMENT_METHOD_LABELS[info.getValue() as PaymentMethod] ?? info.getValue() : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 240,
    align: 'center',
    fixed: 'right',
  },
])
</script>

<template>
  <div>
    <FaPageHeader title="出院结算" class="mb-0">
      <template #description>
        S3.1 结算闭环:生成结算单→收款/减免→完成结算并出院(unsettled→prepared→settled/waived→finalized)
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="门店" class="col-span-1">
              <FaSelect v-model="search.storeId" :options="storeOptions" class="w-full" @change="currentChange()" />
            </FaLabel>
            <FaLabel label="结算状态" class="col-span-1">
              <FaSelect
                v-model="search.settlementStatus"
                :options="[
                  { label: '全部', value: '' },
                  { label: '未结算', value: 'unsettled' },
                  { label: '已生成结算单', value: 'prepared' },
                  { label: '已收款', value: 'settled' },
                  { label: '已减免', value: 'waived' },
                  { label: '已完成出院', value: 'finalized' },
                ]"
                class="w-full"
                @change="currentChange()"
              />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton variant="outline" @click="searchReset()">
                重置
              </FaButton>
              <FaButton type="primary" @click="currentChange()">
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
        <template #cell-operation="{ row }">
          <div class="flex-center gap-1">
            <FaButton v-if="row.original.settlement_status === 'unsettled'" variant="outline" size="sm" @click="onPrepare(row.original)">
              生成结算单
            </FaButton>
            <template v-if="row.original.settlement_status === 'prepared'">
              <FaButton variant="outline" size="sm" @click="openSettle(row.original)">
                收款
              </FaButton>
              <FaButton variant="outline" size="sm" @click="openWaive(row.original)">
                减免
              </FaButton>
            </template>
            <FaButton v-if="row.original.settlement_status === 'settled' || row.original.settlement_status === 'waived'" variant="outline" size="sm" @click="onFinalize(row.original)">
              完成出院
            </FaButton>
          </div>
        </template>
      </FaTable>
      <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />

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
    </FaPageMain>
  </div>
</template>
