<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { CustomerPackage, ServicePackage, ServicePackageItem } from '@/api/modules/marketing'
import apiCustomer from '@/api/modules/customer'
import apiMarketing from '@/api/modules/marketing'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'MarketingPackages',
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

/** 幂等键生成(crypto.randomUUID,用于购卡/核销/退款) */
function idemKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

const activeTab = ref('templates')
const TABS = [
  { label: '套餐模板', value: 'templates' },
  { label: '客户套餐', value: 'customerPackages' },
]

// ===== 套餐模板 =====
const packages = ref<ServicePackage[]>([])
const pkgTotal = ref(0)
const pkgPage = ref(1)
const pkgPageSize = ref(20)
const pkgStatus = ref('all')
const pkgLoading = ref(false)

/** 套餐明细摘要 */
function itemsText(pkg: ServicePackage): string {
  const items = pkg.items ?? []
  if (!items.length) {
    return '-'
  }
  return items.map(i => `${i.name} x${i.quantity}`).join('; ')
}

const pkgColumns = computed<TableColumn<ServicePackage>[]>(() => [
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'price', header: '售价(元)' },
  {
    accessorKey: 'validity_days',
    header: '有效期(天)',
    cell: info => (info.getValue() ? `${info.getValue()} 天` : '永久'),
  },
  {
    accessorKey: 'items',
    header: '包含项目',
    cell: info => itemsText(info.row.original),
  },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: info => (info.getValue() ? '启用' : '停用'),
  },
  {
    id: 'operation',
    header: '操作',
    width: 150,
    align: 'left',
    fixed: 'right',
  },
])

/** 加载套餐模板列表 */
async function loadPackages() {
  if (!requireTenant()) {
    return
  }
  pkgLoading.value = true
  try {
    const res: any = await apiMarketing.listPackages({ tenantId: tenantId(), isActive: pkgStatus.value === 'all' ? undefined : (pkgStatus.value as 'true' | 'false'), page: pkgPage.value, pageSize: pkgPageSize.value })
    packages.value = res?.data?.list ?? []
    pkgTotal.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error(`加载套餐失败: ${e instanceof Error ? e.message : ''}`)
  }
  finally {
    pkgLoading.value = false
  }
}

// ===== 套餐表单 =====
const pkgDialogVisible = ref(false)
const pkgSaving = ref(false)
const pkgForm = reactive<{
  id: string
  code: string
  name: string
  description: string
  price: number
  validityDays: number | null
  storeId: string
  isActive: boolean
  items: Array<{ catalogItemId: string, name: string, quantity: number }>
}>({ id: '', code: '', name: '', description: '', price: 0, validityDays: null, storeId: '', isActive: true, items: [] })

function emptyPkgItem() {
  return { catalogItemId: '', name: '', quantity: 1 }
}

function openCreatePkg() {
  Object.assign(pkgForm, {
    id: '',
    code: '',
    name: '',
    description: '',
    price: 0,
    validityDays: null,
    storeId: '',
    isActive: true,
    items: [emptyPkgItem()],
  })
  pkgDialogVisible.value = true
}

function openEditPkg(row: ServicePackage) {
  Object.assign(pkgForm, {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    price: Number(row.price),
    validityDays: row.validity_days == null ? null : Number(row.validity_days),
    storeId: row.store_id ?? '',
    isActive: row.is_active,
    items: (row.items ?? []).map(i => ({ catalogItemId: i.catalog_item_id ?? '', name: i.name, quantity: i.quantity })),
  })
  if (!pkgForm.items.length) {
    pkgForm.items = [emptyPkgItem()]
  }
  pkgDialogVisible.value = true
}

function addPkgItem() {
  pkgForm.items.push(emptyPkgItem())
}

function removePkgItem(index: number) {
  pkgForm.items.splice(index, 1)
}

