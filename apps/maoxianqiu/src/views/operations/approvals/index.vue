<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { ApprovalInboxItem } from '@/api/modules/approval'
import apiApproval from '@/api/modules/approval'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'OperationsApprovals',
})

const tenantStore = useAppTenantStore()
const appAccountStore = useAppAccountStore()
const { auth } = useAppAuth()
const { pagination, onSizeChange, onCurrentChange } = usePagination()

const activeTab = ref('inbox')
const loading = ref(false)
const dataList = ref<ApprovalInboxItem[]>([])

const TYPE_LABELS: Record<string, string> = {
  invoice_discount: '发票折扣',
  medical_record_amendment: '病历修订',
}
const STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  applied: '已应用',
}
const RISK_LABELS: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
}
const TABS = [
  { label: '待我审批', value: 'inbox' },
  { label: '我发起的', value: 'mine' },
  { label: '已处理', value: 'processed' },
]

const tabCounts = ref({ inbox: 0, mine: 0, processed: 0 })

const columns = computed<TableColumn<ApprovalInboxItem>[]>(() => [
  {
    accessorKey: 'title',
    header: '业务对象',
    cell: (info: any) => {
      const row = info.row.original as ApprovalInboxItem
      return `${row.title}${row.summary ? ` · ${row.summary}` : ''}`
    },
    minSize: 220,
  },
  {
    accessorKey: 'type',
    header: '类型',
    cell: (info: any) => TYPE_LABELS[info.getValue()] ?? info.getValue(),
  },
  {
    accessorKey: 'requestedByName',
    header: '发起人',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'amount',
    header: '金额',
    cell: (info: any) => (info.getValue() != null ? `¥${Number(info.getValue()).toFixed(2)}` : '-'),
  },
  {
    accessorKey: 'risk',
    header: '风险',
    cell: (info: any) => RISK_LABELS[info.getValue() as string] ?? info.getValue(),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => STATUS_LABELS[info.getValue()] ?? info.getValue(),
  },
  {
    accessorKey: 'createdAt',
    header: '等待时间',
    cell: (info: any) => waitText(info.getValue()),
  },
  {
    id: 'operation',
    header: '操作',
    width: 150,
    align: 'center',
    fixed: 'right',
  },
])

function waitText(createdAt: string | null): string {
  if (!createdAt) {
    return '-'
  }
  const diff = Date.now() - new Date(createdAt).getTime()
  if (diff < 0) {
    return '-'
  }
  const hours = Math.floor(diff / 3600000)
  if (hours < 1) {
    return `${Math.max(1, Math.floor(diff / 60000))} 分钟`
  }
  if (hours < 24) {
    return `${hours} 小时`
  }
  return `${Math.floor(hours / 24)} 天`
}

async function load() {
  loading.value = true
  try {
    const tenantId = tenantStore.currentTenantId || undefined
    // P0-18:只加载当前 Tab 分页数据 + 独立计数,不再一次拉三个全量列表
    const [listRes, counts] = await Promise.all([
      apiApproval.listApprovals({ tab: activeTab.value as 'inbox' | 'mine' | 'processed', page: pagination.value.page, pageSize: pagination.value.size, tenantId }),
      apiApproval.getApprovalCounts({ tenantId }),
    ])
    tabCounts.value = counts
    dataList.value = listRes.list ?? []
    pagination.value.total = listRes.total ?? 0
  }
  catch (e) {
    dataList.value = []
    tabCounts.value = { inbox: 0, mine: 0, processed: 0 }
    useFaToast().error('加载审批失败', {
      description: e instanceof Error ? e.message : '请确认服务端已部署审批接口',
    })
  }
  finally {
    loading.value = false
  }
}

function onTabChange() {
  onCurrentChange(1).then(() => load())
}

function handlePageChange(page: number) {
  onCurrentChange(page).then(() => load())
}

function handleSizeChange(size: number) {
  onSizeChange(size).then(() => load())
}

