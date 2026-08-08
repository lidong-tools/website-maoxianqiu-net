<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { PetRecord } from '@/types/customer'
import type { CriticalAlertLevel, CriticalAlertStatus, NotifyChannel } from '@/types/diagnostics'
import apiDiagnostics from '@/api/modules/diagnostics'
import apiStore from '@/api/modules/store'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { CRITICAL_ALERT_STATUS_LABELS } from '@/types/diagnostics'

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

const petMap = ref<Record<string, PetRecord>>({})

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

async function enrichPets(rows: CriticalAlertRow[]) {
  const ids = [...new Set(rows.map(r => r.pet_id).filter(Boolean))]
  if (!ids.length) {
    return
  }
  const { data } = await supabase.from('pets').select('*').in('id', ids)
  data?.forEach((p) => { petMap.value[p.id] = p as PetRecord })
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
  }).then(async (res: any) => {
    loading.value = false
    dataList.value = res.data.list ?? []
    pagination.value.total = res.data.total
    await enrichPets(dataList.value)
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

function openNotify(row: CriticalAlertRow) {
  notifyTarget.value = row
  notifyChannel.value = 'phone'
  notifyVisible.value = true
}

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

function openAck(row: CriticalAlertRow) {
  ackTarget.value = row
  ackNote.value = ''
  ackVisible.value = true
}

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

function openResolve(row: CriticalAlertRow) {
  resolveTarget.value = row
  resolveNote.value = ''
  resolveVisible.value = true
}

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

/** 未处理(pending/acknowledged)危急值 */
const unresolved = computed(() => dataList.value.filter(r => r.status === 'pending' || r.status === 'acknowledged'))
const pendingCount = computed(() => dataList.value.filter(r => r.status === 'pending').length)
const acknowledgedCount = computed(() => dataList.value.filter(r => r.status === 'acknowledged').length)
const todayResolvedCount = computed(() => dataList.value.filter(r => r.status === 'resolved').length)

const tableColumns = computed<TableColumn<CriticalAlertRow>[]>(() => [
  {
    accessorKey: 'alert_level',
    header: '级别',
    cell: (info: any) => {
      const v = info.getValue() as CriticalAlertLevel
      return h(EntityStatusTag, { label: v === 'critical' ? '危急' : '重要', variant: v === 'critical' ? 'danger' : 'warning', dot: true })
    },
  },
  { accessorKey: 'critical_value_code', header: '危急值项目', cell: (info: any) => info.getValue() ?? '-' },
  { accessorKey: 'message', header: '告警内容', cell: (info: any) => info.getValue() ?? '-' },
  {
    id: 'pet',
    header: '宠物',
    cell: (info: any) => petMap.value[info.row.original.pet_id]?.name ?? (info.row.original.pet_id?.slice(0, 8) ?? '-'),
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
      const v = info.getValue() as CriticalAlertStatus
      return h(EntityStatusTag, { label: CRITICAL_ALERT_STATUS_LABELS[v] ?? v, variant: v === 'pending' ? 'danger' : v === 'acknowledged' ? 'warning' : 'success', dot: true })
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
  <div class="flex flex-col h-full">
    <EntityPageHeader compact title="危急值管理" description="未处理优先 · 通知→确认→解决全程审计">
      <template #actions>
        <FaSelect
          v-model="search.storeId"
          :options="storeOptions"
          class="w-40"
          @change="currentChange()"
        />
        <FaSelect
          v-model="search.status"
          :options="[
            { label: '全部状态', value: '' },
            { label: '待确认', value: 'pending' },
            { label: '已确认', value: 'acknowledged' },
            { label: '已解决', value: 'resolved' },
          ]"
          class="w-36"
          @change="currentChange()"
        />
      </template>
    </EntityPageHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <!-- 红色告警摘要 -->
      <div class="gap-4 grid grid-cols-3">
        <div class="p-3 border border-red-200 rounded-lg bg-red-50">
          <div class="text-2xl text-red-600 font-semibold tabular-nums">
            {{ pendingCount }}
          </div>
          <div class="text-xs text-red-600/70 font-medium">
            未处理
          </div>
        </div>
        <div class="p-3 border border-amber-200 rounded-lg bg-amber-50">
          <div class="text-2xl text-amber-600 font-semibold tabular-nums">
            {{ acknowledgedCount }}
          </div>
          <div class="text-xs text-amber-600/70 font-medium">
            已通知未确认
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card">
          <div class="text-2xl font-semibold tabular-nums">
            {{ todayResolvedCount }}
          </div>
          <div class="text-xs text-muted-foreground">
            已解决
          </div>
        </div>
      </div>

      <!-- 未处理卡片流(UNRESOLVED FIRST) -->
      <div v-if="unresolved.length" class="gap-3 grid auto-rows-max grid-cols-1 xl:grid-cols-2">
        <div
          v-for="row in unresolved"
          :key="row.id"
          class="p-3 border border-red-200 rounded-lg bg-red-50/60 flex gap-3 items-center justify-between"
        >
          <div class="min-w-0">
            <div class="flex gap-2 items-center">
              <FaIcon :name="row.alert_level === 'critical' ? 'i-lucide:alert-octagon' : 'i-lucide:alert-triangle'" class="text-red-600 shrink-0 size-4" />
              <span class="text-sm font-medium">{{ petMap[row.pet_id]?.name ?? '未知宠物' }}</span>
              <span class="text-xs text-muted-foreground">{{ row.critical_value_code ?? '危急值' }}</span>
            </div>
            <div class="text-sm text-red-700 font-medium mt-1">
              {{ row.message ?? '危急值告警' }}
            </div>
            <div class="text-xs text-red-600/70 mt-0.5">
              产生于 {{ row.notified_at ? new Date(row.notified_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '未知时间' }}
              · 状态 {{ CRITICAL_ALERT_STATUS_LABELS[row.status] }}
            </div>
          </div>
          <div class="flex shrink-0 flex-col gap-1.5">
            <FaButton v-if="row.status === 'pending' || row.status === 'acknowledged'" size="sm" variant="outline" @click="openNotify(row)">
              通知
            </FaButton>
            <FaButton v-if="row.status === 'pending'" size="sm" @click="openAck(row)">
              立即处理
            </FaButton>
            <FaButton v-if="row.status === 'acknowledged'" size="sm" @click="openResolve(row)">
              解决
            </FaButton>
          </div>
        </div>
      </div>

      <!-- 全部危急值列表 -->
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 overflow-hidden">
        <div class="text-sm font-medium px-4 py-2.5 border-b">
          全部危急值
        </div>
        <div v-loading="loading" class="flex-1 min-h-0 overflow-auto">
          <FaTable
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
        </div>
        <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2 px-4 pb-3" @page-change="currentChange" @size-change="sizeChange" />
      </div>
    </div>

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
  </div>
</template>
