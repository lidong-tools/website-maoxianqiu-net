<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { Campaign } from '@/api/modules/marketing'
import apiCrmGrowth from '@/api/modules/crmGrowth'
import apiCustomer from '@/api/modules/customer'
import apiMarketing from '@/api/modules/marketing'
import apiMessaging from '@/api/modules/messaging'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'MarketingCampaigns',
})

const tenantStore = useAppTenantStore()

/** 当前租户 id(空时返回 '') */
function tenantId(): string {
  return tenantStore.currentTenantId || ''
}

/** 校验已选择租户,未选择时提示并返回 false */
function requireTenant(): boolean {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户与门店')
    return false
  }
  return true
}

const TYPE_LABELS: Record<string, string> = {
  manual: '手动名单',
  segment: '客户分层',
  birthday: '生日营销',
  churn: '流失挽回',
  referral: '老带新',
}
const CHANNEL_LABELS: Record<string, string> = {
  sms: '短信',
  email: '邮件',
  wechat: '微信公众号',
  work_wechat: '企业微信',
}
const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  scheduled: '已排期',
  published: '已发布',
  completed: '已完成',
  cancelled: '已取消',
}
const OFFER_LABELS: Record<string, string> = {
  coupon: '优惠券',
  package: '套餐',
  none: '无权益',
}

// ===== 列表 =====
const campaigns = ref<Campaign[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const statusFilter = ref('all')
const loading = ref(false)
const segments = ref<Array<{ id: string, name: string }>>([])
const offers = ref<Array<{ id: string, name: string }>>([])
/** 消息模板列表(F-R-3:messageTemplateId 存在性校验与预览数据源) */
const messageTemplates = ref<Array<{ id: string, code: string, name: string, channel: string, body: string, is_active: boolean }>>([])

/** 当前选中模板(F-R-3:表单模板预览) */
const selectedTemplate = computed(() =>
  form.messageTemplateId ? messageTemplates.value.find(t => t.id === form.messageTemplateId) ?? null : null,
)

/** 活动 Offer 摘要 */
function offerText(row: Campaign): string {
  const type = OFFER_LABELS[row.offer_type ?? 'none'] ?? row.offer_type ?? '无权益'
  if (row.offer_type === 'none' || !row.offer_type) {
    return type
  }
  const found = offers.value.find(o => o.id === row.offer_id)
  return found ? `${type}: ${found.name}` : `${type}(${row.offer_id ?? ''})`
}

const columns = computed<TableColumn<Campaign>[]>(() => [
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'name', header: '名称' },
  {
    accessorKey: 'type',
    header: '类型',
    cell: info => TYPE_LABELS[String(info.getValue())] ?? String(info.getValue()),
  },
  {
    accessorKey: 'channel',
    header: '渠道',
    cell: info => CHANNEL_LABELS[String(info.getValue())] ?? String(info.getValue()),
  },
  {
    accessorKey: 'offer_type',
    header: '权益',
    cell: info => offerText(info.row.original),
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const s = String(info.getValue())
      const color = s === 'published' ? '#1677ff' : s === 'completed' ? '#52c41a' : s === 'cancelled' ? '#999' : '#fa8c16'
      return h('span', {
        class: 'inline-flex items-center rounded px-2 py-0.5 text-xs',
        style: { color, border: `1px solid ${color}`, background: `${color}14` },
      }, STATUS_LABELS[s] ?? s)
    },
  },
  {
    accessorKey: 'latest_run',
    header: '触达/已投递',
    cell: (info) => {
      const run = info.getValue() as Campaign['latest_run']
      if (!run) {
        return '-'
      }
      // F-R-3:发布后展示 dispatch_count(投递进度)
      return run.dispatch_count != null ? `${run.audience_count} / ${run.dispatch_count}` : `${run.audience_count}`
    },
  },
  {
    accessorKey: 'starts_at',
    header: '时间窗口',
    cell: (info) => {
      const row = info.row.original as Campaign
      const from = row.starts_at ? String(row.starts_at).slice(0, 10) : '不限'
      const until = row.ends_at ? String(row.ends_at).slice(0, 10) : '不限'
      return `${from} ~ ${until}`
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 230,
    align: 'left',
    fixed: 'right',
  },
])

