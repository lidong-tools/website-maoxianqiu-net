<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  MedicalWasteRecord,
  WasteRecordStatus,
} from '@/types/regulatory'
import apiRegulatory from '@/api/modules/regulatory'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { WASTE_STATUS_LABELS } from '@/types/regulatory'

defineOptions({
  name: 'RegulatoryMedicalWaste',
})

/** 列表展示行 */
interface DisplayRow {
  id: string
  storeName: string
  wasteType: string
  quantity: number
  unit: string
  handlerName: string
  generatedAt: string
  handoverAt: string
  status: WasteRecordStatus
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<MedicalWasteRecord[]>([])
// 复审审计(S3.1-Fix-Reaudit-v3 §6):computed 而非 ref+onMounted,切租户即时响应,不保留旧 Tenant 快照
const currentTenantId = computed(() => tenantStore.currentTenantId)
const searchStoreId = ref('')
const searchStatus = ref('')
const platformUiDeferred = computed(() => !tenantStore.currentTenantId)

/** 列表列配置 */
const tableColumns = computed<TableColumn<DisplayRow>[]>(() => [
  {
    accessorKey: 'storeName',
    header: '门店',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'wasteType',
    header: '废弃物类型',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'quantity',
    header: '数量',
    cell: (info) => {
      const row = info.row.original
      return `${info.getValue() ?? '-'}${row.unit ? ` ${row.unit}` : ''}`
    },
  },
  {
    accessorKey: 'handlerName',
    header: '经办员工',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'generatedAt',
    header: '产生时间',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'handoverAt',
    header: '交接时间',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: info => WASTE_STATUS_LABELS[info.getValue() as WasteRecordStatus] ?? '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 200,
    align: 'center',
    fixed: 'right',
  },
])

/** 行 → 展示结构 */
function toDisplayRow(row: MedicalWasteRecord): DisplayRow {
  return {
    id: row.id,
    storeName: row.stores?.name ?? '-',
    wasteType: row.waste_type,
    quantity: row.quantity,
    unit: row.unit ?? '',
    handlerName: row.employees?.name ?? '-',
    generatedAt: row.generated_at ?? '-',
    handoverAt: row.handover_at ?? '-',
    status: row.status,
  }
}

/**
 * 加载废弃物列表(浏览器直连,RLS 兜底)
 */
async function getDataList() {
  if (!currentTenantId.value) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiRegulatory.listWasteRecords(
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
const drawerTitle = ref('新增废弃物记录')
const submitting = ref(false)
const form = reactive({
  recordId: '',
  storeId: '',
  wasteType: '',
  quantity: 1 as number,
  unit: '',
  generatedAt: '',
  handlerEmployeeId: '',
  notes: '',
  attachmentFileId: '',
  status: 'draft' as 'draft' | 'recorded',
})

/** 打开新增抽屉并重置表单 */
function openCreate() {
  Object.assign(form, {
    recordId: '',
    storeId: searchStoreId.value,
    wasteType: '',
    quantity: 1,
    unit: '',
    generatedAt: '',
    handlerEmployeeId: '',
    notes: '',
    attachmentFileId: '',
    status: 'draft',
  })
  drawerTitle.value = '新增废弃物记录'
  drawerVisible.value = true
}

/** 打开编辑抽屉并回填(仅 draft/recorded 可编辑) */
function openEdit(row: DisplayRow) {
  const src = dataList.value.find(r => r.id === row.id)
  if (!src) {
    return
  }
  Object.assign(form, {
    recordId: src.id,
    storeId: src.store_id,
    wasteType: src.waste_type,
    quantity: Number(src.quantity),
    unit: src.unit ?? '',
    generatedAt: src.generated_at ?? '',
    handlerEmployeeId: src.handler_employee_id ?? '',
    notes: src.notes ?? '',
    attachmentFileId: src.attachment_file_id ?? '',
    status: src.status === 'recorded' ? 'recorded' : 'draft',
  })
  drawerTitle.value = '维护废弃物记录'
  drawerVisible.value = true
}

/** datetime-local 值 → ISO 带偏移(datetime 校验需要 offset) */
function toIso(dt: string): string | undefined {
  if (!dt) {
    return undefined
  }
  const date = new Date(dt)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * 保存废弃物记录(走 Hono Command,权限 waste.manage)
 */
async function onSubmit() {
  if (!form.storeId) {
    useFaToast().warning('请选择门店')
    return
  }
  if (!form.wasteType.trim()) {
    useFaToast().warning('请填写废弃物类型')
    return
  }
  if (form.quantity < 0) {
    useFaToast().warning('数量不能为负数')
    return
  }
  if (submitting.value) {
    return
  }
  submitting.value = true
  try {
    await apiRegulatory.saveWasteRecord({
      storeId: form.storeId,
      recordId: form.recordId || undefined,
      wasteType: form.wasteType.trim(),
      quantity: form.quantity,
      unit: form.unit || undefined,
      generatedAt: toIso(form.generatedAt),
      handlerEmployeeId: form.handlerEmployeeId || undefined,
      notes: form.notes || undefined,
      attachmentFileId: form.attachmentFileId || undefined,
      status: form.status,
    })
    drawerVisible.value = false
    useFaToast().success('废弃物记录已保存')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '保存失败')
  }
  finally {
    submitting.value = false
  }
}

/** 交接抽屉表单 */
const handoverVisible = ref(false)
const handoverRow = ref<DisplayRow | null>(null)
const handoverSubmitting = ref(false)
const handoverForm = reactive({
  handlerEmployeeId: '',
  receiver: '',
  disposalMethod: '',
  handoverAt: '',
})

/** 打开交接抽屉并预填经办员工 */
function openHandover(row: DisplayRow) {
  const src = dataList.value.find(r => r.id === row.id)
  handoverRow.value = row
  Object.assign(handoverForm, {
    handlerEmployeeId: src?.handler_employee_id ?? '',
    receiver: '',
    disposalMethod: '',
    handoverAt: '',
  })
  handoverVisible.value = true
}

/**
 * 提交交接(走 Hono Command,权限 waste.manage;交接后不可修改)
 */
async function onSubmitHandover() {
  if (!handoverForm.receiver.trim()) {
    useFaToast().warning('请填写接收方')
    return
  }
  if (handoverSubmitting.value || !handoverRow.value) {
    return
  }
  handoverSubmitting.value = true
  try {
    await apiRegulatory.handoverWaste(handoverRow.value.id, {
      handlerEmployeeId: handoverForm.handlerEmployeeId || undefined,
      receiver: handoverForm.receiver.trim(),
      disposalMethod: handoverForm.disposalMethod || undefined,
      handoverAt: toIso(handoverForm.handoverAt),
    })
    handoverVisible.value = false
    useFaToast().success('交接完成,记录已锁定')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '交接失败')
  }
  finally {
    handoverSubmitting.value = false
  }
}

/** 附件上传回调(FileUploader uploaded 事件) */
function onAttachmentUploaded(payload: { fileId: string }) {
  form.attachmentFileId = payload.fileId
}

// 复审审计 §6:切租户时重置门店筛选并重载,避免残留旧租户数据
watch(currentTenantId, () => {
  searchStoreId.value = ''
  getDataList()
})

onMounted(() => {
  // 审计 S3.1 P0-03:统一使用全局 Tenant Store 上下文,不再自行从 memberships 推导当前租户
  getDataList()
})
</script>

<template>
  <!-- 标准布局:外层固定高度容器,撑满视口 -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域 -->
    <!--
    <EntityPageHeader compact title="医疗废弃物台账" description="记录医疗废弃物产生/交接全程(交接后锁定不可修改),满足《医疗废物管理条例》台账要求" />
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <!-- 无租户上下文警告条 -->
      <div
        v-if="platformUiDeferred"
        class="text-sm text-amber-700 px-4 py-3 border border-amber-200 rounded-md bg-amber-50 shrink-0"
      >
        当前账号无租户成员关系,无法确定租户上下文。平台管理员跨租户维护废弃物台账的界面将在后续版本提供。
      </div>
      <!-- 主内容白底卡片 -->
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 卡片顶部筛选区:筛选控件左、功能按钮右 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 flex flex-wrap gap-3 items-center">
            <BusinessStorePicker v-model="searchStoreId" placeholder="选择门店(可选)" class="w-56" />
            <FaSelect
              v-model="searchStatus"
              :options="[
                { label: '全部状态', value: '' },
                { label: '草稿', value: 'draft' },
                { label: '已记录', value: 'recorded' },
                { label: '已交接', value: 'handed_over' },
              ]"
              class="w-36"
            />
            <FaButton variant="outline" @click="getDataList">
              查询
            </FaButton>
            <div class="ml-auto flex gap-2 items-center">
              <PermissionButton permission="waste.manage" @click="openCreate">
                新增记录
              </PermissionButton>
            </div>
          </div>
        </div>
        <!-- 中部表格区 -->
        <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="tableColumns"
            :data="dataList.map(toDisplayRow)"
          >
            <template #cell-operation="{ row }">
          <PermissionButton
            v-if="['draft', 'recorded'].includes(row.original.status)"
            permission="waste.manage"
            size="sm"
            variant="outline"
            class="mr-1"
            @click="openEdit(row.original)"
          >
            维护
          </PermissionButton>
          <PermissionButton
            v-if="['draft', 'recorded'].includes(row.original.status)"
            permission="waste.manage"
            size="sm"
            variant="outline"
            @click="openHandover(row.original)"
          >
            交接
          </PermissionButton>
          </template>
          </FaTable>
        </div>
      </div>
    </div>

