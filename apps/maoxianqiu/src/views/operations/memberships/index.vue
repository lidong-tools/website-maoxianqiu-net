<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  CustomerMembershipWithCustomer,
  MembershipDiscountRule,
  MembershipTier,
  PointReason,
  PointTransactionWithCustomer,
} from '@/types/operations'
import apiOperations from '@/api/modules/operations'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { BILLING_TYPE_LABELS } from '@/types/catalog'

defineOptions({
  name: 'OperationsMemberships',
})

const tenantStore = useAppTenantStore()

const activeTab = ref('tiers')

const TABS = [
  { label: '会员等级', value: 'tiers' },
  { label: '客户会员', value: 'customers' },
  { label: '积分流水', value: 'points' },
  { label: '折扣规则', value: 'rules' },
]

function tenantId(): string {
  return tenantStore.currentTenantId || ''
}

function requireTenant(): boolean {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户与门店')
    return false
  }
  return true
}

// ===== 会员等级 =====
const tiers = ref<MembershipTier[]>([])
const tierLoading = ref(false)
const tierDialogVisible = ref(false)
const tierSaving = ref(false)
const tierForm = reactive({
  id: '',
  code: '',
  name: '',
  discountPercent: 100,
  pointsMultiplier: 1,
  isActive: true,
  sortOrder: 0,
})

const tierColumns = computed<TableColumn<MembershipTier>[]>(() => [
  { accessorKey: 'code', header: '等级编码' },
  { accessorKey: 'name', header: '等级名称' },
  {
    accessorKey: 'discount_percent',
    header: '基础折扣',
    cell: info => discountText(Number(info.getValue())),
  },
  {
    accessorKey: 'points_multiplier',
    header: '积分倍率',
    cell: info => `${Number(info.getValue()).toFixed(2)}x`,
  },
  { accessorKey: 'sort_order', header: '排序' },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: info => (info.getValue() ? '启用' : '停用'),
  },
  {
    id: 'operation',
    header: '操作',
    width: 150,
    align: 'center',
    fixed: 'right',
  },
])

