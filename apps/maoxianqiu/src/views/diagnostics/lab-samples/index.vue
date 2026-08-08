<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { LabSampleStatus, SpecimenType } from '@/types/diagnostics'
import apiDiagnostics from '@/api/modules/diagnostics'
import apiStore from '@/api/modules/store'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { LAB_SAMPLE_STATUS_COLORS, LAB_SAMPLE_STATUS_LABELS } from '@/types/diagnostics'

defineOptions({
  name: 'DiagnosticsLabSamples',
})

interface LabSampleRow {
  id: string
  lab_order_id: string
  sample_no: string
  sample_type: SpecimenType
  status: LabSampleStatus
  planned_at: string
  collected_at: string | null
  received_at: string | null
  rejected_at: string | null
  reject_reason: string | null
  container: string | null
  storage_condition: string | null
  remark: string | null
  store_id: string | null
}

const tenantStore = useAppTenantStore()
const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const loading = ref(false)
const dataList = ref<LabSampleRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  storeId: '',
  status: '',
})

/** 新建标本弹窗 */
const createVisible = ref(false)
const labOrderOptions = ref<Array<{ label: string, value: string }>>([])
const createForm = reactive({
  labOrderId: '',
  sampleType: 'blood' as SpecimenType,
  container: '',
  storageCondition: '',
  remark: '',
})
const creating = ref(false)

/** 状态流转弹窗 */
const transitionVisible = ref(false)
const transitionTarget = ref<LabSampleRow | null>(null)
const transitionForm = reactive({
  toStatus: '' as LabSampleStatus,
  reason: '',
})
const transitioning = ref(false)

/** 拒收原因弹窗(专门用于 rejected) */
const rejectVisible = ref(false)
const rejectTarget = ref<LabSampleRow | null>(null)
const rejectReason = ref('')
const rejecting = ref(false)

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
 * 加载可用的检验申请(浏览器直连,RLS 跟随 lab_orders)
 * 仅展示 requested/collected 状态,便于创建标本
 */
async function loadLabOrderOptions() {
  try {
    const res: any = await apiDiagnostics.listLabOrders({ page: 1, pageSize: 50 })
    labOrderOptions.value = (res.data.list ?? []).map((o: any) => ({
      label: `${o.order_no} (${o.status})`,
      value: o.id,
    }))
  }
  catch {
    labOrderOptions.value = []
  }
}

/**
 * 获取标本列表(S3.1-C,走 Hono Command)
 */
