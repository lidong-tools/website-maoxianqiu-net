<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { NurseTaskStatus, NurseTaskType } from '@/types/clinical'
import type { PetRecord } from '@/types/customer'
import apiClinical from '@/api/modules/clinical'
import apiStore from '@/api/modules/store'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import BusinessPetPicker from '@/components/business/PetPicker/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { NURSE_TASK_STATUS_LABELS, NURSE_TASK_TYPE_LABELS } from '@/types/clinical'

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
const statsList = ref<NurseTaskRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  storeId: '',
  status: '',
  taskType: '',
})
const activeTab = ref('all')

const petMap = ref<Record<string, PetRecord>>({})

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

const TABS = [
  { label: '全部', value: 'all' },
  { label: '待处理', value: 'pending' },
  { label: '进行中', value: 'in_progress' },
  { label: '已完成', value: 'completed' },
  { label: '已取消', value: 'cancelled' },
  { label: '已失败', value: 'failed' },
]

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

async function enrich(rows: NurseTaskRow[]) {
  const petIds = [...new Set(rows.map(r => r.pet_id).filter(Boolean))]
  if (petIds.length) {
    const { data } = await supabase.from('pets').select('*').in('id', petIds)
    data?.forEach((p) => { petMap.value[p.id] = p as PetRecord })
  }
}

function getDataList() {
  loading.value = true
  const status = activeTab.value === 'all' ? undefined : (activeTab.value as NurseTaskStatus)
  apiClinical.listNurseTasks({
    storeId: search.value.storeId || undefined,
    status,
    taskType: (search.value.taskType as NurseTaskType) || undefined,
    ...getParams(),
  }).then(async (res: any) => {
    loading.value = false
    dataList.value = res.data.list ?? []
    pagination.value.total = res.data.total
    await enrich(dataList.value)
  }).catch(() => {
    loading.value = false
  })
}

/** 统计:加载一次全量用于顶部计数 */
async function loadStats() {
  try {
    const res: any = await apiClinical.listNurseTasks({
      storeId: search.value.storeId || undefined,
      page: 1,
      pageSize: 500,
    })
    statsList.value = res.data.list ?? []
    await enrich(statsList.value)
  }
  catch {
    statsList.value = []
  }
}

const overdueCount = computed(() => statsList.value.filter(r => r.scheduled_at && new Date(r.scheduled_at).getTime() < Date.now() && ['pending', 'in_progress'].includes(r.status)).length)
const activeCount = computed(() => statsList.value.filter(r => ['pending', 'in_progress', 'done'].includes(r.status)).length)
const completedCount = computed(() => statsList.value.filter(r => r.status === 'completed').length)

// P0-06:切店后重置分页与门店筛选并重载列表/统计
useStoreScopedPage({
  load: () => {
    getDataList()
    loadStats()
  },
  reset: () => {
    search.value.storeId = tenantStore.currentStoreId
    onCurrentChange(1)
  },
})

onMounted(async () => {
  await loadStoreOptions()
  if (tenantStore.currentStoreId) {
    search.value.storeId = tenantStore.currentStoreId
  }
  getDataList()
  loadStats()
})

function onTabChange(val: string | number) {
  activeTab.value = String(val)
  onCurrentChange(1).then(() => getDataList())
}

function sizeChange(size: number) {
  onSizeChange(size).then(() => getDataList())
}

function currentChange(page = 1) {
  onCurrentChange(page).then(() => getDataList())
}

function searchReset() {
  search.value.taskType = ''
  currentChange()
}

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
    loadStats()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '创建失败')
  }
  finally {
    creating.value = false
  }
}

async function onComplete(row: NurseTaskRow) {
  try {
    await apiClinical.completeNurseTask(row.id)
    useFaToast().success('任务已完成')
    getDataList()
    loadStats()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
}

async function onSkip(row: NurseTaskRow) {
  try {
    await apiClinical.skipNurseTask(row.id)
    useFaToast().success('任务已跳过')
    getDataList()
    loadStats()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
}

function openFail(row: NurseTaskRow) {
  failTarget.value = row
  failReason.value = ''
  failVisible.value = true
}

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
    loadStats()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
  finally {
    failing.value = false
  }
}

function openCancel(row: NurseTaskRow) {
  cancelTarget.value = row
  cancelReason.value = ''
  cancelVisible.value = true
}

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
    loadStats()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
  finally {
    cancelling.value = false
  }
}

async function onScanOverdue() {
  try {
    const res = await apiClinical.scanNurseTaskOverdue(tenantStore.currentTenantId || '', search.value.storeId || undefined)
    const data = res.data
    useFaToast().success(`扫描完成:超时 ${data?.overdueCount ?? 0} 条,即将到期 ${data?.dueSoonCount ?? 0} 条`)
    getDataList()
    loadStats()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '扫描失败')
  }
}

function onDelete(row: NurseTaskRow) {
  useFaModal().confirm({
    title: '删除任务',
    content: `确认删除任务"${row.description}"?`,
    onConfirm: async () => {
      try {
        await apiClinical.deleteNurseTask(row.id)
        useFaToast().success('已删除')
        getDataList()
        loadStats()
      }
      catch (e: any) {
        useFaToast().error(e?.message || '删除失败')
      }
    },
  })
}