/** 加载活动列表与 Segment/Offer 选项 */
async function loadCampaigns() {
  if (!requireTenant()) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiMarketing.listCampaigns({ tenantId: tenantId(), status: statusFilter.value === 'all' ? undefined : statusFilter.value, page: page.value, pageSize: pageSize.value })
    campaigns.value = res?.data?.list ?? []
    total.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error('加载活动失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    loading.value = false
  }
}

/** 加载下拉选项(Segment/优惠券/套餐/消息模板) */
async function loadOptions() {
  if (!requireTenant()) {
    return
  }
  try {
    const [segRes, couponRes, pkgRes, tplRes] = await Promise.all([
      apiCrmGrowth.listSegments({ tenantId: tenantId() }),
      apiMarketing.listCoupons({ tenantId: tenantId() }),
      apiMarketing.listPackages({ tenantId: tenantId() }),
      apiMessaging.listTemplates({ tenantId: tenantId(), onlyActive: true }),
    ])
    segments.value = ((segRes as any)?.data?.list ?? []).map((s: any) => ({ id: s.id, name: s.name }))
    offers.value = [
      ...((couponRes as any)?.data?.list ?? []).map((c: any) => ({ id: c.id, name: `[券] ${c.name}` })),
      ...((pkgRes as any)?.data?.list ?? []).map((p: any) => ({ id: p.id, name: `[套餐] ${p.name}` })),
    ]
    messageTemplates.value = ((tplRes as any)?.data?.list ?? []).map((t: any) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      channel: t.channel,
      body: t.body,
      is_active: t.is_active,
    }))
  }
  catch {
    // 选项加载失败不阻塞列表
  }
}

// ===== 表单 =====
const dialogVisible = ref(false)
const saving = ref(false)
const form = reactive<{
  id: string
  code: string
  name: string
  description: string
  type: Campaign['type']
  segmentId: string
  storeId: string
  offerType: Campaign['offer_type']
  offerId: string
  channel: Campaign['channel']
  messageTemplateId: string
  startsAt: string
  endsAt: string
}>({
  id: '',
  code: '',
  name: '',
  description: '',
  type: 'manual',
  segmentId: '',
  storeId: '',
  offerType: 'none',
  offerId: '',
  channel: 'sms',
  messageTemplateId: '',
  startsAt: '',
  endsAt: '',
})

function openCreate() {
  Object.assign(form, {
    id: '',
    code: '',
    name: '',
    description: '',
    type: 'manual',
    segmentId: '',
    storeId: '',
    offerType: 'none',
    offerId: '',
    channel: 'sms',
    messageTemplateId: '',
    startsAt: '',
    endsAt: '',
  })
  dialogVisible.value = true
}

function openEdit(row: Campaign) {
  Object.assign(form, {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    type: row.type,
    segmentId: row.segment_id ?? '',
    storeId: row.store_id ?? '',
    offerType: row.offer_type ?? 'none',
    offerId: row.offer_id ?? '',
    channel: row.channel,
    messageTemplateId: row.message_template_id ?? '',
    startsAt: row.starts_at ?? '',
    endsAt: row.ends_at ?? '',
  })
  dialogVisible.value = true
}

