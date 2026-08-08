<script setup lang="ts">
import type { EffectiveSettingItem } from '@/api/modules/settings'
import apiSettings from '@/api/modules/settings'
import BusinessStoreSelector from '@/components/business/StoreSelector/index.vue'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'SystemSettings',
})

const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()

const activeTab = ref('hospital')
const loading = ref(false)

const canManageTenant = computed(() => auth('settings.tenant.manage'))
const canManageStore = computed(() => auth('settings.store.manage'))

const TIMEZONE_OPTIONS = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
  'Europe/London',
  'America/New_York',
  'UTC',
]

// ===== 医院信息 =====
const tenantForm = ref({
  name: '',
  shortName: '',
  timezone: '',
  currency: '',
  locale: '',
})
const tenantSaving = ref(false)

async function loadTenant() {
  if (!tenantStore.currentTenantId) {
    return
  }
  loading.value = true
  try {
    const t = await apiSettings.getTenant(tenantStore.currentTenantId)
    tenantForm.value = {
      name: t.name ?? '',
      shortName: t.short_name ?? '',
      timezone: t.timezone ?? '',
      currency: t.currency ?? '',
      locale: t.locale ?? '',
    }
  }
  catch (e) {
    useFaToast().error('加载医院信息失败', {
      description: e instanceof Error ? e.message : '请确认服务端已部署设置接口',
    })
  }
  finally {
    loading.value = false
  }
}

async function saveTenant() {
  if (!tenantStore.currentTenantId) {
    return
  }
  tenantSaving.value = true
  try {
    await apiSettings.updateTenant(tenantStore.currentTenantId, {
      name: tenantForm.value.name,
      shortName: tenantForm.value.shortName,
      timezone: tenantForm.value.timezone,
      currency: tenantForm.value.currency,
      locale: tenantForm.value.locale,
    })
    useFaToast().success('医院信息已保存')
  }
  catch (e) {
    useFaToast().error('保存失败', {
      description: e instanceof Error ? e.message : '请稍后重试',
    })
  }
  finally {
    tenantSaving.value = false
  }
}

// ===== 门店营业 =====
const storeId = ref(tenantStore.currentStoreId)
const storeInfo = ref<any>(null)
const storeTimezone = ref('')
const hoursModel = ref<Record<string, { enabled: boolean, start: string, end: string }>>({})
const storeSaving = ref(false)
const DAYS = [
  { key: 'mon', label: '周一' },
  { key: 'tue', label: '周二' },
  { key: 'wed', label: '周三' },
  { key: 'thu', label: '周四' },
  { key: 'fri', label: '周五' },
  { key: 'sat', label: '周六' },
  { key: 'sun', label: '周日' },
]

function initHoursModel(hours: Record<string, Array<{ start: string, end: string }>> | null | undefined) {
  const model: Record<string, { enabled: boolean, start: string, end: string }> = {}
  for (const day of DAYS) {
    const list = hours?.[day.key]
    const first = Array.isArray(list) ? list[0] : null
    model[day.key] = {
      enabled: !!first,
      start: first?.start ?? '09:00',
      end: first?.end ?? '18:00',
    }
  }
  hoursModel.value = model
}

function buildBusinessHours() {
  const result: Record<string, Array<{ start: string, end: string }>> = {}
  for (const day of DAYS) {
    const m = hoursModel.value[day.key]
    if (m?.enabled && m.start && m.end) {
      result[day.key] = [{ start: m.start, end: m.end }]
    }
    else {
      result[day.key] = []
    }
  }
  return result
}

async function loadStore() {
  if (!storeId.value) {
    storeInfo.value = null
    return
  }
  loading.value = true
  try {
    const { data } = await supabase
      .from('stores')
      .select('id, name, tenant_id, timezone, business_hours')
      .eq('id', storeId.value)
      .maybeSingle()
    storeInfo.value = data ?? null
    storeTimezone.value = data?.timezone ?? ''
    initHoursModel(data?.business_hours)
  }
  catch (e) {
    useFaToast().error('加载门店设置失败', {
      description: e instanceof Error ? e.message : '请稍后重试',
    })
  }
  finally {
    loading.value = false
  }
}

