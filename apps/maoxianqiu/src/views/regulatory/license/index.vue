<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  InstitutionLicenseRecord,
  InstitutionLicenseVersionRecord,
  LicenseStatus,
} from '@/types/regulatory'
import apiApp from '@/api/modules/app'
import apiFile from '@/api/modules/file'
import apiRegulatory from '@/api/modules/regulatory'
import { LICENSE_STATUS_LABELS } from '@/types/regulatory'

defineOptions({
  name: 'RegulatoryLicense',
})

/** 列表展示行(含派生"已过期"展示) */
interface DisplayRow {
  id: string
  storeName: string
  licenseNo: string
  issuingAuthority: string
  diagnosisScope: string
  validFrom: string
  validUntil: string
  status: LicenseStatus
  /** 派生展示状态:active 且已过有效期 → 已过期 */
  displayStatus: string
  hasCertificate: boolean
}

const loading = ref(false)
const dataList = ref<InstitutionLicenseRecord[]>([])
const currentTenantId = ref('')
const searchStoreId = ref('')
const searchStatus = ref('')
const platformUiDeferred = ref(false)

/** 列表列配置 */
const tableColumns = computed<TableColumn<DisplayRow>[]>(() => [
  {
    accessorKey: 'storeName',
    header: '门店',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'licenseNo',
    header: '许可证号',
  },
  {
    accessorKey: 'issuingAuthority',
    header: '发证机关',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'diagnosisScope',
    header: '诊疗范围',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'validFrom',
    header: '生效日期',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'validUntil',
    header: '到期时间',
    cell: (info) => {
      const v = info.getValue() as string
      return v ? `${v}${isExpired(info.row.original) ? '(已过期)' : ''}` : '长期有效'
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const row = info.row.original
      const status = isExpired(row) ? 'expired' : row.status
      return LICENSE_STATUS_LABELS[status] ?? row.status
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 280,
    align: 'center',
    fixed: 'right',
  },
])

/** active 且 valid_until 已过 → 派生已过期 */
function isExpired(row: DisplayRow): boolean {
  if (row.status !== 'active' || !row.validUntil) {
    return false
  }
  return new Date(`${row.validUntil}T23:59:59`).getTime() < Date.now()
}

/** 行 → 展示结构 */
function toDisplayRow(row: InstitutionLicenseRecord): DisplayRow {
  return {
    id: row.id,
    storeName: row.stores?.name ?? '-',
    licenseNo: row.license_no,
    issuingAuthority: row.issuing_authority ?? '-',
    diagnosisScope: row.diagnosis_scope ?? '-',
    validFrom: row.valid_from ?? '-',
    validUntil: row.valid_until ?? '',
    status: row.status,
    displayStatus: '',
    hasCertificate: !!row.certificate_file_id,
  }
}

/**
 * 加载许可证列表(浏览器直连,RLS 兜底)
 */
async function getDataList() {
  if (!currentTenantId.value) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiRegulatory.listLicenses(
      currentTenantId.value,
      searchStoreId.value || undefined,
      searchStatus.value || undefined,
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

/** 编辑抽屉表单 */
const drawerVisible = ref(false)
const drawerTitle = ref('新增许可证')
const submitting = ref(false)
const form = reactive({
  licenseId: '',
  storeId: '',
  licenseNo: '',
  issuingAuthority: '',
  diagnosisScope: '',
  issuedAt: '',
  validFrom: '',
  validUntil: '',
  status: 'draft' as LicenseStatus,
  certificateFileId: '',
  certificateQr: '',
})

/** 打开新增抽屉并重置表单 */
function openCreate() {
  Object.assign(form, {
    licenseId: '',
    storeId: searchStoreId.value,
    licenseNo: '',
    issuingAuthority: '',
    diagnosisScope: '',
    issuedAt: '',
    validFrom: '',
    validUntil: '',
    status: 'draft',
    certificateFileId: '',
    certificateQr: '',
  })
  drawerTitle.value = '新增许可证'
  drawerVisible.value = true
}

/** 打开编辑抽屉并回填 */
function openEdit(row: DisplayRow) {
  const src = dataList.value.find(r => r.id === row.id)
  if (!src) {
    return
  }
  Object.assign(form, {
    licenseId: src.id,
    storeId: src.store_id,
    licenseNo: src.license_no,
    issuingAuthority: src.issuing_authority ?? '',
    diagnosisScope: src.diagnosis_scope ?? '',
    issuedAt: src.issued_at ?? '',
    validFrom: src.valid_from ?? '',
    validUntil: src.valid_until ?? '',
    status: src.status,
    certificateFileId: src.certificate_file_id ?? '',
    certificateQr: src.certificate_qr ?? '',
  })
  drawerTitle.value = '编辑许可证'
  drawerVisible.value = true
}

/**
 * 提交保存(走 Hono Command,权限 license.manage)
 */
async function onSubmit() {
  if (!form.storeId) {
    useFaToast().warning('请选择门店')
    return
  }
  if (!form.licenseNo.trim()) {
    useFaToast().warning('请填写许可证号')
    return
  }
  if (submitting.value) {
    return
  }
  submitting.value = true
  try {
    await apiRegulatory.saveLicense({
      storeId: form.storeId,
      licenseId: form.licenseId || undefined,
      licenseNo: form.licenseNo.trim(),
      issuingAuthority: form.issuingAuthority || undefined,
      diagnosisScope: form.diagnosisScope || undefined,
      issuedAt: form.issuedAt || undefined,
      validFrom: form.validFrom || undefined,
      validUntil: form.validUntil || undefined,
      status: form.status,
      certificateFileId: form.certificateFileId || undefined,
      certificateQr: form.certificateQr || undefined,
    })
    drawerVisible.value = false
    useFaToast().success('许可证已保存')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '保存失败')
  }
  finally {
    submitting.value = false
  }
}

/** 状态变更(走 Hono Command,权限 license.manage,内部 status_change 审计) */
async function onChangeStatus(row: DisplayRow, newStatus: LicenseStatus) {
  if (newStatus === row.status) {
    return
  }
  try {
    await apiRegulatory.changeLicenseStatus(row.id, { newStatus })
    useFaToast().success('状态已更新')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '状态更新失败')
  }
}

/** 查看详情抽屉(含历史版本) */
const detailVisible = ref(false)
const detailRow = ref<InstitutionLicenseRecord | null>(null)
const versions = ref<InstitutionLicenseVersionRecord[]>([])

/** 打开详情并加载历史版本 */
async function openDetail(row: DisplayRow) {
  const src = dataList.value.find(r => r.id === row.id)
  if (!src) {
    return
  }
  detailRow.value = src
  detailVisible.value = true
  try {
    const res: any = await apiRegulatory.listLicenseVersions(src.id)
    versions.value = res.data.list ?? []
  }
  catch {
    versions.value = []
  }
}

/** 查看证照附件(走 getDownloadUrl 私有签名 URL) */
async function onViewCertificate(fileId: string) {
  try {
    const res: any = await apiFile.getDownloadUrl({ fileId })
    window.open(res.data.downloadUrl, '_blank', 'noopener')
  }
  catch (e: any) {
    useFaToast().error('打开证照失败', { description: e?.message })
  }
}

/** 证照上传回调(FileUploader uploaded 事件) */
function onCertUploaded(payload: { fileId: string }) {
  form.certificateFileId = payload.fileId
}

onMounted(async () => {
  // 租户上下文来源与现有页面一致:普通租户用户取 memberships[0].tenant_id;
  // 平台管理员(无租户成员关系)暂不提供跨租户维护 UI。
  const res: any = await apiApp.profile()
  const memberships = res.data.memberships ?? []
  currentTenantId.value = memberships[0]?.tenant_id ?? ''
  platformUiDeferred.value = !currentTenantId.value
  getDataList()
})
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="动物诊疗许可证" class="mb-0">
      <template #description>
        管理门店动物诊疗许可证(证号/发证机关/诊疗范围/有效期/证照附件/历史版本)
      </template>
    </FaPageHeader>
    <FaPageMain>
      <div
        v-if="platformUiDeferred"
        class="text-sm text-amber-700 mb-3 px-4 py-3 border border-amber-200 rounded-md bg-amber-50"
      >
        当前账号无租户成员关系,无法确定租户上下文。平台管理员跨租户维护许可证的界面将在后续版本提供。
      </div>
      <div class="mb-3 flex flex-wrap gap-2 items-center">
        <BusinessStorePicker v-model="searchStoreId" placeholder="选择门店(可选)" class="w-56" />
        <FaSelect
          v-model="searchStatus"
          :options="[
            { label: '全部状态', value: '' },
            { label: '草稿', value: 'draft' },
            { label: '有效', value: 'active' },
            { label: '暂停', value: 'suspended' },
            { label: '注销', value: 'revoked' },
            { label: '过期', value: 'expired' },
          ]"
          class="w-36"
        />
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
          <PermissionButton permission="license.manage" @click="openCreate">
            新增许可证
          </PermissionButton>
        </template>
        <template #cell-operation="{ row }">
          <FaButton size="sm" variant="outline" class="mr-1" @click="openDetail(row.original)">
            查看
          </FaButton>
          <PermissionButton
            permission="license.manage"
            size="sm"
            variant="outline"
            class="mr-1"
            @click="openEdit(row.original)"
          >
            编辑
          </PermissionButton>
          <FaButton
            v-if="row.original.hasCertificate"
            size="sm"
            variant="outline"
            class="mr-1"
            @click="onViewCertificate(dataList.find(r => r.id === row.original.id)?.certificate_file_id ?? '')"
          >
            证照
          </FaButton>
          <PermissionButton
            v-if="!['revoked', 'expired'].includes(row.original.status)"
            permission="license.manage"
            size="sm"
            variant="outline"
            class="mr-1"
            @click="onChangeStatus(row.original, 'suspended')"
          >
            暂停
          </PermissionButton>
          <PermissionButton
            v-if="!['revoked', 'expired'].includes(row.original.status)"
            permission="license.manage"
            size="sm"
            variant="outline"
            @click="onChangeStatus(row.original, 'active')"
          >
            启用
          </PermissionButton>
        </template>
      </FaTable>
    </FaPageMain>

    <FaDrawer v-model="drawerVisible" :title="drawerTitle" :width="620">
      <div class="space-y-3">
        <FaLabel label="门店">
          <BusinessStorePicker v-model="form.storeId" class="w-full" />
        </FaLabel>
        <FaLabel label="许可证号">
          <FaInput v-model="form.licenseNo" placeholder="动物诊疗许可证号" class="w-full" />
        </FaLabel>
        <FaLabel label="发证机关">
          <FaInput v-model="form.issuingAuthority" placeholder="发证机关" class="w-full" />
        </FaLabel>
        <FaLabel label="诊疗范围">
          <FaInput v-model="form.diagnosisScope" placeholder="诊疗科目/范围" class="w-full" />
        </FaLabel>
        <div class="gap-3 grid grid-cols-2">
          <FaLabel label="发证日期">
            <FaInput v-model="form.issuedAt" type="date" class="w-full" />
          </FaLabel>
          <FaLabel label="生效日期">
            <FaInput v-model="form.validFrom" type="date" class="w-full" />
          </FaLabel>
        </div>
        <div class="gap-3 grid grid-cols-2">
          <FaLabel label="到期时间">
            <FaInput v-model="form.validUntil" type="date" placeholder="留空=长期有效" class="w-full" />
          </FaLabel>
          <FaLabel label="状态">
            <FaSelect
              v-model="form.status"
              :options="[
                { label: '草稿', value: 'draft' },
                { label: '有效', value: 'active' },
                { label: '暂停', value: 'suspended' },
                { label: '注销', value: 'revoked' },
                { label: '过期', value: 'expired' },
              ]"
              class="w-full"
            />
          </FaLabel>
        </div>
        <FaLabel label="证照附件">
          <!-- S31-MERGE-B B03:显式传入页面租户/门店,避免 FileUploader 读取 localStorage 残留上下文 -->
          <BusinessFileUploader
            :tenant-id="currentTenantId"
            :store-id="form.storeId"
            category="image"
            max="1"
            description="上传许可证扫描件/照片"
            @uploaded="onCertUploaded"
          />
        </FaLabel>
        <FaLabel label="证书二维码">
          <FaInput v-model="form.certificateQr" placeholder="二维码文本/URL(可选)" class="w-full" />
        </FaLabel>
      </div>
      <template #footer>
        <div class="flex gap-2 justify-end">
          <FaButton variant="outline" @click="drawerVisible = false">
            取消
          </FaButton>
          <FaButton type="primary" :loading="submitting" @click="onSubmit">
            保存
          </FaButton>
        </div>
      </template>
    </FaDrawer>

    <FaDrawer v-model="detailVisible" title="许可证详情" :width="620">
      <div v-if="detailRow" class="text-sm space-y-3">
        <FaDescriptions
          :items="[
            { label: '许可证号', value: detailRow.license_no },
            { label: '发证机关', value: detailRow.issuing_authority ?? '-' },
            { label: '诊疗范围', value: detailRow.diagnosis_scope ?? '-' },
            { label: '发证日期', value: detailRow.issued_at ?? '-' },
            { label: '生效日期', value: detailRow.valid_from ?? '-' },
            { label: '到期时间', value: detailRow.valid_until ?? '长期有效' },
            { label: '状态', value: LICENSE_STATUS_LABELS[detailRow.status] ?? detailRow.status },
          ]"
        />
        <FaDivider />
        <div class="font-medium">
          历史版本
        </div>
        <FaTable
          row-key="id"
          stripe
          border
          :columns="[
            { accessorKey: 'version_no', header: '版本' },
            { accessorKey: 'change_type', header: '变更类型' },
            { accessorKey: 'changed_at', header: '变更时间' },
          ]"
          :data="versions"
        />
      </div>
    </FaDrawer>
  </div>
</template>
