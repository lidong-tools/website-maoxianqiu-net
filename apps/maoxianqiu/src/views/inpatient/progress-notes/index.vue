<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { ProgressNoteStatus, ProgressNoteType } from '@/types/inpatient'
import apiInpatient from '@/api/modules/inpatient'
import apiStore from '@/api/modules/store'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { PROGRESS_NOTE_STATUS_COLORS, PROGRESS_NOTE_STATUS_LABELS, PROGRESS_NOTE_TYPE_LABELS } from '@/types/inpatient'

defineOptions({
  name: 'InpatientProgressNotes',
})

interface ProgressNoteRow {
  id: string
  admission_id: string
  pet_id: string
  note_no: string
  note_type: ProgressNoteType
  content: string
  status: ProgressNoteStatus
  recorded_at: string
  recorded_by: string | null
  signed_at: string | null
  signed_by: string | null
  store_id: string | null
}

const tenantStore = useAppTenantStore()
const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const loading = ref(false)
const dataList = ref<ProgressNoteRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  storeId: '',
  status: '',
  noteType: '',
})

/** 记录病程弹窗 */
const createVisible = ref(false)
const admissionOptions = ref<Array<{ label: string, value: string }>>([])
const createForm = reactive({
  admissionId: '',
  content: '',
  noteType: 'daily' as ProgressNoteType,
  recordedAt: '',
})
const creating = ref(false)

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
 * 加载住院中(admitted)的入院记录,供选择
 */
async function loadAdmissionOptions() {
  try {
    const res: any = await apiInpatient.listAdmissions(search.value.storeId || undefined, 'admitted')
    admissionOptions.value = (res.data.list ?? []).map((a: any) => ({
      label: `${a.id?.slice(0, 8) ?? '-'} (${a.pet_id?.slice(0, 8) ?? '-'})`,
      value: a.id,
    }))
  }
  catch {
    admissionOptions.value = []
  }
}

/**
 * 获取病程记录列表(S3.1-C,走 Hono Command)
 */
function getDataList() {
  loading.value = true
  apiInpatient.listProgressNotes({
    storeId: search.value.storeId || undefined,
    status: (search.value.status as ProgressNoteStatus) || undefined,
    noteType: (search.value.noteType as ProgressNoteType) || undefined,
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
  search.value.noteType = ''
  currentChange()
}

/**
 * 打开记录病程弹窗并加载住院记录
 */
function openCreate() {
  createForm.admissionId = ''
  createForm.content = ''
  createForm.noteType = 'daily'
  createForm.recordedAt = ''
  createVisible.value = true
  loadAdmissionOptions()
}

/**
 * 记录病程(S3.1-C,走 create_progress_note RPC,状态初始 draft)
 */
async function onCreate() {
  if (!createForm.admissionId || !createForm.content.trim()) {
    useFaToast().warning('请选择住院记录并填写病程内容')
    return
  }
  creating.value = true
  try {
    const res: any = await apiInpatient.createProgressNote({
      admissionId: createForm.admissionId,
      content: createForm.content.trim(),
      noteType: createForm.noteType,
      recordedAt: createForm.recordedAt || undefined,
    })
    useFaToast().success(`病程已记录(${res.data?.noteNo ?? ''})`)
    createVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '记录失败')
  }
  finally {
    creating.value = false
  }
}

/**
 * 签署病程(S3.1-C,draft→signed 终态,签署后内容不可再改)
 */
async function onSign(row: ProgressNoteRow) {
  try {
    await apiInpatient.signProgressNote(row.id)
    useFaToast().success('病程已签署')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '签署失败')
  }
}

const tableColumns = computed<TableColumn<ProgressNoteRow>[]>(() => [
  { accessorKey: 'note_no', header: '病程编号' },
  {
    accessorKey: 'note_type',
    header: '类型',
    cell: (info: any) => PROGRESS_NOTE_TYPE_LABELS[info.getValue() as keyof typeof PROGRESS_NOTE_TYPE_LABELS] ?? info.getValue(),
  },
  {
    accessorKey: 'admission_id',
    header: '住院记录',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-',
  },
  {
    accessorKey: 'content',
    header: '内容',
    ellipsis: true,
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'recorded_at',
    header: '记录时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue()
      const label = PROGRESS_NOTE_STATUS_LABELS[v as keyof typeof PROGRESS_NOTE_STATUS_LABELS] ?? v
      return h('span', { class: `px-2 py-0.5 rounded text-xs bg-${PROGRESS_NOTE_STATUS_COLORS[v as ProgressNoteStatus] ?? 'default'}-100` }, label)
    },
  },
  {
    accessorKey: 'signed_at',
    header: '签署时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 100,
    align: 'center',
    fixed: 'right',
  },
])
</script>

<template>
  <div>
    <EntityPageHeader compact title="病程记录" description="日常/危重/术前/术后/出院病程 · draft→signed 终态" />
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
                  { label: '草稿', value: 'draft' },
                  { label: '已签署', value: 'signed' },
                ]"
                class="w-full"
                @change="currentChange()"
              />
            </FaLabel>
            <FaLabel label="类型" class="col-span-1">
              <FaSelect
                v-model="search.noteType"
                :options="[
                  { label: '全部', value: '' },
                  { label: '日常病程', value: 'daily' },
                  { label: '危重病程', value: 'critical' },
                  { label: '术前病程', value: 'preop' },
                  { label: '术后病程', value: 'postop' },
                  { label: '出院病程', value: 'discharge' },
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
            记录病程
          </FaButton>
        </template>
        <template #cell-operation="{ row }">
          <div class="flex-center gap-1">
            <FaButton v-if="row.original.status === 'draft'" variant="outline" size="sm" @click="onSign(row.original)">
              签署
            </FaButton>
          </div>
        </template>
      </FaTable>
      <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />

      <!-- 记录病程弹窗 -->
      <FaModal v-model:visible="createVisible" title="记录病程" :loading="creating" @confirm="onCreate">
        <div class="space-y-3">
          <FaLabel label="住院记录" required>
            <FaSelect v-model="createForm.admissionId" :options="admissionOptions" class="w-full" placeholder="选择住院中的记录" />
          </FaLabel>
          <FaLabel label="病程类型">
            <FaSelect
              v-model="createForm.noteType"
              :options="[
                { label: '日常病程', value: 'daily' },
                { label: '危重病程', value: 'critical' },
                { label: '术前病程', value: 'preop' },
                { label: '术后病程', value: 'postop' },
                { label: '出院病程', value: 'discharge' },
              ]"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="病程内容" required>
            <FaInput v-model="createForm.content" type="textarea" :rows="4" placeholder="记录病情变化、处置措施等" class="w-full" />
          </FaLabel>
          <FaLabel label="记录时间">
            <FaInput v-model="createForm.recordedAt" type="datetime-local" class="w-full" />
          </FaLabel>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
