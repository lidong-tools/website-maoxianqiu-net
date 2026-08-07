<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { CriticalValueAlert, LabOrderAnalyte, LabOrderRecord, LabSpecimen } from '@/types/diagnostics'
import apiDiagnostics from '@/api/modules/diagnostics'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { LAB_ORDER_STATUS_COLORS, LAB_ORDER_STATUS_LABELS } from '@/types/diagnostics'

defineOptions({
  name: 'DiagnosticsLab',
})

interface LabOrderRow {
  id: string
  order_no: string
  pet_id: string
  customer_id: string
  status: LabOrderRecord['status']
  requested_at: string
  collected_at: string | null
  completed_at: string | null
  remark: string | null
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const submitting = ref(false)
const dataList = ref<LabOrderRow[]>([])
const criticalAlerts = ref<CriticalValueAlert[]>([])

/** 当前选中行(展开详情/录入结果) */
const selectedOrder = ref<LabOrderRow | null>(null)
/** 详情抽屉显隐(布尔控制,与数据 selectedOrder 分离) */
const detailVisible = ref(false)
const analytes = ref<LabOrderAnalyte[]>([])
const specimens = ref<LabSpecimen[]>([])
const detailLoading = ref(false)

/** 结果录入表单:analyteId -> { result_value, result_numeric, is_abnormal, is_critical, flag, note } */
const resultForm = ref<Record<string, {
  result_value: string
  result_numeric: string
  is_abnormal: boolean
  is_critical: boolean
  flag: string
  note: string
}>>({})

const search = ref({
  status: '',
  petId: '',
})

const tableColumns = computed<TableColumn<LabOrderRow>[]>(() => [
  {
    accessorKey: 'order_no',
    header: '申请单号',
    cell: (info: any) => info.getValue(),
  },
  {
    accessorKey: 'pet_id',
    header: '宠物 ID',
    cell: (info: any) => info.getValue()?.slice(0, 8),
  },
  {
    accessorKey: 'customer_id',
    header: '客户 ID',
    cell: (info: any) => info.getValue()?.slice(0, 8),
  },
  {
    accessorKey: 'requested_at',
    header: '申请时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'collected_at',
    header: '采集时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'completed_at',
    header: '完成时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as LabOrderRecord['status']
      const label = LAB_ORDER_STATUS_LABELS[v] ?? v
      const color = LAB_ORDER_STATUS_COLORS[v] ?? 'default'
      return h('span', {
        class: `inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-${color}-100 text-${color}-700`,
      }, label)
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 220,
    align: 'center',
    fixed: 'right',
  },
])

const labForm = reactive({
  customerId: '',
  petId: '',
  remark: '',
})

/** 加载检验申请列表 */
async function loadLabOrders() {
  loading.value = true
  try {
    const res = await apiDiagnostics.listLabOrders({
      storeId: tenantStore.currentStoreId || undefined,
      status: (search.value.status || undefined) as LabOrderRecord['status'] | undefined,
      petId: search.value.petId.trim() || undefined,
    })
    dataList.value = res.data.list as LabOrderRow[]
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载检验申请列表失败')
  }
  finally {
    loading.value = false
  }
}

/** 加载危急值告警列表 */
async function loadCriticalAlerts() {
  try {
    const res = await apiDiagnostics.listCriticalAlerts({
      storeId: tenantStore.currentStoreId || undefined,
      status: 'pending',
    })
    criticalAlerts.value = res.data.list
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

/** 创建检验申请 */
async function onCreate() {
  if (!labForm.customerId || !labForm.petId) {
    useFaToast().warning('请填写客户 ID 与宠物 ID')
    return
  }
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择工作租户')
    return
  }

  submitting.value = true
  try {
    await apiDiagnostics.createLabOrder({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId || undefined,
      customerId: labForm.customerId.trim(),
      petId: labForm.petId.trim(),
      remark: labForm.remark.trim() || undefined,
    })
    useFaToast().success('已创建检验申请')
    labForm.customerId = ''
    labForm.petId = ''
    labForm.remark = ''
    await loadLabOrders()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

/** 取消检验申请(仅 requested 状态) */
function onCancel(row: LabOrderRow) {
  if (row.status !== 'requested') {
    useFaToast().warning('仅「已申请」状态可取消')
    return
  }
  useFaModal().confirm({
    title: '取消检验申请',
    content: `确认取消申请单 ${row.order_no} 吗?`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.cancelLabOrder(row.id)
        useFaToast().success('已取消')
        await loadLabOrders()
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

/** 标记已采集(requested→collected) */
function onCollect(row: LabOrderRow) {
  if (row.status !== 'requested') {
    useFaToast().warning('仅「已申请」状态可采集')
    return
  }
  useFaModal().confirm({
    title: '标记已采集',
    content: `确认将申请单 ${row.order_no} 标记为已采集吗?`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.markLabOrderCollected(row.id)
        useFaToast().success('已标记采集')
        await loadLabOrders()
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

/** 展开详情:加载结果项 + 标本 */
async function onShowDetail(row: LabOrderRow) {
  selectedOrder.value = row
  detailVisible.value = true
  detailLoading.value = true
  try {
    const [analyteRes, specimenRes] = await Promise.all([
      apiDiagnostics.listLabOrderAnalytes(row.id),
      apiDiagnostics.listSpecimens(row.id),
    ])
    analytes.value = analyteRes.data.list
    specimens.value = specimenRes.data.list
    // 初始化结果录入表单
    resultForm.value = {}
    for (const a of analytes.value) {
      resultForm.value[a.id] = {
        result_value: a.result_value ?? '',
        result_numeric: a.result_numeric != null ? String(a.result_numeric) : '',
        is_abnormal: a.is_abnormal,
        is_critical: a.is_critical,
        flag: a.flag ?? '',
        note: a.note ?? '',
      }
    }
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    detailLoading.value = false
  }
}

/** 发布检验结果(MXQ-10008,走 publish_lab_results RPC) */
async function onPublishResults() {
  if (!selectedOrder.value) {
    return
  }
  const results = analytes.value.map((a) => {
    const f = resultForm.value[a.id]
    return {
      id: a.id,
      result_value: f?.result_value || undefined,
      result_numeric: f?.result_numeric ? Number(f.result_numeric) : undefined,
      is_abnormal: f?.is_abnormal,
      is_critical: f?.is_critical,
      flag: (f?.flag || undefined) as 'low' | 'high' | 'critical' | undefined,
      note: f?.note || undefined,
    }
  })
  try {
    await apiDiagnostics.publishLabResults({
      labOrderId: selectedOrder.value.id,
      results,
    })
    useFaToast().success('结果已发布(自动触发危急值告警)')
    await Promise.all([loadLabOrders(), loadCriticalAlerts(), onShowDetail(selectedOrder.value)])
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

/** 审核检验结果(MXQ-10008,走 review_lab_results RPC,双签) */
function onReview(decision: 'approved' | 'rejected') {
  if (!selectedOrder.value) {
    return
  }
  const label = decision === 'approved' ? '通过' : '驳回'
  useFaModal().confirm({
    title: `审核${label}`,
    content: `确认${label}申请单 ${selectedOrder.value.order_no} 的检验结果吗?(走 review_lab_results RPC,双签校验)`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.reviewLabResults({
          labOrderId: selectedOrder.value!.id,
          decision,
        })
        useFaToast().success(`已${label}`)
        await Promise.all([loadLabOrders(), onShowDetail(selectedOrder.value!)])
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

/** 确认危急值(pending→acknowledged) */
async function onAcknowledgeAlert(alert: CriticalValueAlert) {
  try {
    await apiDiagnostics.acknowledgeCriticalAlert(alert.id)
    useFaToast().success('危急值已确认')
    await loadCriticalAlerts()
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

onMounted(async () => {
  await Promise.all([loadLabOrders(), loadCriticalAlerts()])
})
</script>

<template>
  <div>
    <FaPageHeader title="检验管理" class="mb-0">
      <template #description>
        检验申请 → 采集 → 录入结果 → 审核发布;危急值自动告警;结果发布与审核走 RPC 事务化
      </template>
    </FaPageHeader>
    <FaPageMain>
      <!-- 危急值告警横幅 -->
      <div v-if="criticalAlerts.length > 0" class="border-danger-300 bg-danger-50 mb-4 p-3 border rounded-lg">
        <div class="mb-2 flex gap-2 items-center">
          <FaIcon name="i-ri:alarm-warning-line" class="text-danger-600 text-lg" />
          <span class="text-danger-700 font-bold">危急值告警({{ criticalAlerts.length }} 条待确认)</span>
        </div>
        <div class="space-y-1">
          <div
            v-for="alert in criticalAlerts"
            :key="alert.id"
            class="text-sm flex items-center justify-between"
          >
            <span>
              <FaIcon name="i-ri:alert-line" class="text-danger-600 mr-1" />
              {{ alert.message ?? '危急值' }} · 宠物 {{ alert.pet_id.slice(0, 8) }}
            </span>
            <FaButton variant="destructive" size="sm" @click="onAcknowledgeAlert(alert)">
              确认
            </FaButton>
          </div>
        </div>
      </div>

      <!-- 创建检验申请表单 -->
      <div class="mb-4 p-4 border rounded-lg bg-muted/30">
        <div class="mb-3 flex gap-2 items-center">
          <FaIcon name="i-ri:test-tube-line" class="text-lg" />
          <span class="font-bold">创建检验申请</span>
          <span class="text-xs text-muted-foreground">(RLS 须 lab.request 权限)</span>
        </div>
        <div class="gap-3 grid grid-cols-1 md:grid-cols-3">
          <FaLabel label="客户 ID">
            <FaInput v-model="labForm.customerId" placeholder="客户 UUID" class="w-full" />
          </FaLabel>
          <FaLabel label="宠物 ID">
            <FaInput v-model="labForm.petId" placeholder="宠物 UUID" class="w-full" />
          </FaLabel>
          <FaLabel label="备注">
            <FaInput v-model="labForm.remark" placeholder="备注信息" class="w-full" />
          </FaLabel>
          <div class="flex items-end">
            <FaButton type="primary" :loading="submitting" @click="onCreate">
              <FaIcon name="i-ri:add-line" />
              创建申请
            </FaButton>
          </div>
        </div>
      </div>

      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="状态" class="col-span-1">
              <FaSelect
                v-model="search.status"
                :options="[
                  { label: '全部', value: '' },
                  { label: '已申请', value: 'requested' },
                  { label: '已采集', value: 'collected' },
                  { label: '已完成', value: 'completed' },
                  { label: '已取消', value: 'cancelled' },
                ]"
                class="w-full"
                @change="loadLabOrders()"
              />
            </FaLabel>
            <FaLabel label="宠物 ID" class="col-span-1">
              <FaInput v-model="search.petId" placeholder="按宠物 ID 筛选" class="w-full" />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton type="primary" @click="loadLabOrders">
                <FaIcon name="i-ri:refresh-line" />
                刷新
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
        <template #cell-operation="{ row }">
          <div class="flex-center gap-2">
            <FaButton
              variant="outline"
              size="sm"
              @click="onShowDetail(row.original)"
            >
              <FaIcon name="i-ri:eye-line" />
              详情
            </FaButton>
            <FaButton
              v-if="row.original.status === 'requested'"
              variant="outline"
              size="sm"
              @click="onCollect(row.original)"
            >
              <FaIcon name="i-ri:drop-line" />
              采集
            </FaButton>
            <FaButton
              v-if="row.original.status === 'requested'"
              variant="destructive"
              size="sm"
              @click="onCancel(row.original)"
            >
              <FaIcon name="i-ri:close-line" />
              取消
            </FaButton>
          </div>
        </template>
      </FaTable>

      <!-- 详情抽屉:结果录入 + 标本 + 审核 -->
      <FaDrawer v-if="selectedOrder" v-model="detailVisible" title="检验结果详情" :width="720">
        <div v-loading="detailLoading" class="space-y-4">
          <!-- 基本信息 -->
          <div class="p-3 border rounded-lg bg-muted/20">
            <div class="text-sm font-bold mb-1">
              申请单号:{{ selectedOrder.order_no }}
            </div>
            <div class="text-xs text-muted-foreground">
              状态:{{ LAB_ORDER_STATUS_LABELS[selectedOrder.status] }} · 宠物:{{ selectedOrder.pet_id.slice(0, 8) }}
            </div>
          </div>

          <!-- 结果录入表单 -->
          <div v-if="analytes.length > 0">
            <div class="mb-2 flex gap-2 items-center">
              <FaIcon name="i-ri:file-list-3-line" class="text-lg" />
              <span class="font-bold">检验结果项({{ analytes.length }} 项)</span>
            </div>
            <div class="space-y-2">
              <div
                v-for="a in analytes"
                :key="a.id"
                class="p-3 border rounded-lg"
              >
                <div class="mb-2 flex items-center justify-between">
                  <span class="text-sm font-bold">指标 ID:{{ a.analyte_id?.slice(0, 8) ?? '-' }}</span>
                  <span v-if="a.is_critical" class="bg-danger-100 text-danger-700 text-xs px-2 py-0.5 rounded">危急</span>
                  <span v-else-if="a.is_abnormal" class="bg-warning-100 text-warning-700 text-xs px-2 py-0.5 rounded">异常</span>
                </div>
                <div class="gap-2 grid grid-cols-2 md:grid-cols-3">
                  <FaLabel label="结果值(文本)">
                    <FaInput
                      v-model="resultForm[a.id].result_value"
                      placeholder="如:阳性"
                      class="w-full"
                      :disabled="selectedOrder.status === 'completed'"
                    />
                  </FaLabel>
                  <FaLabel label="数值结果">
                    <FaInput
                      v-model="resultForm[a.id].result_numeric"
                      type="number"
                      placeholder="如:12.5"
                      class="w-full"
                      :disabled="selectedOrder.status === 'completed'"
                    />
                  </FaLabel>
                  <FaLabel label="标志">
                    <FaSelect
                      v-model="resultForm[a.id].flag"
                      :options="[
                        { label: '正常', value: '' },
                        { label: '偏低', value: 'low' },
                        { label: '偏高', value: 'high' },
                        { label: '危急', value: 'critical' },
                      ]"
                      class="w-full"
                      :disabled="selectedOrder.status === 'completed'"
                    />
                  </FaLabel>
                </div>
                <div class="mt-2 flex gap-4 items-center">
                  <label class="text-xs flex gap-1 items-center">
                    <input
                      v-model="resultForm[a.id].is_abnormal"
                      type="checkbox"
                      :disabled="selectedOrder.status === 'completed'"
                    >
                    异常
                  </label>
                  <label class="text-xs flex gap-1 items-center">
                    <input
                      v-model="resultForm[a.id].is_critical"
                      type="checkbox"
                      :disabled="selectedOrder.status === 'completed'"
                    >
                    危急值
                  </label>
                </div>
              </div>
            </div>
            <!-- 发布与审核按钮 -->
            <div v-if="selectedOrder.status === 'collected'" class="mt-3 flex gap-2">
              <FaButton type="primary" @click="onPublishResults">
                <FaIcon name="i-ri:upload-line" />
                发布结果(RPC)
              </FaButton>
              <FaButton variant="outline" @click="onReview('approved')">
                <FaIcon name="i-ri:check-double-line" />
                审核通过(双签)
              </FaButton>
              <FaButton variant="destructive" @click="onReview('rejected')">
                <FaIcon name="i-ri:close-line" />
                审核驳回
              </FaButton>
            </div>
          </div>
          <div v-else class="text-sm text-muted-foreground py-4 text-center">
            暂无结果项(可在采集后录入)
          </div>

          <!-- 标本信息 -->
          <div v-if="specimens.length > 0">
            <div class="mb-2 flex gap-2 items-center">
              <FaIcon name="i-ri:test-bottle-line" class="text-lg" />
              <span class="font-bold">标本({{ specimens.length }} 个)</span>
            </div>
            <div class="space-y-1">
              <div
                v-for="s in specimens"
                :key="s.id"
                class="text-xs p-2 border rounded flex items-center justify-between"
              >
                <span>类型:{{ s.specimen_type }} · 容器:{{ s.container_id ?? '-' }}</span>
                <span class="text-muted-foreground">{{ s.status }}</span>
              </div>
            </div>
          </div>
        </div>
      </FaDrawer>
    </FaPageMain>
  </div>
</template>
