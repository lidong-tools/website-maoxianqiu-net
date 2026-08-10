<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  CustomerConsent,
  NotificationSubscription,
  PortalAccessType,
  PortalChannel,
  PortalIdentity,
  PortalIdentityProvider,
  PortalPetAccess,
  PortalPetPermission,
  ProviderChannelStatus,
  ProviderWebhookEventRow,
} from '@/types/portal'
import apiPortal from '@/api/modules/portal'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  CONSENT_TYPE_LABELS,
  NOTIFICATION_SCENE_LABELS,
  PORTAL_ACCESS_TYPE_LABELS,
  PORTAL_CHANNEL_LABELS,
  PORTAL_PROVIDER_LABELS,
  WEBHOOK_EVENT_STATUS_LABELS,
  WEBHOOK_EVENT_TYPE_LABELS,
} from '@/types/portal'

defineOptions({
  name: 'PortalAdminConsole',
})

type TabKey = 'identities' | 'petAccess' | 'consents' | 'subscriptions' | 'webhookEvents'

const tenantStore = useAppTenantStore()
const activeTab = ref<TabKey>('identities')

/** 消息通道配置状态(顶部展示,不含 Secret) */
const channelStatus = ref<ProviderChannelStatus[]>([])
const channelStatusLoading = ref(false)

async function loadChannelStatus() {
  channelStatusLoading.value = true
  try {
    const res: any = await apiPortal.getProviderChannelStatus()
    channelStatus.value = (res.data ?? []) as ProviderChannelStatus[]
  }
  catch {
    channelStatus.value = []
  }
  finally {
    channelStatusLoading.value = false
  }
}

onMounted(() => {
  loadChannelStatus()
  loadIdentities()
  loadPetAccess()
  loadConsents()
  loadSubscriptions()
  loadWebhookEvents()
})

// ===== 身份 Tab =====
const identityLoading = ref(false)
const identityList = ref<PortalIdentity[]>([])

