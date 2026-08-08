<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { DeliveryStatus, MessageChannel } from '@/types/operations'
import apiOperations, { isMockProvider } from '@/api/modules/operations'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  DELIVERY_STATUS_LABELS,
  MEMBERSHIP_CHANNEL_LABELS,
} from '@/types/operations'

defineOptions({
  name: 'OperationsMessageDeliveries',
})

interface DeliveryRow {
  id: string
  tenant_id: string
  reminder_id: string | null
  template_id: string | null
  channel: MessageChannel
  recipient: string
  content_snapshot: string
  provider_message_id: string | null
  status: DeliveryStatus
  error: string | null
  attempts: number
  sent_at: string | null
  created_at: string
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<DeliveryRow[]>([])
/** 是否为 Mock 模式 */
const isMock = ref(false)
/** 是否为生产环境 Mock 模式（消息功能完全禁用） */
const isProdMock = computed(() => isMock.value && import.meta.env.PROD)
/** 是否为开发环境 Mock 模式 */
const isDevMock = computed(() => isMock.value && !import.meta.env.PROD)

/** 状态筛选选项 */
const statusOptions = [
  { label: '全部状态', value: '' },
  { label: '排队中', value: 'queued' },
  { label: '已发送', value: 'sent' },
  { label: '发送失败', value: 'failed' },
  { label: '重试中', value: 'retry' },
]

/** 渠道筛选选项 */
const channelOptions = [
  { label: '全部渠道', value: '' },
  { label: '短信', value: 'sms' },
  { label: '邮件', value: 'email' },
  { label: '微信', value: 'wechat' },
  { label: '企业微信', value: 'work_wechat' },
]

const search = ref({
  status: '' as '' | DeliveryStatus,
  channel: '' as '' | MessageChannel,
})

/** 发送中状态 */
const sendingId = ref<string | null>(null)

/**
 * 拉取投递记录列表
 */
function getDataList() {
  if (!tenantStore.currentTenantId) {
    dataList.value = []
    return
  }
  loading.value = true
  apiOperations.listDeliveries({
    tenantId: tenantStore.currentTenantId,
    status: search.value.status || undefined,
    channel: search.value.channel || undefined,
  }).then((res: any) => {
    loading.value = false
    dataList.value = (res.data.list ?? []) as DeliveryRow[]
  }).catch(() => {
    loading.value = false
  })
}

onMounted(() => {
  isMock.value = isMockProvider()
  getDataList()
})

function onSearch() {
  getDataList()
}

function onReset() {
  search.value.status = ''
  search.value.channel = ''
  getDataList()
}

const tableColumns = computed<TableColumn<DeliveryRow>[]>(() => [
  {
    accessorKey: 'channel',
    header: '渠道',
    cell: (info: any) => MEMBERSHIP_CHANNEL_LABELS[info.getValue() as MessageChannel] ?? info.getValue(),
  },
  {
    accessorKey: 'recipient',
    header: '接收人',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as DeliveryStatus
      const label = DELIVERY_STATUS_LABELS[v] ?? v
      if (v === 'sent') {
        return h('span', { style: { color: '#22c55e', fontWeight: 500 } }, label)
      }
      if (v === 'failed') {
        return h('span', { style: { color: '#ef4444', fontWeight: 500 } }, label)
      }
      return label
    },
  },
  {
    accessorKey: 'template_id',
    header: '关联模板',
    cell: (info: any) => info.getValue() ? `${info.getValue().slice(0, 8)}...` : '-',
  },
  {
    accessorKey: 'attempts',
    header: '尝试次数',
    cell: (info: any) => info.getValue() ?? 0,
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'sent_at',
    header: '发送时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 120,
    align: 'center',
    fixed: 'right',
  },
])

/**
 * 触发发送
 */
function triggerSend(row: DeliveryRow) {
  if (isProdMock.value) {
    useFaToast().error('生产环境未配置消息供应商，无法发送')
    return
  }
  sendingId.value = row.id
  apiOperations.sendDelivery(row.id).then(() => {
    useFaToast().success(isDevMock.value ? 'Mock 发送已标记为成功' : '发送已触发')
    getDataList()
  }).catch(() => {
    useFaToast().error('发送失败')
    // 错误已在拦截器中处理
  }).finally(() => {
    sendingId.value = null
  })
}
</script>

<template>
  <div>
    <EntityPageHeader compact title="消息投递记录" description="消息发送投递记录{{ isDevMock ? '；当前使用 Mock Provider，仅开发环境可用' : '' }}" />
    <FaPageMain>
      <!-- Mock 模式提示横幅：生产环境红色/橙色，开发环境黄色 -->
      <div v-if="isProdMock" class="mock-banner mock-banner--prod">
        <FaIcon name="i-ri:error-warning-line" class="mock-banner-icon" />
        <span>
          <strong>未配置消息供应商 — 消息功能已禁用。</strong>
          请在环境变量中设置 VITE_MESSAGE_PROVIDER=real 并配置后端供应商后启用。
        </span>
      </div>
      <div v-else-if="isDevMock" class="mock-banner mock-banner--dev">
        <FaIcon name="i-ri:alert-line" class="mock-banner-icon" />
        <span>
          <strong>Mock Provider，仅开发环境可用。</strong>
          正式上线前需配置真实消息供应商（如阿里云短信、SendGrid 邮件等）。
        </span>
      </div>

      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="状态" class="col-span-1">
              <FaSelect v-model="search.status" :options="statusOptions" class="w-full" @change="onSearch" />
            </FaLabel>
            <FaLabel label="渠道" class="col-span-1">
              <FaSelect v-model="search.channel" :options="channelOptions" class="w-full" @change="onSearch" />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton variant="outline" @click="onReset">
                重置
              </FaButton>
              <FaButton type="primary" @click="onSearch">
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
          <div class="flex-center gap-2">
            <FaTooltip
              v-if="isProdMock"
              content="生产环境未配置消息供应商，无法发送"
            >
              <FaButton
                variant="outline"
                size="icon-sm"
                disabled
              >
                <FaIcon name="i-ri:send-plane-line" />
              </FaButton>
            </FaTooltip>
            <template v-else>
              <FaButton
                variant="outline"
                size="icon-sm"
                :loading="sendingId === row.id"
                :disabled="row.original.status !== 'queued' && row.original.status !== 'failed' && row.original.status !== 'retry'"
                @click="triggerSend(row.original)"
              >
                <FaIcon name="i-ri:send-plane-line" />
              </FaButton>
              <span v-if="isDevMock" class="mock-tag">Mock 模式</span>
            </template>
          </div>
        </template>
      </FaTable>
    </FaPageMain>
  </div>
</template>

<style scoped>
.mock-banner {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
  margin-bottom: 16px;
  font-size: 14px;
  border-radius: 8px;
}

.mock-banner--dev {
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #f59e0b;
}

.mock-banner--prod {
  color: #991b1b;
  background: #fee2e2;
  border: 1px solid #ef4444;
}

.mock-banner-icon {
  flex-shrink: 0;
  font-size: 18px;
}

.mock-tag {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  font-size: 12px;
  line-height: 20px;
  color: #92400e;
  white-space: nowrap;
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 4px;
}
</style>
