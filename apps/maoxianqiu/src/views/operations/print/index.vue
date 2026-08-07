<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  InvoicePrintSection,
  LabReportPrintSection,
  MedicalRecordPrintSection,
  PrescriptionPrintSection,
  PrintData,
  PrintJobStatus,
  PrintTemplateType,
  VaccineCertificatePrintSection,
} from '@/types/operations'
import apiOperations from '@/api/modules/operations'
import apiStore from '@/api/modules/store'
import BusinessDiagnosticOrderPicker from '@/components/business/DiagnosticOrderPicker/index.vue'
import BusinessEncounterPicker from '@/components/business/EncounterPicker/index.vue'
import BusinessInvoicePicker from '@/components/business/InvoicePicker/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { PRINT_JOB_STATUS_LABELS, PRINT_TEMPLATE_TYPE_LABELS } from '@/types/operations'

defineOptions({
  name: 'OperationsPrint',
})

interface PrintJobRow {
  id: string
  tenant_id: string
  store_id: string | null
  template_id: string | null
  entity_type: string
  entity_id: string
  status: PrintJobStatus
  operator_id: string | null
  created_at: string
}

interface TemplateOption {
  id: string
  code: string
  name: string
  type: PrintTemplateType
}

/** 新建打印弹窗状态 */
const printVisible = ref(false)
const printSubmitting = ref(false)
const printForm = ref({
  templateId: '',
  entityType: 'invoice',
  entityId: '',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<PrintJobRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const templateOptions = ref<TemplateOption[]>([])

const search = ref({
  storeId: '',
  status: '' as '' | PrintJobStatus,
})

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
 * 加载打印模板列表
 */
async function loadTemplates() {
  if (!tenantStore.currentTenantId) {
    templateOptions.value = []
    return
  }
  try {
    const res: any = await apiOperations.listPrintTemplates({
      tenantId: tenantStore.currentTenantId,
      onlyActive: true,
    })
    templateOptions.value = res.data.list ?? []
  }
  catch {
    templateOptions.value = []
  }
}

/**
 * 拉取打印任务列表
 */
function getDataList() {
  if (!tenantStore.currentTenantId) {
    dataList.value = []
    return
  }
  loading.value = true
  apiOperations.listPrintJobs({
    tenantId: tenantStore.currentTenantId,
    storeId: search.value.storeId || undefined,
    status: search.value.status || undefined,
  }).then((res: any) => {
    loading.value = false
    dataList.value = (res.data.list ?? []) as PrintJobRow[]
  }).catch(() => {
    loading.value = false
  })
}

onMounted(async () => {
  await Promise.all([loadStoreOptions(), loadTemplates()])
  if (tenantStore.currentStoreId) {
    search.value.storeId = tenantStore.currentStoreId
  }
  getDataList()
})

function onSearch() {
  getDataList()
}

function onReset() {
  search.value.storeId = tenantStore.currentStoreId || ''
  search.value.status = ''
  getDataList()
}

const tableColumns = computed<TableColumn<PrintJobRow>[]>(() => [
  {
    accessorKey: 'entity_type',
    header: '业务类型',
    cell: info => PRINT_TEMPLATE_TYPE_LABELS[info.getValue() as PrintTemplateType] ?? info.getValue(),
  },
  { accessorKey: 'entity_id', header: '业务 id', cell: info => (info.getValue() as string | undefined)?.slice(0, 8) ?? '-' },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const v = info.getValue() as PrintJobStatus
      return PRINT_JOB_STATUS_LABELS[v] ?? v
    },
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 120,
    align: 'center',
    fixed: 'right',
  },
])

/**
 * 打开"新建打印"弹窗(MXQ-12007)
 */
function onCreate() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  if (templateOptions.value.length === 0) {
    useFaToast().warning('当前租户没有可用的打印模板')
    return
  }
  printForm.value = {
    templateId: templateOptions.value[0]?.id ?? '',
    entityType: 'invoice',
    entityId: '',
  }
  printVisible.value = true
}

/** 支持通过选择器选取业务单据的模板类型(S30-R06:禁止手填 UUID) */
const PICKABLE_ENTITY_TYPES: PrintTemplateType[] = ['invoice', 'medical_record', 'prescription', 'lab_report', 'vaccine_certificate']

/**
 * 提交创建打印任务(走 Hono Command + create_print_job RPC)
 */
