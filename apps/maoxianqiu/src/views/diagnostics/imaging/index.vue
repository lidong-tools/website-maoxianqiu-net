<script setup lang="ts">
import type { CustomerRecord, PetRecord } from '@/types/customer'
import type {
  ImagingAttachmentRecord,
  ImagingOrderRecord,
  ImagingOrderStage,
  ImagingOrderWorkbenchRecord,
  ImagingReportRecord,
  ImagingType,
} from '@/types/diagnostics'
import apiDiagnostics from '@/api/modules/diagnostics'
import apiFile from '@/api/modules/file'
import BusinessCustomerPicker from '@/components/business/CustomerPicker/index.vue'
import BusinessPetPicker from '@/components/business/PetPicker/index.vue'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { IMAGING_REPORT_STATUS_LABELS, IMAGING_STAGE_LABELS, IMAGING_TYPE_LABELS } from '@/types/diagnostics'

defineOptions({
  name: 'DiagnosticsImaging',
})

const route = useRoute()
const tenantStore = useAppTenantStore()

const loading = ref(false)
const dataList = ref<ImagingOrderWorkbenchRecord[]>([])
const statsList = ref<ImagingOrderWorkbenchRecord[]>([])
const detailLoading = ref(false)

/** 当前选中影像申请单 */
const selectedOrder = ref<ImagingOrderRecord | null>(null)
const reports = ref<ImagingReportRecord[]>([])
const attachments = ref<ImagingAttachmentRecord[]>([])

const petMap = ref<Record<string, PetRecord>>({})
const customerMap = ref<Record<string, CustomerRecord>>({})

/** 工作台业务状态标签 */
const activeTab = ref<ImagingOrderStage | 'all'>('all')
const STATUS_TABS = [
  { label: '全部', value: 'all' },
  { label: '待预约', value: 'awaiting_schedule' },
  { label: '待执行', value: 'awaiting_perform' },
  { label: '待报告', value: 'awaiting_report' },
  { label: '待审核', value: 'awaiting_review' },
  { label: '已发布', value: 'published' },
  { label: '已取消', value: 'cancelled' },
]

const reportForm = reactive({ findings: '', impression: '', recommendation: '' })
const uploading = ref(false)

const latestReport = computed(() => reports.value[reports.value.length - 1] ?? null)
const canEditReport = computed(() => !!selectedOrder.value && (latestReport.value ? latestReport.value.status !== 'published' : true))

/** 申请单当前业务阶段 */
const orderStage = computed<ImagingOrderStage>(() => {
  const s = selectedOrder.value?.status ?? 'requested'
  if (s === 'scheduled' || s === 'in_progress') { return 'awaiting_perform' }
  if (s === 'performed') { return 'awaiting_report' }
  if (s === 'reported' || s === 'reviewed') { return 'awaiting_review' }
  if (s === 'published') { return 'published' }
  if (s === 'cancelled') { return 'cancelled' }
  return 'awaiting_schedule'
})

const inProgress = computed(() => selectedOrder.value?.status === 'in_progress')

