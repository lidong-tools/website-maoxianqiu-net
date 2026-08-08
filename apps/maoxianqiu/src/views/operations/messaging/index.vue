<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiMessaging from '@/api/modules/messaging'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import type {
  MessagingChannel,
  MessagingDelivery,
  MessagingStatus,
  MessagingTemplate,
  MessageDeliveryAttempt,
  ProviderSummary,
  WhitelistVariable,
} from '@/types/messaging'
import {
  MESSAGING_CHANNEL_LABELS,
  MESSAGING_SCENE_LABELS,
  MESSAGING_STATUS_LABELS,
} from '@/types/messaging'

defineOptions({
  name: 'OperationsMessagingConsole',
})

type TabKey = 'templates' | 'send' | 'deliveries'

const tenantStore = useAppTenantStore()
const activeTab = ref<TabKey>('templates')

/** Provider 摘要 */
const providerSummary = ref<ProviderSummary | null>(null)
const providerLoading = ref(false)

/** 变量白名单 */
const whitelist = ref<WhitelistVariable[]>([])

const channelOptions = [
  { label: '短信', value: 'sms' },
  { label: '邮件', value: 'email' },
  { label: '微信', value: 'wechat' },
  { label: '企业微信', value: 'work_wechat' },
]
const statusOptions = [
  { label: '全部状态', value: '' },
  { label: '排队中', value: 'queued' },
  { label: '发送中/结果未知', value: 'sending' },
  { label: '已发送', value: 'sent' },
  { label: '已送达', value: 'delivered' },
  { label: '发送失败', value: 'failed' },
  { label: '重试中', value: 'retry' },
]
const sceneOptions = [
  { label: '全部场景', value: '' },
  { label: '预约提醒', value: 'appointment_reminder' },
  { label: '疫苗提醒', value: 'vaccine_reminder' },
  { label: '回访提醒', value: 'revisit_reminder' },
  { label: '检验报告通知', value: 'lab_report' },
]

const isProdMock = computed(() => !providerSummary.value?.configured && import.meta.env.PROD)

async function loadProviderSummary() {
  providerLoading.value = true
  try {
    const res: any = await apiMessaging.getProviderSummary()
    providerSummary.value = res.data ?? null
  }
  catch {
    providerSummary.value = null
  }
  finally {
    providerLoading.value = false
  }
}

async function loadWhitelist() {
  try {
    const res: any = await apiMessaging.getVariableWhitelist()
    whitelist.value = (res.data ?? []) as WhitelistVariable[]
  }
  catch {
    whitelist.value = []
  }
}

onMounted(() => {
  loadProviderSummary()
  loadWhitelist()
  loadTemplates()
  loadDeliveries()
})

// ===== 模板 Tab =====
const templateLoading = ref(false)
const templateList = ref<MessagingTemplate[]>([])
const templateSearch = ref({ channel: '' as '' | MessagingChannel })