function onSubmitPrint() {
  if (!tenantStore.currentTenantId) {
    return
  }
  if (!printForm.value.templateId) {
    useFaToast().warning('请选择打印模板')
    return
  }
  if (!PICKABLE_ENTITY_TYPES.includes(printForm.value.entityType as PrintTemplateType)) {
    useFaToast().warning('该业务类型暂不支持打印')
    return
  }
  if (!printForm.value.entityId.trim()) {
    useFaToast().warning('请选择业务单据')
    return
  }
  printSubmitting.value = true
  apiOperations
    .createPrintJob({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId || undefined,
      templateId: printForm.value.templateId,
      entityType: printForm.value.entityType,
      entityId: printForm.value.entityId.trim(),
    })
    .then(() => {
      useFaToast().success('打印任务已创建')
      printVisible.value = false
      getDataList()
    })
    .finally(() => {
      printSubmitting.value = false
    })
}

// ===== 详情查看弹窗 =====
const detailVisible = ref(false)
const detailRow = ref<PrintJobRow | null>(null)

// ===== 打印预览弹窗 =====
const previewVisible = ref(false)
const previewContent = ref('')
/** 纸张规格 */
type PaperSize = 'A4' | 'A5' | 'receipt'
const paperSize = ref<PaperSize>('A4')
const PAPER_SIZE_OPTIONS: Array<{ label: string, value: PaperSize }> = [
  { label: 'A4 (210mm × 297mm)', value: 'A4' },
  { label: 'A5 (148mm × 210mm)', value: 'A5' },
  { label: '小票 80mm', value: 'receipt' },
]

/** 可预览的模板类型集合 */
const PREVIEWABLE_TYPES: PrintTemplateType[] = ['invoice', 'medical_record', 'prescription', 'lab_report', 'vaccine_certificate']

/**
 * 查看任务详情
 */
function onView(row: PrintJobRow) {
  detailRow.value = row
  detailVisible.value = true
}

/**
 * 获取模板类型对应的实体标签
 */
function getEntityLabel(entityType: string): string {
  return PRINT_TEMPLATE_TYPE_LABELS[entityType as PrintTemplateType] ?? entityType
}

/**
 * 根据模板类型选择默认纸张规格
 */
function getDefaultPaperSize(entityType: string): PaperSize {
  switch (entityType) {
    case 'prescription':
      return 'A5'
    case 'invoice':
      return 'receipt'
    case 'medical_record':
    case 'lab_report':
    case 'vaccine_certificate':
    default:
      return 'A4'
  }
}

