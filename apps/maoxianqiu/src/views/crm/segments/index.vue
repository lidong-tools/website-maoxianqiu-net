<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { SegmentCondition, SegmentDefinition } from '@/api/modules/crmGrowth'
import apiCrmGrowth from '@/api/modules/crmGrowth'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'CrmSegments',
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

// ===== 条件维度/操作符常量(与后端 segment_condition_hit 保持一致) =====
const DIMS = [
  { label: '最近到店天数', value: 'recency_days' },
  { label: '累计到店次数', value: 'visits_total' },
  { label: '近一年到店次数', value: 'visits_last_365' },
  { label: '累计消费金额', value: 'spend_total' },
  { label: '近一年消费金额', value: 'spend_last_365' },
  { label: '宠物数量', value: 'pet_count' },
  { label: '会员等级', value: 'member_tier_code' },
  { label: '会员积分', value: 'member_points' },
  { label: '疫苗逾期天数', value: 'vaccination_due' },
  { label: '驱虫逾期天数', value: 'deworming_due' },
  { label: '爽约次数', value: 'no_show_count' },
  { label: '逾期回访数', value: 'followup_overdue' },
]

const OPS = [
  { label: '等于', value: 'eq' },
  { label: '不等于', value: 'neq' },
  { label: '大于', value: 'gt' },
  { label: '大于等于', value: 'gte' },
  { label: '小于', value: 'lt' },
  { label: '小于等于', value: 'lte' },
]

const DIM_LABELS: Record<string, string> = Object.fromEntries(DIMS.map(d => [d.value, d.label]))
const OP_LABELS: Record<string, string> = Object.fromEntries(OPS.map(o => [o.value, o.label]))

// ===== 列表 =====
const segments = ref<SegmentDefinition[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)
const refreshing = ref(false)

/** 分层筛选(空 = 全部分层) */
const filterName = ref('')
const filteredSegments = computed(() =>
  filterName.value ? segments.value.filter(s => s.name === filterName.value) : segments.value,
)

/** 条件文本摘要(供列表展示) */
function conditionsText(rule: SegmentDefinition['rule_json']): string {
  if (!rule?.conditions?.length) {
    return '无条件(恒命中)'
  }
  const parts = rule.conditions.map(c => `${DIM_LABELS[c.dim] ?? c.dim} ${OP_LABELS[c.op] ?? c.op} ${c.value}`)
  return `${rule.logic === 'or' ? '任一' : '全部'}: ${parts.join('; ')}`
}

const columns = computed<TableColumn<SegmentDefinition>[]>(() => [
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'priority', header: '优先级' },
  { accessorKey: 'member_count', header: '成员数' },
  {
    accessorKey: 'rule_json',
    header: '规则',
    cell: info => conditionsText(info.getValue() as SegmentDefinition['rule_json']),
  },
  {
    accessorKey: 'active',
    header: '状态',
    cell: info => (info.getValue() ? '启用' : '停用'),
  },
  {
    id: 'operation',
    header: '操作',
    width: 200,
    align: 'center',
    fixed: 'right',
  },
])

/** 加载分层定义列表 */
async function loadSegments() {
  if (!requireTenant()) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiCrmGrowth.listSegments({ tenantId: tenantId(), page: page.value, pageSize: pageSize.value })
    segments.value = res?.data?.list ?? []
    total.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error('加载客户分层失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    loading.value = false
  }
}

