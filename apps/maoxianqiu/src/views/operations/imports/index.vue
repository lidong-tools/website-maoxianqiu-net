<script setup lang="ts">
import type { FileItem, TableColumn } from '@fantastic-admin/components'
import type { ImportTaskStatus, ImportType } from '@/types/operations'
import apiOperations from '@/api/modules/operations'
import apiStore from '@/api/modules/store'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  IMPORT_TASK_STATUS_LABELS,
  IMPORT_TYPE_LABELS,
} from '@/types/operations'

defineOptions({
  name: 'OperationsImports',
})

/** 显示提示信息 */
function showToastInfo(msg: string) {
  useFaToast().info(msg)
}

interface ImportRow {
  id: string
  tenant_id: string
  store_id: string | null
  type: ImportType
  file_id: string | null
  status: ImportTaskStatus
  total_rows: number
  success_count: number
  failed_count: number
  created_by: string | null
  created_at: string
  updated_at: string
}

/** 新建导入弹窗状态 */
const importVisible = ref(false)
const importSubmitting = ref(false)
const importForm = ref({
  type: 'customer' as ImportType,
  storeId: '',
})
/** 上传完成后的 file id */
const uploadedFileId = ref<string | null>(null)
/** 上传文件列表(绑定 FileUploader v-model) */
const uploadFileList = ref<FileItem[]>([])

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<ImportRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])

const search = ref({
  storeId: '',
  type: '' as '' | ImportType,
  status: '' as '' | ImportTaskStatus,
})

/**
 * 加载门店选项(用于筛选)
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
 * 拉取导入任务列表
 */
function getDataList() {
  if (!tenantStore.currentTenantId) {
    dataList.value = []
    return
  }
  loading.value = true
  apiOperations.listImportTasks({
    tenantId: tenantStore.currentTenantId,
    storeId: search.value.storeId || undefined,
    type: search.value.type || undefined,
    status: search.value.status || undefined,
  }).then((res: any) => {
    loading.value = false
    dataList.value = (res.data.list ?? []) as ImportRow[]
  }).catch(() => {
    loading.value = false
  })
}

onMounted(async () => {
  await loadStoreOptions()
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
  search.value.type = ''
  search.value.status = ''
  getDataList()
}

const tableColumns = computed<TableColumn<ImportRow>[]>(() => [
  {
    accessorKey: 'type',
    header: '类型',
    cell: info => IMPORT_TYPE_LABELS[info.getValue() as ImportType] ?? info.getValue(),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const v = info.getValue() as ImportTaskStatus
      return IMPORT_TASK_STATUS_LABELS[v] ?? v
    },
  },
  {
    accessorKey: 'total_rows',
    header: '总行数',
    cell: info => info.getValue() ?? 0,
  },
  {
    accessorKey: 'success_count',
    header: '成功',
    cell: info => info.getValue() ?? 0,
  },
  {
    accessorKey: 'failed_count',
    header: '失败',
    cell: info => info.getValue() ?? 0,
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 100,
    align: 'center',
    fixed: 'right',
  },
])

/**
 * 打开"新建导入"弹窗(MXQ-12006)
 */
function openCreate() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  importForm.value = {
    type: 'customer',
    storeId: tenantStore.currentStoreId || '',
  }
  uploadedFileId.value = null
  uploadFileList.value = []
  importVisible.value = true
}

/**
 * 提交创建导入任务(走 Hono Command + create_import_task RPC)
 * 必须选择数据文件后才可创建
 */
function onSubmitImport() {
  if (!tenantStore.currentTenantId) {
    return
  }
  if (!uploadedFileId.value) {
    useFaToast().warning('请先上传数据文件')
    return
  }
  importSubmitting.value = true
  apiOperations
    .createImportTask({
      tenantId: tenantStore.currentTenantId,
      storeId: importForm.value.storeId || undefined,
      type: importForm.value.type,
      fileId: uploadedFileId.value,
    })
    .then(() => {
      useFaToast().success('导入任务已创建')
      importVisible.value = false
      getDataList()
    })
    .finally(() => {
      importSubmitting.value = false
    })
}
</script>

<template>
  <div>
    <EntityPageHeader compact title="导入中心" description="客户/宠物/商品/库存批量导入;任务走 Hono Command + RPC,异步处理" />
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="门店" class="col-span-1">
              <FaSelect v-model="search.storeId" :options="storeOptions" class="w-full" @change="onSearch" />
            </FaLabel>
            <FaLabel label="类型" class="col-span-1">
              <FaSelect
                v-model="search.type"
                :options="[
                  { label: '全部', value: '' },
                  { label: '客户', value: 'customer' },
                  { label: '宠物', value: 'pet' },
                  { label: '商品', value: 'product' },
                  { label: '库存', value: 'inventory' },
                ]"
                class="w-full"
                @change="onSearch"
              />
            </FaLabel>
            <FaLabel label="状态" class="col-span-1">
              <FaSelect
                v-model="search.status"
                :options="[
                  { label: '全部', value: '' },
                  { label: '待处理', value: 'pending' },
                  { label: '处理中', value: 'processing' },
                  { label: '已完成', value: 'completed' },
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
          <FaButton @click="openCreate">
            <FaIcon name="i-ri:upload-line" />
            新建导入
          </FaButton>
        </template>
        <template #cell-operation>
          <div class="flex-center gap-2">
            <FaButton variant="outline" size="icon-sm" @click="showToastInfo('详情查看即将上线')">
              <FaIcon name="i-ri:eye-line" />
            </FaButton>
          </div>
        </template>
      </FaTable>

      <!-- 新建导入弹窗(MXQ-12006) -->
      <FaModal
        v-model="importVisible"
        title="新建导入"
        confirm-text="创建任务"
        :loading="importSubmitting"
        @confirm="onSubmitImport"
      >
        <div class="space-y-4">
          <FaLabel label="导入类型">
            <FaSelect
              v-model="importForm.type"
              :options="[
                { label: '客户', value: 'customer' },
                { label: '宠物', value: 'pet' },
                { label: '商品', value: 'product' },
                { label: '库存', value: 'inventory' },
              ]"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="门店">
            <FaSelect v-model="importForm.storeId" :options="storeOptions" class="w-full" />
          </FaLabel>
          <FaLabel label="数据文件">
            <BusinessFileUploader
              v-model="uploadFileList"
              category="import"
              purpose="attachment"
              :max="1"
              :tenant-id="tenantStore.currentTenantId"
              :store-id="importForm.storeId || undefined"
              description="上传 CSV/Excel 数据文件"
              @uploaded="uploadedFileId = $event.fileId"
            />
          </FaLabel>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
