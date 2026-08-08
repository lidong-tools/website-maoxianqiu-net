<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiAudit from '@/api/modules/audit'
import apiStore from '@/api/modules/store'
import BusinessStoreSelector from '@/components/business/StoreSelector/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'SystemAudit',
})

const tenantStore = useAppTenantStore()
const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const activeTab = ref('audit')
const loading = ref(false)

// ===== 门店映射(审计日志 store_id → 门店名) =====
const storeMap = ref<Record<string, string>>({})
async function loadStores() {
  try {
    const res: any = await apiStore.list()
    const map: Record<string, string> = {}
    for (const s of res?.data?.list ?? []) {
      map[s.id] = s.name
    }
    storeMap.value = map
  }
  catch {
    storeMap.value = {}
  }
}

// ===== 审计日志 =====
const auditSearch = ref({
  startAt: '',
  endAt: '',
  storeId: '',
  action: '',
  entityType: '',
  requestId: '',
})
const auditList = ref<any[]>([])

const auditColumns = computed<TableColumn<any>[]>(() => [
  {
    accessorKey: 'created_at',
    header: '时间',
    cell: (info: any) => formatTime(info.getValue()),
    minSize: 160,
  },
  {
    accessorKey: 'employee_name',
    header: '员工',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'store_id',
    header: '门店',
    cell: (info: any) => (info.getValue() ? storeMap.value[info.getValue()] ?? '-' : '-'),
  },
  { accessorKey: 'action', header: '动作' },
  {
    accessorKey: 'entity_type',
    header: '资源',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'metadata',
    header: '结果摘要',
    cell: (info: any) => {
      const meta = info.getValue()
      const str = typeof meta === 'object' && meta !== null ? JSON.stringify(meta) : ''
      return str ? str.slice(0, 60) + (str.length > 60 ? '…' : '') : '-'
    },
    minSize: 200,
  },
  {
    accessorKey: 'request_id',
    header: 'Request ID',
    cell: (info: any) => {
      const v = info.getValue()
      return v ? v.slice(0, 12) : '-'
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 70,
    align: 'center',
  },
])

function formatTime(v: string | null | undefined): string {
  if (!v) {
    return '-'
  }
  return v.replace('T', ' ').slice(0, 19)
}

async function getAuditList() {
  loading.value = true
  try {
    const params: any = {
      ...getParams(),
      tenantId: tenantStore.currentTenantId,
    }
    if (auditSearch.value.startAt) {
      params.startAt = `${auditSearch.value.startAt}T00:00:00`
    }
    if (auditSearch.value.endAt) {
      params.endAt = `${auditSearch.value.endAt}T23:59:59`
    }
    if (auditSearch.value.storeId) {
      params.storeId = auditSearch.value.storeId
    }
    if (auditSearch.value.action) {
      params.action = auditSearch.value.action.trim()
    }
    if (auditSearch.value.entityType) {
      params.entityType = auditSearch.value.entityType.trim()
    }
    if (auditSearch.value.requestId) {
      params.requestId = auditSearch.value.requestId.trim()
    }
    const res = await apiAudit.listAuditLogs(params)
    auditList.value = res.list ?? []
    pagination.value.total = res.total ?? 0
  }
  catch (e) {
    auditList.value = []
    pagination.value.total = 0
    useFaToast().error('加载审计日志失败', {
      description: e instanceof Error ? e.message : '请确认服务端已部署审计接口',
    })
  }
  finally {
    loading.value = false
  }
}

function auditSearchReset() {
  auditSearch.value = { startAt: '', endAt: '', storeId: '', action: '', entityType: '', requestId: '' }
  getAuditList()
}

function exportAuditCsv() {
  const headers = ['时间', '员工', '门店', '动作', '资源类型', '资源ID', 'RequestID', '结果摘要']
  const rows = auditList.value.map((log) => {
    const meta = log.metadata && typeof log.metadata === 'object' ? JSON.stringify(log.metadata) : ''
    return [
      log.created_at ?? '',
      log.employee_name ?? '',
      log.store_id ? storeMap.value[log.store_id] ?? '' : '',
      log.action ?? '',
      log.entity_type ?? '',
      log.entity_id ?? '',
      log.request_id ?? '',
      meta,
    ]
  })
  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `审计日志_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// 审计详情抽屉
const auditDetail = ref<any>(null)
const auditDetailVisible = ref(false)
async function openAuditDetail(row: any) {
  auditDetail.value = row
  auditDetailVisible.value = true
}

function metadataLines(meta: Record<string, unknown> | null | undefined): Array<{ key: string, value: string }> {
  if (!meta || typeof meta !== 'object') {
    return []
  }
  return Object.entries(meta).map(([key, value]) => ({
    key,
    value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
  }))
}

// ===== 安全事件 =====
const SECURITY_EVENT_TYPE_LABELS: Record<string, string> = {
  login_failed: '登录失败',
  permission_denied: '权限拒绝',
  suspicious: '可疑行为',
  data_export: '数据导出',
}
const SECURITY_SEVERITY_LABELS: Record<string, string> = {
  critical: '严重',
  warning: '警告',
  info: '信息',
}
const securitySearch = ref({
  severity: '',
  eventType: '',
})
const securityList = ref<any[]>([])

const severityCounts = computed(() => {
  const counts = { critical: 0, warning: 0, info: 0 }
  for (const ev of securityList.value) {
    if (counts[ev.severity as keyof typeof counts] !== undefined) {
      counts[ev.severity as keyof typeof counts] += 1
    }
  }
  return counts
})

const securityColumns = computed<TableColumn<any>[]>(() => [
  {
    accessorKey: 'created_at',
    header: '时间',
    cell: (info: any) => formatTime(info.getValue()),
    minSize: 160,
  },
  {
    accessorKey: 'severity',
    header: '严重度',
    cell: (info: any) => SECURITY_SEVERITY_LABELS[info.getValue() as string] ?? info.getValue(),
  },
  {
    accessorKey: 'event_type',
    header: '类型',
    cell: (info: any) => SECURITY_EVENT_TYPE_LABELS[info.getValue()] ?? info.getValue(),
  },
  {
    accessorKey: 'user_id',
    header: '用户',
    cell: (info: any) => (info.getValue() ? String(info.getValue()).slice(0, 8) : '-'),
  },
  {
    accessorKey: 'ip',
    header: 'IP',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'description',
    header: '描述',
    minSize: 200,
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 70,
    align: 'center',
  },
])

async function getSecurityList() {
  loading.value = true
  try {
    const params: any = {
      tenantId: tenantStore.currentTenantId,
      from: (pagination.value.page - 1) * pagination.value.size,
      limit: pagination.value.size,
    }
    if (securitySearch.value.severity) {
      params.severity = securitySearch.value.severity
    }
    if (securitySearch.value.eventType) {
      params.eventType = securitySearch.value.eventType
    }
    const res: any = await apiAudit.listSecurityEvents(params)
    securityList.value = res?.data?.list ?? []
    pagination.value.total = res?.data?.total ?? 0
  }
  catch (e) {
    securityList.value = []
    pagination.value.total = 0
    useFaToast().error('加载安全事件失败', {
      description: e instanceof Error ? e.message : '请确认服务端已部署安全事件接口',
    })
  }
  finally {
    loading.value = false
  }
}

function securitySearchReset() {
  securitySearch.value = { severity: '', eventType: '' }
  getSecurityList()
}

// 安全事件详情抽屉
const securityDetail = ref<any>(null)
const securityDetailVisible = ref(false)
function openSecurityDetail(row: any) {
  securityDetail.value = row
  securityDetailVisible.value = true
}

function onTabChange() {
  pagination.value.page = 1
  pagination.value.total = 0
  if (activeTab.value === 'audit') {
    getAuditList()
  }
  else {
    getSecurityList()
  }
}

function sizeChange(size: number) {
  onSizeChange(size).then(() => (activeTab.value === 'audit' ? getAuditList() : getSecurityList()))
}

function currentChange(page = 1) {
  onCurrentChange(page).then(() => (activeTab.value === 'audit' ? getAuditList() : getSecurityList()))
}

onMounted(async () => {
  await loadStores()
  getAuditList()
})
</script>

<template>
  <div>
    <EntityPageHeader compact title="审计与安全">
      <template #description>
        审计日志与安全事件只读查询;高风险操作留痕,便于合规审计。
      </template>
      <template #actions>
        <PermissionButton v-if="activeTab === 'audit'" variant="outline" permission="audit.export" class="mr-2" @click="exportAuditCsv">
          <FaIcon name="i-ri:download-2-line" class="me-1" />
          导出 CSV
        </PermissionButton>
      </template>
    </EntityPageHeader>
    <FaPageMain>
      <FaTabs
        v-model="activeTab" :list="[
          { label: '审计日志', value: 'audit' },
          { label: '安全事件', value: 'security' },
        ]" class="mb-4" @change="onTabChange"
      />

      <!-- 审计日志 -->
      <template v-if="activeTab === 'audit'">
        <FaSearchBar :show-toggle="false">
          <template #default>
            <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
              <FaLabel label="起始日期" class="col-span-1">
                <FaInput v-model="auditSearch.startAt" type="date" class="w-full" />
              </FaLabel>
              <FaLabel label="结束日期" class="col-span-1">
                <FaInput v-model="auditSearch.endAt" type="date" class="w-full" />
              </FaLabel>
              <FaLabel label="门店" class="col-span-1">
                <BusinessStoreSelector v-model="auditSearch.storeId" include-all all-label="全部门店" clearable />
              </FaLabel>
              <FaLabel label="动作" class="col-span-1">
                <FaInput v-model="auditSearch.action" placeholder="如 invoice.confirm" clearable class="w-full" />
              </FaLabel>
              <FaLabel label="资源类型" class="col-span-1">
                <FaInput v-model="auditSearch.entityType" placeholder="如 invoice" clearable class="w-full" />
              </FaLabel>
              <FaLabel label="Request ID" class="col-span-1">
                <FaInput v-model="auditSearch.requestId" placeholder="完整或前 12 位" clearable class="w-full" />
              </FaLabel>
              <div class="flex gap-2 col-end--1 justify-end">
                <FaButton variant="outline" @click="auditSearchReset">
                  重置
                </FaButton>
                <FaButton type="primary" @click="getAuditList">
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
          :columns="auditColumns"
          :data="auditList"
          empty-text="暂无审计日志"
          @row-click="openAuditDetail"
        >
          <template #cell-operation="{ row }">
            <FaButton variant="outline" size="icon-sm" @click.stop="openAuditDetail(row.original)">
              <FaIcon name="i-ri:eye-line" />
            </FaButton>
          </template>
        </FaTable>
        <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />
      </template>

      <!-- 安全事件 -->
      <template v-else>
        <div class="mb-4 gap-4 grid grid-cols-3">
          <div class="p-3 border border-red-200 rounded-lg bg-red-50">
            <div class="text-2xl text-red-600 font-semibold tabular-nums">
              {{ severityCounts.critical }}
            </div>
            <div class="text-xs text-red-600/70 font-medium">
              严重
            </div>
          </div>
          <div class="p-3 border border-amber-200 rounded-lg bg-amber-50">
            <div class="text-2xl text-amber-600 font-semibold tabular-nums">
              {{ severityCounts.warning }}
            </div>
            <div class="text-xs text-amber-600/70 font-medium">
              警告
            </div>
          </div>
          <div class="p-3 border rounded-lg bg-muted">
            <div class="text-2xl text-muted-foreground font-semibold tabular-nums">
              {{ severityCounts.info }}
            </div>
            <div class="text-xs text-muted-foreground/70 font-medium">
              信息
            </div>
          </div>
        </div>
        <FaSearchBar :show-toggle="false">
          <template #default>
            <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
              <FaLabel label="严重度" class="col-span-1">
                <FaSelect
                  v-model="securitySearch.severity" :options="[
                    { label: '全部', value: '' },
                    { label: '严重', value: 'critical' },
                    { label: '警告', value: 'warning' },
                    { label: '信息', value: 'info' },
                  ]" class="w-full"
                />
              </FaLabel>
              <FaLabel label="事件类型" class="col-span-1">
                <FaSelect
                  v-model="securitySearch.eventType" :options="[
                    { label: '全部', value: '' },
                    ...Object.entries(SECURITY_EVENT_TYPE_LABELS).map(([value, label]) => ({ label, value })),
                  ]" class="w-full"
                />
              </FaLabel>
              <div class="flex gap-2 col-end--1 justify-end">
                <FaButton variant="outline" @click="securitySearchReset">
                  重置
                </FaButton>
                <FaButton type="primary" @click="getSecurityList">
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
          :columns="securityColumns"
          :data="securityList"
          empty-text="暂无安全事件"
          @row-click="openSecurityDetail"
        >
          <template #cell-operation="{ row }">
            <FaButton variant="outline" size="icon-sm" @click.stop="openSecurityDetail(row.original)">
              <FaIcon name="i-ri:eye-line" />
            </FaButton>
          </template>
        </FaTable>
        <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />
      </template>
    </FaPageMain>

    <!-- 审计日志详情 -->
    <FaDrawer v-model="auditDetailVisible" title="审计日志详情" width="520px" :footer="false">
      <template v-if="auditDetail">
        <FaDescriptions
          :items="[
            { label: '时间', value: formatTime(auditDetail.created_at) },
            { label: '操作者', value: auditDetail.employee_name ?? '-' },
            { label: '门店', value: auditDetail.store_id ? storeMap[auditDetail.store_id] ?? '-' : '-' },
            { label: '动作', value: auditDetail.action ?? '-' },
            { label: '资源类型', value: auditDetail.entity_type ?? '-' },
            { label: '资源 ID', value: auditDetail.entity_id ?? '-' },
            { label: 'Request ID', value: auditDetail.request_id ?? '-' },
          ]" label-width="96px" :column="1"
        />
        <div class="text-sm font-medium mb-1 mt-4">
          操作数据(Metadata)
        </div>
        <div v-if="metadataLines(auditDetail.metadata).length > 0" class="p-3 rounded-md bg-muted space-y-1">
          <div v-for="line in metadataLines(auditDetail.metadata)" :key="line.key" class="text-xs break-all">
            <span class="text-muted-foreground">{{ line.key }}:</span>
            <span class="ms-1">{{ line.value }}</span>
          </div>
        </div>
        <div v-else class="text-sm text-muted-foreground">
          无
        </div>
      </template>
    </FaDrawer>

    <!-- 安全事件详情 -->
    <FaDrawer v-model="securityDetailVisible" title="安全事件详情" width="520px" :footer="false">
      <template v-if="securityDetail">
        <FaDescriptions
          :items="[
            { label: '时间', value: formatTime(securityDetail.created_at) },
            { label: '严重度', value: SECURITY_SEVERITY_LABELS[securityDetail.severity] ?? securityDetail.severity },
            { label: '类型', value: SECURITY_EVENT_TYPE_LABELS[securityDetail.event_type] ?? securityDetail.event_type },
            { label: '用户', value: securityDetail.user_id ?? '-' },
            { label: 'IP', value: securityDetail.ip ?? '-' },
            { label: 'User Agent', value: securityDetail.user_agent ?? '-' },
            { label: '描述', value: securityDetail.description ?? '-' },
          ]" label-width="96px" :column="1"
        />
        <div class="text-sm font-medium mb-1 mt-4">
          事件数据(Metadata)
        </div>
        <div v-if="metadataLines(securityDetail.metadata).length > 0" class="p-3 rounded-md bg-muted space-y-1">
          <div v-for="line in metadataLines(securityDetail.metadata)" :key="line.key" class="text-xs break-all">
            <span class="text-muted-foreground">{{ line.key }}:</span>
            <span class="ms-1">{{ line.value }}</span>
          </div>
        </div>
        <div v-else class="text-sm text-muted-foreground">
          无
        </div>
      </template>
    </FaDrawer>
  </div>
</template>