/** 批量重算分层成员(服务端 RPC,规则版本随迁移固定) */
async function refreshSegments() {
  if (!requireTenant()) {
    return
  }
  refreshing.value = true
  try {
    const res: any = await apiCrmGrowth.refreshSegments({ tenantId: tenantId() })
    useFaToast().success(`重算完成,共评估 ${res?.data?.evaluated ?? 0} 位客户`)
    await loadSegments()
  }
  catch (e) {
    useFaToast().error('重算失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    refreshing.value = false
  }
}

// ===== 新建/编辑 =====
const dialogVisible = ref(false)
const saving = ref(false)
const form = reactive<{
  id: string
  code: string
  name: string
  description: string
  priority: number
  active: boolean
  logic: 'and' | 'or'
  conditions: SegmentCondition[]
}>({ id: '', code: '', name: '', description: '', priority: 100, active: true, logic: 'and', conditions: [] })

function emptyCondition(): SegmentCondition {
  return { dim: 'recency_days', op: 'lt', value: 30 }
}

function openCreate() {
  Object.assign(form, {
    id: '', code: '', name: '', description: '',
    priority: segments.value.length * 10 + 10, active: true, logic: 'and',
    conditions: [emptyCondition()],
  })
  dialogVisible.value = true
}

function openEdit(row: SegmentDefinition) {
  Object.assign(form, {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    priority: row.priority,
    active: row.active,
    logic: row.rule_json?.logic ?? 'and',
    conditions: (row.rule_json?.conditions ?? []).map(c => ({ ...c })),
  })
  dialogVisible.value = true
}

function addCondition() {
  form.conditions.push(emptyCondition())
}

function removeCondition(index: number) {
  form.conditions.splice(index, 1)
}

/**
 * 条件值输入回写:数值型维度保留 number(供后端 JSONB 数值比较),其余转字符串
 * @param index 条件下标
 * @param v FaInput 回写值(string | number | undefined)
 */
function onCondValueInput(index: number, v: string | number | undefined): void {
  const cond = form.conditions[index]
  if (v === undefined || v === '') {
    cond.value = ''
    return
  }
  const n = Number(v)
  cond.value = Number.isFinite(n) && String(n) === v ? n : v
}

/** 保存分层定义(编辑走 update,新建走 create) */
async function saveSegment() {
  if (!form.code.trim() || !form.name.trim()) {
    useFaToast().warning('请填写编码与名称')
    return
  }
  const ruleJson = { logic: form.logic, conditions: form.conditions }
  saving.value = true
  try {
    if (form.id) {
      await apiCrmGrowth.updateSegment(form.id, {
        code: form.code,
        name: form.name,
        description: form.description,
        ruleJson,
        priority: form.priority,
        active: form.active,
      })
    }
    else {
      await apiCrmGrowth.createSegment({
        tenantId: tenantId(),
        code: form.code,
        name: form.name,
        description: form.description,
        ruleJson,
        priority: form.priority,
        active: form.active,
      })
    }
    useFaToast().success('保存成功')
    dialogVisible.value = false
    await loadSegments()
  }
  catch (e) {
    useFaToast().error('保存失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    saving.value = false
  }
}

// ===== 删除 =====
/** 删除分层定义 */
async function deleteSegment(row: SegmentDefinition) {
  try {
    await apiCrmGrowth.deleteSegment(row.id)
    useFaToast().success('已删除')
    await loadSegments()
  }
  catch (e) {
    useFaToast().error('删除失败', { description: e instanceof Error ? e.message : '' })
  }
}

// ===== 成员列表 =====
const memberDrawerVisible = ref(false)
const memberLoading = ref(false)
const memberList = ref<any[]>([])
const memberTotal = ref(0)
const memberPage = ref(1)
const memberPageSize = ref(20)
const memberSegment = ref<SegmentDefinition | null>(null)

const memberColumns = computed<TableColumn<any>[]>(() => [
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
  { accessorKey: 'score', header: '命中评分' },
  { accessorKey: 'matched_at', header: '匹配时间' },
])

/** 打开成员抽屉并加载第一页 */
async function openMembers(row: SegmentDefinition) {
  memberSegment.value = row
  memberDrawerVisible.value = true
  memberPage.value = 1
  await loadMembers()
}

/** 加载当前分层成员(分页) */
async function loadMembers() {
  if (!memberSegment.value) {
    return
  }
  memberLoading.value = true
  try {
    const res: any = await apiCrmGrowth.listSegmentCustomers(memberSegment.value.id, {
      tenantId: tenantId(),
      page: memberPage.value,
      pageSize: memberPageSize.value,
    })
    memberList.value = res?.data?.list ?? []
    memberTotal.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error(`加载成员失败: ${e instanceof Error ? e.message : ''}`)
  }
  finally {
    memberLoading.value = false
  }
}

onMounted(() => {
  loadSegments()
})
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告) -->
    <!--
    <EntityPageHeader compact title="客户分层">
      <template #description>
        基于规则 + 评分的客户分层(可解释,非黑盒);用于营销 Audience 与运营分组。客户是租户级关系,分层按租户整体计算。
      </template>
    </EntityPageHeader>
    -->
    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0">
        <div class="px-4 py-3 border-b flex justify-between items-center">
          <div class="flex gap-2 items-center">
            <FaSelect
              v-model="filterName"
              class="w-44"
              :options="[{ label: '全部分层', value: '' }, ...segments.map(s => ({ label: s.name, value: s.name }))]"
            />
            <span class="text-sm text-muted-foreground">
              共 {{ total }} 个分层
            </span>
          </div>
          <div class="flex gap-2">
            <FaButton size="sm" variant="outline" :loading="refreshing" @click="refreshSegments">
              <FaIcon name="i-ri:refresh-line" />
              重算成员
            </FaButton>
            <FaButton size="sm" @click="openCreate">
              <FaIcon name="i-ri:add-line" />
              新建分层
            </FaButton>
          </div>
        </div>
        <div v-loading="loading" class="flex-1 min-h-0 overflow-auto">
          <FaTable
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="columns"
            :data="filteredSegments"
            empty-text="暂无客户分层(请先新建)"
          >
            <template #cell-operation="{ row }">
              <div class="flex-center gap-1">
                <FaButton variant="outline" size="sm" @click="openMembers(row.original)">
                  成员
                </FaButton>
                <FaButton variant="outline" size="sm" @click="openEdit(row.original)">
                  编辑
                </FaButton>
                <FaButton variant="outline" size="sm" class="text-red-600" @click="deleteSegment(row.original)">
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
          class="mt-2 px-4 pb-3"
          @page-change="p => { page = p; loadSegments() }"
          @size-change="s => { pageSize = s; page = 1; loadSegments() }"
        />
      </div>
    </div>

    <!-- 新建/编辑分层 -->
    <FaModal
      v-model="dialogVisible"
      :title="form.id ? '编辑分层' : '新建分层'"
      :show-cancel="true"
      confirm-text="保存"
      :loading="saving"
      width="720px"
      @confirm="saveSegment"
    >
      <div class="grid grid-cols-2 gap-3 p-2">
        <FaLabel label="编码">
          <FaInput v-model="form.code" placeholder="如 VIP_365" />
        </FaLabel>
        <FaLabel label="名称">
          <FaInput v-model="form.name" placeholder="如 高频活跃客户" />
        </FaLabel>
        <FaLabel label="优先级(小=优先)">
          <FaInputNumber v-model="form.priority" :min="0" :precision="0" />
        </FaLabel>
        <FaLabel label="启用">
          <FaSwitch v-model="form.active" />
        </FaLabel>
        <FaLabel label="说明" class="col-span-2">
          <FaInput v-model="form.description" placeholder="可选" />
        </FaLabel>
        <FaLabel label="条件组合" class="col-span-2">
          <FaSelect
            v-model="form.logic"
            :options="[
              { label: '全部满足(AND)', value: 'and' },
              { label: '任一满足(OR)', value: 'or' },
            ]"
          />
        </FaLabel>
      </div>
      <div class="px-2">
        <div class="flex justify-between items-center mb-2">
          <span class="text-sm text-muted-foreground">规则条件({{ form.conditions.length }})</span>
          <FaButton size="sm" variant="outline" @click="addCondition">
            <FaIcon name="i-ri:add-line" />
            添加条件
          </FaButton>
        </div>
        <div
          v-for="(cond, index) in form.conditions"
          :key="index"
          class="grid grid-cols-[1fr_110px_1fr_36px] gap-2 items-center mb-2"
        >
          <FaSelect v-model="cond.dim" :options="DIMS" size="small" />
          <FaSelect v-model="cond.op" :options="OPS" size="small" />
          <FaInput :model-value="String(cond.value ?? '')" size="small" placeholder="比较值" @update:model-value="onCondValueInput(index, $event)" />
          <FaButton variant="ghost" size="sm" class="text-red-600" @click="removeCondition(index)">
            <FaIcon name="i-ri:delete-bin-line" />
          </FaButton>
        </div>
      </div>
    </FaModal>

    <!-- 成员列表抽屉 -->
    <FaDrawer v-model="memberDrawerVisible" :title="`成员 · ${memberSegment?.name ?? ''}`" width="560px">
      <FaTable
        v-loading="memberLoading"
        table-root-class="overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="memberColumns"
        :data="memberList"
        empty-text="暂无成员(可先重算)"
      />
      <FaPagination
        :page="memberPage"
        :size="memberPageSize"
        :total="memberTotal"
        class="mt-2 px-4 pb-3"
        @page-change="p => { memberPage = p; loadMembers() }"
        @size-change="s => { memberPageSize = s; memberPage = 1; loadMembers() }"
      />
    </FaDrawer>
  </div>
</template>
