<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { NurseTaskStatus, NurseTaskType } from '@/types/clinical'
import apiClinical from '@/api/modules/clinical'
import apiStore from '@/api/modules/store'
import BusinessPetPicker from '@/components/business/PetPicker/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { NURSE_TASK_STATUS_COLORS, NURSE_TASK_STATUS_LABELS, NURSE_TASK_TYPE_LABELS } from '@/types/clinical'

defineOptions({
  name: 'ClinicalNurseTasks',
})

interface NurseTaskRow {
  id: string
  encounter_id: string | null
  pet_id: string
  assigned_to: string | null
  task_type: NurseTaskType
  description: string
  scheduled_at: string | null
  status: NurseTaskStatus
  store_id: string | null
}

const tenantStore = useAppTenantStore()
const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const loading = ref(false)
const dataList = ref<NurseTaskRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  storeId: '',
  status: '',
  taskType: '',
})

/** 新建弹窗 */
const createVisible = ref(false)
const createForm = reactive({
  petId: '',
  description: '',
  taskType: 'other' as NurseTaskType,
  scheduledAt: '',
})
const creating = ref(false)

/** 失败原因弹窗 */
const failVisible = ref(false)
const failTarget = ref<NurseTaskRow | null>(null)
const failReason = ref('')
const failing = ref(false)

/** 取消原因弹窗 */
const cancelVisible = ref(false)
const cancelTarget = ref<NurseTaskRow | null>(null)
const cancelReason = ref('')
const cancelling = ref(false)

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
 * 获取护士任务列表
 */
