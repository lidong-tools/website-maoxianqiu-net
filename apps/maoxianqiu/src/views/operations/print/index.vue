<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { PrintJobStatus, PrintTemplateType } from '@/types/operations'
import apiOperations from '@/api/modules/operations'
import apiStore from '@/api/modules/store'
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
    cell: (info: any) => PRINT_TEMPLATE_TYPE_LABELS[info.getValue() as PrintTemplateType] ?? info.getValue(),
  },
  { accessorKey: 'entity_id', header: '业务 id', cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-' },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as PrintJobStatus
      return PRINT_JOB_STATUS_LABELS[v] ?? v
    },
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
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
  if (!printForm.value.entityId.trim()) {
    useFaToast().warning('请填写业务 id')
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

/**
 * 查看任务详情(占位)
 */
function onView(_row: PrintJobRow) {
  useFaToast().info('详情查看即将上线')
}
</script>

<template>
  <div>
    <FaPageHeader title="打印中心" class="mb-0">
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
          <FaLabel label="业务 id">
            <FaInput
              v-model="printForm.entityId"
              class="w-full"
              placeholder="发票/处方/病历等实体 id"
            />
          </FaLabel>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