async function saveStore() {
  if (!storeId.value) {
    useFaToast().warning('请先选择门店')
    return
  }
  storeSaving.value = true
  try {
    await apiSettings.updateStoreSettings(storeId.value, {
      timezone: storeTimezone.value || '',
      businessHours: buildBusinessHours(),
    })
    useFaToast().success('门店营业设置已保存')
  }
  catch (e) {
    useFaToast().error('保存失败', {
      description: e instanceof Error ? e.message : '请稍后重试',
    })
  }
  finally {
    storeSaving.value = false
  }
}

function onStoreChange() {
  loadStore()
}

// ===== 业务规则 =====
const rules = ref<EffectiveSettingItem[]>([])
const rulesStoreId = ref(tenantStore.currentStoreId)
const rulesLoading = ref(false)
// 规则编辑草稿:bool 与 number 分表,避免 unknown 类型
const ruleBoolDrafts = ref<Record<string, boolean>>({})
const ruleNumberDrafts = ref<Record<string, number>>({})

const SOURCE_LABELS: Record<string, string> = {
  store: '本店覆盖',
  tenant: '医院默认',
  system: '系统默认',
}

async function loadRules() {
  if (!tenantStore.currentTenantId) {
    return
  }
  rulesLoading.value = true
  try {
    const res = await apiSettings.getEffectiveSettings(tenantStore.currentTenantId, rulesStoreId.value || undefined)
    rules.value = res.items ?? []
    ruleBoolDrafts.value = {}
    ruleNumberDrafts.value = {}
    for (const item of rules.value) {
      if (item.type === 'bool') {
        ruleBoolDrafts.value[item.key] = Boolean(item.value)
      }
      else {
        ruleNumberDrafts.value[item.key] = Number(item.value ?? 0)
      }
    }
  }
  catch (e) {
    rules.value = []
    useFaToast().error('加载业务规则失败', {
      description: e instanceof Error ? e.message : '请稍后重试',
    })
  }
  finally {
    rulesLoading.value = false
  }
}

async function saveRule(item: EffectiveSettingItem, scope: 'tenant' | 'store') {
  const value = item.type === 'bool' ? ruleBoolDrafts.value[item.key] : ruleNumberDrafts.value[item.key]
  try {
    await apiSettings.saveSetting({
      tenantId: tenantStore.currentTenantId!,
      storeId: scope === 'store' ? rulesStoreId.value || undefined : undefined,
      namespace: item.namespace,
      key: item.key,
      value,
    })
    useFaToast().success(scope === 'store' ? '已保存为本店覆盖' : '已保存为医院默认')
    loadRules()
  }
  catch (e) {
    useFaToast().error('保存失败', {
      description: e instanceof Error ? e.message : '请稍后重试',
    })
  }
}

async function removeOverride(item: EffectiveSettingItem) {
  if (!rulesStoreId.value) {
    return
  }
  try {
    await apiSettings.removeOverride(tenantStore.currentTenantId!, rulesStoreId.value, item.namespace, item.key)
    useFaToast().success('已删除覆盖，恢复医院默认')
    loadRules()
  }
  catch (e) {
    useFaToast().error('删除失败', {
      description: e instanceof Error ? e.message : '请稍后重试',
    })
  }
}

function onRulesStoreChange() {
  loadRules()
}

// ===== 支付 / 打印 =====
const payStoreId = ref(tenantStore.currentStoreId)
const payList = ref<any[]>([])
const printStoreId = ref(tenantStore.currentStoreId)
const printList = ref<any[]>([])

async function loadPayment() {
  if (!tenantStore.currentTenantId || !payStoreId.value) {
    payList.value = []
    return
  }
  try {
    payList.value = await apiSettings.listPaymentContexts(tenantStore.currentTenantId, payStoreId.value)
  }
  catch (e) {
    payList.value = []
    useFaToast().error('加载支付方式失败', {
      description: e instanceof Error ? e.message : '请确认支付配置可访问',
    })
  }
}

async function loadPrint() {
  if (!tenantStore.currentTenantId || !printStoreId.value) {
    printList.value = []
    return
  }
  try {
    printList.value = await apiSettings.listPrintSettings(tenantStore.currentTenantId, printStoreId.value)
  }
  catch (e) {
    printList.value = []
    useFaToast().error('加载打印设置失败', {
      description: e instanceof Error ? e.message : '请确认打印配置可访问',
    })
  }
}