    <FaDrawer v-model="drawerVisible" :title="drawerTitle" :width="620">
      <div class="space-y-3">
        <FaLabel label="门店">
          <BusinessStorePicker v-model="form.storeId" class="w-full" />
        </FaLabel>
        <FaLabel label="废弃物类型">
          <FaInput v-model="form.wasteType" placeholder="如:感染性废物/损伤性废物" class="w-full" />
        </FaLabel>
        <div class="gap-3 grid grid-cols-2">
          <FaLabel label="数量">
            <FaInput v-model="form.quantity" type="number" :min="0" class="w-full" />
          </FaLabel>
          <FaLabel label="单位">
            <FaInput v-model="form.unit" placeholder="如:kg / 袋(可选)" class="w-full" />
          </FaLabel>
        </div>
        <div class="gap-3 grid grid-cols-2">
          <FaLabel label="产生时间">
            <FaInput v-model="form.generatedAt" type="datetime-local" class="w-full" />
          </FaLabel>
          <FaLabel label="经办员工">
            <BusinessEmployeePicker v-model="form.handlerEmployeeId" class="w-full" />
          </FaLabel>
        </div>
        <FaLabel label="记录状态">
          <FaSelect
            v-model="form.status"
            :options="[
              { label: '草稿', value: 'draft' },
              { label: '已记录', value: 'recorded' },
            ]"
            class="w-full"
          />
        </FaLabel>
        <FaLabel label="交接凭证(可选)">
          <!-- S31-MERGE-B B03:显式传入页面租户/门店,避免 FileUploader 读取 localStorage 残留上下文 -->
          <BusinessFileUploader
            :tenant-id="currentTenantId"
            :store-id="form.storeId"
            category="general"
            max="1"
            description="上传交接单/称重单等凭证"
            @uploaded="onAttachmentUploaded"
          />
        </FaLabel>
        <FaLabel label="备注">
          <FaTextarea v-model="form.notes" placeholder="补充说明(可选)" class="w-full" />
        </FaLabel>
        <div class="text-xs text-muted-foreground">
          交接请使用列表中的「交接」动作,交接后记录将锁定,不可再修改。
        </div>
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

    <FaDrawer v-model="handoverVisible" title="废弃物交接" :width="520">
      <div v-if="handoverRow" class="space-y-3">
        <FaDescriptions
          :items="[
            { label: '废弃物类型', value: handoverRow.wasteType },
            { label: '数量', value: `${handoverRow.quantity}${handoverRow.unit ? ` ${handoverRow.unit}` : ''}` },
          ]"
        />
        <FaDivider />
        <FaLabel label="交接员工">
          <BusinessEmployeePicker v-model="handoverForm.handlerEmployeeId" class="w-full" />
        </FaLabel>
        <FaLabel label="接收方">
          <FaInput v-model="handoverForm.receiver" placeholder="接收单位/人员(必填)" class="w-full" />
        </FaLabel>
        <FaLabel label="处置方式">
          <FaInput v-model="handoverForm.disposalMethod" placeholder="如:集中焚烧(可选)" class="w-full" />
        </FaLabel>
        <FaLabel label="交接时间">
          <FaInput v-model="handoverForm.handoverAt" type="datetime-local" class="w-full" />
        </FaLabel>
        <div class="text-xs text-muted-foreground">
          交接后状态将置为「已交接」,记录锁定不可修改,并写入 waste.handover 审计。
        </div>
      </div>
      <template #footer>
        <div class="flex gap-2 justify-end">
          <FaButton variant="outline" @click="handoverVisible = false">
            取消
          </FaButton>
          <FaButton type="primary" :loading="handoverSubmitting" @click="onSubmitHandover">
            确认交接
          </FaButton>
        </div>
      </template>
    </FaDrawer>
  </div>
</template>