async function enrich(rows: Array<{ pet_id: string, customer_id: string }>) {
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

async function loadImagingOrders() {
  loading.value = true
  try {
    const res = await apiDiagnostics.listImagingOrders({
      storeId: tenantStore.currentStoreId || undefined,
      stage: activeTab.value === 'all' ? undefined : activeTab.value,
    })
    dataList.value = res.data.list
    await enrich(dataList.value)
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    loading.value = false
  }
}

async function loadStats() {
  try {
    const res = await apiDiagnostics.listImagingOrders({
      storeId: tenantStore.currentStoreId || undefined,
    })
    statsList.value = res.data.list
    await enrich(statsList.value)
  }
  catch {
    statsList.value = []
  }
}

function tabCount(stage: string) {
  if (stage === 'all') {
    return statsList.value.length
  }
  return statsList.value.filter(r => r.workflowStage === stage).length
}

async function onShowDetail(row: ImagingOrderWorkbenchRecord) {
  selectedOrder.value = row
  detailLoading.value = true
  try {
    await loadDetail(row.id)
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    detailLoading.value = false
  }
}

async function loadDetail(orderId: string) {
  const res = await apiDiagnostics.getImagingOrder(orderId)
  selectedOrder.value = res.data.order
  reports.value = res.data.reports
  attachments.value = res.data.attachments
  syncReportForm()
}

function syncReportForm() {
  const latest = reports.value[reports.value.length - 1]
  reportForm.findings = latest?.findings ?? ''
  reportForm.impression = latest?.impression ?? ''
  reportForm.recommendation = latest?.recommendation ?? ''
}

function displayRow(row: { pet_id: string, customer_id: string }) {
  const pet = petMap.value[row.pet_id]
  const customer = customerMap.value[row.customer_id]
  return {
    petName: pet?.name ?? '未知宠物',
    customerName: customer?.name ?? '未知主人',
    risks: pet?.risk_tags ?? [],
  }
}

function stageVariant(stage: string) {
  if (stage === 'published') { return 'success' }
  if (stage === 'cancelled') { return 'neutral' }
  if (stage === 'awaiting_review') { return 'warning' }
  return 'info'
}

function onTabChange(val: string) {
  activeTab.value = val as ImagingOrderStage | 'all'
  loadImagingOrders()
}

// ===== 排程 =====
const scheduleVisible = ref(false)
const scheduleDate = ref('')
function onOpenSchedule() {
  scheduleDate.value = ''
  scheduleVisible.value = true
}
async function onConfirmSchedule() {
  if (!selectedOrder.value || !scheduleDate.value) {
    useFaToast().warning('请选择预约时间')
    return
  }
  try {
    await apiDiagnostics.scheduleImagingOrder(selectedOrder.value.id, new Date(scheduleDate.value).toISOString())
    useFaToast().success('已排程')
    scheduleVisible.value = false
    await refreshAll(selectedOrder.value.id)
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

// ===== 执行 =====
async function onStart() {
  if (!selectedOrder.value) { return }
  useFaModal().confirm({
    title: '开始执行',
    content: '确认开始执行该影像申请?',
    onConfirm: async () => {
      try {
        await apiDiagnostics.startImagingOrder(selectedOrder.value!.id)
        useFaToast().success('已开始执行')
        await refreshAll(selectedOrder.value!.id)
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

async function onPerform() {
  if (!selectedOrder.value) { return }
  useFaModal().confirm({
    title: '完成执行',
    content: '确认完成影像拍摄/采集?完成后可录入报告。',
    onConfirm: async () => {
      try {
        await apiDiagnostics.performImagingOrder(selectedOrder.value!.id)
        useFaToast().success('已标记完成')
        await refreshAll(selectedOrder.value!.id)
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

async function onCancel() {
  if (!selectedOrder.value) { return }
  useFaModal().confirm({
    title: '取消影像申请',
    content: `确认取消申请单 ${selectedOrder.value.order_no} 吗?`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.cancelImagingOrder(selectedOrder.value!.id)
        useFaToast().success('已取消')
        await refreshAll(selectedOrder.value!.id)
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

// ===== 报告 =====
async function onSaveReport() {
  if (!selectedOrder.value) { return }
  try {
    if (latestReport.value) {
      await apiDiagnostics.updateImagingReport(latestReport.value.id, {
        findings: reportForm.findings || undefined,
        impression: reportForm.impression || undefined,
        recommendation: reportForm.recommendation || undefined,
      })
    }
    else {
      await apiDiagnostics.createImagingReport(selectedOrder.value.id, {
        findings: reportForm.findings || undefined,
        impression: reportForm.impression || undefined,
        recommendation: reportForm.recommendation || undefined,
      })
    }
    useFaToast().success('报告已保存')
    await refreshAll(selectedOrder.value.id)
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

async function onCreateRevision() {
  if (!selectedOrder.value) { return }
  try {
    await apiDiagnostics.createImagingReport(selectedOrder.value.id, {
      findings: latestReport.value?.findings ?? undefined,
      impression: latestReport.value?.impression ?? undefined,
      recommendation: latestReport.value?.recommendation ?? undefined,
    })
    useFaToast().success('已创建修订版本')
    await refreshAll(selectedOrder.value.id)
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

async function onSubmitReport() {
  if (!latestReport.value) { return }
  try {
    await apiDiagnostics.submitImagingReport(latestReport.value.id)
    useFaToast().success('已提交审核')
    await refreshAll(selectedOrder.value!.id)
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

async function onReviewReport(decision: 'approved' | 'rejected') {
  if (!latestReport.value) { return }
  const label = decision === 'approved' ? '通过' : '退回'
  useFaModal().confirm({
    title: `审核${label}`,
    content: `确认${label}报告 v${latestReport.value.version}?(双签:审核人不可与报告作者同人)`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.reviewImagingReport(latestReport.value!.id, decision)
        useFaToast().success(`已${label}`)
        await refreshAll(selectedOrder.value!.id)
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

async function onPublishReport() {
  if (!latestReport.value) { return }
  useFaModal().confirm({
    title: '发布报告',
    content: `确认发布报告 v${latestReport.value.version}?发布后不可静默修改。`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.publishImagingReport(latestReport.value!.id)
        useFaToast().success('报告已发布')
        await refreshAll(selectedOrder.value!.id)
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

// ===== 附件上传(复用 files/attachments/R2) =====
async function onUploadAttachment(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !selectedOrder.value) {
    input.value = ''
    return
  }
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择工作租户')
    input.value = ''
    return
  }
  uploading.value = true
  try {
    const intentRes: any = await apiFile.createUploadIntent({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId || undefined,
      category: 'image',
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      entityType: 'imaging_order',
      entityId: selectedOrder.value.id,
      purpose: 'image',
    })
    const { uploadUrl, fileId } = intentRes.data
    await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } })
    await apiFile.completeUpload({ fileId })
    useFaToast().success('影像已上传')
    await loadDetail(selectedOrder.value.id)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '上传失败')
  }
  finally {
    uploading.value = false
    input.value = ''
  }
}

async function onDownload(fileId: string) {
  try {
    const res: any = await apiFile.getDownloadUrl({ fileId })
    window.open(res.data.url, '_blank')
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

async function refreshAll(orderId: string) {
  await Promise.all([loadDetail(orderId), loadImagingOrders(), loadStats()])
}

// ===== 新建申请 =====
const createVisible = ref(false)
const submitting = ref(false)
const imagingForm = reactive<{
  customerId: string
  petId: string
  imagingType: ImagingType
  scheduledAt: string
  clinicalQuestion: string
  notes: string
}>({
  customerId: '',
  petId: '',
  imagingType: 'ultrasound',
  scheduledAt: '',
  clinicalQuestion: '',
  notes: '',
})

const prefilledEncounterId = computed(() => (typeof route.query.encounterId === 'string' ? route.query.encounterId : ''))

function openCreate() {
  // 从医生工作台带参进入时预填
  if (typeof route.query.petId === 'string' && route.query.petId) {
    imagingForm.petId = route.query.petId
  }
  if (typeof route.query.customerId === 'string' && route.query.customerId) {
    imagingForm.customerId = route.query.customerId
  }
  createVisible.value = true
}

async function onCreate() {
  if (!imagingForm.customerId || !imagingForm.petId) {
    useFaToast().warning('请选择客户与宠物')
    return
  }
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择工作租户')
    return
  }
  submitting.value = true
  try {
    await apiDiagnostics.createImagingOrder({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId || undefined,
      encounterId: prefilledEncounterId.value || undefined,
      customerId: imagingForm.customerId.trim(),
      petId: imagingForm.petId.trim(),
      imagingType: imagingForm.imagingType,
      scheduledAt: imagingForm.scheduledAt ? new Date(imagingForm.scheduledAt).toISOString() : undefined,
      clinicalQuestion: imagingForm.clinicalQuestion.trim() || undefined,
      notes: imagingForm.notes.trim() || undefined,
    })
    useFaToast().success('已创建影像申请')
    createVisible.value = false
    imagingForm.customerId = ''
    imagingForm.petId = ''
    imagingForm.scheduledAt = ''
    imagingForm.clinicalQuestion = ''
    imagingForm.notes = ''
    await Promise.all([loadImagingOrders(), loadStats()])
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

// P0-06:切店后清空选中态并按新门店重载
useStoreScopedPage({
  load: async () => {
    await Promise.all([loadImagingOrders(), loadStats()])
  },
  reset: () => {
    selectedOrder.value = null
    reports.value = []
    attachments.value = []
    reportForm.findings = ''
    reportForm.impression = ''
    reportForm.recommendation = ''
  },
})

onMounted(async () => {
  await Promise.all([loadImagingOrders(), loadStats()])
})
</script>

<template>
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="影像工作台" description="申请 → 排程 → 执行 → 报告 → 审核 → 发布">
      <template #actions>
        <FaButton size="sm" @click="openCreate">
          <FaIcon name="i-lucide:plus" />
          新建申请
        </FaButton>
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <div class="flex flex-1 gap-4 min-h-0">
        <!-- 左:影像申请队列 -->
        <div class="border rounded-lg bg-card flex shrink-0 flex-col w-[38%]">
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
                {{ displayRow(row).customerName }} · {{ IMAGING_TYPE_LABELS[row.imaging_type] }}
              </div>
              <div class="mt-1 flex gap-2 items-center justify-between">
                <div v-if="displayRow(row).risks.length" class="flex flex-wrap gap-1">
                  <span v-for="r in displayRow(row).risks" :key="r" class="text-[10px] text-amber-700 font-medium px-1 rounded bg-amber-100 inline-flex gap-0.5 items-center">
                    <FaIcon name="i-lucide:triangle-alert" class="size-2.5" />
                    {{ r }}
                  </span>
                </div>
                <EntityStatusTag :label="IMAGING_STAGE_LABELS[row.workflowStage]" :variant="stageVariant(row.workflowStage)" :dot="false" class="ml-auto" />
                <span v-if="row.revisionPending" class="text-[10px] text-amber-700 font-medium px-1 rounded bg-amber-100 inline-flex gap-0.5 items-center">
                  <FaIcon name="i-lucide:rotate-ccw" class="size-2.5" />
                  修订待处理
                </span>
              </div>
            </button>
            <EmptyState v-if="!loading && dataList.length === 0" compact title="当前队列无影像申请" />
          </div>
        </div>

        <!-- 右:影像申请详情 -->
        <div v-loading="detailLoading" class="border rounded-lg bg-card flex-1 min-w-0 overflow-auto">
          <div v-if="selectedOrder" class="p-4 space-y-4">
            <div class="pb-3 border-b flex flex-wrap gap-2 items-center justify-between">
              <div>
                <div class="flex gap-2 items-center">
                  <span class="text-base font-medium">{{ displayRow(selectedOrder).petName }}</span>
                  <EntityStatusTag :label="IMAGING_STAGE_LABELS[orderStage]" :variant="stageVariant(orderStage)" />
                </div>
                <div class="text-xs text-muted-foreground mt-0.5">
                  {{ displayRow(selectedOrder).customerName }} · {{ selectedOrder.order_no }} · {{ IMAGING_TYPE_LABELS[selectedOrder.imaging_type] }} · 申请于 {{ new Date(selectedOrder.created_at).toLocaleString('zh-CN') }}
                </div>
              </div>
              <div class="flex gap-2">
                <FaButton v-if="orderStage === 'awaiting_schedule'" variant="outline" size="sm" @click="onOpenSchedule">
                  排程
                </FaButton>
                <FaButton v-if="orderStage === 'awaiting_schedule'" variant="outline" size="sm" @click="onCancel">
                  取消
                </FaButton>
                <FaButton v-if="orderStage === 'awaiting_perform' && !inProgress" size="sm" @click="onStart">
                  开始执行
                </FaButton>
                <FaButton v-if="orderStage === 'awaiting_perform' && inProgress" size="sm" @click="onPerform">
                  完成执行
                </FaButton>
                <FaButton v-if="orderStage === 'awaiting_report'" size="sm" @click="onSaveReport">
                  <FaIcon name="i-lucide:file-plus" />
                  保存报告
                </FaButton>
                <FaButton v-if="latestReport && latestReport.status === 'published'" variant="outline" size="sm" @click="onCreateRevision">
                  创建修订
                </FaButton>
              </div>
            </div>

            <!-- 临床信息 -->
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="text-sm">
                <span class="text-muted-foreground">临床问题:</span>
                <span class="ml-2">{{ selectedOrder.clinical_question ?? '未填写' }}</span>
              </div>
              <div class="text-sm">
                <span class="text-muted-foreground">排程时间:</span>
                <span class="ml-2">{{ selectedOrder.scheduled_at ? new Date(selectedOrder.scheduled_at).toLocaleString('zh-CN') : '未排程' }}</span>
              </div>
              <div class="text-sm">
                <span class="text-muted-foreground">执行时间:</span>
                <span class="ml-2">{{ selectedOrder.performed_at ? new Date(selectedOrder.performed_at).toLocaleString('zh-CN') : '未执行' }}</span>
              </div>
              <div class="text-sm">
                <span class="text-muted-foreground">备注:</span>
                <span class="ml-2">{{ selectedOrder.notes ?? '无' }}</span>
              </div>
            </div>

            <!-- 附件 -->
            <div>
              <div class="mb-2 flex gap-2 items-center justify-between">
                <span class="text-sm font-medium">影像附件({{ attachments.length }})</span>
                <label class="cursor-pointer">
                  <span class="text-xs text-primary inline-flex items-center gap-1">
                    <FaIcon name="i-lucide:upload" />
                    上传影像
                  </span>
                  <input type="file" accept="image/*" class="hidden" :disabled="uploading" @change="onUploadAttachment" />
                </label>
              </div>
              <div v-if="attachments.length" class="grid gap-2 sm:grid-cols-2">
                <div v-for="att in attachments" :key="att.id" class="text-xs p-2 border rounded-md flex items-center justify-between">
                  <span class="truncate">{{ att.file.original_name }}</span>
                  <div class="flex gap-2 items-center">
                    <span class="text-muted-foreground">{{ (att.file.size_bytes / 1024).toFixed(1) }}KB</span>
                    <FaButton size="sm" variant="ghost" @click="onDownload(att.file.id)">
                      查看
                    </FaButton>
                  </div>
                </div>
              </div>
              <EmptyState v-else compact title="暂无影像附件" />
            </div>

            <!-- 报告 -->
            <div>
              <div class="mb-2 flex gap-2 items-center justify-between">
                <span class="text-sm font-medium">
                  报告
                  <template v-if="latestReport">
                    v{{ latestReport.version }} ·
                    <span class="text-muted-foreground">{{ IMAGING_REPORT_STATUS_LABELS[latestReport.status] }}</span>
                  </template>
                </span>
                <div v-if="latestReport" class="flex gap-2">
                  <FaButton v-if="latestReport.status === 'draft'" size="sm" variant="outline" @click="onSubmitReport">
                    提交审核
                  </FaButton>
                  <FaButton v-if="latestReport.status === 'submitted'" size="sm" variant="outline" @click="onReviewReport('approved')">
                    审核通过
                  </FaButton>
                  <FaButton v-if="latestReport.status === 'submitted'" size="sm" variant="outline" @click="onReviewReport('rejected')">
                    退回
                  </FaButton>
                  <FaButton v-if="latestReport.status === 'reviewed'" size="sm" @click="onPublishReport">
                    <FaIcon name="i-lucide:send" />
                    发布
                  </FaButton>
                </div>
              </div>
              <div class="space-y-3">
                <FaLabel label="Findings">
                  <FaInput v-model="reportForm.findings" type="textarea" :rows="4" :disabled="!canEditReport" placeholder="影像所见" class="w-full" />
                </FaLabel>
                <FaLabel label="Impression">
                  <FaInput v-model="reportForm.impression" type="textarea" :rows="3" :disabled="!canEditReport" placeholder="影像结论" class="w-full" />
                </FaLabel>
                <FaLabel label="Recommendation">
                  <FaInput v-model="reportForm.recommendation" type="textarea" :rows="2" :disabled="!canEditReport" placeholder="建议" class="w-full" />
                </FaLabel>
                <div v-if="canEditReport && latestReport" class="flex gap-2 justify-end">
                  <FaButton size="sm" variant="outline" @click="onSaveReport">
                    <FaIcon name="i-lucide:save" />
                    保存修改
                  </FaButton>
                </div>
                <EmptyState v-if="!latestReport" compact title="暂无报告" description="填写上方内容后点击「保存报告」创建 v1" />
              </div>
            </div>
          </div>
          <EmptyState v-else compact title="请选择左侧影像申请" description="选中后在此排程、执行、上传附件、录入报告" />
        </div>
      </div>
    </div>

    <!-- 新建申请 -->
    <FaDrawer v-model="createVisible" title="新建影像申请" :width="560" :show-confirm-button="false">
      <div class="p-4 space-y-3">
        <FaLabel label="客户" required>
          <BusinessCustomerPicker v-model="imagingForm.customerId" placeholder="搜索选择客户" />
        </FaLabel>
        <FaLabel label="宠物" required>
          <BusinessPetPicker v-model="imagingForm.petId" :customer-id="imagingForm.customerId || undefined" placeholder="搜索选择宠物" />
        </FaLabel>
        <FaLabel label="影像类型" required>
          <FaSelect v-model="imagingForm.imagingType" :options="Object.entries(IMAGING_TYPE_LABELS).map(([value, label]) => ({ value, label }))" class="w-full" />
        </FaLabel>
        <FaLabel label="期望排程时间">
          <FaInput v-model="imagingForm.scheduledAt" type="datetime-local" class="w-full" />
        </FaLabel>
        <FaLabel label="临床问题">
          <FaInput v-model="imagingForm.clinicalQuestion" type="textarea" :rows="3" placeholder="临床问题/检查目的" class="w-full" />
        </FaLabel>
        <FaLabel label="备注">
          <FaInput v-model="imagingForm.notes" placeholder="备注信息" class="w-full" />
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

    <!-- 排程 -->
    <FaDrawer v-model="scheduleVisible" title="影像排程" :width="420" :show-confirm-button="false">
      <div class="p-4 space-y-3">
        <FaLabel label="预约时间" required>
          <FaInput v-model="scheduleDate" type="datetime-local" class="w-full" />
        </FaLabel>
        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="scheduleVisible = false">
            取消
          </FaButton>
          <FaButton @click="onConfirmSchedule">
            确认排程
          </FaButton>
        </div>
      </div>
    </FaDrawer>
  </div>
</template>