/** 保存套餐模板(编辑走 update,新建走 create;带 items 时整体重写明细) */
async function savePkg() {
  if (!pkgForm.code.trim() || !pkgForm.name.trim()) {
    useFaToast().warning('请填写编码与名称')
    return
  }
  const validItems = pkgForm.items.filter(i => i.name.trim() && i.quantity > 0)
  if (!validItems.length) {
    useFaToast().warning('请至少添加一个明细项目')
    return
  }
  pkgSaving.value = true
  try {
    const payload = {
      code: pkgForm.code,
      name: pkgForm.name,
      description: pkgForm.description,
      price: pkgForm.price,
      validityDays: pkgForm.validityDays,
      storeId: pkgForm.storeId || null,
      isActive: pkgForm.isActive,
      items: validItems.map(i => ({ catalogItemId: i.catalogItemId || null, name: i.name, quantity: i.quantity })),
    }
    if (pkgForm.id) {
      await apiMarketing.updatePackage(pkgForm.id, payload)
    }
    else {
      await apiMarketing.createPackage({ ...payload, tenantId: tenantId() })
    }
    useFaToast().success('保存成功')
    pkgDialogVisible.value = false
    await loadPackages()
  }
  catch (e) {
    useFaToast().error('保存失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    pkgSaving.value = false
  }
}

// ===== 购卡 =====
const buyDialogVisible = ref(false)
const buySaving = ref(false)
const buyTarget = ref<ServicePackage | null>(null)
const buyCustomerId = ref('')
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

function openBuy(row: ServicePackage) {
  buyTarget.value = row
  buyCustomerId.value = ''
  customerSearchKeyword.value = ''
  loadCustomerOptions()
  buyDialogVisible.value = true
}

/** 确认购卡(幂等开卡,返回 total_quantity) */
async function doBuy() {
  if (!buyTarget.value) {
    return
  }
  if (!buyCustomerId.value) {
    useFaToast().warning('请选择客户')
    return
  }
  buySaving.value = true
  try {
    const res: any = await apiMarketing.purchasePackage(buyTarget.value.id, {
      tenantId: tenantId(),
      customerId: buyCustomerId.value,
      storeId: tenantStore.currentStoreId || '',
      idempotencyKey: idemKey(),
    })
    useFaToast().success(`开卡成功,共 ${res?.data?.total_quantity ?? 0} 次`)
    buyDialogVisible.value = false
    await loadCustomerPackages()
  }
  catch (e) {
    useFaToast().error('开卡失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    buySaving.value = false
  }
}

// ===== 客户套餐 =====
const custPackages = ref<CustomerPackage[]>([])
const custTotal = ref(0)
const custPage = ref(1)
const custPageSize = ref(20)
const custStatus = ref('')
const custLoading = ref(false)

const custColumns = computed<TableColumn<CustomerPackage>[]>(() => [
  {
    accessorKey: 'customers.name',
    header: '客户',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'service_packages.name',
    header: '套餐',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  { accessorKey: 'remaining_quantity', header: '剩余次数' },
  { accessorKey: 'total_quantity', header: '总次数' },
  {
    accessorKey: 'valid_from',
    header: '有效期',
    cell: (info) => {
      const row = info.row.original as CustomerPackage
      const from = row.valid_from ? String(row.valid_from).slice(0, 10) : ''
      const until = row.expires_at ? String(row.expires_at).slice(0, 10) : '永久'
      return `${from} ~ ${until}`
    },
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const map: Record<string, string> = { active: '生效中', expired: '已过期', refunded: '已退款', cancelled: '已取消' }
      return map[String(info.getValue())] ?? String(info.getValue())
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 170,
    align: 'left',
    fixed: 'right',
  },
])

/** 加载客户套餐列表 */
async function loadCustomerPackages() {
  if (!requireTenant()) {
    return
  }
  custLoading.value = true
  try {
    const res: any = await apiMarketing.listCustomerPackages({
      tenantId: tenantId(),
      status: (custStatus.value || undefined) as any,
      page: custPage.value,
      pageSize: custPageSize.value,
    })
    custPackages.value = res?.data?.list ?? []
    custTotal.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error('加载客户套餐失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    custLoading.value = false
  }
}

// ===== 核销 / 退款 =====
const redeemDialogVisible = ref(false)
const redeemSaving = ref(false)
const redeemTarget = ref<CustomerPackage | null>(null)
const redeemItems = ref<ServicePackageItem[]>([])
const redeemItemId = ref('')

/** 打开核销弹窗,加载套餐明细供选择 */
async function openRedeem(row: CustomerPackage) {
  redeemTarget.value = row
  redeemItemId.value = ''
  redeemDialogVisible.value = true
  const pkgId = row.service_packages?.id ?? row.package_id
  const found = packages.value.find(p => p.id === pkgId)
  if (found?.items?.length) {
    redeemItems.value = found.items
  }
  else {
    // 套餐 items 未随列表返回时,重新拉取套餐模板
    try {
      const res: any = await apiMarketing.listPackages({ tenantId: tenantId() })
      const p = (res?.data?.list ?? []).find((x: ServicePackage) => x.id === pkgId)
      redeemItems.value = p?.items ?? []
    }
    catch {
      redeemItems.value = []
    }
  }
}

/** 确认核销(服务端行锁防负 + 幂等) */
async function doRedeem() {
  if (!redeemTarget.value) {
    return
  }
  if (!redeemItemId.value) {
    useFaToast().warning('请选择核销项目')
    return
  }
  redeemSaving.value = true
  try {
    const res: any = await apiMarketing.redeemCustomerPackage(redeemTarget.value.id, {
      tenantId: tenantId(),
      customerId: redeemTarget.value.customer_id,
      storeId: tenantStore.currentStoreId || '',
      packageItemId: redeemItemId.value,
      idempotencyKey: idemKey(),
    })
    useFaToast().success(`核销成功,剩余 ${res?.data?.remaining_quantity ?? 0} 次`)
    redeemDialogVisible.value = false
    await loadCustomerPackages()
  }
  catch (e) {
    useFaToast().error('核销失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    redeemSaving.value = false
  }
}

/** 客户套餐退款(服务端幂等,状态流转 refunded) */
async function refundCust(row: CustomerPackage) {
  try {
    await apiMarketing.refundCustomerPackage(row.id, {
      tenantId: tenantId(),
      reason: '页面退款',
      idempotencyKey: idemKey(),
    })
    useFaToast().success('已退款')
    await loadCustomerPackages()
  }
  catch (e) {
    useFaToast().error(`退款失败: ${e instanceof Error ? e.message : ''}`)
  }
}

function onTabChange() {
  if (activeTab.value === 'templates') {
    loadPackages()
  }
  else {
    loadCustomerPackages()
  }
}

onMounted(() => {
  loadPackages()
})
</script>

<template>
  <!-- 绝对定位占满父容器,与回访任务等列表页保持内容区高度一致 -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告) -->
    <!--
    <EntityPageHeader compact title="套餐次卡">
      <template #description>
        套餐模板与客户次卡管理;核销次数由服务端行锁维护(防并发负次数),核销流水不可变,支持冲正与退款。
      </template>
    </EntityPageHeader>
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <div class="px-4 pt-3 border-b">
          <FaTabs v-model="activeTab" :list="TABS" class="mb-2" @update:model-value="onTabChange" />

          <!-- 套餐模板工具栏 -->
          <template v-if="activeTab === 'templates'">
            <div class="pb-3 flex items-center justify-between">
              <div class="flex gap-2 items-center">
                <FaSelect
                  v-model="pkgStatus"
                  :options="[
                    { label: '全部状态', value: 'all' },
                    { label: '启用', value: 'true' },
                    { label: '停用', value: 'false' },
                  ]"
                  class="w-36"
                  @change="pkgPage = 1; loadPackages()"
                />
                <span class="text-sm text-muted-foreground">
                  共 {{ pkgTotal }} 个套餐模板
                </span>
              </div>
              <FaButton size="sm" @click="openCreatePkg">
                <FaIcon name="i-ri:add-line" />
                新建套餐
              </FaButton>
            </div>
          </template>
          <!-- 客户套餐工具栏 -->
          <template v-else>
            <div class="pb-3 flex gap-2 items-center">
              <FaSelect
                v-model="custStatus"
                :options="[
                  { label: '全部状态', value: '' },
                  { label: '生效中', value: 'active' },
                  { label: '已过期', value: 'expired' },
                  { label: '已退款', value: 'refunded' },
                  { label: '已取消', value: 'cancelled' },
                ]"
                class="w-36"
                @change="custPage = 1; loadCustomerPackages()"
              />
              <span class="text-sm text-muted-foreground">共 {{ custTotal }} 张次卡</span>
            </div>
          </template>
        </div>

        <!-- 表格区 -->
        <div class="flex-1 min-h-0 overflow-auto">
          <template v-if="activeTab === 'templates'">
            <FaTable
              v-loading="pkgLoading"
              table-root-class="overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="pkgColumns"
              :data="packages"
              empty-text="暂无套餐模板"
            >
              <template #cell-operation="{ row }">
                <div class="flex-center gap-1">
                  <FaButton variant="outline" size="sm" @click="openBuy(row.original)">
                    购卡
                  </FaButton>
                  <FaButton variant="outline" size="sm" @click="openEditPkg(row.original)">
                    编辑
                  </FaButton>
                </div>
              </template>
            </FaTable>
          </template>
          <template v-else>
            <FaTable
              v-loading="custLoading"
              table-root-class="overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="custColumns"
              :data="custPackages"
              empty-text="暂无客户套餐"
            >
              <template #cell-operation="{ row }">
                <div class="flex-center gap-1">
                  <FaButton
                    v-if="row.original.status === 'active' && row.original.remaining_quantity > 0"
                    variant="outline"
                    size="sm"
                    @click="openRedeem(row.original)"
                  >
                    核销
                  </FaButton>
                  <FaButton
                    v-if="row.original.status === 'active'"
                    variant="outline"
                    size="sm"
                    class="text-red-600"
                    @click="refundCust(row.original)"
                  >
                    退款
                  </FaButton>
                </div>
              </template>
            </FaTable>
          </template>
        </div>

        <!-- 分页区 -->
        <FaPagination
          v-if="activeTab === 'templates'"
          :page="pkgPage"
          :size="pkgPageSize"
          :total="pkgTotal"
          class="mt-2 px-4 pb-3"
          @page-change="p => { pkgPage = p; loadPackages() }"
          @size-change="s => { pkgPageSize = s; pkgPage = 1; loadPackages() }"
        />
        <FaPagination
          v-else
          :page="custPage"
          :size="custPageSize"
          :total="custTotal"
          class="mt-2 px-4 pb-3"
          @page-change="p => { custPage = p; loadCustomerPackages() }"
          @size-change="s => { custPageSize = s; custPage = 1; loadCustomerPackages() }"
        />
      </div>
    </div>

    <!-- 套餐模板表单 -->
    <FaModal
      v-model="pkgDialogVisible"
      :title="pkgForm.id ? '编辑套餐' : '新建套餐'"
      :show-cancel="true"
      confirm-text="保存"
      :confirm-loading="pkgSaving"
      width="720px"
      @confirm="savePkg"
    >
      <div class="p-2 gap-3 grid grid-cols-2">
        <FaLabel label="编码">
          <FaInput v-model="pkgForm.code" placeholder="如 VACCINE_3" />
        </FaLabel>
        <FaLabel label="名称">
          <FaInput v-model="pkgForm.name" placeholder="如 疫苗三针套餐" />
        </FaLabel>
        <FaLabel label="售价(元)">
          <FaInputNumber v-model="pkgForm.price" :min="0" :precision="2" />
        </FaLabel>
        <FaLabel label="有效期(天,可空)">
          <FaInputNumber v-model="pkgForm.validityDays" :min="1" :precision="0" />
        </FaLabel>
        <FaLabel label="定向门店 UUID(可空)">
          <FaInput v-model="pkgForm.storeId" placeholder="留空=全门店" />
        </FaLabel>
        <FaLabel label="启用">
          <FaSwitch v-model="pkgForm.isActive" />
        </FaLabel>
        <FaLabel label="说明" class="col-span-2">
          <FaInput v-model="pkgForm.description" placeholder="可选" />
        </FaLabel>
      </div>
      <div class="px-2">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-sm text-muted-foreground">包含项目({{ pkgForm.items.length }})</span>
          <FaButton size="sm" variant="outline" @click="addPkgItem">
            <FaIcon name="i-ri:add-line" />
            添加项目
          </FaButton>
        </div>
        <div
          v-for="(item, index) in pkgForm.items"
          :key="index"
          class="mb-2 gap-2 grid grid-cols-[1fr_90px_100px_36px] items-center"
        >
          <FaInput v-model="item.name" size="small" placeholder="项目名称" />
          <FaInput v-model="item.catalogItemId" size="small" placeholder="目录UUID(可空)" />
          <FaInputNumber v-model="item.quantity" size="small" :min="1" :precision="0" placeholder="次数" />
          <FaButton variant="ghost" size="sm" class="text-red-600" @click="removePkgItem(index)">
            <FaIcon name="i-ri:delete-bin-line" />
          </FaButton>
        </div>
      </div>
    </FaModal>

    <!-- 购卡弹窗 -->
    <FaModal
      v-model="buyDialogVisible"
      :title="`购卡 · ${buyTarget?.name ?? ''}`"
      :show-cancel="true"
      confirm-text="确认开卡"
      :confirm-loading="buySaving"
      @confirm="doBuy"
    >
      <div class="p-2 gap-3 grid grid-cols-1">
        <FaLabel label="选择客户(可搜索)">
          <FaSelect
            v-model="buyCustomerId"
            filterable
            :options="customerOptions"
            placeholder="输入姓名/手机号搜索"
            @search="loadCustomerOptions"
          />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 核销弹窗 -->
    <FaModal
      v-model="redeemDialogVisible"
      :title="`核销 · ${redeemTarget?.service_packages?.name ?? ''}`"
      :show-cancel="true"
      confirm-text="确认核销"
      :loading="redeemSaving"
      @confirm="doRedeem"
    >
      <div class="p-2 gap-3 grid grid-cols-1">
        <FaLabel label="核销项目">
          <FaSelect
            v-model="redeemItemId"
            :options="redeemItems.map(i => ({ label: `${i.name} x${i.quantity}`, value: i.id }))"
            placeholder="选择核销项目"
          />
        </FaLabel>
        <p class="text-xs text-muted-foreground">
          核销在服务端执行:行锁防并发,次数不足将拒绝;流水不可变。
        </p>
      </div>
    </FaModal>
  </div>
</template>