/** 保存活动(编辑走 update,新建走 create) */
async function saveCampaign() {
  if (!form.code.trim() || !form.name.trim()) {
    useFaToast().warning('请填写编码与名称')
    return
  }
  if (form.type === 'segment' && !form.segmentId) {
    useFaToast().warning('请选择分层')
    return
  }
  // F-R-3:消息模板存在性校验(选择器数据源仅含启用模板,落库前兜底校验)
  if (form.messageTemplateId && !selectedTemplate.value) {
    useFaToast().warning('所选消息模板不存在或已停用,请重新选择')
    return
  }
  saving.value = true
  try {
    const payload = {
      code: form.code,
      name: form.name,
      description: form.description,
      type: form.type,
      segmentId: form.segmentId || null,
      storeId: form.storeId || null,
      offerType: form.offerType,
      offerId: form.offerType && form.offerType !== 'none' ? form.offerId || null : null,
      channel: form.channel,
      messageTemplateId: form.messageTemplateId || null,
      startsAt: form.startsAt || null,
      endsAt: form.endsAt || null,
    }
    if (form.id) {
      await apiMarketing.updateCampaign(form.id, payload)
    }
    else {
      await apiMarketing.createCampaign({ ...payload, tenantId: tenantId() })
    }
    useFaToast().success('保存成功')
    dialogVisible.value = false
    await loadCampaigns()
  }
  catch (e) {
    useFaToast().error('保存失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    saving.value = false
  }
}

/** 删除活动 */
async function deleteCampaign(row: Campaign) {
  try {
    await apiMarketing.deleteCampaign(row.id)
    useFaToast().success('已删除')
    await loadCampaigns()
  }
  catch (e) {
    useFaToast().error('删除失败', { description: e instanceof Error ? e.message : '' })
  }
}

// ===== 发布 =====
const publishDialogVisible = ref(false)
const publishSaving = ref(false)
const publishTarget = ref<Campaign | null>(null)
const publishCustomerIds = ref<string[]>([])
const publishCustomerOptions = ref<Array<{ label: string, value: string }>>([])
const publishResult = ref<{
  run_id: string
  run_no: number
  audience_count: number
  rule_version: string
  dispatch_count?: number
  dispatch_error?: string
  idempotent?: boolean
} | null>(null)

/** 加载手动名单客户选项 */
async function loadPublishCustomers(keyword = '') {
  if (!requireTenant()) {
    return
  }
  const res: any = await apiCustomer.list({ keyword, page: 1, pageSize: 50 })
  const list = res?.data?.list ?? []
  publishCustomerOptions.value = list.map((c: any) => ({
    label: `${c.name}${c.phone ? `(${c.phone})` : ''}`,
    value: c.id,
  }))
}

/** 打开发布弹窗(manual 类型需选择名单) */
function openPublish(row: Campaign) {
  publishTarget.value = row
  publishResult.value = null
  publishCustomerIds.value = []
  publishCustomerOptions.value = []
  if (row.type === 'manual') {
    loadPublishCustomers()
  }
  publishDialogVisible.value = true
}

/** 执行发布(服务端 Snapshot Audience + 建 Run,拒绝重复发布) */
async function doPublish() {
  if (!publishTarget.value) {
    return
  }
  if (publishTarget.value.type === 'manual' && !publishCustomerIds.value.length) {
    useFaToast().warning('手动名单活动请选择至少一位客户')
    return
  }
  publishSaving.value = true
  try {
    const res: any = await apiMarketing.publishCampaign(publishTarget.value.id, {
      tenantId: tenantId(),
      customerIds: publishTarget.value.type === 'manual' ? publishCustomerIds.value : undefined,
    })
    publishResult.value = res?.data ?? null
    // F-R-3:发布后展示投递生成数(dispatch_count);生成失败时附加错误提示
    const dispatchInfo = publishResult.value?.dispatch_count != null
      ? `,已生成投递 ${publishResult.value.dispatch_count} 条`
      : ''
    useFaToast().success(`发布成功,触达 ${publishResult.value?.audience_count ?? 0} 人${dispatchInfo}`)
    if (publishResult.value?.dispatch_error) {
      useFaToast().warning(publishResult.value.dispatch_error)
    }
    await loadCampaigns()
  }
  catch (e) {
    useFaToast().error('发布失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    publishSaving.value = false
  }
}

// ===== Audience 预览 =====
const previewVisible = ref(false)
const previewLoading = ref(false)
const previewList = ref<any[]>([])
const previewTotal = ref(0)
const previewPage = ref(1)
const previewPageSize = ref(20)
const previewCampaign = ref<Campaign | null>(null)

const previewColumns = computed<TableColumn<any>[]>(() => [
  {
    accessorKey: 'customers.name',
    header: '客户',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'customers.phone',
    header: '手机号',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
])

/** 打开 Audience 预览抽屉 */
async function openPreview(row: Campaign) {
  previewCampaign.value = row
  previewVisible.value = true
  previewPage.value = 1
  await loadPreview()
}

/** 加载 Audience 快照预览 */
async function loadPreview() {
  if (!previewCampaign.value) {
    return
  }
  previewLoading.value = true
  try {
    const res: any = await apiMarketing.campaignAudiencePreview(previewCampaign.value.id, {
      tenantId: tenantId(),
      page: previewPage.value,
      pageSize: previewPageSize.value,
    })
    previewList.value = res?.data?.list ?? []
    previewTotal.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error(`加载 Audience 失败: ${e instanceof Error ? e.message : ''}`)
  }
  finally {
    previewLoading.value = false
  }
}

onMounted(() => {
  loadOptions()
  loadCampaigns()
})
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告) -->
    <!--
    <EntityPageHeader compact title="营销活动">
      <template #description>
        Campaign 只负责"谁/何时/用什么权益/哪个渠道";发布时服务端快照 Audience 与规则版本,消息发送走 Messaging Contract(Agent-08)。
      </template>
    </EntityPageHeader>
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <div class="px-4 py-3 border-b flex shrink-0 items-center justify-between">
          <div class="flex gap-2 items-center">
            <FaSelect
              v-model="statusFilter"
              :options="[
                { label: '全部状态', value: 'all' },
                { label: '草稿', value: 'draft' },
                { label: '已排期', value: 'scheduled' },
                { label: '已发布', value: 'published' },
                { label: '已完成', value: 'completed' },
                { label: '已取消', value: 'cancelled' },
              ]"
              class="w-36"
              @change="page = 1; loadCampaigns()"
            />
            <span class="text-sm text-muted-foreground">
              共 {{ total }} 个活动;发布后不可修改
            </span>
          </div>
          <FaButton size="sm" @click="openCreate">
            <FaIcon name="i-ri:add-line" />
            新建活动
          </FaButton>
        </div>
        <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="columns"
            :data="campaigns"
            empty-text="暂无营销活动"
          >
            <template #cell-operation="{ row }">
              <div class="flex-center gap-1">
                <FaButton variant="outline" size="sm" @click="openPreview(row.original)">
                  Audience
                </FaButton>
                <FaButton
                  v-if="['draft', 'scheduled'].includes(row.original.status)"
                  variant="outline"
                  size="sm"
                  @click="openPublish(row.original)"
                >
                  发布
                </FaButton>
                <FaButton
                  v-if="['draft', 'scheduled'].includes(row.original.status)"
                  variant="outline"
                  size="sm"
                  @click="openEdit(row.original)"
                >
                  编辑
                </FaButton>
                <FaButton
                  v-if="['draft', 'scheduled', 'cancelled'].includes(row.original.status)"
                  variant="outline"
                  size="sm"
                  class="text-red-600"
                  @click="deleteCampaign(row.original)"
                >
                  删除
                </FaButton>
              </div>
            </template>
          </FaTable>
        </div>
        <FaPagination
          :page="page"
          :size="pageSize"
          :total="total"
          class="mt-2 px-4 pb-3 shrink-0"
          @page-change="p => { page = p; loadCampaigns() }"
          @size-change="s => { pageSize = s; page = 1; loadCampaigns() }"
        />
      </div>
    </div>

    <!-- 活动表单 -->
    <FaModal
      v-model="dialogVisible"
      :title="form.id ? '编辑活动' : '新建活动'"
      :show-cancel="true"
      confirm-text="保存"
      :confirm-loading="saving"
      width="720px"
      @confirm="saveCampaign"
    >
      <div class="p-2 gap-3 grid grid-cols-2">
        <FaLabel label="编码">
          <FaInput v-model="form.code" placeholder="如 CAMP_0628" />
        </FaLabel>
        <FaLabel label="名称">
          <FaInput v-model="form.name" placeholder="如 会员生日关怀" />
        </FaLabel>
        <FaLabel label="类型">
          <FaSelect
            v-model="form.type"
            :options="Object.entries(TYPE_LABELS).map(([value, label]) => ({ label, value }))"
          />
        </FaLabel>
        <FaLabel v-if="form.type === 'segment'" label="客户分层">
          <FaSelect
            v-model="form.segmentId"
            :options="segments.map(s => ({ label: s.name, value: s.id }))"
            placeholder="选择分层"
          />
        </FaLabel>
        <FaLabel v-else label="定向门店 UUID(可空)">
          <FaInput v-model="form.storeId" placeholder="留空=租户整体" />
        </FaLabel>
        <FaLabel label="渠道">
          <FaSelect
            v-model="form.channel"
            :options="Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ label, value }))"
          />
        </FaLabel>
        <FaLabel label="权益类型">
          <FaSelect
            v-model="form.offerType"
            :options="[
              { label: '无权益', value: 'none' },
              { label: '优惠券', value: 'coupon' },
              { label: '套餐', value: 'package' },
            ]"
          />
        </FaLabel>
        <FaLabel v-if="form.offerType && form.offerType !== 'none'" label="权益对象">
          <FaSelect
            v-model="form.offerId"
            :options="offers.map(o => ({ label: o.name, value: o.id }))"
            placeholder="选择券/套餐"
          />
        </FaLabel>
        <FaLabel label="消息模板(可空)" class="col-span-2">
          <FaSelect
            v-model="form.messageTemplateId"
            :options="messageTemplates.map(t => ({ label: `${t.code}(${t.name})`, value: t.id }))"
            clearable
            filterable
            placeholder="选择消息模板(发布时按模板渲染投递)"
          />
          <!-- F-R-3:模板存在性校验 + 内容预览 -->
          <div v-if="selectedTemplate" class="mt-1 text-xs text-muted-foreground rounded bg-muted px-2 py-1 whitespace-pre-wrap">
            {{ selectedTemplate.body }}
          </div>
        </FaLabel>
        <FaLabel label="开始时间">
          <FaDatePicker v-model="form.startsAt" value-type="format" />
        </FaLabel>
        <FaLabel label="结束时间">
          <FaDatePicker v-model="form.endsAt" value-type="format" />
        </FaLabel>
        <FaLabel label="说明" class="col-span-2">
          <FaInput v-model="form.description" placeholder="可选" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 发布弹窗 -->
    <FaModal
      v-model="publishDialogVisible"
      :title="`发布 · ${publishTarget?.name ?? ''}`"
      :show-cancel="!publishResult"
      confirm-text="确认发布"
      :loading="publishSaving"
      :show-confirm-button="!publishResult"
      @confirm="doPublish"
    >
      <div v-if="!publishResult" class="p-2 gap-3 grid grid-cols-1">
        <FaLabel v-if="publishTarget?.type === 'manual'" label="手动名单(可搜索)">
          <FaSelect
            v-model="publishCustomerIds"
            multiple
            filterable
            :options="publishCustomerOptions"
            placeholder="输入姓名/手机号搜索"
            @search="loadPublishCustomers"
          />
        </FaLabel>
        <p class="text-xs text-muted-foreground">
          发布将快照当前 Audience(含规则版本),生成运行记录;已发布活动不可重复发布。
        </p>
      </div>
      <div v-else class="p-2">
        <div class="text-sm gap-3 grid grid-cols-2">
          <div>运行批次:<span class="font-bold ml-1">#{{ publishResult.run_no }}</span></div>
          <div>触达人数:<span class="font-bold ml-1">{{ publishResult.audience_count }}</span></div>
          <!-- F-R-3:发布后投递进度(dispatch_count) -->
          <div>已生成投递:<span class="font-bold ml-1">{{ publishResult.dispatch_count ?? 0 }}</span></div>
          <div>规则版本:<span class="font-bold ml-1">{{ publishResult.rule_version }}</span></div>
          <div class="col-span-2">运行 ID:<span class="text-xs font-bold ml-1">{{ publishResult.run_id.slice(0, 8) }}…</span></div>
        </div>
        <div v-if="publishResult.dispatch_error" class="mt-2 text-xs text-red-600">
          {{ publishResult.dispatch_error }}
        </div>
      </div>
    </FaModal>

    <!-- Audience 预览抽屉 -->
    <FaDrawer v-model="previewVisible" :title="`Audience · ${previewCampaign?.name ?? ''}`" width="560px">
      <FaTable
        v-loading="previewLoading"
        table-root-class="overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="previewColumns"
        :data="previewList"
        empty-text="暂无 Audience(发布后生成快照)"
      />
      <FaPagination
        :page="previewPage"
        :size="previewPageSize"
        :total="previewTotal"
        class="mt-2 px-4 pb-3"
        @page-change="p => { previewPage = p; loadPreview() }"
        @size-change="s => { previewPageSize = s; previewPage = 1; loadPreview() }"
      />
    </FaDrawer>
  </div>
</template>
