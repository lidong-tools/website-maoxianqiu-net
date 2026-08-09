<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiArtifacts from '@/api/modules/document-artifacts'
import apiStore from '@/api/modules/store'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import type {
  DocumentArchive,
  SignatureRequest,
} from '@/types/insurance'
import {
  ARCHIVE_STATUS_LABELS,
  SIGNATURE_STATUS_LABELS,
} from '@/types/insurance'

defineOptions({
  name: 'OperationsArchives',
})

const tenantStore = useAppTenantStore()

// ===== 门店过滤 =====
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  storeId: '',
  documentType: '',
  status: '',
})

/** 加载门店选项 */
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

const DOCUMENT_TYPE_OPTIONS = [
  { label: '就诊病历', value: 'encounter' },
  { label: '病历摘要', value: 'medical_record_summary' },
  { label: '处方', value: 'prescription' },
  { label: '收费发票', value: 'invoice' },
  { label: '检验报告', value: 'lab_report' },
  { label: '影像报告', value: 'imaging_report' },
  { label: '出院记录', value: 'discharge_summary' },
  { label: '疫苗证明', value: 'vaccination_certificate' },
  { label: '保险理赔包', value: 'insurance_claim_pack' },
]

const ARCHIVE_STATUS_OPTIONS = [
  { label: '生效中', value: 'active' },
  { label: '已取代', value: 'superseded' },
  { label: '已归档', value: 'archived' },
]

/** 文档类型中文名(列展示) */
function documentTypeLabel(type: string): string {
  return DOCUMENT_TYPE_OPTIONS.find(o => o.value === type)?.label ?? type
}

// ===== 归档列表 =====
const archives = ref<DocumentArchive[]>([])
const total = ref(0)
const loading = ref(false)
const page = ref(1)
const pageSize = ref(20)

/** 加载归档列表 */
async function loadArchives() {
  if (!tenantStore.currentTenantId) {
    archives.value = []
    return
  }
  loading.value = true
  try {
    const res: any = await apiArtifacts.listArchives({
      tenantId: tenantStore.currentTenantId,
      storeId: search.value.storeId || undefined,
      documentType: search.value.documentType || undefined,
      status: (search.value.status as 'active' | 'superseded' | 'archived' | undefined) || undefined,
      page: page.value,
      pageSize: pageSize.value,
    })
    archives.value = res.data?.list ?? []
    total.value = res.data?.total ?? 0
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '加载归档失败')
  }
  finally {
    loading.value = false
  }
}

/** 下载归档 PDF(预签名 URL) */
async function onDownload(row: DocumentArchive) {
  try {
    const res: any = await apiArtifacts.getDownloadUrl(row.id)
    window.open(res.data.downloadUrl, '_blank')
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '获取下载链接失败')
  }
}

// ===== 发起签名 =====
const signVisible = ref(false)
const signSubmitting = ref(false)
const signArchive = ref<DocumentArchive | null>(null)
const signForm = ref({
  signerType: 'customer' as 'customer' | 'guardian' | 'other',
  signerName: '',
  signerEmail: '',
})

const SIGNER_TYPE_OPTIONS = [
  { label: '客户', value: 'customer' },
  { label: '监护人', value: 'guardian' },
  { label: '其他', value: 'other' },
]

function openSign(row: DocumentArchive) {
  signArchive.value = row
  signForm.value = { signerType: 'customer', signerName: '', signerEmail: '' }
  signVisible.value = true
}

/** 发起签名请求(内部 Provider,仅表达内部流程) */
async function onSign() {
  if (!signArchive.value) {
    return
  }
  signSubmitting.value = true
  try {
    await apiArtifacts.createSignature(signArchive.value.id, {
      signerType: signForm.value.signerType,
      signerName: signForm.value.signerName || undefined,
      signerEmail: signForm.value.signerEmail || undefined,
    })
    useFaToast().success('签名请求已创建(内部流程,不具备独立法律效力)')
    signVisible.value = false
    loadSignatures(signArchive.value.id)
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '创建签名请求失败')
  }
  finally {
    signSubmitting.value = false
  }
}

// ===== 签名列表 =====
const signatures = ref<SignatureRequest[]>([])
const signaturesVisible = ref(false)
const signaturesLoading = ref(false)

/** 查看归档签名请求列表 */
async function loadSignatures(archiveId: string) {
  signaturesVisible.value = true
  signaturesLoading.value = true
  try {
    const res: any = await apiArtifacts.listSignatures(archiveId)
    signatures.value = res.data?.list ?? []
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '加载签名列表失败')
  }
  finally {
    signaturesLoading.value = false
  }
}