function getDataList() {
  loading.value = true
  apiDiagnostics.listLabSamples({
    storeId: search.value.storeId || undefined,
    status: (search.value.status as LabSampleStatus) || undefined,
    ...getParams(),
  }).then((res: any) => {
    loading.value = false
    dataList.value = res.data.list ?? []
    pagination.value.total = res.data.total
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

// P0-06:切店后重置分页与门店筛选并重载(避免旧门店标本数据残留)
useStoreScopedPage({
  load: getDataList,
  reset: () => {
    search.value.storeId = tenantStore.currentStoreId
    onCurrentChange(1)
  },
})

function sizeChange(size: number) {
  onSizeChange(size).then(() => getDataList())
}

function currentChange(page = 1) {
  onCurrentChange(page).then(() => getDataList())
}

function searchReset() {
  search.value.status = ''
  currentChange()
}

/**
 * 打开新建标本弹窗并加载检验申请
 */
function openCreate() {
  createForm.labOrderId = ''
  createForm.sampleType = 'blood'
  createForm.container = ''
  createForm.storageCondition = ''
  createForm.remark = ''
  createVisible.value = true
  loadLabOrderOptions()
}

/**
 * 创建标本(S3.1-C,走 create_lab_sample RPC,状态初始 planned)
 */
async function onCreate() {
  if (!createForm.labOrderId) {
    useFaToast().warning('请选择检验申请')
    return
  }
  creating.value = true
  try {
    const res: any = await apiDiagnostics.createLabSample({
      labOrderId: createForm.labOrderId,
      sampleType: createForm.sampleType,
      container: createForm.container || undefined,
      storageCondition: createForm.storageCondition || undefined,
      remark: createForm.remark || undefined,
    })
    useFaToast().success(`标本已创建(${res.data?.sampleNo ?? ''})`)
    createVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '创建失败')
  }
  finally {
    creating.value = false
  }
}

/**
 * 打开状态流转弹窗
 */
function openTransition(row: LabSampleRow, toStatus: LabSampleStatus) {
  transitionTarget.value = row
  transitionForm.toStatus = toStatus
  transitionForm.reason = ''
  transitionVisible.value = true
}

/**
 * 打开拒收弹窗(任意非终态可拒收,须填写原因)
 */
function openReject(row: LabSampleRow) {
  rejectTarget.value = row
  rejectReason.value = ''
  rejectVisible.value = true
}

/**
 * 执行状态流转(S3.1-C,走 transition_lab_sample RPC)
 */
async function onTransition() {
  if (!transitionTarget.value) {
    return
  }
  transitioning.value = true
  try {
    await apiDiagnostics.transitionLabSample(transitionTarget.value.id, {
      toStatus: transitionForm.toStatus,
    })
    useFaToast().success('标本状态已更新')
    transitionVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
  finally {
    transitioning.value = false
  }
}

/**
 * 拒收标本(须填写原因)
 */
async function onReject() {
  if (!rejectTarget.value) {
    return
  }
  if (!rejectReason.value.trim()) {
    useFaToast().warning('请填写拒收原因')
    return
  }
  rejecting.value = true
  try {
    await apiDiagnostics.transitionLabSample(rejectTarget.value.id, {
      toStatus: 'rejected',
      reason: rejectReason.value.trim(),
    })
    useFaToast().success('标本已拒收')
    rejectVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
  finally {
    rejecting.value = false
  }
}

const tableColumns = computed<TableColumn<LabSampleRow>[]>(() => [
  { accessorKey: 'sample_no', header: '标本编号' },
  {
    accessorKey: 'lab_order_id',
    header: '检验申请',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-',
  },
  {
    accessorKey: 'sample_type',
    header: '类型',
    cell: (info: any) => {
      const map: Record<string, string> = { blood: '血液', urine: '尿液', feces: '粪便', tissue: '组织', other: '其他' }
      return map[info.getValue() as string] ?? info.getValue()
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue()
      const label = LAB_SAMPLE_STATUS_LABELS[v as keyof typeof LAB_SAMPLE_STATUS_LABELS] ?? v
      return h('span', { class: `px-2 py-0.5 rounded text-xs bg-${LAB_SAMPLE_STATUS_COLORS[v as LabSampleStatus] ?? 'default'}-100` }, label)
    },
  },
  {
    accessorKey: 'planned_at',
    header: '计划时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'collected_at',
    header: '采集时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'reject_reason',
    header: '拒收原因',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 260,
    align: 'center',
    fixed: 'right',
  },
])
</script>

<template>
  <div>
    <EntityPageHeader compact title="标本流转" description="S3.1 标本闭环:planned→collected→received→testing→completed;任意非终态可拒收(须原因)" />
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="门店" class="col-span-1">
              <FaSelect v-model="search.storeId" :options="storeOptions" class="w-full" @change="currentChange()" />
            </FaLabel>
            <FaLabel label="状态" class="col-span-1">
              <FaSelect
                v-model="search.status"
                :options="[
                  { label: '全部', value: '' },
                  { label: '待采集', value: 'planned' },
                  { label: '已采集', value: 'collected' },
                  { label: '已签收', value: 'received' },
                  { label: '检测中', value: 'testing' },
                  { label: '已完成', value: 'completed' },
                  { label: '已拒收', value: 'rejected' },
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
        <template #toolbar>
          <FaButton @click="openCreate()">
            <FaIcon name="i-ri:add-line" />
            新建标本
          </FaButton>
        </template>
        <template #cell-operation="{ row }">
          <div class="flex-center flex-wrap gap-1">
            <FaButton v-if="row.original.status === 'planned'" variant="outline" size="sm" @click="openTransition(row.original, 'collected')">
              采集
            </FaButton>
            <FaButton v-if="row.original.status === 'collected'" variant="outline" size="sm" @click="openTransition(row.original, 'received')">
              签收
            </FaButton>
            <FaButton v-if="row.original.status === 'received'" variant="outline" size="sm" @click="openTransition(row.original, 'testing')">
              检测
            </FaButton>
            <FaButton v-if="row.original.status === 'testing'" variant="outline" size="sm" @click="openTransition(row.original, 'completed')">
              完成
            </FaButton>
            <FaButton
              v-if="row.original.status !== 'completed' && row.original.status !== 'rejected'"
              variant="outline"
              size="sm"
              type="danger"
              @click="openReject(row.original)"
            >
              拒收
            </FaButton>
          </div>
        </template>
      </FaTable>
      <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />

      <!-- 新建标本弹窗 -->
      <FaModal v-model:visible="createVisible" title="新建标本" :loading="creating" @confirm="onCreate">
        <div class="space-y-3">
          <FaLabel label="检验申请" required>
            <FaSelect v-model="createForm.labOrderId" :options="labOrderOptions" class="w-full" placeholder="选择检验申请" />
          </FaLabel>
          <FaLabel label="标本类型">
            <FaSelect
              v-model="createForm.sampleType"
              :options="[
                { label: '血液', value: 'blood' },
                { label: '尿液', value: 'urine' },
                { label: '粪便', value: 'feces' },
                { label: '组织', value: 'tissue' },
                { label: '其他', value: 'other' },
              ]"
              class="w-full"
            />
          </FaLabel>
          <div class="gap-x-4 gap-y-3 grid grid-cols-2">
            <FaLabel label="容器">
              <FaInput v-model="createForm.container" placeholder="如 EDTA 抗凝管" class="w-full" />
            </FaLabel>
            <FaLabel label="储存条件">
              <FaInput v-model="createForm.storageCondition" placeholder="如 2-8°C 冷藏" class="w-full" />
            </FaLabel>
          </div>
          <FaLabel label="备注">
            <FaInput v-model="createForm.remark" placeholder="可选" class="w-full" />
          </FaLabel>
        </div>
      </FaModal>

      <!-- 状态流转弹窗 -->
      <FaModal v-model:visible="transitionVisible" title="标本状态流转" :loading="transitioning" @confirm="onTransition">
        <FaAlert type="info" :closable="false">
          标本"{{ transitionTarget?.sample_no }}"将流转为"{{ LAB_SAMPLE_STATUS_LABELS[transitionForm.toStatus] }}"
        </FaAlert>
      </FaModal>

      <!-- 拒收弹窗 -->
      <FaModal v-model:visible="rejectVisible" title="拒收标本" :loading="rejecting" @confirm="onReject">
        <div class="space-y-3">
          <FaAlert type="warning" :closable="false">
            标本"{{ rejectTarget?.sample_no }}"将被拒收,且需填写原因
          </FaAlert>
          <FaLabel label="拒收原因" required>
            <FaInput v-model="rejectReason" placeholder="必填,说明拒收原因" class="w-full" />
          </FaLabel>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