// 支付编辑弹窗
const payModal = ref(false)
const payForm = ref({ id: '', method: 'cash', label: '', is_default: false, is_active: true })
const paySaving = ref(false)
const PAY_METHODS = [
  { label: '现金', value: 'cash' },
  { label: '银行卡', value: 'card' },
  { label: '微信', value: 'wechat' },
  { label: '支付宝', value: 'alipay' },
  { label: '其他', value: 'other' },
]

function openPayEdit(row: any | null) {
  payForm.value = row
    ? { id: row.id, method: row.method, label: row.label, is_default: row.is_default, is_active: row.is_active }
    : { id: '', method: 'cash', label: '', is_default: false, is_active: true }
  payModal.value = true
}

async function savePay() {
  if (!tenantStore.currentTenantId || !payStoreId.value) {
    return
  }
  if (!payForm.value.label.trim()) {
    useFaToast().warning('请填写显示名称')
    return
  }
  paySaving.value = true
  try {
    await apiSettings.savePaymentContext({
      id: payForm.value.id || undefined,
      tenant_id: tenantStore.currentTenantId,
      store_id: payStoreId.value,
      method: payForm.value.method,
      label: payForm.value.label,
      is_default: payForm.value.is_default,
      is_active: payForm.value.is_active,
    })
    useFaToast().success('已保存')
    payModal.value = false
    loadPayment()
  }
  catch (e) {
    useFaToast().error('保存失败', {
      description: e instanceof Error ? e.message : '请稍后重试',
    })
  }
  finally {
    paySaving.value = false
  }
}

function onPayStoreChange() {
  loadPayment()
}
function onPrintStoreChange() {
  loadPrint()
}

// 打印编辑弹窗
const printModal = ref(false)
const printForm = ref({ id: '', paper_size: '80mm', label: '', is_default: false, is_active: true })
const printSaving = ref(false)
const PAPER_SIZES = [
  { label: '58mm', value: '58mm' },
  { label: '80mm', value: '80mm' },
  { label: 'A4', value: 'a4' },
]

function openPrintEdit(row: any | null) {
  printForm.value = row
    ? { id: row.id, paper_size: row.paper_size, label: row.label, is_default: row.is_default, is_active: row.is_active }
    : { id: '', paper_size: '80mm', label: '', is_default: false, is_active: true }
  printModal.value = true
}

async function savePrint() {
  if (!tenantStore.currentTenantId || !printStoreId.value) {
    return
  }
  if (!printForm.value.label.trim()) {
    useFaToast().warning('请填写打印设置名称')
    return
  }
  printSaving.value = true
  try {
    await apiSettings.savePrintSetting({
      id: printForm.value.id || undefined,
      tenant_id: tenantStore.currentTenantId,
      store_id: printStoreId.value,
      paper_size: printForm.value.paper_size,
      label: printForm.value.label,
      is_default: printForm.value.is_default,
      is_active: printForm.value.is_active,
    })
    useFaToast().success('已保存')
    printModal.value = false
    loadPrint()
  }
  catch (e) {
    useFaToast().error('保存失败', {
      description: e instanceof Error ? e.message : '请稍后重试',
    })
  }
  finally {
    printSaving.value = false
  }
}

// ===== 字典 =====
const dictCategory = ref('species')
const dictList = ref<any[]>([])
const DICT_CATEGORIES = [
  { label: '物种', value: 'species' },
  { label: '品种', value: 'breed' },
  { label: '毛色', value: 'color' },
]
const dictModal = ref(false)
const dictForm = ref({ id: '', code: '', label: '', sort_order: 0, is_active: true })
const dictSaving = ref(false)

async function loadDict() {
  if (!tenantStore.currentTenantId) {
    dictList.value = []
    return
  }
  try {
    dictList.value = await apiSettings.listDictionary(tenantStore.currentTenantId, dictCategory.value)
  }
  catch (e) {
    dictList.value = []
    useFaToast().error('加载字典失败', {
      description: e instanceof Error ? e.message : '请确认字典配置可访问',
    })
  }
}