function moreFor(row: NurseTaskRow) {
  const items: any[] = []
  if (['pending', 'in_progress'].includes(row.status)) {
    items.push({ label: '跳过', onClick: () => onSkip(row) })
    items.push({ label: '标记失败', onClick: () => openFail(row) })
    items.push({ label: '取消', onClick: () => openCancel(row) })
  }
  items.push({ label: '删除', destructive: true, onClick: () => onDelete(row) })
  return items
}

const tableColumns = computed<TableColumn<NurseTaskRow>[]>(() => [
  {
    accessorKey: 'scheduled_at',
    header: '计划时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '立即执行',
  },
  {
    id: 'pet',
    header: '宠物',
    cell: (info: any) => petMap.value[info.row.original.pet_id]?.name ?? (info.row.original.pet_id?.slice(0, 8) ?? '-'),
  },
  {
    accessorKey: 'task_type',
    header: '类型',
    cell: (info: any) => NURSE_TASK_TYPE_LABELS[info.getValue() as keyof typeof NURSE_TASK_TYPE_LABELS] ?? info.getValue(),
  },
  { accessorKey: 'description', header: '描述' },
  {
    accessorKey: 'assigned_to',
    header: '执行人',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '未指派',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as NurseTaskStatus
      return h(EntityStatusTag, { label: NURSE_TASK_STATUS_LABELS[v] ?? v, variant: v === 'failed' ? 'danger' : v === 'completed' ? 'success' : v === 'cancelled' ? 'neutral' : v === 'in_progress' ? 'info' : 'warning', dot: true })
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 180,
    align: 'right',
    fixed: 'right',
  },
])
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告) -->
    <!--
    <EntityPageHeader compact title="护士任务" description="按时间工作 · 完成/跳过/失败统一处理">
      <template #actions>
        <FaButton size="sm" variant="outline" @click="onScanOverdue()">
          <FaIcon name="i-lucide:clock" />
          超时扫描
        </FaButton>
        <FaButton size="sm" @click="createVisible = true">
          <FaIcon name="i-lucide:plus" />
          新建任务
        </FaButton>
      </template>
    </EntityPageHeader>
    -->

    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <!-- 顶部统计 -->
      <div class="shrink-0 gap-4 grid grid-cols-3">
        <div class="p-3 border border-amber-200 rounded-lg bg-amber-50">
          <div class="text-2xl text-amber-600 font-semibold tabular-nums">
            {{ overdueCount }}
          </div>
          <div class="text-xs text-amber-600/70 font-medium">
            逾期
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ activeCount }}
          </div>
          <div class="text-xs text-muted-foreground">
            待执行
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ completedCount }}
          </div>
          <div class="text-xs text-muted-foreground">
            已完成
          </div>
        </div>
      </div>

      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 工具栏:Tabs + 左筛选右功能按钮 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <FaTabs v-model="activeTab" :list="TABS" class="mb-2" @update:model-value="onTabChange" />
          <div class="pb-3 flex flex-wrap gap-2 items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaSelect v-model="search.storeId" :options="storeOptions" class="w-36" @change="currentChange()" />
              <FaSelect
                v-model="search.taskType"
                :options="[
                  { label: '全部类型', value: '' },
                  { label: '给药', value: 'medication' },
                  { label: '观察', value: 'observation' },
                  { label: '护理', value: 'care' },
                  { label: '采样', value: 'sample_collection' },
                  { label: '其他', value: 'other' },
                ]"
                class="w-32"
                @change="currentChange()"
              />
              <FaButton size="sm" variant="outline" @click="searchReset">
                重置
              </FaButton>
              <span class="text-sm text-muted-foreground">共 {{ pagination.total }} 条</span>
            </div>
            <div class="flex gap-2 items-center">
              <FaButton size="sm" variant="outline" @click="onScanOverdue()">
                <FaIcon name="i-lucide:clock" />
                超时扫描
              </FaButton>
              <FaButton size="sm" @click="createVisible = true">
                <FaIcon name="i-lucide:plus" />
                新建任务
              </FaButton>
            </div>
          </div>
        </div>

        <div v-loading="loading" class="flex-1 min-h-0 overflow-auto">
          <FaTable
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="tableColumns"
            :data="dataList"
          >
            <template #cell-operation="{ row }">
              <TablePrimaryAction
                :primary-label="['pending', 'in_progress', 'done'].includes(row.original.status) ? '完成' : undefined"
                primary-icon="i-lucide:check"
                :more="moreFor(row.original)"
                @primary="onComplete(row.original)"
              />
            </template>
          </FaTable>
        </div>
        <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2 px-4 pb-3 shrink-0" @page-change="currentChange" @size-change="sizeChange" />
      </div>
    </div>

    <!-- 新建任务弹窗 -->
    <FaModal v-model="createVisible" title="新建护士任务" :loading="creating" @confirm="onCreate">
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
    <FaModal v-model="failVisible" title="标记任务失败" :loading="failing" @confirm="onFail">
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
    <FaModal v-model="cancelVisible" title="取消任务" :loading="cancelling" @confirm="onCancel">
      <div class="space-y-3">
        <FaAlert type="warning" :closable="false">
          任务"{{ cancelTarget?.description }}"将被取消,已执行任务不可取消(永久保留)
        </FaAlert>
        <FaLabel label="取消原因">
          <FaInput v-model="cancelReason" placeholder="可选" class="w-full" />
        </FaLabel>
      </div>
    </FaModal>
  </div>
</template>