// ===== 列定义 =====
const columns: TableColumn[] = [
  { label: '文档类型', prop: 'document_type', width: 130, formatter: (row: DocumentArchive) => documentTypeLabel(row.document_type) },
  { label: '文件名', prop: 'files', minWidth: 200, formatter: (row: DocumentArchive) => row.files?.original_name ?? '-' },
  { label: '大小', prop: 'size_bytes', width: 100, formatter: (row: DocumentArchive) => `${(row.size_bytes / 1024).toFixed(1)} KB` },
  { label: 'SHA256', prop: 'sha256', minWidth: 260 },
  { label: '状态', prop: 'status', width: 100, formatter: (row: DocumentArchive) => ARCHIVE_STATUS_LABELS[row.status] ?? row.status },
  { label: '客户可见', prop: 'customer_visible', width: 90, formatter: (row: DocumentArchive) => (row.customer_visible ? '是' : '否') },
  { label: '创建时间', prop: 'created_at', width: 170 },
]

const signatureColumns: TableColumn[] = [
  { label: '签署人类型', prop: 'signer_type', width: 110 },
  { label: '姓名', prop: 'signer_name', minWidth: 120 },
  { label: '邮箱', prop: 'signer_email', minWidth: 180 },
  { label: 'Provider', prop: 'provider', width: 100 },
  { label: '状态', prop: 'status', width: 100, formatter: (row: SignatureRequest) => SIGNATURE_STATUS_LABELS[row.status] ?? row.status },
  { label: '时间', prop: 'created_at', width: 170 },
]

loadStoreOptions()
loadArchives()
</script>

<template>
  <div class="p-4">
    <FaSearchBar :show-toggle="false">
      <FaSearchItem label="门店">
        <FaSelect
          v-model="search.storeId"
          placeholder="全部门店"
          clearable
          class="w-52"
          :options="storeOptions"
          @change="loadArchives"
        />
      </FaSearchItem>
      <FaSearchItem label="文档类型">
        <FaSelect
          v-model="search.documentType"
          placeholder="全部类型"
          clearable
          class="w-40"
          :options="DOCUMENT_TYPE_OPTIONS"
          @change="loadArchives"
        />
      </FaSearchItem>
      <FaSearchItem label="状态">
        <FaSelect
          v-model="search.status"
          placeholder="全部状态"
          clearable
          class="w-32"
          :options="ARCHIVE_STATUS_OPTIONS"
          @change="loadArchives"
        />
      </FaSearchItem>
      <FaButton type="primary" @click="loadArchives">
        查询
      </FaButton>
    </FaSearchBar>

    <FaCard>
      <FaTable
        row-key="id"
        :loading="loading"
        :columns="columns"
        :data="archives"
        :total="total"
        :page="page"
        :page-size="pageSize"
        @page-change="(p: number) => { page = p; loadArchives() }"
      >
        <template #actions="{ row }">
          <FaButton type="link" @click="onDownload(row)">
            下载
          </FaButton>
          <FaButton type="link" @click="openSign(row)">
            发起签名
          </FaButton>
          <FaButton type="link" @click="loadSignatures(row.id)">
            签名记录
          </FaButton>
        </template>
      </FaTable>
    </FaCard>

    <!-- 发起签名 -->
    <FaModal v-model="signVisible" title="发起签名请求" width="520px" :footer="false" :close-on-click-overlay="false">
      <div class="py-2 space-y-4">
        <p class="text-xs text-amber-600">
          当前为内部流程(provider=internal),仅表达门店内部确认,不具备独立法律效力。
        </p>
        <FaLabel label="签署人类型" class="block">
          <FaSelect v-model="signForm.signerType" class="w-full" :options="SIGNER_TYPE_OPTIONS" />
        </FaLabel>
        <FaLabel label="姓名" class="block">
          <FaInput v-model="signForm.signerName" placeholder="签署人姓名" class="w-full" />
        </FaLabel>
        <FaLabel label="邮箱" class="block">
          <FaInput v-model="signForm.signerEmail" placeholder="签署人邮箱(可选)" class="w-full" />
        </FaLabel>
      </div>
      <div class="flex justify-end gap-2 pt-4">
        <FaButton @click="signVisible = false">
          取消
        </FaButton>
        <FaButton type="primary" :loading="signSubmitting" @click="onSign">
          创建请求
        </FaButton>
      </div>
    </FaModal>

    <!-- 签名记录 -->
    <FaModal v-model="signaturesVisible" title="签名记录" width="720px" :footer="false">
      <div class="py-2">
        <FaTable
          row-key="id"
          :loading="signaturesLoading"
          :columns="signatureColumns"
          :data="signatures"
          :pagination="false"
          size="small"
        />
      </div>
    </FaModal>
  </div>
</template>