const templateColumns = computed<TableColumn<MessagingTemplate>[]>(() => [
  { accessorKey: 'code', header: '模板编码', cell: (info: any) => info.getValue() ?? '-' },
  { accessorKey: 'name', header: '模板名称', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'channel',
    header: '渠道',
    cell: (info: any) => MESSAGING_CHANNEL_LABELS[info.getValue() as MessagingChannel] ?? info.getValue(),
  },
  { accessorKey: 'subject', header: '标题', cell: (info: any) => info.getValue() ?? '-' },
  { accessorKey: 'is_active', header: '状态', cell: (info: any) => info.getValue() ? '启用' : '停用' },
  {
    accessorKey: 'updated_at',
    header: '更新时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  { id: 'operation', header: '操作', width: 160, align: 'center', fixed: 'right' },
])

async function loadTemplates() {
  if (!tenantStore.currentTenantId) {
    templateList.value = []
    return
  }
  templateLoading.value = true
  try {
    const res: any = await apiMessaging.listTemplates({
      tenantId: tenantStore.currentTenantId,
      channel: templateSearch.value.channel || undefined,
    })
    templateList.value = (res.data?.list ?? []) as MessagingTemplate[]
  }
  catch {
    templateList.value = []
  }
  finally {
    templateLoading.value = false
  }
}

const editVisible = ref(false)
const editSubmitting = ref(false)
const isEditing = ref(false)
const editForm = ref({
  id: '' as string,
  code: '',
  name: '',
  channel: 'sms' as MessagingChannel,
  subject: '',
  body: '',
  is_active: true,
})

/** 点击变量白名单插入 {{key}} 到内容末尾 */
function insertVariable(key: string) {
  if (!key) return
  editForm.value.body = `${editForm.value.body}${editForm.value.body ? '\n' : ''}{{${key}}}`
}

function openCreateTemplate() {
  isEditing.value = false
  editForm.value = {
    id: '',
    code: '',
    name: '',
    channel: 'sms',
    subject: '',
    body: '',
    is_active: true,
  }
  editVisible.value = true
}

function openEditTemplate(row: MessagingTemplate) {
  isEditing.value = true
  editForm.value = {
    id: row.id,
    code: row.code,
    name: row.name,
    channel: row.channel,
    subject: row.subject ?? '',
    body: row.body,
    is_active: row.is_active,
  }
  editVisible.value = true
}

async function submitTemplate() {
  if (!tenantStore.currentTenantId) return
  if (!editForm.value.code.trim() || !editForm.value.name.trim() || !editForm.value.body.trim()) {
    useFaToast().warning('模板编码、名称和内容不能为空')
    return
  }
  editSubmitting.value = true
  try {
    if (isEditing.value) {
      await apiMessaging.updateTemplate(editForm.value.id, {
        tenantId: tenantStore.currentTenantId,
        name: editForm.value.name.trim(),
        channel: editForm.value.channel,
        subject: editForm.value.subject.trim() || null,
        body: editForm.value.body.trim(),
        isActive: editForm.value.is_active,
      })
      useFaToast().success('模板已更新')
    }
    else {
      await apiMessaging.createTemplate({
        tenantId: tenantStore.currentTenantId,
        code: editForm.value.code.trim(),
        name: editForm.value.name.trim(),
        channel: editForm.value.channel,
        subject: editForm.value.subject.trim() || null,
        body: editForm.value.body.trim(),
        isActive: editForm.value.is_active,
      })
      useFaToast().success('模板已创建')
    }
    editVisible.value = false
    loadTemplates()
  }
  catch {
    // 错误已在拦截器中提示
  }
  finally {
    editSubmitting.value = false
  }
}

async function toggleTemplateActive(row: MessagingTemplate) {
  if (!tenantStore.currentTenantId) return
  try {
    await apiMessaging.updateTemplate(row.id, {
      tenantId: tenantStore.currentTenantId,
      isActive: !row.is_active,
    })
    useFaToast().success(row.is_active ? '已停用' : '已启用')
    loadTemplates()
  }
  catch {
    // 拦截器已提示
  }
}

// ===== 发送 Tab =====
const sendSubmitting = ref(false)
const sendResultVisible = ref(false)
const sendResult = ref<{ delivery: MessagingDelivery, attempts: number, status: string, error: string | null } | null>(null)
const sendForm = ref({
  templateId: '' as string,
  channel: 'email' as MessagingChannel,
  scene: 'appointment_reminder' as string,
  recipient: '',
  variables: {} as Record<string, string>,
})

const activeTemplate = computed<MessagingTemplate | null>(() => {
  return templateList.value.find(t => t.id === sendForm.value.templateId) ?? null
})

/** 模板用到的变量 key(来自服务端自动提取的白名单子集) */
const activeVariableKeys = computed<string[]>(() => {
  const t = activeTemplate.value
  if (!t) return []
  return Object.keys(t.variables ?? {})
})

function onSelectTemplate() {
  sendForm.value.variables = {}
}

function variableLabel(key: string): string {
  return whitelist.value.find(w => w.key === key)?.label ?? key
}

/** 生成占位符文本(避免模板源码出现字面量双花括号,规避 Vue 编译器解析问题) */
function placeholderText(key: string): string {
  return `{{${key}}}`
}

/** 变量标签 + 占位符(用于发送 Tab 的输入标签) */
function variableLabelWithKey(key: string): string {
  return `${variableLabel(key)}（${placeholderText(key)}）`
}

/** 一次"发送动作"期间的稳定幂等键(审计 v2 §24:完成/明确失败前持续复用) */
let pendingSendKey: string | null = null

async function submitSend() {
  if (!tenantStore.currentTenantId) return
  if (!sendForm.value.templateId) {
    useFaToast().warning('请选择消息模板')
    return
  }
  if (!sendForm.value.recipient.trim()) {
    useFaToast().warning('请填写接收人')
    return
  }
  const variables: Record<string, string> = {}
  for (const key of activeVariableKeys.value) {
    if (sendForm.value.variables[key] !== undefined && sendForm.value.variables[key] !== '') {
      variables[key] = sendForm.value.variables[key]
    }
  }
  // 幂等键:发送动作开始时生成,期间复用(网络重试/重复点击不产生重复投递)
  if (!pendingSendKey) {
    pendingSendKey = crypto.randomUUID()
  }
  const idempotencyKey = pendingSendKey
  sendSubmitting.value = true
  try {
    const res: any = await apiMessaging.send({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId ?? null,
      scene: sendForm.value.scene,
      templateId: sendForm.value.templateId,
      channel: sendForm.value.channel,
      recipient: sendForm.value.recipient.trim(),
      variables,
      idempotencyKey,
    })
    // 服务端明确成功后才释放幂等键(审计 v3 §18):网络超时/连接中断时保留 Key,
    // 下次点击继续复用同一 Idempotency-Key,避免"服务端已发送但客户端未收到响应"
    // 后再次点击生成新 Key 导致重复消息
    pendingSendKey = null
    const d = res.data as { delivery: MessagingDelivery, result: { status: MessagingStatus } }
    sendResult.value = {
      delivery: d.delivery,
      attempts: d.delivery.attempts,
      status: MESSAGING_STATUS_LABELS[d.result.status] ?? d.result.status,
      error: d.delivery.error,
    }
    sendResultVisible.value = true
    loadDeliveries()
  }
  catch {
    // 拦截器已提示;保留 pendingSendKey,供下次重试复用
  }
  finally {
    sendSubmitting.value = false
  }
}

// ===== 投递记录 Tab =====
const deliveryLoading = ref(false)
const deliveryList = ref<MessagingDelivery[]>([])
const deliverySearch = ref({
  status: '' as '' | MessagingStatus,
  channel: '' as '' | MessagingChannel,
  scene: '' as string,
})

const deliveryColumns = computed<TableColumn<MessagingDelivery>[]>(() => [
  {
    accessorKey: 'channel',
    header: '渠道',
    cell: (info: any) => MESSAGING_CHANNEL_LABELS[info.getValue() as MessagingChannel] ?? info.getValue(),
  },
  { accessorKey: 'recipient', header: '接收人', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'scene',
    header: '场景',
    cell: (info: any) => MESSAGING_SCENE_LABELS[info.getValue() as string] ?? info.getValue() ?? '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as MessagingStatus
      const label = MESSAGING_STATUS_LABELS[v] ?? v
      if (v === 'sent' || v === 'delivered') {
        return h('span', { style: { color: '#22c55e', fontWeight: 500 } }, label)
      }
      if (v === 'failed') {
        return h('span', { style: { color: '#ef4444', fontWeight: 500 } }, label)
      }
      return label
    },
  },
  { accessorKey: 'attempts', header: '尝试次数', cell: (info: any) => info.getValue() ?? 0 },
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
  { id: 'operation', header: '操作', width: 130, align: 'center', fixed: 'right' },
])

