<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { CustomerRecord, PetRecord } from '@/types/customer'
import type { CriticalValueAlert, LabOrderAnalyte, LabSpecimen, LabWorkbenchRecord, LabWorkflowStage } from '@/types/diagnostics'
import { FaInput, FaSelect } from '@fantastic-admin/components'
import apiDiagnostics from '@/api/modules/diagnostics'
import BusinessCustomerPicker from '@/components/business/CustomerPicker/index.vue'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import BusinessPetPicker from '@/components/business/PetPicker/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { LAB_WORKFLOW_STAGE_LABELS } from '@/types/diagnostics'

defineOptions({
  name: 'DiagnosticsLab',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const submitting = ref(false)
const dataList = ref<LabWorkbenchRecord[]>([])
const statsList = ref<LabWorkbenchRecord[]>([])
const criticalAlerts = ref<CriticalValueAlert[]>([])

/** 当前选中行(展开详情/录入结果) */
const selectedOrder = ref<LabWorkbenchRecord | null>(null)
const analytes = ref<LabOrderAnalyte[]>([])
const specimens = ref<LabSpecimen[]>([])
const detailLoading = ref(false)

const petMap = ref<Record<string, PetRecord>>({})
const customerMap = ref<Record<string, CustomerRecord>>({})

/** 结果录入表单:analyteId -> { result_value, result_numeric, is_abnormal, is_critical, flag, note } */
interface ResultFormValue {
  result_value: string
  result_numeric: string
  is_abnormal: boolean
  is_critical: boolean
  flag: string
  note: string
}
const resultForm = ref<Record<string, ResultFormValue>>({})
/** 加载时的结果快照,用于 P0-28 dirty 判定 */
const resultBaseline = ref<Record<string, ResultFormValue>>({})

/** P0-28:检验录入 Dirty Guard(切单/路由/门店均由它保护) */
const labGuard = useUnsavedChangesGuard().register('diagnostics-lab')
const resultsDirty = computed(() => {
  const keys = Object.keys(resultForm.value)
  if (!keys.length) {
    return false
  }
  return keys.some((aid) => {
    const f = resultForm.value[aid]
    const b = resultBaseline.value[aid]
    if (!b) {
      return true
    }
    return f.result_value !== b.result_value
      || f.result_numeric !== b.result_numeric
      || f.is_abnormal !== b.is_abnormal
      || f.is_critical !== b.is_critical
      || f.flag !== b.flag
      || f.note !== b.note
  })
})
watch(resultsDirty, (d) => labGuard.setDirty(d), { immediate: true })

/** P0-27:工作台按业务状态分页(前端只消费后端 DTO) */
const activeTab = ref<LabWorkflowStage | 'all'>('all')

const STATUS_TABS = [
  { label: '全部', value: 'all' },
  { label: '待采样', value: 'awaiting_sample' },
  { label: '检测中', value: 'testing' },
  { label: '待审核', value: 'awaiting_review' },
  { label: '已发布', value: 'published' },
  { label: '退回', value: 'rejected' },
  { label: '已取消', value: 'cancelled' },
]

async function enrich(rows: LabWorkbenchRecord[]) {
  const petIds = [...new Set(rows.map(r => r.pet_id).filter(Boolean))]
  const customerIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))]
  if (petIds.length) {
    const { data } = await supabase.from('pets').select('*').in('id', petIds)
    data?.forEach((p) => { petMap.value[p.id] = p as PetRecord })
  }
  if (customerIds.length) {
    const { data } = await supabase.from('customers').select('*').in('id', customerIds)
    data?.forEach((c) => { customerMap.value[c.id] = c as CustomerRecord })
  }
}

/** 加载检验工作台列表 */
async function loadLabOrders() {
  loading.value = true
  try {
    const res = await apiDiagnostics.getLabWorkbench({
      storeId: tenantStore.currentStoreId || undefined,
      stage: (activeTab.value === 'all' ? undefined : activeTab.value) as LabWorkflowStage | undefined,
    })
    dataList.value = res.data.list
    await enrich(dataList.value)
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '加载检验工作台失败')
  }
  finally {
    loading.value = false
  }
}

/** 加载全量用于 tab 计数 */
async function loadStats() {
  try {
    const res = await apiDiagnostics.getLabWorkbench({
      storeId: tenantStore.currentStoreId || undefined,
    })
    statsList.value = res.data.list
    await enrich(statsList.value)
  }
  catch {
    statsList.value = []
  }
}

function tabCount(status: string) {
  if (status === 'all') {
    return statsList.value.length
  }
  return statsList.value.filter(r => r.workflowStage === status).length
}

