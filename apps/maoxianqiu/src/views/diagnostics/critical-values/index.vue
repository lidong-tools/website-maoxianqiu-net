<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { CriticalAlertLevel, CriticalAlertStatus, NotifyChannel } from '@/types/diagnostics'
import apiDiagnostics from '@/api/modules/diagnostics'
import apiStore from '@/api/modules/store'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { CRITICAL_ALERT_STATUS_COLORS, CRITICAL_ALERT_STATUS_LABELS } from '@/types/diagnostics'

defineOptions({
  name: 'DiagnosticsCriticalValues',
})

interface CriticalAlertRow {
  id: string
  lab_order_id: string
  pet_id: string
  alert_level: CriticalAlertLevel
  message: string | null
  status: CriticalAlertStatus
  critical_value_code: string | null
  notified_at: string | null
  acknowledged_at: string | null
  resolved_at: string | null
  store_id: string | null
}

const tenantStore = useAppTenantStore()
const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const loading = ref(false)
const dataList = ref<CriticalAlertRow[]>([])
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({
  storeId: '',
  status: '',
})

/** 通知渠道弹窗 */
const notifyVisible = ref(false)
const notifyTarget = ref<CriticalAlertRow | null>(null)
const notifyChannel = ref<NotifyChannel>('phone')
const notifying = ref(false)

/** 确认弹窗 */
const ackVisible = ref(false)
const ackTarget = ref<CriticalAlertRow | null>(null)
const ackNote = ref('')
const acking = ref(false)

/** 解决弹窗 */
const resolveVisible = ref(false)
const resolveTarget = ref<CriticalAlertRow | null>(null)
const resolveNote = ref('')
const resolving = ref(false)

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
 * 获取危急值告警列表(S3.1-C,走 Hono Command)
 */
function getDataList() {
  loading.value = true
  apiDiagnostics.listCriticalAlerts({
    storeId: search.value.storeId || undefined,
    status: (search.value.status as CriticalAlertStatus) || undefined,
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
  currentChange()
}

/**
 * 打开通知弹窗
 */
function openNotify(row: CriticalAlertRow) {
  notifyTarget.value = row
  notifyChannel.value = 'phone'
  notifyVisible.value = true
}

/**
 * 通知危急值(S3.1-C,走 notify_critical_value RPC,不改变状态)
 * 确认前必须已通知(闭环强制,后端 CRITICAL_NOT_NOTIFIED 拦截)
 */
async function onNotify() {
  if (!notifyTarget.value) {
    return
  }
  notifying.value = true
  try {
    await apiDiagnostics.notifyCriticalAlert(notifyTarget.value.id, notifyChannel.value)
    useFaToast().success('已通知')
    notifyVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '通知失败')
  }
  finally {
    notifying.value = false
  }
}

/**
 * 打开确认弹窗
 */
function openAck(row: CriticalAlertRow) {
  ackTarget.value = row
  ackNote.value = ''
  ackVisible.value = true
}

/**
 * 确认危急值(S3.1-C,pending→acknowledged,须已通知)
 */
async function onAck() {
  if (!ackTarget.value) {
    return
  }
  acking.value = true
  try {
    await apiDiagnostics.acknowledgeCriticalAlert(ackTarget.value.id, ackNote.value.trim() || undefined)
    useFaToast().success('已确认')
    ackVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '确认失败')
  }
  finally {
    acking.value = false
  }
}

/**
 * 打开解决弹窗
 */
function openResolve(row: CriticalAlertRow) {
  resolveTarget.value = row
  resolveNote.value = ''
  resolveVisible.value = true
}

/**
 * 解决危急值(S3.1-C,acknowledged→resolved,禁止跳级)
 */
async function onResolve() {
  if (!resolveTarget.value) {
    return
  }
  resolving.value = true
  try {
    await apiDiagnostics.resolveCriticalAlert(resolveTarget.value.id, resolveNote.value.trim() || undefined)
    useFaToast().success('已解决')
    resolveVisible.value = false
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '操作失败')
  }
  finally {
    resolving.value = false
  }
}

