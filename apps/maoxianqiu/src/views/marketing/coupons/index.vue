<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { Coupon, CouponIssue } from '@/api/modules/marketing'
import apiCustomer from '@/api/modules/customer'
import apiMarketing from '@/api/modules/marketing'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { BILLING_TYPE_LABELS } from '@/types/catalog'

defineOptions({
  name: 'MarketingCoupons',
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

const activeTab = ref('templates')
const TABS = [
  { label: '券模板', value: 'templates' },
  { label: '发放记录', value: 'issues' },
]

// ===== 券模板 =====
const coupons = ref<Coupon[]>([])
const couponTotal = ref(0)
const couponPage = ref(1)
const couponPageSize = ref(20)
const couponType = ref<'all' | 'fixed' | 'percentage'>('all')
const couponLoading = ref(false)

/** 券额度文本(固定金额/折扣百分比) */
function couponValueText(row: Coupon): string {
  return row.type === 'fixed' ? `¥${Number(row.value).toFixed(2)}` : `${Number(row.value)}% off`
}

const couponColumns = computed<TableColumn<Coupon>[]>(() => [
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'name', header: '名称' },
  {
    accessorKey: 'type',
    header: '类型',
    cell: info => (info.getValue() === 'fixed' ? '满减券' : '折扣券'),
  },
  {
    accessorKey: 'value',
    header: '额度',
    cell: info => couponValueText(info.row.original),
  },
  { accessorKey: 'min_spend', header: '最低消费' },
  {
    accessorKey: 'valid_from',
    header: '有效期',
    cell: (info) => {
      const row = info.row.original as Coupon
      const from = row.valid_from ? String(row.valid_from).slice(0, 10) : '不限'
      const until = row.valid_until ? String(row.valid_until).slice(0, 10) : '不限'
      return `${from} ~ ${until}`
    },
  },
  { accessorKey: 'used_count', header: '已用/总量' },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: info => (info.getValue() ? '启用' : '停用'),
  },
  {
    id: 'operation',
    header: '操作',
    width: 210,
    align: 'left',
    fixed: 'right',
  },
])