async function loadTiers() {
  if (!requireTenant()) {
    return
  }
  tierLoading.value = true
  try {
    const res: any = await apiOperations.listMembershipTiersApi({ tenantId: tenantId() })
    tiers.value = res?.data?.list ?? []
  }
  catch (e) {
    useFaToast().error('加载会员等级失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    tierLoading.value = false
  }
}

function openCreateTier() {
  Object.assign(tierForm, {
    id: '',
    code: '',
    name: '',
    discountPercent: 100,
    pointsMultiplier: 1,
    isActive: true,
    sortOrder: tiers.value.length,
  })
  tierDialogVisible.value = true
}

function openEditTier(row: MembershipTier) {
  Object.assign(tierForm, {
    id: row.id,
    code: row.code,
    name: row.name,
    discountPercent: Number(row.discount_percent),
    pointsMultiplier: Number(row.points_multiplier),
    isActive: row.is_active,
    sortOrder: row.sort_order,
  })
  tierDialogVisible.value = true
}

async function saveTier() {
  if (!tierForm.code.trim() || !tierForm.name.trim()) {
    useFaToast().warning('请填写等级编码与名称')
    return
  }
  tierSaving.value = true
  try {
    if (tierForm.id) {
      await apiOperations.updateMembershipTier(tierForm.id, {
        code: tierForm.code,
        name: tierForm.name,
        discountPercent: tierForm.discountPercent,
        pointsMultiplier: tierForm.pointsMultiplier,
        isActive: tierForm.isActive,
        sortOrder: tierForm.sortOrder,
      })
    }
    else {
      await apiOperations.createMembershipTier({
        tenantId: tenantId(),
        code: tierForm.code,
        name: tierForm.name,
        discountPercent: tierForm.discountPercent,
        pointsMultiplier: tierForm.pointsMultiplier,
        isActive: tierForm.isActive,
        sortOrder: tierForm.sortOrder,
      })
    }
    useFaToast().success('保存成功')
    tierDialogVisible.value = false
    await loadTiers()
  }
  catch (e) {
    useFaToast().error('保存失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    tierSaving.value = false
  }
}

async function toggleTierActive(row: MembershipTier) {
  await apiOperations.updateMembershipTier(row.id, { isActive: !row.is_active })
  await loadTiers()
}

// ===== 客户会员 =====
const customers = ref<CustomerMembershipWithCustomer[]>([])
const customerLoading = ref(false)
const customerKeyword = ref('')
const customerTotal = ref(0)
const customerPage = ref(1)
const customerPageSize = ref(20)
const customerDialogVisible = ref(false)
const customerSaving = ref(false)
const customerForm = reactive<{
  id: string
  customerName: string
  tierId: string
  expiresAt: string
}>({ id: '', customerName: '', tierId: '', expiresAt: '' })

const customerColumns = computed<TableColumn<CustomerMembershipWithCustomer>[]>(() => [
  {
    accessorKey: 'customer.name',
    header: '客户',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'customer.phone',
    header: '手机号',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'tier.name',
    header: '等级',
    cell: info => (info.getValue() as string | null) ?? '未分配',
  },
  { accessorKey: 'points_balance', header: '积分' },
  {
    accessorKey: 'joined_at',
    header: '加入时间',
    cell: info => String(info.getValue() ?? '-').slice(0, 10),
  },
  {
    accessorKey: 'expires_at',
    header: '到期时间',
    cell: info => (info.getValue() ? String(info.getValue()).slice(0, 10) : '永久'),
  },
  {
    id: 'operation',
    header: '操作',
    width: 120,
    align: 'center',
    fixed: 'right',
  },
])

async function loadCustomers() {
  if (!requireTenant()) {
    return
  }
  customerLoading.value = true
  try {
    const res: any = await apiOperations.listCustomerMemberships({
      tenantId: tenantId(),
      keyword: customerKeyword.value.trim() || undefined,
      from: (customerPage.value - 1) * customerPageSize.value,
      limit: customerPageSize.value,
    })
    customers.value = res?.data?.list ?? []
    customerTotal.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error('加载客户会员失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    customerLoading.value = false
  }
}

function openEditCustomer(row: CustomerMembershipWithCustomer) {
  Object.assign(customerForm, {
    id: row.id,
    customerName: row.customer?.name ?? '客户',
    tierId: row.tier_id ?? '',
    expiresAt: row.expires_at ? String(row.expires_at).slice(0, 10) : '',
  })
  customerDialogVisible.value = true
}

async function saveCustomer() {
  customerSaving.value = true
  try {
    await apiOperations.updateCustomerMembership(customerForm.id, {
      tierId: customerForm.tierId || undefined,
      expiresAt: customerForm.expiresAt || null,
    })
    useFaToast().success('保存成功')
    customerDialogVisible.value = false
    await loadCustomers()
  }
  catch (e) {
    useFaToast().error('保存失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    customerSaving.value = false
  }
}

// ===== 积分流水 =====
const points = ref<PointTransactionWithCustomer[]>([])
const pointsLoading = ref(false)
const pointsTotal = ref(0)
const pointsPage = ref(1)
const pointsPageSize = ref(20)

const POINT_REASON_LABELS: Record<PointReason, string> = {
  purchase: '消费获得',
  redeem: '积分兑换',
  adjust: '手工调整',
  expiry: '到期失效',
}

const pointColumns = computed<TableColumn<PointTransactionWithCustomer>[]>(() => [
  {
    accessorKey: 'customer.name',
    header: '客户',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'delta',
    header: '变动',
    cell: (info) => {
      const v = Number(info.getValue())
      return `<span class="${v > 0 ? 'text-green-600' : 'text-red-600'}">${v > 0 ? '+' : ''}${v}</span>`
    },
  },
  {
    accessorKey: 'reason',
    header: '原因',
    cell: info => POINT_REASON_LABELS[info.getValue() as PointReason] ?? info.getValue(),
  },
  { accessorKey: 'balance_after', header: '余额' },
  {
    accessorKey: 'created_at',
    header: '时间',
    cell: info => String(info.getValue() ?? '-').slice(0, 19).replace('T', ' '),
  },
])

async function loadPoints() {
  if (!requireTenant()) {
    return
  }
  pointsLoading.value = true
  try {
    const res: any = await apiOperations.listPointTransactionsApi({
      tenantId: tenantId(),
      from: (pointsPage.value - 1) * pointsPageSize.value,
      limit: pointsPageSize.value,
    })
    points.value = res?.data?.list ?? []
    pointsTotal.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error('加载积分流水失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    pointsLoading.value = false
  }
}

// ===== 折扣规则 =====
const rules = ref<MembershipDiscountRule[]>([])
const rulesLoading = ref(false)
const ruleDialogVisible = ref(false)
const ruleSaving = ref(false)
const ruleForm = reactive<{
  id: string
  tierId: string
  storeId: string
  catalogItemId: string
  catalogType: string
  discountPercent: number
  priority: number
  isActive: boolean
}>({ id: '', tierId: '', storeId: '', catalogItemId: '', catalogType: '', discountPercent: 100, priority: 100, isActive: true })

const ruleColumns = computed<TableColumn<MembershipDiscountRule>[]>(() => [
  {
    accessorKey: 'tier.name',
    header: '等级',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'store_id',
    header: '适用门店',
    cell: info => (info.getValue() ? '指定门店' : '全门店'),
  },
  {
    accessorKey: 'catalog_item_id',
    header: '定向项目',
    cell: info => (info.getValue() ? '指定项目' : '不限'),
  },
  {
    accessorKey: 'catalog_type',
    header: '定向类型',
    cell: info => (info.getValue() ? (BILLING_TYPE_LABELS[info.getValue() as keyof typeof BILLING_TYPE_LABELS] ?? info.getValue()) : '不限'),
  },
  {
    accessorKey: 'discount_percent',
    header: '收取比例',
    cell: info => discountText(Number(info.getValue())),
  },
  { accessorKey: 'priority', header: '优先级' },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: info => (info.getValue() ? '启用' : '停用'),
  },
  {
    id: 'operation',
    header: '操作',
    width: 150,
    align: 'center',
    fixed: 'right',
  },
])

async function loadRules() {
  if (!requireTenant()) {
    return
  }
  rulesLoading.value = true
  try {
    const res: any = await apiOperations.listDiscountRules({ tenantId: tenantId() })
    rules.value = res?.data?.list ?? []
  }
  catch (e) {
    useFaToast().error('加载折扣规则失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    rulesLoading.value = false
  }
}

function openCreateRule() {
  Object.assign(ruleForm, {
    id: '',
    tierId: tiers.value[0]?.id ?? '',
    storeId: '',
    catalogItemId: '',
    catalogType: '',
    discountPercent: 100,
    priority: 100,
    isActive: true,
  })
  ruleDialogVisible.value = true
}

function openEditRule(row: MembershipDiscountRule) {
  Object.assign(ruleForm, {
    id: row.id,
    tierId: row.tier_id,
    storeId: row.store_id ?? '',
    catalogItemId: row.catalog_item_id ?? '',
    catalogType: row.catalog_type ?? '',
    discountPercent: Number(row.discount_percent),
    priority: row.priority,
    isActive: row.is_active,
  })
  ruleDialogVisible.value = true
}

async function saveRule() {
  if (!ruleForm.tierId) {
    useFaToast().warning('请选择等级')
    return
  }
  ruleSaving.value = true
  try {
    const payload = {
      tierId: ruleForm.tierId,
      storeId: ruleForm.storeId || null,
      catalogItemId: ruleForm.catalogItemId || null,
      catalogType: ruleForm.catalogType || null,
      discountPercent: ruleForm.discountPercent,
      priority: ruleForm.priority,
      isActive: ruleForm.isActive,
    }
    if (ruleForm.id) {
      await apiOperations.updateDiscountRule(ruleForm.id, payload)
    }
    else {
      await apiOperations.createDiscountRule({ ...payload, tenantId: tenantId() })
    }
    useFaToast().success('保存成功')
    ruleDialogVisible.value = false
    await loadRules()
  }
  catch (e) {
    useFaToast().error('保存失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    ruleSaving.value = false
  }
}

async function deleteRule(row: MembershipDiscountRule) {
  await apiOperations.deleteDiscountRule(row.id)
  useFaToast().success('已删除')
  await loadRules()
}

function discountText(v: number): string {
  if (v >= 100) {
    return '不打折'
  }
  return `${v.toFixed(2)}% 收取`
}

function onTabChange() {
  if (activeTab.value === 'tiers') {
    loadTiers()
  }
  else if (activeTab.value === 'customers') {
    loadCustomers()
  }
  else if (activeTab.value === 'points') {
    loadPoints()
  }
  else if (activeTab.value === 'rules') {
    loadTiers().then(() => loadRules())
  }
}

onMounted(() => {
  loadTiers()
})
</script>

<template>
  <div>
    <EntityPageHeader compact title="会员中心">
      <template #description>
        会员等级、客户会员关系、积分流水与会员折扣规则的统一管理;会员折扣在收银时按规则自动计算并写入价格快照。
      </template>
    </EntityPageHeader>
    <FaPageMain>
      <FaTabs v-model="activeTab" :list="TABS" class="mb-4" @change="onTabChange" />

      <!-- 会员等级 -->
      <template v-if="activeTab === 'tiers'">
        <div class="mb-3 flex items-center justify-between">
          <div class="text-sm text-muted-foreground">
            共 {{ tiers.length }} 个等级;折扣按 100%=不打折,90=9折
          </div>
          <FaButton size="sm" @click="openCreateTier">
            <FaIcon name="i-ri:add-line" />
            新建等级
          </FaButton>
        </div>
        <FaTable
          v-loading="tierLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="tierColumns"
          :data="tiers"
          empty-text="暂无会员等级"
        >
          <template #cell-operation="{ row }">
            <div class="flex-center gap-1">
              <FaButton variant="outline" size="sm" @click="openEditTier(row.original)">
                编辑
              </FaButton>
              <FaButton variant="outline" size="sm" @click="toggleTierActive(row.original)">
                {{ row.original.is_active ? '停用' : '启用' }}
              </FaButton>
            </div>
          </template>
        </FaTable>
      </template>

      <!-- 客户会员 -->
      <template v-else-if="activeTab === 'customers'">
        <div class="mb-3 flex gap-2 items-center">
          <FaInput v-model="customerKeyword" placeholder="按姓名/手机号搜索" class="w-64" @keyup.enter="loadCustomers" />
          <FaButton size="sm" variant="outline" @click="loadCustomers">
            <FaIcon name="i-ri:search-line" />
            查询
          </FaButton>
        </div>
        <FaTable
          v-loading="customerLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="customerColumns"
          :data="customers"
          empty-text="暂无客户会员"
        >
          <template #cell-operation="{ row }">
            <FaButton variant="outline" size="sm" @click="openEditCustomer(row.original)">
              调整等级
            </FaButton>
          </template>
        </FaTable>
        <FaPagination
          :page="customerPage"
          :size="customerPageSize"
          :total="customerTotal"
          class="mt-2 px-4 pb-3"
          @page-change="p => { customerPage = p; loadCustomers() }"
          @size-change="s => { customerPageSize = s; customerPage = 1; loadCustomers() }"
        />
      </template>

      <!-- 积分流水 -->
      <template v-else-if="activeTab === 'points'">
        <div class="text-sm text-muted-foreground mb-3">
          积分流水不可修改;余额由系统在消费/兑换/调整时维护
        </div>
        <FaTable
          v-loading="pointsLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="pointColumns"
          :data="points"
          empty-text="暂无积分流水"
        />
        <FaPagination
          :page="pointsPage"
          :size="pointsPageSize"
          :total="pointsTotal"
          class="mt-2 px-4 pb-3"
          @page-change="p => { pointsPage = p; loadPoints() }"
          @size-change="s => { pointsPageSize = s; pointsPage = 1; loadPoints() }"
        />
      </template>

      <!-- 折扣规则 -->
      <template v-else-if="activeTab === 'rules'">
        <div class="mb-3 flex items-center justify-between">
          <div class="text-sm text-muted-foreground">
            匹配优先级:具体项目 &gt; 目录类型 &gt; 等级默认;同维度下指定门店 &gt; 全门店
          </div>
          <FaButton size="sm" @click="openCreateRule">
            <FaIcon name="i-ri:add-line" />
            新建规则
          </FaButton>
        </div>
        <FaTable
          v-loading="rulesLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="ruleColumns"
          :data="rules"
          empty-text="暂无折扣规则(未配置时按等级默认折扣)"
        >
          <template #cell-operation="{ row }">
            <div class="flex-center gap-1">
              <FaButton variant="outline" size="sm" @click="openEditRule(row.original)">
                编辑
              </FaButton>
              <FaButton variant="outline" size="sm" class="text-red-600" @click="deleteRule(row.original)">
                删除
              </FaButton>
            </div>
          </template>
        </FaTable>
      </template>
    </FaPageMain>

    <!-- 会员等级表单 -->
    <FaModal v-model="tierDialogVisible" :title="tierForm.id ? '编辑等级' : '新建等级'" :show-cancel="true" confirm-text="保存" @confirm="saveTier">
      <div class="p-2 gap-3 grid grid-cols-2">
        <FaLabel label="等级编码">
          <FaInput v-model="tierForm.code" placeholder="如 GOLD" />
        </FaLabel>
        <FaLabel label="等级名称">
          <FaInput v-model="tierForm.name" placeholder="如 金卡会员" />
        </FaLabel>
        <FaLabel label="基础折扣(收取比例)">
          <FaInputNumber v-model="tierForm.discountPercent" :min="0" :max="100" :precision="2" />
        </FaLabel>
        <FaLabel label="积分倍率">
          <FaInputNumber v-model="tierForm.pointsMultiplier" :min="0" :max="100" :precision="2" />
        </FaLabel>
        <FaLabel label="排序">
          <FaInputNumber v-model="tierForm.sortOrder" :min="0" :precision="0" />
        </FaLabel>
        <FaLabel label="启用">
          <FaSwitch v-model="tierForm.isActive" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 客户会员表单 -->
    <FaModal v-model="customerDialogVisible" :title="`调整等级 · ${customerForm.customerName}`" :show-cancel="true" confirm-text="保存" @confirm="saveCustomer">
      <div class="p-2 gap-3 grid grid-cols-1">
        <FaLabel label="等级">
          <FaSelect
            v-model="customerForm.tierId"
            :options="tiers.map(t => ({ label: t.name, value: t.id }))"
            placeholder="选择会员等级"
          />
        </FaLabel>
        <FaLabel label="到期时间(留空=永久)">
          <FaDatePicker v-model="customerForm.expiresAt" value-type="format" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 折扣规则表单 -->
    <FaModal v-model="ruleDialogVisible" :title="ruleForm.id ? '编辑规则' : '新建规则'" :show-cancel="true" confirm-text="保存" @confirm="saveRule">
      <div class="p-2 gap-3 grid grid-cols-2">
        <FaLabel label="等级">
          <FaSelect
            v-model="ruleForm.tierId"
            :options="tiers.map(t => ({ label: t.name, value: t.id }))"
            placeholder="选择等级"
          />
        </FaLabel>
        <FaLabel label="定向项目">
          <FaInput v-model="ruleForm.catalogItemId" placeholder="项目 UUID(留空=不限)" />
        </FaLabel>
        <FaLabel label="定向类型">
          <FaSelect
            v-model="ruleForm.catalogType"
            :options="[
              { label: '不限', value: '' },
              ...Object.entries(BILLING_TYPE_LABELS).map(([value, label]) => ({ label, value })),
            ]"
          />
        </FaLabel>
        <FaLabel label="收取比例">
          <FaInputNumber v-model="ruleForm.discountPercent" :min="0" :max="100" :precision="2" />
        </FaLabel>
        <FaLabel label="优先级(小=优先)">
          <FaInputNumber v-model="ruleForm.priority" :min="0" :precision="0" />
        </FaLabel>
        <FaLabel label="启用">
          <FaSwitch v-model="ruleForm.isActive" />
        </FaLabel>
      </div>
    </FaModal>
  </div>
</template>