function openDictEdit(row: any | null) {
  dictForm.value = row
    ? { id: row.id, code: row.code, label: row.label, sort_order: row.sort_order, is_active: row.is_active }
    : { id: '', code: '', label: '', sort_order: 0, is_active: true }
  dictModal.value = true
}

async function saveDict() {
  if (!tenantStore.currentTenantId) {
    return
  }
  if (!dictForm.value.code.trim() || !dictForm.value.label.trim()) {
    useFaToast().warning('请填写编码与名称')
    return
  }
  dictSaving.value = true
  try {
    await apiSettings.saveDictionaryItem({
      id: dictForm.value.id || undefined,
      tenant_id: tenantStore.currentTenantId,
      category: dictCategory.value,
      code: dictForm.value.code.trim(),
      label: dictForm.value.label.trim(),
      sort_order: dictForm.value.sort_order,
      is_active: dictForm.value.is_active,
    })
    useFaToast().success('已保存')
    dictModal.value = false
    loadDict()
  }
  catch (e) {
    useFaToast().error('保存失败', {
      description: e instanceof Error ? e.message : '请稍后重试',
    })
  }
  finally {
    dictSaving.value = false
  }
}

async function deleteDict(row: any) {
  useFaModal().confirm({
    title: '确认删除',
    content: `确认删除字典项「${row.label}」吗？`,
    onConfirm: async () => {
      try {
        await apiSettings.deleteDictionaryItem(row.id, tenantStore.currentTenantId)
        useFaToast().success('已删除')
        loadDict()
      }
      catch (e) {
        useFaToast().error('删除失败', {
          description: e instanceof Error ? e.message : '请稍后重试',
        })
      }
    },
  })
}

function onTabChange() {
  if (activeTab.value === 'hospital') {
    loadTenant()
  }
  else if (activeTab.value === 'store') {
    loadStore()
  }
  else if (activeTab.value === 'rules') {
    loadRules()
  }
  else if (activeTab.value === 'payment') {
    loadPayment()
  }
  else if (activeTab.value === 'print') {
    loadPrint()
  }
  else if (activeTab.value === 'dict') {
    loadDict()
  }
}

// P0-06/审计 26:切店后同步门店相关子页的门店 id 并按当前 Tab 重载,避免残留旧门店数据
useStoreScopedPage({
  load: () => {
    if (activeTab.value === 'store') { return loadStore() }
    if (activeTab.value === 'rules') { return loadRules() }
    if (activeTab.value === 'payment') { return loadPayment() }
    if (activeTab.value === 'print') { return loadPrint() }
  },
  reset: () => {
    storeId.value = tenantStore.currentStoreId
    rulesStoreId.value = tenantStore.currentStoreId
    payStoreId.value = tenantStore.currentStoreId
    printStoreId.value = tenantStore.currentStoreId
  },
})

onMounted(loadTenant)
</script>