async function loadDeliveries() {
  if (!tenantStore.currentTenantId) {
    deliveryList.value = []
    return
  }
  deliveryLoading.value = true
  try {
    const res: any = await apiMessaging.listDeliveries({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId ?? undefined,
      status: deliverySearch.value.status || undefined,
      channel: deliverySearch.value.channel || undefined,
      scene: deliverySearch.value.scene || undefined,
      from: 0,
      limit: 50,
    })
    deliveryList.value = (res.data?.list ?? []) as MessagingDelivery[]
  }
  catch {
    deliveryList.value = []
  }
  finally {
    deliveryLoading.value = false
  }
}

const retryingId = ref<string | null>(null)

async function onRetry(row: MessagingDelivery) {
  retryingId.value = row.id
  try {
    const res: any = await apiMessaging.retryDelivery(row.id)
    const status = (res.data as { result: { status: MessagingStatus } }).result.status
    useFaToast().success(status === 'sent' ? '重试成功' : '重试完成')
    loadDeliveries()
  }
  catch {
    // 拦截器已提示
  }
  finally {
    retryingId.value = null
  }
}

function canRetry(row: MessagingDelivery): boolean {
  // 审计 Full12 §8:Retry 仅限 failed/retry;sending(含 stale)单独显示
  // "发送结果未知",不作为普通 Retry 状态,避免并发重复外部发送。
  return (row.status === 'failed' || row.status === 'retry') && row.attempts < 3
}