const identityColumns = computed<TableColumn<PortalIdentity>[]>(() => [
  {
    accessorKey: 'provider',
    header: '渠道',
    cell: (info: any) => PORTAL_PROVIDER_LABELS[info.getValue() as PortalIdentityProvider] ?? info.getValue(),
  },
  { accessorKey: 'subject', header: '身份标识', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'customers',
    header: '绑定客户',
    cell: (info: any) => {
      const v = info.getValue() as PortalIdentity['customers']
      return v ? `${v.name}（${v.customer_no}）` : '未绑定'
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as string
      const active = v === 'active'
      return h('span', { style: { color: active ? '#22c55e' : '#ef4444', fontWeight: 500 } }, active ? '正常' : '已停用')
    },
  },
  {
    accessorKey: 'verified_at',
    header: '最近验证',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  { id: 'operation', header: '操作', width: 100, align: 'center', fixed: 'right' },
])

async function loadIdentities() {
  if (!tenantStore.currentTenantId) {
    identityList.value = []
    return
  }
  identityLoading.value = true
  try {
    const res: any = await apiPortal.listIdentities({ tenantId: tenantStore.currentTenantId })
    identityList.value = (res.data?.list ?? []) as PortalIdentity[]
  }
  catch {
    identityList.value = []
  }
  finally {
    identityLoading.value = false
  }
}

const identityDialogVisible = ref(false)
const identitySubmitting = ref(false)
const identityForm = ref({
  customerId: '',
  provider: 'phone' as PortalIdentityProvider,
  subject: '',
})

function openCreateIdentity() {
  identityForm.value = { customerId: '', provider: 'phone', subject: '' }
  identityDialogVisible.value = true
}

async function submitIdentity() {
  if (!tenantStore.currentTenantId) { return }
  if (!identityForm.value.customerId.trim() || !identityForm.value.subject.trim()) {
    useFaToast().warning('客户 id 与身份标识不能为空')
    return
  }
  identitySubmitting.value = true
  try {
    await apiPortal.createIdentity({
      tenantId: tenantStore.currentTenantId,
      customerId: identityForm.value.customerId.trim(),
      provider: identityForm.value.provider,
      subject: identityForm.value.subject.trim(),
    })
    useFaToast().success('身份已绑定')
    identityDialogVisible.value = false
    loadIdentities()
  }
  catch {
    // 拦截器已提示
  }
  finally {
    identitySubmitting.value = false
  }
}

const revokingIdentityId = ref<string | null>(null)

async function onRevokeIdentity(row: PortalIdentity) {
  if (!tenantStore.currentTenantId) { return }
  revokingIdentityId.value = row.id
  try {
    await apiPortal.revokeIdentity(row.id, { tenantId: tenantStore.currentTenantId, reason: '管理端停用' })
    useFaToast().success('身份已停用')
    loadIdentities()
  }
  catch {
    // 拦截器已提示
  }
  finally {
    revokingIdentityId.value = null
  }
}

// ===== 宠物访问授权 Tab =====
const petAccessLoading = ref(false)
const petAccessList = ref<PortalPetAccess[]>([])

const petAccessColumns = computed<TableColumn<PortalPetAccess>[]>(() => [
  {
    accessorKey: 'pets',
    header: '宠物',
    cell: (info: any) => {
      const v = info.getValue() as PortalPetAccess['pets']
      return v ? `${v.name}（${v.species ?? '-'}）` : '-'
    },
  },
  {
    accessorKey: 'customers',
    header: '客户',
    cell: (info: any) => {
      const v = info.getValue() as PortalPetAccess['customers']
      return v ? `${v.name}（${v.customer_no}）` : '-'
    },
  },
  {
    accessorKey: 'access_type',
    header: '关系',
    cell: (info: any) => PORTAL_ACCESS_TYPE_LABELS[info.getValue() as PortalAccessType] ?? info.getValue(),
  },
  {
    accessorKey: 'permissions',
    header: '权限',
    cell: (info: any) => {
      const list = (info.getValue() as PortalPetPermission[]) ?? []
      const map: Record<PortalPetPermission, string> = { view: '查看', appointment: '预约', report: '报告' }
      return list.map(p => map[p] ?? p).join(' / ')
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as string
      const active = v === 'active'
      return h('span', { style: { color: active ? '#22c55e' : '#ef4444', fontWeight: 500 } }, active ? '生效' : '已撤销')
    },
  },
  {
    accessorKey: 'expires_at',
    header: '有效期至',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleDateString('zh-CN') : '长期',
  },
  { id: 'operation', header: '操作', width: 100, align: 'center', fixed: 'right' },
])

async function loadPetAccess() {
  if (!tenantStore.currentTenantId) {
    petAccessList.value = []
    return
  }
  petAccessLoading.value = true
  try {
    const res: any = await apiPortal.listPetAccess({ tenantId: tenantStore.currentTenantId })
    petAccessList.value = (res.data?.list ?? []) as PortalPetAccess[]
  }
  catch {
    petAccessList.value = []
  }
  finally {
    petAccessLoading.value = false
  }
}

const petAccessDialogVisible = ref(false)
const petAccessSubmitting = ref(false)
const petAccessForm = ref({
  petId: '',
  customerId: '',
  accessType: 'family' as PortalAccessType,
  permissions: ['view'] as PortalPetPermission[],
  expiresAt: '',
})

function openCreatePetAccess() {
  petAccessForm.value = { petId: '', customerId: '', accessType: 'family', permissions: ['view'], expiresAt: '' }
  petAccessDialogVisible.value = true
}

const petPermissionOptions = [
  { label: '查看档案', value: 'view' },
  { label: '预约', value: 'appointment' },
  { label: '查看报告', value: 'report' },
]

async function submitPetAccess() {
  if (!tenantStore.currentTenantId) { return }
  if (!petAccessForm.value.petId.trim() || !petAccessForm.value.customerId.trim()) {
    useFaToast().warning('宠物 id 与客户 id 不能为空')
    return
  }
  if (petAccessForm.value.permissions.length === 0) {
    useFaToast().warning('请至少选择一项权限')
    return
  }
  petAccessSubmitting.value = true
  try {
    await apiPortal.upsertPetAccess({
      tenantId: tenantStore.currentTenantId,
      petId: petAccessForm.value.petId.trim(),
      customerId: petAccessForm.value.customerId.trim(),
      accessType: petAccessForm.value.accessType,
      permissions: petAccessForm.value.permissions,
      expiresAt: petAccessForm.value.expiresAt || undefined,
    })
    useFaToast().success('授权已保存')
    petAccessDialogVisible.value = false
    loadPetAccess()
  }
  catch {
    // 拦截器已提示
  }
  finally {
    petAccessSubmitting.value = false
  }
}

const revokingPetAccessId = ref<string | null>(null)

async function onRevokePetAccess(row: PortalPetAccess) {
  if (!tenantStore.currentTenantId) { return }
  revokingPetAccessId.value = row.id
  try {
    await apiPortal.revokePetAccess(row.id, { tenantId: tenantStore.currentTenantId })
    useFaToast().success('授权已撤销')
    loadPetAccess()
  }
  catch {
    // 拦截器已提示
  }
  finally {
    revokingPetAccessId.value = null
  }
}

// ===== Consent Tab(只读) =====
const consentLoading = ref(false)
const consentList = ref<CustomerConsent[]>([])

const consentColumns = computed<TableColumn<CustomerConsent>[]>(() => [
  {
    accessorKey: 'customers',
    header: '客户',
    cell: (info: any) => {
      const v = info.getValue() as CustomerConsent['customers']
      return v ? `${v.name}（${v.customer_no}）` : '-'
    },
  },
  {
    accessorKey: 'consent_type',
    header: '授权类型',
    cell: (info: any) => CONSENT_TYPE_LABELS[info.getValue() as keyof typeof CONSENT_TYPE_LABELS] ?? info.getValue(),
  },
  { accessorKey: 'version', header: '版本', cell: (info: any) => info.getValue() ?? '1.0' },
  {
    accessorKey: 'accepted_at',
    header: '同意时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'revoked_at',
    header: '撤销时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '有效',
  },
  { accessorKey: 'source', header: '来源', cell: (info: any) => info.getValue() ?? '-' },
])

async function loadConsents() {
  if (!tenantStore.currentTenantId) {
    consentList.value = []
    return
  }
  consentLoading.value = true
  try {
    const res: any = await apiPortal.listConsents({ tenantId: tenantStore.currentTenantId })
    consentList.value = (res.data?.list ?? []) as CustomerConsent[]
  }
  catch {
    consentList.value = []
  }
  finally {
    consentLoading.value = false
  }
}

// ===== 通知订阅 Tab(只读) =====
const subscriptionLoading = ref(false)
const subscriptionList = ref<NotificationSubscription[]>([])

const subscriptionColumns = computed<TableColumn<NotificationSubscription>[]>(() => [
  {
    accessorKey: 'customers',
    header: '客户',
    cell: (info: any) => {
      const v = info.getValue() as NotificationSubscription['customers']
      return v ? `${v.name}（${v.customer_no}）` : '-'
    },
  },
  {
    accessorKey: 'channel',
    header: '渠道',
    cell: (info: any) => PORTAL_CHANNEL_LABELS[info.getValue() as PortalChannel] ?? info.getValue(),
  },
  {
    accessorKey: 'scene',
    header: '场景',
    cell: (info: any) => NOTIFICATION_SCENE_LABELS[info.getValue() as keyof typeof NOTIFICATION_SCENE_LABELS] ?? info.getValue(),
  },
  {
    accessorKey: 'enabled',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as boolean
      return h('span', { style: { color: v ? '#22c55e' : '#94a3b8', fontWeight: 500 } }, v ? '开启' : '关闭')
    },
  },
  { accessorKey: 'destination', header: '接收地址', cell: (info: any) => info.getValue() ?? '(默认)' },
  {
    accessorKey: 'updated_at',
    header: '更新时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
])

async function loadSubscriptions() {
  if (!tenantStore.currentTenantId) {
    subscriptionList.value = []
    return
  }
  subscriptionLoading.value = true
  try {
    const res: any = await apiPortal.listSubscriptions({ tenantId: tenantStore.currentTenantId })
    subscriptionList.value = (res.data?.list ?? []) as NotificationSubscription[]
  }
  catch {
    subscriptionList.value = []
  }
  finally {
    subscriptionLoading.value = false
  }
}

// ===== Webhook 事件 Tab(只读) =====
const webhookLoading = ref(false)
const webhookList = ref<ProviderWebhookEventRow[]>([])

const webhookColumns = computed<TableColumn<ProviderWebhookEventRow>[]>(() => [
  { accessorKey: 'provider', header: '渠道', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'event_type',
    header: '事件',
    cell: (info: any) => WEBHOOK_EVENT_TYPE_LABELS[info.getValue() as keyof typeof WEBHOOK_EVENT_TYPE_LABELS] ?? info.getValue(),
  },
  {
    accessorKey: 'status',
    header: '处理状态',
    cell: (info: any) => {
      const v = info.getValue() as string
      const color = v === 'processed' ? '#22c55e' : v === 'ignored' ? '#f59e0b' : '#64748b'
      return h('span', { style: { color, fontWeight: 500 } }, WEBHOOK_EVENT_STATUS_LABELS[v as keyof typeof WEBHOOK_EVENT_STATUS_LABELS] ?? v)
    },
  },
  { accessorKey: 'delivery_id', header: '投递 ID', cell: (info: any) => info.getValue() ? `${info.getValue().slice(0, 8)}…` : '-' },
  { accessorKey: 'provider_event_id', header: '事件 ID', cell: (info: any) => info.getValue() ?? '-' },
  {
    accessorKey: 'received_at',
    header: '接收时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
])

async function loadWebhookEvents() {
  if (!tenantStore.currentTenantId) {
    webhookList.value = []
    return
  }
  webhookLoading.value = true
  try {
    const res: any = await apiPortal.listWebhookEvents({ tenantId: tenantStore.currentTenantId })
    webhookList.value = (res.data?.list ?? []) as ProviderWebhookEventRow[]
  }
  catch {
    webhookList.value = []
  }
  finally {
    webhookLoading.value = false
  }
}

const TABS = [
  { key: 'identities', label: '客户身份' },
  { key: 'petAccess', label: '宠物访问授权' },
  { key: 'consents', label: 'Consent 授权' },
  { key: 'subscriptions', label: '通知订阅' },
  { key: 'webhookEvents', label: 'Webhook 事件' },
] as const
</script>

<template>
  <div>
    <EntityPageHeader compact title="客户门户管理" description="C 端身份、宠物访问授权、Consent、通知订阅与消息回调事件" />

    <!-- 通道配置状态(不含 Secret) -->
    <div v-if="channelStatusLoading" class="portal-banner portal-banner--dev">
      <span>正在读取消息通道配置…</span>
    </div>
    <div v-else-if="channelStatus.length" class="portal-banner portal-banner--ok">
      <FaIcon name="i-ri:checkbox-circle-line" class="portal-banner-icon" />
      <span>
        <strong>消息通道状态：</strong>
        <template v-for="s in channelStatus" :key="s.channel">
          {{ s.channel.toUpperCase() }}={{ s.configured ? '已配置' : '未配置' }}
        </template>
        未配置通道在生产环境拒绝发送与回调接收。
      </span>
    </div>

    <!-- Tab 切换 -->
    <div class="portal-tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="portal-tab"
        :class="{ 'portal-tab--active': activeTab === t.key }"
        @click="activeTab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <FaPageMain>
      <!-- ===== 身份 ===== -->
      <template v-if="activeTab === 'identities'">
        <FaTable
          v-loading="identityLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="identityColumns"
          :data="identityList"
        >
          <template #toolbar>
            <FaButton @click="openCreateIdentity">
              <FaIcon name="i-ri:add-line" />
              手动绑定身份
            </FaButton>
          </template>
          <template #cell-operation="{ row }">
            <FaButton
              v-if="row.original.status === 'active'"
              variant="outline"
              size="icon-sm"
              :loading="revokingIdentityId === row.original.id"
              @click="onRevokeIdentity(row.original)"
            >
              <FaIcon name="i-ri:forbid-line" />
            </FaButton>
          </template>
        </FaTable>
      </template>

      <!-- ===== 宠物访问授权 ===== -->
      <template v-else-if="activeTab === 'petAccess'">
        <FaTable
          v-loading="petAccessLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="petAccessColumns"
          :data="petAccessList"
        >
          <template #toolbar>
            <FaButton @click="openCreatePetAccess">
              <FaIcon name="i-ri:add-line" />
              新增授权
            </FaButton>
          </template>
          <template #cell-operation="{ row }">
            <FaButton
              v-if="row.original.status === 'active'"
              variant="outline"
              size="icon-sm"
              :loading="revokingPetAccessId === row.original.id"
              @click="onRevokePetAccess(row.original)"
            >
              <FaIcon name="i-ri:forbid-line" />
            </FaButton>
          </template>
        </FaTable>
      </template>

      <!-- ===== Consent ===== -->
      <template v-else-if="activeTab === 'consents'">
        <FaTable
          v-loading="consentLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="consentColumns"
          :data="consentList"
        />
      </template>

      <!-- ===== 通知订阅 ===== -->
      <template v-else-if="activeTab === 'subscriptions'">
        <FaTable
          v-loading="subscriptionLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="subscriptionColumns"
          :data="subscriptionList"
        />
      </template>

      <!-- ===== Webhook 事件 ===== -->
      <template v-else>
        <FaTable
          v-loading="webhookLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="webhookColumns"
          :data="webhookList"
        />
      </template>
    </FaPageMain>

    <!-- 手动绑定身份 -->
    <FaModal
      v-model="identityDialogVisible"
      title="手动绑定已核实身份"
      confirm-text="绑定"
      :loading="identitySubmitting"
      @confirm="submitIdentity"
    >
      <div class="space-y-4">
        <FaLabel label="客户 ID（uuid）">
          <FaInput v-model="identityForm.customerId" placeholder="从客户列表复制的 customer id" class="w-full" />
        </FaLabel>
        <div class="gap-4 grid grid-cols-2">
          <FaLabel label="渠道">
            <FaSelect
              v-model="identityForm.provider"
              :options="[
                { label: '手机号', value: 'phone' },
                { label: '邮箱', value: 'email' },
                { label: '微信', value: 'wechat' },
              ]"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="身份标识">
            <FaInput v-model="identityForm.subject" placeholder="手机号 / 邮箱 / openid" class="w-full" />
          </FaLabel>
        </div>
      </div>
    </FaModal>

    <!-- 新增宠物访问授权 -->
    <FaModal
      v-model="petAccessDialogVisible"
      title="新增宠物访问授权"
      confirm-text="保存"
      :loading="petAccessSubmitting"
      @confirm="submitPetAccess"
    >
      <div class="space-y-4">
        <div class="gap-4 grid grid-cols-2">
          <FaLabel label="宠物 ID（uuid）">
            <FaInput v-model="petAccessForm.petId" placeholder="宠物 id" class="w-full" />
          </FaLabel>
          <FaLabel label="客户 ID（uuid）">
            <FaInput v-model="petAccessForm.customerId" placeholder="客户 id" class="w-full" />
          </FaLabel>
        </div>
        <div class="gap-4 grid grid-cols-2">
          <FaLabel label="关系">
            <FaSelect
              v-model="petAccessForm.accessType"
              :options="[
                { label: '家庭成员', value: 'family' },
                { label: '看护人', value: 'caregiver' },
                { label: '主人', value: 'owner' },
              ]"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="有效期至（可选）">
            <FaInput v-model="petAccessForm.expiresAt" type="date" class="w-full" />
          </FaLabel>
        </div>
        <FaLabel label="权限">
          <div class="flex flex-wrap gap-4">
            <FaCheckbox
              v-for="opt in petPermissionOptions"
              :key="opt.value"
              :model-value="petAccessForm.permissions.includes(opt.value as PortalPetPermission)"
              @update:model-value="(checked) => {
                const v = opt.value as PortalPetPermission
                petAccessForm.permissions = checked === true
                  ? [...petAccessForm.permissions, v]
                  : petAccessForm.permissions.filter(p => p !== v)
              }"
            >
              {{ opt.label }}
            </FaCheckbox>
          </div>
        </FaLabel>
      </div>
    </FaModal>
  </div>
</template>

<style scoped>
.portal-banner {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
  margin: 0 16px 12px;
  font-size: 14px;
  border-radius: 8px;
}

.portal-banner--dev {
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #f59e0b;
}

.portal-banner--ok {
  color: #166534;
  background: #dcfce7;
  border: 1px solid #22c55e;
}

.portal-banner-icon {
  flex-shrink: 0;
  font-size: 18px;
}

.portal-tabs {
  display: flex;
  gap: 4px;
  padding: 0 16px;
}

.portal-tab {
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

.portal-tab:hover {
  color: #1e293b;
  background: #f1f5f9;
}

.portal-tab--active {
  color: #4338ca;
  font-weight: 500;
  background: #fff;
  border-color: #e2e8f0;
  border-bottom-color: #fff;
}
</style>