/** 加载券模板列表 */
async function loadCoupons() {
  if (!requireTenant()) {
    return
  }
  couponLoading.value = true
  try {
    const res: any = await apiMarketing.listCoupons({ tenantId: tenantId(), type: couponType.value === 'all' ? undefined : couponType.value, page: couponPage.value, pageSize: couponPageSize.value })
    coupons.value = res?.data?.list ?? []
    couponTotal.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error('加载优惠券失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    couponLoading.value = false
  }
}

// ===== 券表单 =====
const couponDialogVisible = ref(false)
const couponSaving = ref(false)
const couponForm = reactive<{
  id: string
  code: string
  name: string
  type: 'fixed' | 'percentage'
  value: number
  minSpend: number
  maxDiscount: number | null
  catalogType: string
  catalogItemId: string
  storeId: string
  validFrom: string
  validUntil: string
  quota: number
  perCustomerLimit: number
  stackingPolicy: 'single' | 'stackable'
  isActive: boolean
}>({
  id: '',
  code: '',
  name: '',
  type: 'fixed',
  value: 0,
  minSpend: 0,
  maxDiscount: null,
  catalogType: '',
  catalogItemId: '',
  storeId: '',
  validFrom: '',
  validUntil: '',
  quota: 100,
  perCustomerLimit: 1,
  stackingPolicy: 'single',
  isActive: true,
})

function openCreateCoupon() {
  Object.assign(couponForm, {
    id: '',
    code: '',
    name: '',
    type: 'fixed',
    value: 0,
    minSpend: 0,
    maxDiscount: null,
    catalogType: '',
    catalogItemId: '',
    storeId: '',
    validFrom: '',
    validUntil: '',
    quota: 100,
    perCustomerLimit: 1,
    stackingPolicy: 'single',
    isActive: true,
  })
  couponDialogVisible.value = true
}

function openEditCoupon(row: Coupon) {
  Object.assign(couponForm, {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    value: Number(row.value),
    minSpend: Number(row.min_spend),
    maxDiscount: row.max_discount == null ? null : Number(row.max_discount),
    catalogType: row.catalog_type ?? '',
    catalogItemId: row.catalog_item_id ?? '',
    storeId: row.store_id ?? '',
    validFrom: row.valid_from ?? '',
    validUntil: row.valid_until ?? '',
    quota: row.quota,
    perCustomerLimit: row.per_customer_limit,
    stackingPolicy: row.stacking_policy,
    isActive: row.is_active,
  })
  couponDialogVisible.value = true
}

/** 保存券模板(编辑走 update,新建走 create) */
async function saveCoupon() {
  if (!couponForm.code.trim() || !couponForm.name.trim()) {
    useFaToast().warning('请填写编码与名称')
    return
  }
  couponSaving.value = true
  try {
    const payload = {
      code: couponForm.code,
      name: couponForm.name,
      type: couponForm.type,
      value: couponForm.value,
      minSpend: couponForm.minSpend,
      maxDiscount: couponForm.maxDiscount,
      catalogType: couponForm.catalogType || null,
      catalogItemId: couponForm.catalogItemId || null,
      storeId: couponForm.storeId || null,
      validFrom: couponForm.validFrom || null,
      validUntil: couponForm.validUntil || null,
      quota: couponForm.quota,
      perCustomerLimit: couponForm.perCustomerLimit,
      stackingPolicy: couponForm.stackingPolicy,
      isActive: couponForm.isActive,
    }
    if (couponForm.id) {
      await apiMarketing.updateCoupon(couponForm.id, payload)
    }
    else {
      await apiMarketing.createCoupon({ ...payload, tenantId: tenantId() })
    }
    useFaToast().success('保存成功')
    couponDialogVisible.value = false
    await loadCoupons()
  }
  catch (e) {
    useFaToast().error('保存失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    couponSaving.value = false
  }
}

// ===== 发放 =====
const issueDialogVisible = ref(false)
const issueSaving = ref(false)
const issueTarget = ref<Coupon | null>(null)
const issueCustomerIds = ref<string[]>([])
const customerOptions = ref<Array<{ label: string, value: string }>>([])
const customerSearchKeyword = ref('')

/** 远程加载客户下拉选项(按姓名/手机号搜索,最多 50 条) */
async function loadCustomerOptions(keyword = '') {
  if (!requireTenant()) {
    return
  }
  const res: any = await apiCustomer.list({ keyword, page: 1, pageSize: 50 })
  const list = res?.data?.list ?? []
  customerOptions.value = list.map((c: any) => ({
    label: `${c.name}${c.phone ? `(${c.phone})` : ''}`,
    value: c.id,
  }))
}

function openIssue(row: Coupon) {
  issueTarget.value = row
  issueCustomerIds.value = []
  customerSearchKeyword.value = ''
  loadCustomerOptions()
  issueDialogVisible.value = true
}

/** 执行发放(服务端校验 per_customer_limit 与 quota) */
async function doIssue() {
  if (!issueTarget.value) {
    return
  }
  if (!issueCustomerIds.value.length) {
    useFaToast().warning('请选择发放客户')
    return
  }
  issueSaving.value = true
  try {
    const res: any = await apiMarketing.issueCoupon(issueTarget.value.id, {
      tenantId: tenantId(),
      customerIds: issueCustomerIds.value,
    })
    useFaToast().success(`已发放 ${res?.data?.issued ?? 0} 张`)
    issueDialogVisible.value = false
    await loadCoupons()
    if (activeTab.value === 'issues') {
      await loadIssues()
    }
  }
  catch (e) {
    useFaToast().error('发放失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    issueSaving.value = false
  }
}

// ===== 发放记录 =====
const issues = ref<CouponIssue[]>([])
const issueTotal = ref(0)
const issuePage = ref(1)
const issuePageSize = ref(20)
const issueStatus = ref('')
const issueLoading = ref(false)

const issueColumns = computed<TableColumn<CouponIssue>[]>(() => [
  {
    accessorKey: 'coupons.name',
    header: '券',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'customers.name',
    header: '客户',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  { accessorKey: 'code', header: '券码' },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const s = String(info.getValue())
      const map: Record<string, string> = { available: '可用', redeemed: '已核销', expired: '已过期', cancelled: '已作废' }
      return map[s] ?? s
    },
  },
  {
    accessorKey: 'issued_at',
    header: '发放时间',
    cell: info => String(info.getValue() ?? '-').slice(0, 19).replace('T', ' '),
  },
  {
    accessorKey: 'redeemed_at',
    header: '核销时间',
    cell: info => (info.getValue() ? String(info.getValue()).slice(0, 19).replace('T', ' ') : '-'),
  },
  {
    id: 'operation',
    header: '操作',
    width: 110,
    align: 'left',
  },
])

/** 加载发放记录 */
async function loadIssues() {
  if (!requireTenant()) {
    return
  }
  issueLoading.value = true
  try {
    const res: any = await apiMarketing.listCouponIssues({
      tenantId: tenantId(),
      status: (issueStatus.value || undefined) as any,
      page: issuePage.value,
      pageSize: issuePageSize.value,
    })
    issues.value = res?.data?.list ?? []
    issueTotal.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error('加载发放记录失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    issueLoading.value = false
  }
}

/** 作废一张未核销券(服务端校验状态) */
async function cancelIssue(row: CouponIssue) {
  try {
    await apiMarketing.cancelCouponIssue(row.id, { tenantId: tenantId(), reason: '页面作废' })
    useFaToast().success('已作废')
    await loadIssues()
  }
  catch (e) {
    useFaToast().error(`作废失败: ${e instanceof Error ? e.message : ''}`)
  }
}

function onTabChange() {
  if (activeTab.value === 'templates') {
    loadCoupons()
  }
  else {
    loadIssues()
  }
}

onMounted(() => {
  loadCoupons()
})
</script>

<template>
  <!-- 绝对定位占满父容器,与回访任务等列表页保持内容区高度一致 -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告) -->
    <!--
    <EntityPageHeader compact title="优惠券">
      <template #description>
        优惠券模板与发放管理;权威核销在服务端(行锁 + 幂等),前端不计算折扣。核销入口在收银流程。
      </template>
    </EntityPageHeader>
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <div class="px-4 pt-3 border-b">
          <FaTabs v-model="activeTab" :list="TABS" class="mb-2" @update:model-value="onTabChange" />

          <!-- 券模板工具栏 -->
          <template v-if="activeTab === 'templates'">
            <div class="pb-3 flex items-center justify-between">
              <div class="flex gap-2 items-center">
                <FaSelect
                  v-model="couponType"
                  :options="[
                    { label: '全部类型', value: 'all' },
                    { label: '满减券', value: 'fixed' },
                    { label: '折扣券', value: 'percentage' },
                  ]"
                  class="w-36"
                  @change="couponPage = 1; loadCoupons()"
                />
                <span class="text-sm text-muted-foreground">
                  共 {{ couponTotal }} 个券模板
                </span>
              </div>
              <FaButton size="sm" @click="openCreateCoupon">
                <FaIcon name="i-ri:add-line" />
                新建券
              </FaButton>
            </div>
          </template>
          <!-- 发放记录工具栏 -->
          <template v-else>
            <div class="pb-3 flex gap-2 items-center">
              <FaSelect
                v-model="issueStatus"
                :options="[
                  { label: '全部状态', value: '' },
                  { label: '可用', value: 'available' },
                  { label: '已核销', value: 'redeemed' },
                  { label: '已过期', value: 'expired' },
                  { label: '已作废', value: 'cancelled' },
                ]"
                class="w-36"
                @change="issuePage = 1; loadIssues()"
              />
              <span class="text-sm text-muted-foreground">共 {{ issueTotal }} 张</span>
            </div>
          </template>
        </div>

        <!-- 表格区 -->
        <div class="flex-1 min-h-0 overflow-auto">
          <template v-if="activeTab === 'templates'">
            <FaTable
              v-loading="couponLoading"
              table-root-class="overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="couponColumns"
              :data="coupons"
              empty-text="暂无优惠券"
            >
              <template #cell-operation="{ row }">
                <div class="flex-center gap-1">
                  <FaButton variant="outline" size="sm" @click="openIssue(row.original)">
                    发放
                  </FaButton>
                  <FaButton variant="outline" size="sm" @click="openEditCoupon(row.original)">
                    编辑
                  </FaButton>
                </div>
              </template>
            </FaTable>
          </template>
          <template v-else>
            <FaTable
              v-loading="issueLoading"
              table-root-class="overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="issueColumns"
              :data="issues"
              empty-text="暂无发放记录"
            >
              <template #cell-operation="{ row }">
                <FaButton
                  v-if="row.original.status === 'available'"
                  variant="outline"
                  size="sm"
                  class="text-red-600"
                  @click="cancelIssue(row.original)"
                >
                  作废
                </FaButton>
              </template>
            </FaTable>
          </template>
        </div>

        <!-- 分页区 -->
        <FaPagination
          v-if="activeTab === 'templates'"
          :page="couponPage"
          :size="couponPageSize"
          :total="couponTotal"
          class="mt-2 px-4 pb-3"
          @page-change="p => { couponPage = p; loadCoupons() }"
          @size-change="s => { couponPageSize = s; couponPage = 1; loadCoupons() }"
        />
        <FaPagination
          v-else
          :page="issuePage"
          :size="issuePageSize"
          :total="issueTotal"
          class="mt-2 px-4 pb-3"
          @page-change="p => { issuePage = p; loadIssues() }"
          @size-change="s => { issuePageSize = s; issuePage = 1; loadIssues() }"
        />
      </div>
    </div>

    <!-- 券模板表单 -->
    <FaModal
      v-model="couponDialogVisible"
      :title="couponForm.id ? '编辑券' : '新建券'"
      :show-cancel="true"
      confirm-text="保存"
      :confirm-loading="couponSaving"
      width="720px"
      @confirm="saveCoupon"
    >
      <div class="p-2 gap-3 grid grid-cols-2">
        <FaLabel label="编码">
          <FaInput v-model="couponForm.code" placeholder="如 SUMMER50" />
        </FaLabel>
        <FaLabel label="名称">
          <FaInput v-model="couponForm.name" placeholder="如 夏季满减券" />
        </FaLabel>
        <FaLabel label="类型">
          <FaSelect
            v-model="couponForm.type"
            :options="[
              { label: '满减券(固定金额)', value: 'fixed' },
              { label: '折扣券(百分比)', value: 'percentage' },
            ]"
          />
        </FaLabel>
        <FaLabel :label="couponForm.type === 'fixed' ? '减免金额(元)' : '折扣(%,如 90=9折)'">
          <FaInputNumber v-model="couponForm.value" :min="0" :precision="2" />
        </FaLabel>
        <FaLabel label="最低消费(元)">
          <FaInputNumber v-model="couponForm.minSpend" :min="0" :precision="2" />
        </FaLabel>
        <FaLabel label="封顶金额(元,可空)">
          <FaInputNumber v-model="couponForm.maxDiscount" :min="0" :precision="2" />
        </FaLabel>
        <FaLabel label="发放总量">
          <FaInputNumber v-model="couponForm.quota" :min="0" :precision="0" />
        </FaLabel>
        <FaLabel label="每人限领">
          <FaInputNumber v-model="couponForm.perCustomerLimit" :min="1" :precision="0" />
        </FaLabel>
        <FaLabel label="生效时间">
          <FaDatePicker v-model="couponForm.validFrom" value-type="format" />
        </FaLabel>
        <FaLabel label="失效时间">
          <FaDatePicker v-model="couponForm.validUntil" value-type="format" />
        </FaLabel>
        <FaLabel label="叠加策略">
          <FaSelect
            v-model="couponForm.stackingPolicy"
            :options="[
              { label: '单券(不叠加)', value: 'single' },
              { label: '可叠加', value: 'stackable' },
            ]"
          />
        </FaLabel>
        <FaLabel label="启用">
          <FaSwitch v-model="couponForm.isActive" />
        </FaLabel>
        <FaLabel label="定向项目类型">
          <FaSelect
            v-model="couponForm.catalogType"
            :options="[
              { label: '不限', value: '' },
              ...Object.entries(BILLING_TYPE_LABELS).map(([value, label]) => ({ label, value })),
            ]"
          />
        </FaLabel>
        <FaLabel label="定向项目 UUID(可空)">
          <FaInput v-model="couponForm.catalogItemId" placeholder="留空=不限" />
        </FaLabel>
        <FaLabel label="定向门店 UUID(可空)">
          <FaInput v-model="couponForm.storeId" placeholder="留空=全门店" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 发放弹窗 -->
    <FaModal
      v-model="issueDialogVisible"
      :title="`发放 · ${issueTarget?.name ?? ''}`"
      :show-cancel="true"
      confirm-text="确认发放"
      :loading="issueSaving"
      @confirm="doIssue"
    >
      <div class="p-2 gap-3 grid grid-cols-1">
        <FaLabel label="选择客户(可搜索)">
          <FaSelect
            v-model="issueCustomerIds"
            multiple
            filterable
            :options="customerOptions"
            placeholder="输入姓名/手机号搜索"
            @search="loadCustomerOptions"
          />
        </FaLabel>
        <p class="text-xs text-muted-foreground">
          发放遵循服务端校验:总量 quota 与每人限领 per_customer_limit。
        </p>
      </div>
    </FaModal>
  </div>
</template>