// ===== 详情 =====
const detailVisible = ref(false)
const detailItem = ref<ApprovalInboxItem | null>(null)
function openDetail(row: ApprovalInboxItem) {
  detailItem.value = row
  detailVisible.value = true
}

function snapshotLines(snapshot: Record<string, unknown> | undefined): Array<{ key: string, value: string }> {
  if (!snapshot || typeof snapshot !== 'object') {
    return []
  }
  return Object.entries(snapshot).map(([key, value]) => ({
    key,
    value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
  }))
}

// P0-17:自己发起的申请不可自审(后端 RPC 亦强制,此处 UI 先行禁用)
function isSelfInitiated(item: ApprovalInboxItem): boolean {
  return item.type === 'invoice_discount' && item.requestedBy === appAccountStore.userId
}

function canApprove(item: ApprovalInboxItem): boolean {
  if (isSelfInitiated(item)) {
    return false
  }
  if (item.type === 'invoice_discount') {
    return auth('invoice.confirm')
  }
  return auth('medical_record.amend.approve')
}

// ===== 审批决定 =====
const decisionModal = ref(false)
const decisionItem = ref<ApprovalInboxItem | null>(null)
const decisionAction = ref<'approve' | 'reject'>('approve')
const decisionReason = ref('')
const decisionLoading = ref(false)

function openDecision(item: ApprovalInboxItem, action: 'approve' | 'reject') {
  decisionItem.value = item
  decisionAction.value = action
  decisionReason.value = ''
  decisionModal.value = true
}