function getDataList() {
  loading.value = true
  apiClinical.listNurseTasks({
    storeId: search.value.storeId || undefined,
    status: (search.value.status as NurseTaskStatus) || undefined,
    taskType: (search.value.taskType as NurseTaskType) || undefined,
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

function sizeChange(size: number) {
  onSizeChange(size).then(() => getDataList())
}

function currentChange(page = 1) {
  onCurrentChange(page).then(() => getDataList())
}

function searchReset() {
  search.value.status = ''
  search.value.taskType = ''
  currentChange()
}

/**
 * 创建护士任务
 */
async function onCreate() {
  if (!createForm.petId || !createForm.description) {
    useFaToast().warning('请选择宠物并填写任务描述')
    return
  }
  creating.value = true
  try {
    await apiClinical.createNurseTask({
      tenantId: tenantStore.currentTenantId || '',
      storeId: search.value.storeId || undefined,
      petId: createForm.petId,
      taskType: createForm.taskType,
      description: createForm.description,
      scheduledAt: createForm.scheduledAt || undefined,
    })
    useFaToast().success('任务已创建')
    createVisible.value = false
    createForm.petId = ''
    createForm.description = ''
    createForm.taskType = 'other'
    createForm.scheduledAt = ''
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
 * 完成任务
 */
async function onComplete(row: NurseTaskRow) {
  try {
    await apiClinical.completeNurseTask(row.id)
    useFaToast().success('任务已完成')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
}

/**
 * 跳过任务
 */
async function onSkip(row: NurseTaskRow) {
  try {
    await apiClinical.skipNurseTask(row.id)
    useFaToast().success('任务已跳过')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
}

/**
 * 打开标记失败弹窗
 */
function openFail(row: NurseTaskRow) {
  failTarget.value = row
  failReason.value = ''
  failVisible.value = true
}

/**
 * 标记任务失败(S3.1-C,须填写原因)
 */
async function onFail() {
  if (!failTarget.value) {
    return
  }
  if (!failReason.value.trim()) {
    useFaToast().warning('请填写失败原因')
    return
  }
  failing.value = true
  try {
    await apiClinical.failNurseTask(failTarget.value.id, failReason.value.trim())
    useFaToast().success('任务已标记失败')
    failVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
  finally {
    failing.value = false
  }
}

/**
 * 打开取消任务弹窗
 */
function openCancel(row: NurseTaskRow) {
  cancelTarget.value = row
  cancelReason.value = ''
  cancelVisible.value = true
}

/**
 * 取消任务(S3.1-C,仅未执行任务可取消)
 */
async function onCancel() {
  if (!cancelTarget.value) {
    return
  }
  cancelling.value = true
  try {
    await apiClinical.cancelNurseTask(cancelTarget.value.id, cancelReason.value.trim() || undefined)
    useFaToast().success('任务已取消')
    cancelVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
  finally {
    cancelling.value = false
  }
}

/**
 * 超时/即将到期扫描(S3.1-C)
 * 批量标记 overdue/due_soon,并提示统计
 */
async function onScanOverdue() {
  try {
    const res = await apiClinical.scanNurseTaskOverdue(tenantStore.currentTenantId || '', search.value.storeId || undefined)
    const data = res.data
    useFaToast().success(`扫描完成:超时 ${data?.overdueCount ?? 0} 条,即将到期 ${data?.dueSoonCount ?? 0} 条`)
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '扫描失败')
  }
}

/**
 * 删除任务
 */
function onDelete(row: NurseTaskRow) {
  useFaModal().confirm({
    title: '删除任务',
    content: `确认删除任务"${row.description}"?`,
    onConfirm: async () => {
      try {
        await apiClinical.deleteNurseTask(row.id)
        useFaToast().success('已删除')
        getDataList()
      }
      catch (e: any) {
        useFaToast().error(e?.message || '删除失败')
      }
    },
  })
}

const tableColumns = computed<TableColumn<NurseTaskRow>[]>(() => [
  {
    accessorKey: 'pet_id',
    header: '宠物 ID',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-',
  },
  {
    accessorKey: 'task_type',
    header: '类型',
    cell: (info: any) => NURSE_TASK_TYPE_LABELS[info.getValue() as keyof typeof NURSE_TASK_TYPE_LABELS] ?? info.getValue(),
  },
  { accessorKey: 'description', header: '描述' },
  {
    accessorKey: 'scheduled_at',
    header: '计划时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'assigned_to',
    header: '执行人',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '未指派',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue()
      const label = NURSE_TASK_STATUS_LABELS[v as keyof typeof NURSE_TASK_STATUS_LABELS] ?? v
      return h('span', { class: `px-2 py-0.5 rounded text-xs bg-${NURSE_TASK_STATUS_COLORS[v as NurseTaskStatus] ?? 'default'}-100` }, label)
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 200,
    align: 'center',
    fixed: 'right',
  },
])
</script>

<template>
  <div>
    <FaPageHeader title="护士任务" class="mb-0">
      <template #description>
        管理给药/观察/护理/采样等护士任务,支持状态推进(待处理→进行中→完成/跳过)
      </template>
    </FaPageHeader>
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
                  { label: '待处理', value: 'pending' },
                  { label: '进行中', value: 'in_progress' },
                  { label: '已完成', value: 'completed' },
                  { label: '已跳过', value: 'skipped' },
                  { label: '已失败', value: 'failed' },
                  { label: '已取消', value: 'cancelled' },
                ]"
                class="w-full"
                @change="currentChange()"
              />
            </FaLabel>
            <FaLabel label="类型" class="col-span-1">
              <FaSelect
                v-model="search.taskType"
                :options="[
                  { label: '全部', value: '' },
                  { label: '给药', value: 'medication' },
                  { label: '观察', value: 'observation' },
                  { label: '护理', value: 'care' },
                  { label: '采样', value: 'sample_collection' },
                  { label: '其他', value: 'other' },
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
          <FaButton @click="onScanOverdue()">
            <FaIcon name="i-ri:time-line" />
            超时扫描
          </FaButton>
          <FaButton @click="createVisible = true">
            <FaIcon name="i-ri:add-line" />
            新建任务
          </FaButton>
        </template>
        <template #cell-operation="{ row }">
          <div class="flex-center gap-1">
            <FaButton v-if="row.original.status === 'pending' || row.original.status === 'in_progress' || row.original.status === 'done'" variant="outline" size="sm" @click="onComplete(row.original)">
              完成
            </FaButton>
            <FaButton v-if="row.original.status === 'pending' || row.original.status === 'in_progress'" variant="outline" size="sm" @click="onSkip(row.original)">
              跳过
            </FaButton>
            <FaButton v-if="row.original.status === 'pending' || row.original.status === 'in_progress'" variant="outline" size="sm" @click="openFail(row.original)">
              失败
            </FaButton>
            <FaButton v-if="row.original.status === 'pending' || row.original.status === 'in_progress'" variant="outline" size="sm" @click="openCancel(row.original)">
              取消
            </FaButton>
            <FaButton variant="outline" size="icon-sm" @click="onDelete(row.original)">
              <FaIcon name="i-ri:delete-bin-line" />
            </FaButton>
          </div>
        </template>
      </FaTable>
      <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />

      <!-- 新建任务弹窗 -->
      <FaModal v-model:visible="createVisible" title="新建护士任务" :loading="creating" @confirm="onCreate">
        <div class="space-y-3">
          <FaLabel label="宠物">
            <BusinessPetPicker v-model="createForm.petId" placeholder="搜索选择宠物" />
          </FaLabel>
          <FaLabel label="任务类型">
            <FaSelect
              v-model="createForm.taskType"
              :options="[
                { label: '给药', value: 'medication' },
                { label: '观察', value: 'observation' },
                { label: '护理', value: 'care' },
                { label: '采样', value: 'sample_collection' },
                { label: '其他', value: 'other' },
              ]"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="任务描述">
            <FaInput v-model="createForm.description" placeholder="任务描述" class="w-full" />
          </FaLabel>
          <FaLabel label="计划时间">
            <FaInput v-model="createForm.scheduledAt" type="datetime-local" class="w-full" />
          </FaLabel>
        </div>
      </FaModal>

      <!-- 标记失败弹窗(S3.1-C) -->
      <FaModal v-model:visible="failVisible" title="标记任务失败" :loading="failing" @confirm="onFail">
        <div class="space-y-3">
          <FaAlert type="warning" :closable="false">
            任务"{{ failTarget?.description }}"将标记为失败,且需填写失败原因
          </FaAlert>
          <FaLabel label="失败原因" required>
            <FaInput v-model="failReason" placeholder="必填,说明失败原因" class="w-full" />
          </FaLabel>
        </div>
      </FaModal>

      <!-- 取消任务弹窗(S3.1-C) -->
      <FaModal v-model:visible="cancelVisible" title="取消任务" :loading="cancelling" @confirm="onCancel">
        <div class="space-y-3">
          <FaAlert type="warning" :closable="false">
            任务"{{ cancelTarget?.description }}"将被取消,已执行任务不可取消(永久保留)
          </FaAlert>
          <FaLabel label="取消原因">
            <FaInput v-model="cancelReason" placeholder="可选" class="w-full" />
          </FaLabel>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
