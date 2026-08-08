<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  EpidemicEventRecord,
  EpidemicEventStatus,
} from '@/types/regulatory'
import apiApp from '@/api/modules/app'
import apiRegulatory from '@/api/modules/regulatory'
import { EPIDEMIC_STATUS_LABELS } from '@/types/regulatory'

defineOptions({
  name: 'RegulatoryEpidemic',
})

/** 列表展示行 */
interface DisplayRow {
  id: string
  storeName: string
  petName: string
  customerName: string
  suspectedDisease: string
  detectedAt: string
  reportedAt: string
  isolated: boolean
  treatmentRestricted: boolean
  status: EpidemicEventStatus
}

const loading = ref(false)
const dataList = ref<EpidemicEventRecord[]>([])
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
    accessorKey: 'petName',
    header: '宠物',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'customerName',
    header: '客户',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'suspectedDisease',
    header: '疑似疫病',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'detectedAt',
    header: '发现时间',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'reportedAt',
    header: '上报时间',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'isolated',
    header: '隔离',
    cell: info => (info.getValue() ? '是' : '否'),
  },
  {
    accessorKey: 'treatmentRestricted',
    header: '限制治疗',
    cell: info => (info.getValue() ? '是' : '否'),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: info => EPIDEMIC_STATUS_LABELS[info.getValue() as EpidemicEventStatus] ?? '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 240,
    align: 'center',
    fixed: 'right',
  },
])

/** 行 → 展示结构 */
function toDisplayRow(row: EpidemicEventRecord): DisplayRow {
  return {
    id: row.id,
    storeName: row.stores?.name ?? '-',
    petName: row.pets?.name ?? '-',
    customerName: row.customers?.name ?? '-',
    suspectedDisease: row.suspected_disease,
    detectedAt: row.detected_at ?? '-',
    reportedAt: row.reported_at ?? '-',
    isolated: row.isolation_required,
    treatmentRestricted: row.treatment_restricted,
    status: row.status,
  }
}

/**
 * 加载疫情事件列表(浏览器直连,RLS 兜底)
 */