/** 转义 HTML 特殊字符,防止业务数据注入打印内容 */
function escapeHtml(v: unknown): string {
  if (v == null) {
    return ''
  }
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 格式化日期时间 */
function fmtDateTime(v?: string | null): string {
  return v ? new Date(v).toLocaleString('zh-CN') : '-'
}

/** 格式化日期 */
function fmtDate(v?: string | null): string {
  return v ? new Date(v).toLocaleDateString('zh-CN') : '-'
}

/** 格式化金额(2 位小数) */
function fmtMoney(v?: number): string {
  return (v ?? 0).toFixed(2)
}

/** 渲染打印基础信息区块(医院/门店/客户/宠物/医生/操作员) */
function renderPrintMeta(data: PrintData): string {
  const hospital = `${data.hospital.name}${data.hospital.shortName ? `(${data.hospital.shortName})` : ''}`
  const store = data.store ? `${data.store.name}${data.store.code ? `(${data.store.code})` : ''}` : '-'
  const customer = data.customer ? `${data.customer.name}${data.customer.phone ? ` ${data.customer.phone}` : ''}` : '-'
  const pet = data.pet
    ? `${data.pet.name}${data.pet.species ? ` / ${data.pet.species}` : ''}${data.pet.breed ? ` ${data.pet.breed}` : ''}${data.pet.gender ? ` / ${data.pet.gender}` : ''}${data.pet.weight != null ? ` / ${data.pet.weight}kg` : ''}`
    : '-'
  const doctor = data.doctor ? `${data.doctor.name}${data.doctor.title ? `(${data.doctor.title})` : ''}` : '-'
  const operator = data.operator?.name ?? '-'
  return `
<table class="print-table">
  <tr><th style="width:18%">医院</th><td>${escapeHtml(hospital)}</td><th style="width:18%">门店</th><td>${escapeHtml(store)}</td></tr>
  <tr><th>客户</th><td>${escapeHtml(customer)}</td><th>宠物</th><td>${escapeHtml(pet)}</td></tr>
  <tr><th>主治医生</th><td>${escapeHtml(doctor)}</td><th>操作员</th><td>${escapeHtml(operator)}</td></tr>
</table>`
}

/**
 * 生成打印预览 HTML 内容(P0-05:基于服务端真实业务 DTO 渲染)
 * @param data 服务端 print-data 接口返回的标准 DTO
 */
function generatePreviewContent(data: PrintData): string {
  const entityLabel = getEntityLabel(data.entityType)
  const createdAt = fmtDateTime(data.createdAt)

  let bodyHtml = ''
  switch (data.entityType) {
    case 'invoice':
      bodyHtml = generateInvoicePreview(data)
      break
    case 'medical_record':
      bodyHtml = generateMedicalRecordPreview(data)
      break
    case 'prescription':
      bodyHtml = generatePrescriptionPreview(data)
      break
    case 'lab_report':
      bodyHtml = generateLabReportPreview(data)
      break
    case 'vaccine_certificate':
      bodyHtml = generateVaccineCertificatePreview(data)
      break
    default:
      bodyHtml = `<p style="text-align:center;padding:40px;">暂不支持该类型的打印预览</p>`
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>打印预览 - ${escapeHtml(entityLabel)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "SimSun", "Microsoft YaHei", serif; font-size: 14px; color: #333; padding: 20px; }
  .print-header { text-align: center; margin-bottom: 16px; }
  .print-header h1 { font-size: 20px; margin-bottom: 4px; }
  .print-header .sub { font-size: 12px; color: #666; }
  .print-table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  .print-table th, .print-table td { border: 1px solid #333; padding: 6px 8px; font-size: 13px; }
  .print-table th { background: #f0f0f0; text-align: center; }
  .print-table td { text-align: left; }
  .print-footer-text { margin-top: 12px; font-size: 12px; color: #666; }
  .print-footer { margin-top: 20px; font-size: 12px; color: #666; text-align: center; }
  .print-footer p { margin: 2px 0; }
  @media print {
    body { padding: 0; }
  }
</style></head>
<body>${bodyHtml}<div class="print-footer"><p>${escapeHtml(data.hospital.name)}</p><p>打印时间: ${createdAt}</p></div></body></html>`
}

/**
 * 生成收费单预览(真实 DTO 数据)
 */
function generateInvoicePreview(data: PrintData): string {
  const sec = data.invoice as InvoicePrintSection | undefined
  const rows = (sec?.items ?? []).map(it => `
    <tr>
      <td>${escapeHtml(it.name)}</td>
      <td style="text-align:right">${fmtMoney(it.unitPrice)}</td>
      <td style="text-align:center">${it.quantity}</td>
      <td style="text-align:right">${fmtMoney(it.discountAmount)}</td>
      <td style="text-align:right">${fmtMoney(it.amount)}</td>
    </tr>`).join('')
  return `
<div class="print-header">
  <h1>收费单</h1>
  <p class="sub">单号: ${escapeHtml(sec?.invoiceNo ?? '-')} | 状态: ${escapeHtml(sec?.status ?? '-')}</p>
</div>
${renderPrintMeta(data)}
<table class="print-table">
  <tr><th>项目</th><th style="width:80px">单价</th><th style="width:60px">数量</th><th style="width:80px">折扣</th><th style="width:100px">金额</th></tr>
  ${rows || '<tr><td colspan="5" style="text-align:center;color:#999;">暂无明细</td></tr>'}
</table>
<table class="print-table">
  <tr><th style="width:30%">小计</th><td style="text-align:right">${fmtMoney(sec?.subtotal)}</td></tr>
  <tr><th>折扣</th><td style="text-align:right">${fmtMoney(sec?.discountAmount)}${sec?.discountReason ? `(${escapeHtml(sec.discountReason)})` : ''}</td></tr>
  <tr><th>税额</th><td style="text-align:right">${fmtMoney(sec?.taxAmount)}</td></tr>
  <tr><th>应收合计</th><td style="text-align:right;font-weight:bold;">${fmtMoney(sec?.total)}</td></tr>
  <tr><th>已付</th><td style="text-align:right">${fmtMoney(sec?.paidAmount)}</td></tr>
  <tr><th>支付方式</th><td style="text-align:right">${escapeHtml(sec?.paymentMethod ?? '-')}</td></tr>
</table>`
}

/**
 * 生成病历预览(真实 DTO 数据)
 */
function generateMedicalRecordPreview(data: PrintData): string {
  const sec = data.medicalRecord as MedicalRecordPrintSection | undefined
  return `
<div class="print-header">
  <h1>宠物病历</h1>
  <p class="sub">就诊时间: ${fmtDateTime(sec?.startedAt)} | 状态: ${escapeHtml(sec?.status ?? '-')}</p>
</div>
${renderPrintMeta(data)}
<table class="print-table">
  <tr><th style="width:18%">主诉</th><td>${escapeHtml(sec?.chiefComplaint ?? '-')}</td></tr>
  <tr><th>病史</th><td>${escapeHtml(sec?.historyPresent ?? '-')}</td></tr>
  <tr><th>检查发现</th><td>${escapeHtml(sec?.examFindings ?? '-')}</td></tr>
  <tr><th>诊断</th><td>${escapeHtml((sec?.diagnosisCodes ?? []).join('、') || sec?.diagnosisText || '-')}</td></tr>
  <tr><th>治疗方案</th><td>${escapeHtml(sec?.treatmentPlan ?? '-')}</td></tr>
  <tr><th>复诊日期</th><td>${fmtDate(sec?.followUpDate)}</td></tr>
  <tr><th>医生签署</th><td>${escapeHtml(data.doctor?.name ?? '-')}${sec?.signedAt ? ` (${fmtDateTime(sec.signedAt)})` : ''}</td></tr>
</table>`
}

/**
 * 生成处方预览(真实 DTO 数据)
 */
function generatePrescriptionPreview(data: PrintData): string {
  const sec = data.prescription as PrescriptionPrintSection | undefined
  const rows = (sec?.items ?? []).map(it => `
    <tr>
      <td>${escapeHtml(it.drugName)}</td>
      <td>${escapeHtml(it.dosage ?? '-')}</td>
      <td>${escapeHtml(it.frequency ?? '-')}</td>
      <td style="text-align:center">${it.durationDays ?? '-'}</td>
      <td style="text-align:center">${it.quantity}${it.unit ? escapeHtml(it.unit) : ''}</td>
      <td>${escapeHtml(it.instructions ?? '-')}</td>
    </tr>`).join('')
  return `
<div class="print-header">
  <h1>处方笺</h1>
  <p class="sub">状态: ${escapeHtml(sec?.status ?? '-')}</p>
</div>
${renderPrintMeta(data)}
<table class="print-table">
  <tr><th>药品名称</th><th>剂量</th><th>频次</th><th>天数</th><th>数量</th><th>用法</th></tr>
  ${rows || '<tr><td colspan="6" style="text-align:center;color:#999;">暂无处方明细</td></tr>'}
</table>
<p class="print-footer-text">医师: ${escapeHtml(data.doctor?.name ?? '-')}</p>`
}

/**
 * 生成检验报告预览(真实 DTO 数据)
 */
function generateLabReportPreview(data: PrintData): string {
  const sec = data.labReport as LabReportPrintSection | undefined
  const rows = (sec?.analytes ?? []).map(it => `
    <tr>
      <td>${escapeHtml(it.name)}</td>
      <td style="text-align:center">${escapeHtml(it.resultValue ?? '-')}${it.isCritical ? ' ⚠' : it.isAbnormal ? ' *' : ''}</td>
      <td style="text-align:center">${escapeHtml(it.unit ?? '-')}</td>
      <td style="text-align:center">${escapeHtml(it.refRange ?? '-')}</td>
    </tr>`).join('')
  return `
<div class="print-header">
  <h1>检验报告</h1>
  <p class="sub">申请单号: ${escapeHtml(sec?.orderNo ?? '-')} | 状态: ${escapeHtml(sec?.status ?? '-')}</p>
</div>
${renderPrintMeta(data)}
<table class="print-table">
  <tr><th>检验项目</th><th>结果</th><th>单位</th><th>参考范围</th></tr>
  ${rows || '<tr><td colspan="4" style="text-align:center;color:#999;">暂无检验结果</td></tr>'}
</table>
<p class="print-footer-text">申请时间: ${fmtDateTime(sec?.requestedAt)} | 完成时间: ${fmtDateTime(sec?.completedAt)}</p>`
}

/**
 * 生成疫苗证明预览(真实 DTO 数据)
 */
function generateVaccineCertificatePreview(data: PrintData): string {
  const sec = data.vaccineCertificate as VaccineCertificatePrintSection | undefined
  const rows = (sec?.vaccinations ?? []).map(it => `
    <tr>
      <td>${escapeHtml(it.vaccineName ?? '-')}</td>
      <td style="text-align:center">${it.doseNo ?? '-'}</td>
      <td style="text-align:center">${fmtDateTime(it.administeredDate)}</td>
      <td style="text-align:center">${escapeHtml(it.batchNo ?? '-')}</td>
      <td style="text-align:center">${escapeHtml(it.manufacturer ?? '-')}</td>
      <td style="text-align:center">${fmtDate(it.nextDueDate)}</td>
    </tr>`).join('')
  return `
<div class="print-header">
  <h1>疫苗免疫证明</h1>
  <p class="sub">证书编号: ${escapeHtml(sec?.certificateNo ?? '-')} | 签发时间: ${fmtDateTime(sec?.issuedDate)}</p>
</div>
${renderPrintMeta(data)}
<table class="print-table">
  <tr><th>疫苗名称</th><th>剂次</th><th>接种日期</th><th>批号</th><th>生产厂家</th><th>下次接种</th></tr>
  ${rows || '<tr><td colspan="6" style="text-align:center;color:#999;">暂无疫苗记录</td></tr>'}
</table>`
}

/** 打印数据加载中状态 */
const previewLoading = ref(false)

/**
 * 打开打印预览弹窗(P0-05:先请求服务端真实业务 DTO 再渲染)
 */
async function onPreview() {
  if (!detailRow.value) {
    return
  }
  const row = detailRow.value
  previewLoading.value = true
  try {
    const res = await apiOperations.getPrintData(row.entity_type, row.entity_id)
    const data = res.data as PrintData
    paperSize.value = getDefaultPaperSize(row.entity_type)
    previewContent.value = generatePreviewContent(data)
    previewVisible.value = true
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '加载打印数据失败')
  }
  finally {
    previewLoading.value = false
  }
}

/**
 * 执行打印
 */
function onPrintNow() {
  const printWindow = window.open('', '_blank', 'width=800,height=600')
  if (!printWindow) {
    useFaToast().warning('请允许弹出窗口以进行打印')
    return
  }
  printWindow.document.write(previewContent.value)
  printWindow.document.close()
  printWindow.focus()
  // 延迟调用打印，确保内容已渲染
  setTimeout(() => {
    printWindow.print()
  }, 300)
}
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="打印中心" class="mb-0">
      <template #description>
        收据/处方/病历/标签批量打印;走 Hono Command + create_print_job RPC,审计可追溯
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="门店" class="col-span-1">
              <FaSelect v-model="search.storeId" :options="storeOptions" class="w-full" @change="onSearch" />
            </FaLabel>
            <FaLabel label="状态" class="col-span-1">
              <FaSelect
                v-model="search.status"
                :options="[
                  { label: '全部', value: '' },
                  { label: '排队中', value: 'queued' },
                  { label: '已打印', value: 'printed' },
                  { label: '失败', value: 'failed' },
                ]"
                class="w-full"
                @change="onSearch"
              />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton variant="outline" @click="onReset">
                重置
              </FaButton>
              <FaButton type="primary" @click="onSearch">
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
          <FaButton @click="onCreate">
            <FaIcon name="i-ri:printer-line" />
            新建打印
          </FaButton>
        </template>
        <template #cell-operation="{ row }">
          <div class="flex-center gap-2">
            <FaButton variant="outline" size="icon-sm" @click="onView(row.original)">
              <FaIcon name="i-ri:eye-line" />
            </FaButton>
          </div>
        </template>
      </FaTable>

      <!-- 新建打印弹窗(MXQ-12007) -->
      <FaModal
        v-model="printVisible"
        title="新建打印"
        confirm-text="创建任务"
        :loading="printSubmitting"
        @confirm="onSubmitPrint"
      >
        <div class="space-y-4">
          <FaLabel label="打印模板">
            <FaSelect
              v-model="printForm.templateId"
              :options="templateOptions.map(t => ({ label: `${t.name}(${PRINT_TEMPLATE_TYPE_LABELS[t.type] ?? t.type})`, value: t.id }))"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="业务类型">
            <FaSelect
              v-model="printForm.entityType"
              :options="Object.entries(PRINT_TEMPLATE_TYPE_LABELS).map(([value, label]) => ({ label, value }))"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="业务单据">
            <BusinessInvoicePicker v-if="printForm.entityType === 'invoice'" v-model="printForm.entityId" placeholder="搜索选择发票" />
            <BusinessEncounterPicker v-else-if="printForm.entityType === 'medical_record' || printForm.entityType === 'prescription'" v-model="printForm.entityId" placeholder="搜索选择就诊记录" />
            <BusinessDiagnosticOrderPicker v-else-if="printForm.entityType === 'lab_report'" v-model="printForm.entityId" order-type="lab" placeholder="搜索选择检验申请" />
            <BusinessDiagnosticOrderPicker v-else-if="printForm.entityType === 'vaccine_certificate'" v-model="printForm.entityId" order-type="vaccination" placeholder="搜索选择疫苗记录" />
            <!-- S30-R06:禁止手填 UUID;label/other 无业务单据选择器,禁用输入 -->
            <FaInput v-else v-model="printForm.entityId" placeholder="该类型暂不支持选择业务单据" disabled class="w-full" />
          </FaLabel>
        </div>
      </FaModal>

      <!-- 详情弹窗 -->
      <FaModal
        v-model="detailVisible"
        title="打印任务详情"
        :footer="false"
        width="560px"
      >
        <template v-if="detailRow">
          <div class="space-y-3">
            <div class="gap-3 grid grid-cols-2">
              <FaLabel label="任务编号">
                <span class="text-sm">{{ detailRow.id }}</span>
              </FaLabel>
              <FaLabel label="状态">
                <span class="text-sm">{{ PRINT_JOB_STATUS_LABELS[detailRow.status] ?? detailRow.status }}</span>
              </FaLabel>
              <FaLabel label="模板类型">
                <span class="text-sm">{{ getEntityLabel(detailRow.entity_type) }}</span>
              </FaLabel>
              <FaLabel label="实体 ID">
                <span class="text-sm">{{ detailRow.entity_id || '-' }}</span>
              </FaLabel>
              <FaLabel label="模板 ID">
                <span class="text-sm">{{ detailRow.template_id?.slice(0, 12) ?? '-' }}</span>
              </FaLabel>
              <FaLabel label="门店 ID">
                <span class="text-sm">{{ detailRow.store_id?.slice(0, 12) ?? '-' }}</span>
              </FaLabel>
              <FaLabel label="操作员 ID">
                <span class="text-sm">{{ detailRow.operator_id?.slice(0, 12) ?? '-' }}</span>
              </FaLabel>
              <FaLabel label="创建时间">
                <span class="text-sm">{{ detailRow.created_at ? new Date(detailRow.created_at).toLocaleString('zh-CN') : '-' }}</span>
              </FaLabel>
            </div>
            <div v-if="PREVIEWABLE_TYPES.includes(detailRow.entity_type as PrintTemplateType)" class="pt-3 border-t flex justify-end">
              <FaButton type="primary" :loading="previewLoading" @click="onPreview">
                <FaIcon name="i-ri:printer-line" />
                打印预览
              </FaButton>
            </div>
            <div v-else class="pt-3 border-t">
              <p class="text-sm text-muted-foreground text-center">
                该模板类型暂不支持打印预览
              </p>
            </div>
          </div>
        </template>
      </FaModal>

      <!-- 打印预览弹窗 -->
      <FaModal
        v-model="previewVisible"
        title="打印预览"
        :footer="false"
        width="900px"
      >
        <div class="space-y-4">
          <div class="flex gap-4 items-center">
            <FaLabel label="纸张规格">
              <FaSelect v-model="paperSize" :options="PAPER_SIZE_OPTIONS" class="w-48" />
            </FaLabel>
            <FaButton type="primary" @click="onPrintNow">
              <FaIcon name="i-ri:printer-line" />
              立即打印
            </FaButton>
            <span class="text-xs text-muted-foreground">切换纸张规格仅改变预览宽度，打印时请确保打印机纸张匹配</span>
          </div>
          <div
            class="mx-auto border border-gray-300 bg-white shadow overflow-auto"
            :style="{
              width: paperSize === 'A4' ? '210mm' : paperSize === 'A5' ? '148mm' : '80mm',
              minHeight: paperSize === 'A4' ? '297mm' : paperSize === 'A5' ? '210mm' : 'auto',
              maxHeight: '60vh',
              transformOrigin: 'top center',
            }"
          >
            <div v-html="previewContent" />
          </div>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