<template>
  <div>
    <EntityPageHeader compact title="系统设置">
      <template #description>
        维护医院信息、门店营业参数与业务规则;配置支持"本店覆盖 → 医院默认 → 系统默认"继承。
      </template>
    </EntityPageHeader>
    <FaPageMain>
      <FaTabs
        v-model="activeTab" :list="[
          { label: '医院信息', value: 'hospital' },
          { label: '门店营业', value: 'store' },
          { label: '业务规则', value: 'rules' },
          { label: '支付', value: 'payment' },
          { label: '打印', value: 'print' },
          { label: '字典', value: 'dict' },
        ]" class="mb-4" @change="onTabChange"
      />

      <!-- 医院信息 -->
      <div v-if="activeTab === 'hospital'" v-loading="loading" class="max-w-150">
        <div class="gap-4 grid grid-cols-2">
          <FaLabel label="医院名称" class="block">
            <FaInput v-model="tenantForm.name" placeholder="医院名称" class="w-full" :disabled="!canManageTenant" />
          </FaLabel>
          <FaLabel label="简称" class="block">
            <FaInput v-model="tenantForm.shortName" placeholder="简称(可选)" class="w-full" :disabled="!canManageTenant" />
          </FaLabel>
          <FaLabel label="时区" class="block">
            <FaSelect v-model="tenantForm.timezone" :options="TIMEZONE_OPTIONS.map(v => ({ label: v, value: v }))" class="w-full" :disabled="!canManageTenant" />
          </FaLabel>
          <FaLabel label="币种" class="block">
            <FaInput v-model="tenantForm.currency" placeholder="如 CNY" class="w-full" :disabled="!canManageTenant" />
          </FaLabel>
          <FaLabel label="语言" class="block">
            <FaInput v-model="tenantForm.locale" placeholder="如 zh-CN" class="w-full" :disabled="!canManageTenant" />
          </FaLabel>
        </div>
        <div class="mt-4">
          <PermissionButton permission="settings.tenant.manage" :loading="tenantSaving" @click="saveTenant">
            保存医院信息
          </PermissionButton>
        </div>
      </div>

      <!-- 门店营业 -->
      <div v-else-if="activeTab === 'store'" v-loading="loading" class="max-w-150">
        <div class="mb-4 max-w-80">
          <FaLabel label="选择门店" class="block">
            <BusinessStoreSelector v-model="storeId" @change="onStoreChange" />
          </FaLabel>
        </div>
        <template v-if="storeInfo">
          <div class="text-sm text-muted-foreground mb-4">
            当前门店：<span class="text-foreground font-medium">{{ storeInfo.name }}</span>
          </div>
          <div class="gap-4 grid grid-cols-2">
            <FaLabel label="时区(留空继承医院)" class="col-span-2 block">
              <FaSelect v-model="storeTimezone" :options="[{ label: '继承医院默认', value: '' }, ...TIMEZONE_OPTIONS.map(v => ({ label: v, value: v }))]" class="w-full" :disabled="!canManageStore" />
            </FaLabel>
            <div class="col-span-2">
              <div class="text-sm font-medium mb-2">
                营业时间
              </div>
              <div class="space-y-2">
                <div v-for="day in DAYS" :key="day.key" class="flex gap-3 items-center">
                  <span class="text-sm w-10">{{ day.label }}</span>
                  <FaSwitch v-model="hoursModel[day.key].enabled" :disabled="!canManageStore" />
                  <template v-if="hoursModel[day.key].enabled">
                    <FaInput v-model="hoursModel[day.key].start" type="time" class="w-32" :disabled="!canManageStore" />
                    <span class="text-muted-foreground">至</span>
                    <FaInput v-model="hoursModel[day.key].end" type="time" class="w-32" :disabled="!canManageStore" />
                  </template>
                  <span v-else class="text-xs text-muted-foreground">休息</span>
                </div>
              </div>
            </div>
          </div>
          <div class="mt-4">
            <PermissionButton permission="settings.store.manage" :loading="storeSaving" @click="saveStore">
              保存门店营业设置
            </PermissionButton>
          </div>
        </template>
        <EmptyState v-else title="请先选择门店" description="选择门店后维护其营业时间与时区" />
      </div>

      <!-- 业务规则 -->
      <div v-else-if="activeTab === 'rules'" class="max-w-160">
        <div class="mb-4 flex gap-4 items-center">
          <div class="w-56">
            <BusinessStoreSelector v-model="rulesStoreId" include-all all-label="全部门店(医院默认)" @change="onRulesStoreChange" />
          </div>
          <span class="text-xs text-muted-foreground">
            读取优先级：本店覆盖 → 医院默认 → 系统默认
          </span>
        </div>
        <div v-loading="rulesLoading" class="space-y-3">
          <div v-for="item in rules" :key="item.key" class="p-4 border rounded-lg">
            <div class="flex gap-3 items-center justify-between">
              <div>
                <div class="font-medium">
                  {{ item.label }}
                </div>
                <div class="text-xs text-muted-foreground">
                  {{ item.key }}
                </div>
              </div>
              <span
                class="text-xs px-2 py-0.5 rounded" :class="{
                  'bg-primary/10 text-primary': item.source === 'store',
                  'bg-muted text-muted-foreground': item.source === 'tenant',
                  'bg-muted/60 text-muted-foreground/70': item.source === 'system',
                }"
              >
                {{ SOURCE_LABELS[item.source] }}
              </span>
            </div>
            <div class="mt-3 flex gap-3 items-center">
              <template v-if="item.type === 'bool'">
                <FaSwitch v-model="ruleBoolDrafts[item.key]" />
              </template>
              <template v-else>
                <FaInput v-model.number="ruleNumberDrafts[item.key]" type="number" :step="item.type === 'percent' ? 0.01 : 1" class="w-40" />
                <span v-if="item.type === 'percent'" class="text-xs text-muted-foreground">0.1 = 10%</span>
                <span v-else-if="item.type === 'days'" class="text-xs text-muted-foreground">天</span>
              </template>
              <div class="ms-auto flex gap-2">
                <PermissionButton v-if="rulesStoreId" permission="settings.store.manage" variant="outline" size="sm" @click="saveRule(item, 'store')">
                  保存为本店覆盖
                </PermissionButton>
                <PermissionButton permission="settings.tenant.manage" variant="outline" size="sm" @click="saveRule(item, 'tenant')">
                  保存为医院默认
                </PermissionButton>
                <FaButton v-if="item.source === 'store'" variant="outline" size="sm" class="text-red-600" @click="removeOverride(item)">
                  删除覆盖
                </FaButton>
              </div>
            </div>
          </div>
          <EmptyState v-if="!rulesLoading && rules.length === 0" title="暂无业务规则" description="选择门店后查看生效配置" />
        </div>
      </div>

      <!-- 支付 -->
      <div v-else-if="activeTab === 'payment'" class="max-w-160">
        <div class="mb-4 flex gap-4 items-center">
          <div class="w-56">
            <BusinessStoreSelector v-model="payStoreId" @change="onPayStoreChange" />
          </div>
          <PermissionButton permission="settings.store.manage" @click="openPayEdit(null)">
            新增支付方式
          </PermissionButton>
        </div>
        <FaTable
          row-key="id"
          stripe
          border
          :columns="[
            { accessorKey: 'method', header: '方式', cell: (info: any) => PAY_METHODS.find(m => m.value === info.getValue())?.label ?? info.getValue() },
            { accessorKey: 'label', header: '显示名称' },
            { accessorKey: 'is_default', header: '默认', cell: (info: any) => (info.getValue() ? '是' : '-') },
            { accessorKey: 'is_active', header: '启用', cell: (info: any) => (info.getValue() ? '启用' : '停用') },
            { id: 'operation', header: '操作', width: 80, align: 'center' },
          ]"
          :data="payList"
          empty-text="暂无支付方式"
        >
          <template #cell-operation="{ row }">
            <PermissionButton permission="settings.store.manage" variant="outline" size="icon-sm" @click="openPayEdit(row.original)">
              <FaIcon name="i-ri:edit-line" />
            </PermissionButton>
          </template>
        </FaTable>
      </div>

      <!-- 打印 -->
      <div v-else-if="activeTab === 'print'" class="max-w-160">
        <div class="mb-4 flex gap-4 items-center">
          <div class="w-56">
            <BusinessStoreSelector v-model="printStoreId" @change="onPrintStoreChange" />
          </div>
          <PermissionButton permission="settings.store.manage" @click="openPrintEdit(null)">
            新增打印设置
          </PermissionButton>
        </div>
        <FaTable
          row-key="id"
          stripe
          border
          :columns="[
            { accessorKey: 'paper_size', header: '纸型', cell: (info: any) => info.getValue() },
            { accessorKey: 'label', header: '名称' },
            { accessorKey: 'is_default', header: '默认', cell: (info: any) => (info.getValue() ? '是' : '-') },
            { accessorKey: 'is_active', header: '启用', cell: (info: any) => (info.getValue() ? '启用' : '停用') },
            { id: 'operation', header: '操作', width: 80, align: 'center' },
          ]"
          :data="printList"
          empty-text="暂无打印设置"
        >
          <template #cell-operation="{ row }">
            <PermissionButton permission="settings.store.manage" variant="outline" size="icon-sm" @click="openPrintEdit(row.original)">
              <FaIcon name="i-ri:edit-line" />
            </PermissionButton>
          </template>
        </FaTable>
      </div>

      <!-- 字典 -->
      <div v-else class="max-w-160">
        <div class="mb-4 flex gap-4 items-center">
          <FaTabs v-model="dictCategory" :list="DICT_CATEGORIES" @change="loadDict" />
          <PermissionButton permission="settings.tenant.manage" @click="openDictEdit(null)">
            新增字典项
          </PermissionButton>
        </div>
        <FaTable
          row-key="id"
          stripe
          border
          :columns="[
            { accessorKey: 'code', header: '编码' },
            { accessorKey: 'label', header: '名称' },
            { accessorKey: 'sort_order', header: '排序' },
            { accessorKey: 'is_active', header: '启用', cell: (info: any) => (info.getValue() ? '启用' : '停用') },
            { id: 'operation', header: '操作', width: 110, align: 'center' },
          ]"
          :data="dictList"
          empty-text="暂无字典项"
        >
          <template #cell-operation="{ row }">
            <div class="flex-center gap-1">
              <PermissionButton permission="settings.tenant.manage" variant="outline" size="icon-sm" @click="openDictEdit(row.original)">
                <FaIcon name="i-ri:edit-line" />
              </PermissionButton>
              <PermissionButton permission="settings.tenant.manage" variant="outline" size="icon-sm" class="text-red-600" @click="deleteDict(row.original)">
                <FaIcon name="i-ri:delete-bin-line" />
              </PermissionButton>
            </div>
          </template>
        </FaTable>
      </div>
    </FaPageMain>

    <!-- 支付编辑 -->
    <FaModal v-model="payModal" title="支付方式" :footer="false">
      <div class="py-2 space-y-4">
        <FaLabel label="方式" class="block">
          <FaSelect v-model="payForm.method" :options="PAY_METHODS" class="w-full" />
        </FaLabel>
        <FaLabel label="显示名称" class="block">
          <FaInput v-model="payForm.label" placeholder="如 现金/刷卡/微信" class="w-full" />
        </FaLabel>
        <div class="flex gap-6">
          <FaLabel label="默认方式" class="block">
            <FaSwitch v-model="payForm.is_default" />
          </FaLabel>
          <FaLabel label="启用" class="block">
            <FaSwitch v-model="payForm.is_active" />
          </FaLabel>
        </div>
        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="payModal = false">
            取消
          </FaButton>
          <FaButton :loading="paySaving" @click="savePay">
            保存
          </FaButton>
        </div>
      </div>
    </FaModal>

    <!-- 打印编辑 -->
    <FaModal v-model="printModal" title="打印设置" :footer="false">
      <div class="py-2 space-y-4">
        <FaLabel label="纸型" class="block">
          <FaSelect v-model="printForm.paper_size" :options="PAPER_SIZES" class="w-full" />
        </FaLabel>
        <FaLabel label="名称" class="block">
          <FaInput v-model="printForm.label" placeholder="如 80mm 小票" class="w-full" />
        </FaLabel>
        <div class="flex gap-6">
          <FaLabel label="默认" class="block">
            <FaSwitch v-model="printForm.is_default" />
          </FaLabel>
          <FaLabel label="启用" class="block">
            <FaSwitch v-model="printForm.is_active" />
          </FaLabel>
        </div>
        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="printModal = false">
            取消
          </FaButton>
          <FaButton :loading="printSaving" @click="savePrint">
            保存
          </FaButton>
        </div>
      </div>
    </FaModal>

    <!-- 字典编辑 -->
    <FaModal v-model="dictModal" title="字典项" :footer="false">
      <div class="py-2 space-y-4">
        <FaLabel label="编码" class="block">
          <FaInput v-model="dictForm.code" placeholder="如 cat" class="w-full" />
        </FaLabel>
        <FaLabel label="名称" class="block">
          <FaInput v-model="dictForm.label" placeholder="如 猫" class="w-full" />
        </FaLabel>
        <FaLabel label="排序" class="block">
          <FaNumberField v-model="dictForm.sort_order" class="w-full" />
        </FaLabel>
        <FaLabel label="启用" class="block">
          <FaSwitch v-model="dictForm.is_active" />
        </FaLabel>
        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="dictModal = false">
            取消
          </FaButton>
          <FaButton :loading="dictSaving" @click="saveDict">
            保存
          </FaButton>
        </div>
      </div>
    </FaModal>
  </div>
</template>