async function submitDecision() {
  const item = decisionItem.value
  if (!item) {
    return
  }
  if (decisionAction.value === 'reject' && !decisionReason.value.trim()) {
    useFaToast().warning('请填写拒绝原因')
    return
  }
  decisionLoading.value = true
  try {
    const decision = decisionAction.value === 'approve' ? 'approved' : 'rejected'
    if (item.type === 'invoice_discount') {
      await apiApproval.decideDiscount(item.id, decision, decisionReason.value.trim() || undefined)
    }
    else {
      await apiApproval.decideAmendment(item.id, decision, decisionReason.value.trim() || undefined)
    }
    useFaToast().success(decisionAction.value === 'approve' ? '已批准' : '已拒绝')
    decisionModal.value = false
    load()
  }
  catch (e) {
    useFaToast().error('操作失败', {
      description: e instanceof Error ? e.message : '请稍后重试',
    })
  }
  finally {
    decisionLoading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <EntityPageHeader compact title="审批中心">
      <template #description>
        统一处理待办审批;折扣与病历修订审批在此集中处理,结果同步回原业务对象。
      </template>
    </EntityPageHeader>
    <FaPageMain>
      <FaTabs v-model="activeTab" :list="TABS.map(t => ({ ...t, label: `${t.label}${tabCounts[t.value as keyof typeof tabCounts] ? ` (${tabCounts[t.value as keyof typeof tabCounts]})` : ''}` }))" class="mb-4" @change="onTabChange" />
      <FaTable
        v-loading="loading"
        table-root-class="rounded-lg overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="columns"
        :data="dataList"
        empty-text="暂无审批记录"
        @row-click="openDetail"
      >
        <template #cell-operation="{ row }">
          <div class="flex-center gap-1">
            <FaButton variant="outline" size="icon-sm" @click.stop="openDetail(row.original)">
              <FaIcon name="i-ri:eye-line" />
            </FaButton>
            <span v-if="row.original.status === 'pending' && isSelfInitiated(row.original)" class="text-xs text-muted-foreground">
              不可审批本人申请
            </span>
            <template v-else-if="row.original.status === 'pending' && canApprove(row.original)">
              <FaButton variant="outline" size="sm" class="text-green-600" @click.stop="openDecision(row.original, 'approve')">
                批准
              </FaButton>
              <FaButton variant="outline" size="sm" class="text-red-600" @click.stop="openDecision(row.original, 'reject')">
                拒绝
              </FaButton>
            </template>
          </div>
        </template>
      </FaTable>
      <FaPagination
        :page="pagination.page"
        :size="pagination.size"
        :total="pagination.total"
        class="mt-2 px-4 pb-3"
        @page-change="handlePageChange"
        @size-change="handleSizeChange"
      />
    </FaPageMain>

    <!-- 审批详情 -->
    <FaDrawer v-model="detailVisible" :title="detailItem?.title ?? '审批详情'" width="560px" :footer="false">
      <template v-if="detailItem">
        <FaDescriptions
          :items="[
            { label: '类型', value: TYPE_LABELS[detailItem.type] ?? detailItem.type },
            { label: '状态', value: STATUS_LABELS[detailItem.status] ?? detailItem.status },
            { label: '风险', value: RISK_LABELS[detailItem.risk] ?? detailItem.risk },
            { label: '金额', value: detailItem.amount != null ? `¥${Number(detailItem.amount).toFixed(2)}` : '-' },
            { label: '发起人', value: detailItem.requestedByName ?? '-' },
            { label: '发起时间', value: detailItem.createdAt ? detailItem.createdAt.slice(0, 19).replace('T', ' ') : '-' },
            { label: '申请原因', value: detailItem.reason ?? '-' },
            { label: '业务摘要', value: detailItem.summary },
          ]" label-width="96px" :column="1"
        />
        <div class="text-sm font-medium mb-1 mt-4">
          审批详情数据
        </div>
        <template v-if="detailItem.type === 'invoice_discount'">
          <div class="p-3 rounded-md bg-muted space-y-1">
            <div v-for="line in snapshotLines(detailItem.detail?.approval_metadata as Record<string, unknown>)" :key="line.key" class="text-xs break-all">
              <span class="text-muted-foreground">{{ line.key }}:</span>
              <span class="ms-1">{{ line.value }}</span>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="text-sm font-medium mb-1 mt-3">
            修订前快照
          </div>
          <div class="p-3 rounded-md bg-muted space-y-1">
            <div v-for="line in snapshotLines(detailItem.detail?.before_snapshot as Record<string, unknown>)" :key="line.key" class="text-xs break-all">
              <span class="text-muted-foreground">{{ line.key }}:</span>
              <span class="ms-1">{{ line.value }}</span>
            </div>
          </div>
          <div class="text-sm font-medium mb-1 mt-3">
            拟变更快照
          </div>
          <div class="p-3 rounded-md bg-muted space-y-1">
            <div v-for="line in snapshotLines(detailItem.detail?.after_snapshot as Record<string, unknown>)" :key="line.key" class="text-xs break-all">
              <span class="text-muted-foreground">{{ line.key }}:</span>
              <span class="ms-1">{{ line.value }}</span>
            </div>
          </div>
        </template>
      </template>
    </FaDrawer>

    <!-- 审批决定 -->
    <FaModal v-model="decisionModal" :title="decisionAction === 'approve' ? '批准审批' : '拒绝审批'" :footer="false" :close-on-click-overlay="false">
      <div class="py-2 space-y-4">
        <div class="text-sm">
          <span class="text-muted-foreground">对象：</span>
          <span class="font-medium">{{ decisionItem?.title }}</span>
        </div>
        <template v-if="decisionAction === 'reject'">
          <FaLabel label="拒绝原因(必填)" class="block">
            <FaTextarea v-model="decisionReason" placeholder="请说明拒绝原因" class="w-full" :rows="3" />
          </FaLabel>
        </template>
        <template v-else>
          <FaLabel label="备注(可选)" class="block">
            <FaTextarea v-model="decisionReason" placeholder="审批备注" class="w-full" :rows="3" />
          </FaLabel>
        </template>
        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="decisionModal = false">
            取消
          </FaButton>
          <FaButton :variant="decisionAction === 'approve' ? 'default' : 'destructive'" :loading="decisionLoading" @click="submitDecision">
            {{ decisionAction === 'approve' ? '确认批准' : '确认拒绝' }}
          </FaButton>
        </div>
      </div>
    </FaModal>
  </div>
</template>