async function getDataList() {
  if (!currentTenantId.value) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiRegulatory.listEpidemicEvents(
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
const drawerTitle = ref('上报疫情事件')
const submitting = ref(false)
const form = reactive({
  eventId: '',
  storeId: '',
  customerId: '',
  petId: '',
  encounterId: '',
  suspectedDisease: '',
  detectedAt: '',
  isolationRequired: false,
  treatmentRestricted: false,
  restrictionReason: '',
  cullingRequired: false,
  notes: '',
  status: 'detected' as 'detected' | 'reported',
})

/** 打开新增抽屉并重置表单 */
function openCreate() {
  Object.assign(form, {
    eventId: '',
    storeId: searchStoreId.value,
    customerId: '',
    petId: '',
    encounterId: '',
    suspectedDisease: '',
    detectedAt: '',
    isolationRequired: false,
    treatmentRestricted: false,
    restrictionReason: '',
    cullingRequired: false,
    notes: '',
    status: 'detected',
  })
  drawerTitle.value = '上报疫情事件'
  drawerVisible.value = true
}

/** 打开编辑抽屉并回填(仅 detected/reported 可编辑) */
function openEdit(row: DisplayRow) {
  const src = dataList.value.find(r => r.id === row.id)
  if (!src) {
    return
  }
  Object.assign(form, {
    eventId: src.id,
    storeId: src.store_id,
    customerId: src.customer_id ?? '',
    petId: src.pet_id ?? '',
    encounterId: src.encounter_id ?? '',
    suspectedDisease: src.suspected_disease,
    detectedAt: src.detected_at ?? '',
    isolationRequired: src.isolation_required,
    treatmentRestricted: src.treatment_restricted,
    restrictionReason: src.restriction_reason ?? '',
    cullingRequired: !!src.culling_required,
    notes: src.notes ?? '',
    status: src.status === 'reported' ? 'reported' : 'detected',
  })
  drawerTitle.value = '维护疫情事件'
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
 * 上报/维护疫情事件(走 Hono Command,权限 epidemic.report)
 * 系统只负责记录,是否隔离/限制治疗由授权用户明确填写
 */
async function onSubmit() {
  if (!form.storeId) {
    useFaToast().warning('请选择门店')
    return
  }
  if (!form.suspectedDisease.trim()) {
    useFaToast().warning('请填写疑似疫病')
    return
  }
  if (submitting.value) {
    return
  }
  submitting.value = true
  try {
    await apiRegulatory.saveEpidemicEvent({
      storeId: form.storeId,
      eventId: form.eventId || undefined,
      customerId: form.customerId || undefined,
      petId: form.petId || undefined,
      encounterId: form.encounterId || undefined,
      suspectedDisease: form.suspectedDisease.trim(),
      detectedAt: toIso(form.detectedAt),
      isolationRequired: form.isolationRequired,
      treatmentRestricted: form.treatmentRestricted,
      restrictionReason: form.restrictionReason || undefined,
      cullingRequired: form.cullingRequired,
      notes: form.notes || undefined,
      status: form.status,
    })
    drawerVisible.value = false
    useFaToast().success(form.eventId ? '事件已更新' : '疫情事件已上报')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '保存失败')
  }
  finally {
    submitting.value = false
  }
}

/**
 * 执行隔离(走 Hono Command,权限 epidemic.report)
 */
async function onIsolate(row: DisplayRow) {
  useFaModal().confirm({
    title: '确认隔离',
    content: `确认对事件「${row.suspectedDisease}」执行隔离吗?`,
    onConfirm: async () => {
      try {
        await apiRegulatory.isolateEpidemicEvent(row.id)
        useFaToast().success('事件已隔离')
        getDataList()
      }
      catch (e: any) {
        useFaToast().error(e?.message || '隔离失败')
      }
    },
  })
}

/**
 * 解除疫情事件(走 Hono Command,权限 epidemic.resolve)
 */
async function onResolve(row: DisplayRow) {
  useFaModal().confirm({
    title: '确认解除',
    content: `确认解除事件「${row.suspectedDisease}」吗?`,
    onConfirm: async () => {
      try {
        await apiRegulatory.resolveEpidemicEvent(row.id)
        useFaToast().success('事件已解除')
        getDataList()
      }
      catch (e: any) {
        useFaToast().error(e?.message || '解除失败')
      }
    },
  })
}

onMounted(async () => {
  // 租户上下文来源与现有页面一致:普通租户用户取 memberships[0].tenant_id
  const res: any = await apiApp.profile()
  const memberships = res.data.memberships ?? []
  currentTenantId.value = memberships[0]?.tenant_id ?? ''
  platformUiDeferred.value = !currentTenantId.value
  getDataList()
})
</script>

<template>
  <div>
    <EntityPageHeader compact title="疫情事件台账" description="记录疑似疫病事件(系统只负责记录,不替医生自动诊断);支持隔离/解除状态流转,全程留痕" />
    <FaPageMain>
      <div
        v-if="platformUiDeferred"
        class="text-sm text-amber-700 mb-3 px-4 py-3 border border-amber-200 rounded-md bg-amber-50"
      >
        当前账号无租户成员关系,无法确定租户上下文。平台管理员跨租户维护疫情事件的界面将在后续版本提供。
      </div>
      <div class="mb-3 flex flex-wrap gap-2 items-center">
        <BusinessStorePicker v-model="searchStoreId" placeholder="选择门店(可选)" class="w-56" />
        <FaSelect
          v-model="searchStatus"
          :options="[
            { label: '全部状态', value: '' },
            { label: '已发现', value: 'detected' },
            { label: '已上报', value: 'reported' },
            { label: '已隔离', value: 'isolated' },
            { label: '已解除', value: 'resolved' },
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
          <PermissionButton permission="epidemic.report" @click="openCreate">
            上报事件
          </PermissionButton>
        </template>
        <template #cell-operation="{ row }">
          <PermissionButton
            v-if="['detected', 'reported'].includes(row.original.status)"
            permission="epidemic.report"
            size="sm"
            variant="outline"
            class="mr-1"
            @click="openEdit(row.original)"
          >
            维护
          </PermissionButton>
          <PermissionButton
            v-if="['detected', 'reported'].includes(row.original.status)"
            permission="epidemic.report"
            size="sm"
            variant="outline"
            class="mr-1"
            @click="onIsolate(row.original)"
          >
            隔离
          </PermissionButton>
          <PermissionButton
            v-if="['detected', 'reported', 'isolated'].includes(row.original.status)"
            permission="epidemic.resolve"
            size="sm"
            variant="outline"
            @click="onResolve(row.original)"
          >
            解除
          </PermissionButton>
        </template>
      </FaTable>
    </FaPageMain>

    <FaDrawer v-model="drawerVisible" :title="drawerTitle" :width="620">
      <div class="space-y-3">
        <FaLabel label="门店">
          <BusinessStorePicker v-model="form.storeId" class="w-full" />
        </FaLabel>
        <div class="gap-3 grid grid-cols-2">
          <FaLabel label="客户(可选)">
            <BusinessCustomerPicker v-model="form.customerId" class="w-full" />
          </FaLabel>
          <FaLabel label="宠物(可选)">
            <BusinessPetPicker v-model="form.petId" :customer-id="form.customerId || undefined" class="w-full" />
          </FaLabel>
        </div>
        <FaLabel label="关联就诊(可选)">
          <BusinessEncounterPicker v-model="form.encounterId" :pet-id="form.petId || undefined" class="w-full" />
        </FaLabel>
        <FaLabel label="疑似疫病">
          <FaInput v-model="form.suspectedDisease" placeholder="如:犬瘟热" class="w-full" />
        </FaLabel>
        <div class="gap-3 grid grid-cols-2">
          <FaLabel label="发现时间">
            <FaInput v-model="form.detectedAt" type="datetime-local" class="w-full" />
          </FaLabel>
          <FaLabel label="上报状态">
            <FaSelect
              v-model="form.status"
              :options="[
                { label: '已发现', value: 'detected' },
                { label: '已上报', value: 'reported' },
              ]"
              class="w-full"
            />
          </FaLabel>
        </div>
        <div class="gap-3 grid grid-cols-2">
          <FaLabel label="需要隔离">
            <FaSwitch v-model="form.isolationRequired" />
          </FaLabel>
          <FaLabel label="限制治疗">
            <FaSwitch v-model="form.treatmentRestricted" />
          </FaLabel>
        </div>
        <FaLabel v-if="form.treatmentRestricted" label="限制原因">
          <FaInput v-model="form.restrictionReason" placeholder="限制治疗的原因(可选)" class="w-full" />
        </FaLabel>
        <FaLabel label="建议扑杀">
          <FaSwitch v-model="form.cullingRequired" />
        </FaLabel>
        <FaLabel label="备注">
          <FaTextarea v-model="form.notes" placeholder="补充说明(可选)" class="w-full" />
        </FaLabel>
        <div class="text-xs text-muted-foreground">
          隔离/解除请使用列表中的专属动作,系统会记录隔离/解除时间与操作人。
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
  </div>
</template>