const tableColumns = computed<TableColumn<CriticalAlertRow>[]>(() => [
  {
    accessorKey: 'alert_level',
    header: '级别',
    cell: (info: any) => {
      const v = info.getValue() as CriticalAlertLevel
      return h('span', { class: `px-2 py-0.5 rounded text-xs ${v === 'critical' ? 'bg-red-100 text-red-600' : 'bg-orange-100 text-orange-600'}` }, v === 'critical' ? '危急' : '重要')
    },
  },
  { accessorKey: 'critical_value_code', header: '危急值项目', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'message',
    header: '告警内容',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'pet_id',
    header: '宠物 ID',
    cell: (info: any) => info.getValue()?.slice(0, 8) ?? '-',
  },
  {
    accessorKey: 'notified_at',
    header: '通知时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '未通知',
  },
  {
    accessorKey: 'acknowledged_at',
    header: '确认时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue()
      const label = CRITICAL_ALERT_STATUS_LABELS[v as keyof typeof CRITICAL_ALERT_STATUS_LABELS] ?? v
      return h('span', { class: `px-2 py-0.5 rounded text-xs bg-${CRITICAL_ALERT_STATUS_COLORS[v as CriticalAlertStatus] ?? 'default'}-100` }, label)
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
</script>

<template>
  <div>
    <FaPageHeader title="危急值管理" class="mb-0">
      <template #description>
        S3.1 危急值闭环:结果发布自动告警→通知(确认前必须已通知)→确认→解决,全程审计
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
                  { label: '待确认', value: 'pending' },
                  { label: '已确认', value: 'acknowledged' },
                  { label: '已解决', value: 'resolved' },
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
        <template #cell-operation="{ row }">
          <div class="flex-center gap-1">
            <FaButton v-if="row.original.status === 'pending' || row.original.status === 'acknowledged'" variant="outline" size="sm" @click="openNotify(row.original)">
              通知
            </FaButton>
            <FaButton v-if="row.original.status === 'pending'" variant="outline" size="sm" @click="openAck(row.original)">
              确认
            </FaButton>
            <FaButton v-if="row.original.status === 'acknowledged'" variant="outline" size="sm" @click="openResolve(row.original)">
              解决
            </FaButton>
          </div>
        </template>
      </FaTable>
      <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />

      <!-- 通知渠道弹窗 -->
      <FaModal v-model:visible="notifyVisible" title="通知危急值" :loading="notifying" @confirm="onNotify">
        <div class="space-y-3">
          <FaAlert type="warning" :closable="false">
            确认前必须已完成通知(闭环强制),请选择通知渠道
          </FaAlert>
          <FaLabel label="通知渠道">
            <FaSelect
              v-model="notifyChannel"
              :options="[
                { label: '电话', value: 'phone' },
                { label: '微信', value: 'wechat' },
                { label: '当面', value: 'inperson' },
                { label: '其他', value: 'other' },
              ]"
              class="w-full"
            />
          </FaLabel>
        </div>
      </FaModal>

      <!-- 确认弹窗 -->
      <FaModal v-model:visible="ackVisible" title="确认危急值" :loading="acking" @confirm="onAck">
        <div class="space-y-3">
          <FaAlert type="warning" :closable="false">
            确认危急值"{{ ackTarget?.critical_value_code ?? ackTarget?.message }}",确认后状态为已确认
          </FaAlert>
          <FaLabel label="确认备注">
            <FaInput v-model="ackNote" placeholder="可选" class="w-full" />
          </FaLabel>
        </div>
      </FaModal>

      <!-- 解决弹窗 -->
      <FaModal v-model:visible="resolveVisible" title="解决危急值" :loading="resolving" @confirm="onResolve">
        <div class="space-y-3">
          <FaAlert type="info" :closable="false">
            危急值"{{ resolveTarget?.critical_value_code ?? resolveTarget?.message }}"将标记为已解决
          </FaAlert>
          <FaLabel label="处理备注">
            <FaInput v-model="resolveNote" placeholder="可选,说明处理措施" class="w-full" />
          </FaLabel>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