/** 加载危急值告警列表 */
async function loadCriticalAlerts() {
  try {
    const res = await apiDiagnostics.listCriticalAlerts({
      storeId: tenantStore.currentStoreId || undefined,
      status: 'pending',
    })
    criticalAlerts.value = res.data.list
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

async function onCreate() {
  if (!labForm.customerId || !labForm.petId) {
    useFaToast().warning('请选择客户与宠物')
    return
  }
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择工作租户')
    return
  }
  submitting.value = true
  try {
    await apiDiagnostics.createLabOrder({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId || undefined,
      customerId: labForm.customerId.trim(),
      petId: labForm.petId.trim(),
      remark: labForm.remark.trim() || undefined,
    })
    useFaToast().success('已创建检验申请')
    createVisible.value = false
    labForm.customerId = ''
    labForm.petId = ''
    labForm.remark = ''
    await Promise.all([loadLabOrders(), loadStats()])
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

function onCancel(row: LabWorkbenchRecord) {
  if (row.workflowStage !== 'awaiting_sample') {
    useFaToast().warning('仅「待采样」状态可取消')
    return
  }
  useFaModal().confirm({
    title: '取消检验申请',
    content: `确认取消申请单 ${row.order_no} 吗?`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.cancelLabOrder(row.id)
        useFaToast().success('已取消')
        await Promise.all([loadLabOrders(), loadStats()])
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

function onCollect(row: LabWorkbenchRecord) {
  if (row.workflowStage !== 'awaiting_sample') {
    useFaToast().warning('仅「待采样」状态可采集')
    return
  }
  useFaModal().confirm({
    title: '标记已采集',
    content: `确认将申请单 ${row.order_no} 标记为已采集吗?`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.markLabOrderCollected(row.id)
        useFaToast().success('已标记采集')
        await Promise.all([loadLabOrders(), loadStats()])
        if (selectedOrder.value?.id === row.id) {
          await onShowDetail(row)
        }
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

/** P0-28:切换检验单前确认未保存结果 */
function confirmSwitchOrder(): Promise<boolean> {
  return new Promise((resolve) => {
    useFaModal().confirm({
      title: '未保存的检验结果',
      content: '当前检验单有尚未保存的录入结果,切换后将丢失。',
      confirmButtonText: '放弃并切换',
      cancelButtonText: '取消',
      onConfirm: () => { labGuard.setDirty(false); resolve(true) },
      onCancel: () => resolve(false),
    })
  })
}

/** 选中检验单:加载结果项 + 标本到右侧工作区 */
async function onShowDetail(row: LabWorkbenchRecord) {
  if (resultsDirty.value) {
    const ok = await confirmSwitchOrder()
    if (!ok) {
      return
    }
  }
  selectedOrder.value = row
  detailLoading.value = true
  try {
    const [analyteRes, specimenRes] = await Promise.all([
      apiDiagnostics.listLabOrderAnalytes(row.id),
      apiDiagnostics.listSpecimens(row.id),
    ])
    analytes.value = analyteRes.data.list
    specimens.value = specimenRes.data.list
    resultForm.value = {}
    resultBaseline.value = {}
    for (const a of analytes.value) {
      const v: ResultFormValue = {
        result_value: a.result_value ?? '',
        result_numeric: a.result_numeric != null ? String(a.result_numeric) : '',
        is_abnormal: a.is_abnormal,
        is_critical: a.is_critical,
        flag: a.flag ?? '',
        note: a.note ?? '',
      }
      resultForm.value[a.id] = v
      resultBaseline.value[a.id] = { ...v }
    }
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    detailLoading.value = false
  }
}

async function onPublishResults() {
  if (!selectedOrder.value) {
    return
  }
  const results = analytes.value.map((a) => {
    const f = resultForm.value[a.id]
    return {
      id: a.id,
      result_value: f?.result_value || undefined,
      result_numeric: f?.result_numeric ? Number(f.result_numeric) : undefined,
      is_abnormal: f?.is_abnormal,
      is_critical: f?.is_critical,
      flag: (f?.flag || undefined) as 'low' | 'high' | 'critical' | undefined,
      note: f?.note || undefined,
    }
  })
  try {
    await apiDiagnostics.publishLabResults({
      labOrderId: selectedOrder.value.id,
      results,
    })
    useFaToast().success('结果已发布(自动触发危急值告警)')
    labGuard.setDirty(false)
    await Promise.all([loadLabOrders(), loadStats(), loadCriticalAlerts(), onShowDetail(selectedOrder.value)])
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

function onReview(decision: 'approved' | 'rejected') {
  if (!selectedOrder.value) {
    return
  }
  const label = decision === 'approved' ? '通过' : '驳回'
  useFaModal().confirm({
    title: `审核${label}`,
    content: `确认${label}申请单 ${selectedOrder.value.order_no} 的检验结果吗?(走 review_lab_results RPC,双签校验)`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.reviewLabResults({
          labOrderId: selectedOrder.value!.id,
          decision,
        })
        useFaToast().success(`已${label}`)
        await Promise.all([loadLabOrders(), loadStats(), onShowDetail(selectedOrder.value!)])
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

async function onAcknowledgeAlert(alert: CriticalValueAlert) {
  try {
    await apiDiagnostics.acknowledgeCriticalAlert(alert.id)
    useFaToast().success('危急值已确认')
    await loadCriticalAlerts()
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

function onTabChange(val: string) {
  activeTab.value = val as LabWorkflowStage | 'all'
  loadLabOrders()
}

function displayRow(row: LabWorkbenchRecord) {
  const pet = petMap.value[row.pet_id]
  const customer = customerMap.value[row.customer_id]
  return {
    petName: pet?.name ?? '未知宠物',
    customerName: customer?.name ?? '未知主人',
    petSpecies: pet?.species ?? '',
    risks: pet?.risk_tags ?? [],
  }
}

const resultColumns: TableColumn<LabOrderAnalyte>[] = [
  {
    accessorKey: 'analyte_id',
    header: '检验项目',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-',
  },
  {
    id: 'result_value',
    header: '结果',
    cell: (info: any) => {
      const a = info.row.original
      return h(FaInput, {
        'modelValue': resultForm.value[a.id]?.result_value ?? '',
        'onUpdate:modelValue': (v: any) => { resultForm.value[a.id] = { ...resultForm.value[a.id], result_value: v ?? '' } },
        'placeholder': '结果值',
        'disabled': !selectedOrder.value?.canEditResult,
        'class': 'w-full',
      })
    },
  },
  {
    id: 'result_numeric',
    header: '数值',
    cell: (info: any) => {
      const a = info.row.original
      return h(FaInput, {
        'modelValue': resultForm.value[a.id]?.result_numeric ?? '',
        'onUpdate:modelValue': (v: any) => { resultForm.value[a.id] = { ...resultForm.value[a.id], result_numeric: v ?? '' } },
        'type': 'number',
        'placeholder': '如 12.5',
        'disabled': !selectedOrder.value?.canEditResult,
        'class': 'w-full',
      })
    },
  },
  {
    id: 'flag',
    header: '标志',
    cell: (info: any) => {
      const a = info.row.original
      return h(FaSelect, {
        'modelValue': resultForm.value[a.id]?.flag ?? '',
        'onUpdate:modelValue': (v: any) => { resultForm.value[a.id] = { ...resultForm.value[a.id], flag: v ?? '' } },
        'options': [
          { label: '正常', value: '' },
          { label: '偏低', value: 'low' },
          { label: '偏高', value: 'high' },
          { label: '危急', value: 'critical' },
        ],
        'disabled': !selectedOrder.value?.canEditResult,
        'class': 'w-full',
      })
    },
  },
  {
    id: 'flags_check',
    header: '标记',
    cell: (info: any) => {
      const a = info.row.original
      const f = resultForm.value[a.id]
      return h('div', { class: 'flex items-center gap-3' }, [
        h('label', { class: 'flex items-center gap-1 text-xs' }, [
          h('input', { type: 'checkbox', checked: f?.is_abnormal, disabled: !selectedOrder.value?.canEditResult, onChange: (e: any) => { resultForm.value[a.id] = { ...resultForm.value[a.id], is_abnormal: e.target.checked } } }),
          '异常',
        ]),
        h('label', { class: 'flex items-center gap-1 text-xs' }, [
          h('input', { type: 'checkbox', checked: f?.is_critical, disabled: !selectedOrder.value?.canEditResult, onChange: (e: any) => { resultForm.value[a.id] = { ...resultForm.value[a.id], is_critical: e.target.checked } } }),
          '危急',
        ]),
      ])
    },
  },
  {
    id: 'note',
    header: '备注',
    cell: (info: any) => {
      const a = info.row.original
      return h(FaInput, {
        'modelValue': resultForm.value[a.id]?.note ?? '',
        'onUpdate:modelValue': (v: any) => { resultForm.value[a.id] = { ...resultForm.value[a.id], note: v ?? '' } },
        'placeholder': '备注',
        'disabled': !selectedOrder.value?.canEditResult,
        'class': 'w-full',
      })
    },
  },
]

/** 工作台主动作按钮(P0-27:一状态一主动作) */
function stageVariant(stage: string) {
  if (stage === 'published') { return 'success' }
  if (stage === 'cancelled') { return 'neutral' }
  if (stage === 'rejected') { return 'danger' }
  if (stage === 'testing') { return 'warning' }
  return 'info'
}

// P0-28:路由离开保护
onBeforeRouteLeave(async () => {
  if (!resultsDirty.value) { return true }
  return new Promise((resolve) => {
    useFaModal().confirm({
      title: '未保存的检验结果',
      content: '当前检验单有尚未保存的录入结果,确定要离开吗?',
      confirmButtonText: '放弃并离开',
      cancelButtonText: '取消',
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
})

// P0-28:刷新/关闭页面保护
function handleBeforeUnload(e: BeforeUnloadEvent) {
  if (resultsDirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

// P0-06/P0-28:切店后清空选中态并按新门店重载(切店前 ToolbarStart 已做 dirty 确认)
useStoreScopedPage({
  load: async () => {
    await Promise.all([loadLabOrders(), loadStats()])
  },
  reset: () => {
    selectedOrder.value = null
    analytes.value = []
    specimens.value = []
    resultForm.value = {}
    resultBaseline.value = {}
    labGuard.setDirty(false)
  },
})

onMounted(async () => {
  window.addEventListener('beforeunload', handleBeforeUnload)
  await Promise.all([loadLabOrders(), loadStats(), loadCriticalAlerts()])
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  labGuard.setDirty(false)
})

/** 新建申请弹窗 */
const createVisible = ref(false)
const labForm = reactive({
  customerId: '',
  petId: '',
  remark: '',
})
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="检验工作台" description="按流程状态工作 · 待采样→检测中→待审核→已发布 · 危急值自动告警">
      <template #actions>
        <FaButton size="sm" @click="createVisible = true">
          <FaIcon name="i-lucide:plus" />
          新建申请
        </FaButton>
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <!-- 危急值告警横幅 -->
      <div v-if="criticalAlerts.length > 0" class="px-3 py-2 border border-red-200 rounded-lg bg-red-50">
        <div class="flex gap-2 items-center">
          <FaIcon name="i-lucide:siren" class="text-red-600" />
          <span class="text-sm text-red-700 font-semibold">危急值告警({{ criticalAlerts.length }} 条待确认)</span>
        </div>
        <div class="mt-1 space-y-1">
          <div v-for="alert in criticalAlerts" :key="alert.id" class="text-sm flex gap-2 items-center justify-between">
            <span class="text-red-700">
              {{ alert.message ?? '危急值' }} · 宠物 {{ petMap[alert.pet_id]?.name ?? alert.pet_id.slice(0, 8) }}
            </span>
            <FaButton size="sm" variant="outline" @click="onAcknowledgeAlert(alert)">
              确认
            </FaButton>
          </div>
        </div>
      </div>

      <!-- 主从工作区 -->
      <div class="flex flex-1 gap-4 min-h-0">
        <!-- 左:检验单队列 -->
        <div class="border rounded-lg bg-card flex shrink-0 flex-col w-[40%]">
          <div class="px-2 py-2 border-b flex gap-1 items-center overflow-x-auto">
            <FaButton
              v-for="tab in STATUS_TABS"
              :key="tab.value"
              size="sm"
              :variant="activeTab === tab.value ? 'default' : 'ghost'"
              @click="onTabChange(tab.value)"
            >
              {{ tab.label }} {{ tabCount(tab.value) }}
            </FaButton>
          </div>
          <div v-loading="loading" class="p-2 flex-1 min-h-0 overflow-auto">
            <button
              v-for="row in dataList"
              :key="row.id"
              type="button"
              class="mb-2 p-2.5 text-left border rounded-md w-full transition hover:bg-gray-50"
              :class="{ 'border-primary bg-primary-50': selectedOrder?.id === row.id }"
              @click="onShowDetail(row)"
            >
              <div class="flex gap-2 items-center justify-between">
                <span class="text-sm font-medium">{{ displayRow(row).petName }}</span>
                <span class="text-xs text-muted-foreground">{{ row.order_no }}</span>
              </div>
              <div class="text-xs text-muted-foreground mt-0.5 truncate">
                {{ displayRow(row).customerName }} · {{ new Date(row.requested_at).toLocaleString('zh-CN') }}
              </div>
              <div class="mt-1 flex gap-2 items-center justify-between">
                <div v-if="displayRow(row).risks.length" class="flex flex-wrap gap-1">
                  <span v-for="r in displayRow(row).risks" :key="r" class="text-[10px] text-amber-700 font-medium px-1 rounded bg-amber-100 inline-flex gap-0.5 items-center">
                    <FaIcon name="i-lucide:triangle-alert" class="size-2.5" />
                    {{ r }}
                  </span>
                </div>
                <EntityStatusTag :label="LAB_WORKFLOW_STAGE_LABELS[row.workflowStage]" :variant="stageVariant(row.workflowStage)" :dot="false" class="ml-auto" />
              </div>
            </button>
            <EmptyState v-if="!loading && dataList.length === 0" compact title="当前队列无检验单" />
          </div>
        </div>

        <!-- 右:当前检验单 -->
        <div v-loading="detailLoading" class="border rounded-lg bg-card flex-1 min-w-0 overflow-auto">
          <div v-if="selectedOrder" class="p-4">
            <div class="mb-3 pb-3 border-b flex flex-wrap gap-2 items-center justify-between">
              <div>
                <div class="flex gap-2 items-center">
                  <span class="text-base font-medium">{{ displayRow(selectedOrder).petName }}</span>
                  <EntityStatusTag :label="LAB_WORKFLOW_STAGE_LABELS[selectedOrder.workflowStage]" :variant="stageVariant(selectedOrder.workflowStage)" />
                </div>
                <div class="text-xs text-muted-foreground mt-0.5">
                  {{ displayRow(selectedOrder).customerName }} · {{ selectedOrder.order_no }} · 申请于 {{ new Date(selectedOrder.requested_at).toLocaleString('zh-CN') }}
                </div>
              </div>
              <div class="flex gap-2">
                <FaButton v-if="selectedOrder.workflowStage === 'awaiting_sample'" variant="outline" size="sm" @click="onCollect(selectedOrder)">
                  标记采集
                </FaButton>
                <FaButton v-if="selectedOrder.workflowStage === 'awaiting_sample'" variant="outline" size="sm" @click="onCancel(selectedOrder)">
                  取消
                </FaButton>
                <FaButton v-if="selectedOrder.canPublish" size="sm" @click="onPublishResults">
                  <FaIcon name="i-lucide:upload" />
                  {{ selectedOrder.workflowStage === 'rejected' ? '重新发布' : '发布结果' }}
                </FaButton>
                <FaButton v-if="selectedOrder.canReview" size="sm" variant="outline" @click="onReview('approved')">
                  审核通过
                </FaButton>
                <FaButton v-if="selectedOrder.canReview" size="sm" variant="outline" @click="onReview('rejected')">
                  驳回
                </FaButton>
              </div>
            </div>

            <!-- 结果录入 -->
            <div class="mb-4">
              <div class="text-sm font-medium mb-2">
                检验结果项({{ analytes.length }})
              </div>
              <div v-if="analytes.length" class="overflow-x-auto">
                <FaTable :data="analytes" :columns="resultColumns" stripe border />
              </div>
              <EmptyState v-else compact title="暂无结果项" description="可在采集后录入结果" />
            </div>

            <!-- 标本信息 -->
            <div v-if="specimens.length">
              <div class="text-sm font-medium mb-2">
                标本({{ specimens.length }})
              </div>
              <div class="space-y-1">
                <div v-for="s in specimens" :key="s.id" class="text-xs p-2 border rounded-md flex items-center justify-between">
                  <span>类型:{{ s.specimen_type }} · 容器:{{ s.container_id ?? '-' }}</span>
                  <span class="text-muted-foreground">{{ s.status }}</span>
                </div>
              </div>
            </div>
          </div>
          <EmptyState v-else compact title="请选择左侧检验单" description="选中后在此录入结果、审核发布" />
        </div>
      </div>
    </div>

    <!-- 新建申请弹窗 -->
    <FaDrawer v-model="createVisible" title="新建检验申请" :width="560" :show-confirm-button="false">
      <div class="p-4 space-y-3">
        <FaLabel label="客户" required>
          <BusinessCustomerPicker v-model="labForm.customerId" placeholder="搜索选择客户" />
        </FaLabel>
        <FaLabel label="宠物" required>
          <BusinessPetPicker v-model="labForm.petId" :customer-id="labForm.customerId || undefined" placeholder="搜索选择宠物" />
        </FaLabel>
        <FaLabel label="备注">
          <FaInput v-model="labForm.remark" placeholder="备注信息" class="w-full" />
        </FaLabel>
        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="createVisible = false">
            取消
          </FaButton>
          <FaButton :loading="submitting" @click="onCreate">
            <FaIcon name="i-lucide:plus" />
            创建申请
          </FaButton>
        </div>
      </div>
    </FaDrawer>
  </div>
</template>