// ===== 详情 =====
const detailVisible = ref(false)
const detailLoading = ref(false)
const detail = ref<{ delivery: MessagingDelivery, attempts: MessageDeliveryAttempt[] } | null>(null)

async function openDetail(row: MessagingDelivery) {
  detailVisible.value = true
  detailLoading.value = true
  detail.value = null
  try {
    const res: any = await apiMessaging.getDelivery(row.id)
    detail.value = res.data ?? null
  }
  catch {
    detail.value = null
  }
  finally {
    detailLoading.value = false
  }
}
</script>

<template>
  <div>
    <EntityPageHeader compact title="消息中心" description="真实消息通知 Provider：模板、变量白名单、发送与投递记录" />

    <!-- Provider 状态 -->
    <div v-if="providerLoading" class="mock-banner mock-banner--dev">
      <span>正在读取消息供应商配置…</span>
    </div>
    <div v-else-if="isProdMock" class="mock-banner mock-banner--prod">
      <FaIcon name="i-ri:error-warning-line" class="mock-banner-icon" />
      <span>
        <strong>未配置真实消息供应商 — 生产环境发送已禁用。</strong>
        请在服务端配置 MESSAGING_PROVIDER=email、MESSAGING_API_KEY、MESSAGING_SENDER 后启用。
      </span>
    </div>
    <div v-else-if="providerSummary" class="mock-banner mock-banner--ok">
      <FaIcon name="i-ri:checkbox-circle-line" class="mock-banner-icon" />
      <span>
        <strong>当前供应商：{{ providerSummary.provider }}（{{ providerSummary.channel }}）</strong>
        {{ providerSummary.configured ? '已配置，可发送真实消息。' : '未配置凭据，当前仅开发环境可发送（Mock）。' }}
      </span>
    </div>

    <!-- Tab 切换 -->
    <div class="msg-tabs">
      <button
        v-for="t in ([{ key: 'templates', label: '消息模板' }, { key: 'send', label: '发送消息' }, { key: 'deliveries', label: '投递记录' }] as const)"
        :key="t.key"
        class="msg-tab"
        :class="{ 'msg-tab--active': activeTab === t.key }"
        @click="activeTab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <FaPageMain>
      <!-- ===== 模板 ===== -->
      <template v-if="activeTab === 'templates'">
        <FaSearchBar :show-toggle="false">
          <template #default>
            <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
              <FaLabel label="渠道" class="col-span-1">
                <FaSelect v-model="templateSearch.channel" :options="[{ label: '全部渠道', value: '' }, ...channelOptions]" class="w-full" @change="loadTemplates" />
              </FaLabel>
              <div class="flex gap-2 col-end--1 justify-end">
                <FaButton type="primary" @click="loadTemplates">
                  <FaIcon name="i-ri:search-line" />
                  筛选
                </FaButton>
              </div>
            </div>
          </template>
        </FaSearchBar>
        <div class="mx--4 my-3 border-t border-t-dashed" />
        <FaTable
          v-loading="templateLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="templateColumns"
          :data="templateList"
        >
          <template #toolbar>
            <FaButton @click="openCreateTemplate">
              <FaIcon name="i-ri:add-line" />
              新建模板
            </FaButton>
          </template>
          <template #cell-operation="{ row }">
            <div class="flex-center gap-2">
              <FaButton variant="outline" size="icon-sm" @click="openEditTemplate(row.original)">
                <FaIcon name="i-ri:edit-line" />
              </FaButton>
              <FaButton variant="outline" size="icon-sm" @click="toggleTemplateActive(row.original)">
                <FaIcon :name="row.original.is_active ? 'i-ri:toggle-fill' : 'i-ri:toggle-line'" />
              </FaButton>
            </div>
          </template>
        </FaTable>
      </template>

      <!-- ===== 发送 ===== -->
      <template v-else-if="activeTab === 'send'">
        <div class="space-y-4 max-w-3xl">
          <FaLabel label="消息模板">
            <FaSelect
              v-model="sendForm.templateId"
              :options="templateList.filter(t => t.is_active).map(t => ({ label: `${t.name}（${t.code}）`, value: t.id }))"
              placeholder="选择要发送的模板"
              class="w-full"
              @change="onSelectTemplate"
            />
          </FaLabel>

          <div class="grid grid-cols-2 gap-4">
            <FaLabel label="渠道">
              <FaSelect v-model="sendForm.channel" :options="channelOptions" class="w-full" />
            </FaLabel>
            <FaLabel label="场景">
              <FaSelect v-model="sendForm.scene" :options="sceneOptions.filter(o => o.value !== '')" class="w-full" />
            </FaLabel>
          </div>

          <FaLabel :label="sendForm.channel === 'email' ? '接收邮箱' : '接收手机号'">
            <FaInput v-model="sendForm.recipient" :placeholder="sendForm.channel === 'email' ? '例如: owner@example.com' : '例如: 13800138000'" class="w-full" />
          </FaLabel>

          <div v-if="activeTemplate" class="space-y-3">
            <div class="text-sm text-slate-600">
              模板变量
              <span class="text-slate-400">（{{ activeVariableKeys.length }} 个，白名单变量）</span>
            </div>
            <FaLabel v-for="key in activeVariableKeys" :key="key" :label="variableLabelWithKey(key)">
              <FaInput v-model="sendForm.variables[key]" class="w-full" />
            </FaLabel>
          </div>
          <div v-else class="text-sm text-slate-400">
            请先选择模板以填写变量
          </div>

          <div class="flex gap-2">
            <FaButton type="primary" :loading="sendSubmitting" @click="submitSend">
              <FaIcon name="i-ri:send-plane-line" />
              发送
            </FaButton>
          </div>
        </div>
      </template>

      <!-- ===== 投递记录 ===== -->
      <template v-else>
        <FaSearchBar :show-toggle="false">
          <template #default>
            <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
              <FaLabel label="状态" class="col-span-1">
                <FaSelect v-model="deliverySearch.status" :options="statusOptions" class="w-full" @change="loadDeliveries" />
              </FaLabel>
              <FaLabel label="渠道" class="col-span-1">
                <FaSelect v-model="deliverySearch.channel" :options="[{ label: '全部渠道', value: '' }, ...channelOptions]" class="w-full" @change="loadDeliveries" />
              </FaLabel>
              <FaLabel label="场景" class="col-span-1">
                <FaSelect v-model="deliverySearch.scene" :options="sceneOptions" class="w-full" @change="loadDeliveries" />
              </FaLabel>
              <div class="flex gap-2 col-end--1 justify-end">
                <FaButton type="primary" @click="loadDeliveries">
                  <FaIcon name="i-ri:search-line" />
                  筛选
                </FaButton>
              </div>
            </div>
          </template>
        </FaSearchBar>
        <div class="mx--4 my-3 border-t border-t-dashed" />
        <FaTable
          v-loading="deliveryLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="deliveryColumns"
          :data="deliveryList"
        >
          <template #cell-operation="{ row }">
            <div class="flex-center gap-2">
              <FaButton variant="outline" size="icon-sm" @click="openDetail(row.original)">
                <FaIcon name="i-ri:file-list-3-line" />
              </FaButton>
              <FaTooltip v-if="!canRetry(row.original)" content="不可重试(仅 failed/retry 可重试,或已达最大次数)">
                <FaButton variant="outline" size="icon-sm" disabled>
                  <FaIcon name="i-ri:refresh-line" />
                </FaButton>
              </FaTooltip>
              <FaButton
                v-else
                variant="outline"
                size="icon-sm"
                :loading="retryingId === row.id"
                @click="onRetry(row.original)"
              >
                <FaIcon name="i-ri:refresh-line" />
              </FaButton>
            </div>
          </template>
        </FaTable>
      </template>
    </FaPageMain>

    <!-- 新建/编辑模板 -->
    <FaModal
      v-model="editVisible"
      :title="isEditing ? '编辑模板' : '新建模板'"
      :confirm-text="isEditing ? '保存' : '创建'"
      :loading="editSubmitting"
      @confirm="submitTemplate"
    >
      <div class="space-y-4">
        <FaLabel label="模板编码">
          <FaInput v-model="editForm.code" :disabled="isEditing" placeholder="例如: vaccine_reminder" class="w-full" />
        </FaLabel>
        <FaLabel label="模板名称">
          <FaInput v-model="editForm.name" placeholder="例如: 疫苗提醒模板" class="w-full" />
        </FaLabel>
        <div class="grid grid-cols-2 gap-4">
          <FaLabel label="渠道">
            <FaSelect v-model="editForm.channel" :options="channelOptions" class="w-full" />
          </FaLabel>
          <FaLabel label="启用">
            <FaSwitch v-model="editForm.is_active" />
          </FaLabel>
        </div>
        <FaLabel label="标题（可选，邮件必填）">
          <FaInput v-model="editForm.subject" class="w-full" />
        </FaLabel>
        <FaLabel label="内容">
          <FaInput v-model="editForm.body" type="textarea" :rows="5" class="w-full" />
        </FaLabel>
        <div>
          <div class="mb-2 text-sm text-slate-600">可用变量（点击插入）</div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="v in whitelist"
              :key="v.key"
              type="button"
              class="var-chip"
              @click="insertVariable(v.key)"
            >
              {{ v.label }} {{ placeholderText(v.key) }}
            </button>
          </div>
        </div>
      </div>
    </FaModal>

    <!-- 发送结果 -->
    <FaModal v-model="sendResultVisible" title="发送结果" :footer="false">
      <div v-if="sendResult" class="space-y-3 text-sm">
        <div>状态：<span :style="{ color: sendResult.status.includes('失败') ? '#ef4444' : '#22c55e', fontWeight: 500 }">{{ sendResult.status }}</span></div>
        <div>接收人：{{ sendResult.delivery.recipient }}</div>
        <div>尝试次数：{{ sendResult.attempts }}</div>
        <div v-if="sendResult.delivery.provider_message_id">Provider ID：{{ sendResult.delivery.provider_message_id }}</div>
        <div v-if="sendResult.error" class="text-red-600">{{ sendResult.error }}</div>
        <div>
          <div class="mb-1 font-medium">内容快照：</div>
          <pre class="whitespace-pre-wrap rounded-md bg-gray-50 p-3 text-xs text-gray-700">{{ sendResult.delivery.content_snapshot }}</pre>
        </div>
      </div>
    </FaModal>

    <!-- 投递详情 -->
    <FaModal v-model="detailVisible" title="投递详情" :footer="false" :loading="detailLoading">
      <div v-if="detail" class="space-y-4 text-sm">
        <div class="space-y-1 text-slate-600">
          <div>接收人：{{ detail.delivery.recipient }}　状态：{{ MESSAGING_STATUS_LABELS[detail.delivery.status] }}</div>
          <div v-if="detail.delivery.provider_message_id">Provider ID：{{ detail.delivery.provider_message_id }}</div>
          <div v-if="detail.delivery.error" class="text-red-600">错误：{{ detail.delivery.error }}</div>
        </div>
        <div>
          <div class="mb-2 font-medium">发送尝试（{{ detail.attempts.length }} 次）</div>
          <div v-if="detail.attempts.length === 0" class="text-slate-400">暂无尝试记录</div>
          <div v-for="a in detail.attempts" :key="a.id" class="rounded-md border border-slate-200 p-3">
            <div class="flex items-center gap-2">
              <span class="font-medium">第 {{ a.attempt_no }} 次</span>
              <span :style="{ color: a.status === 'failed' ? '#ef4444' : '#22c55e', fontWeight: 500 }">{{ MESSAGING_STATUS_LABELS[a.status] }}</span>
              <span class="text-slate-400">（{{ a.provider }}）</span>
            </div>
            <div class="mt-1 text-xs text-slate-500">时间：{{ new Date(a.created_at).toLocaleString('zh-CN') }}</div>
            <div v-if="a.error_code" class="mt-1 text-xs text-red-500">错误码：{{ a.error_code }}　{{ a.error_message ?? '' }}</div>
            <div v-if="a.request_snapshot && Object.keys(a.request_snapshot).length" class="mt-2 text-xs text-slate-500">
              请求：{{ JSON.stringify(a.request_snapshot) }}
            </div>
          </div>
        </div>
      </div>
    </FaModal>
  </div>
</template>

<style scoped>
.mock-banner {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
  margin: 0 16px 12px;
  font-size: 14px;
  border-radius: 8px;
}

.mock-banner--prod {
  color: #991b1b;
  background: #fee2e2;
  border: 1px solid #ef4444;
}

.mock-banner--dev {
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #f59e0b;
}

.mock-banner--ok {
  color: #166534;
  background: #dcfce7;
  border: 1px solid #22c55e;
}

.mock-banner-icon {
  flex-shrink: 0;
  font-size: 18px;
}

.msg-tabs {
  display: flex;
  gap: 4px;
  padding: 0 16px;
}

.msg-tab {
  padding: 8px 16px;
  font-size: 14px;
  line-height: 20px;
  color: #475569;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px 8px 0 0;
  cursor: pointer;
  transition: all 0.2s;
}

.msg-tab:hover {
  color: #1e293b;
  background: #f1f5f9;
}

.msg-tab--active {
  color: #4338ca;
  font-weight: 500;
  background: #fff;
  border-color: #e2e8f0;
  border-bottom-color: #fff;
}

.var-chip {
  padding: 4px 10px;
  font-size: 12px;
  line-height: 20px;
  color: #4338ca;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.var-chip:hover {
  background: #e0e7ff;
}
</style>
