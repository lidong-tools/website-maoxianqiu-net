<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type {
  DrugInteractionRecord,
  DrugProfileRecord,
  MedicationSafetyRuleRecord,
} from '@/types/medication-safety'
import { h, ref } from 'vue'
import apiMedicationSafety from '@/api/modules/medication-safety'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import DrugProfileForm from './components/DrugProfileForm.vue'
import InteractionForm from './components/InteractionForm.vue'
import RuleForm from './components/RuleForm.vue'

defineOptions({
  name: 'MedicationSafetyManagement',
})

const tenantStore = useAppTenantStore()
const tabActive = ref<'rules' | 'profiles' | 'interactions'>('rules')

/** 编辑中的行(打开弹窗时由表格行赋值) */
const editingRule = ref<{ id?: string, data?: Record<string, unknown> } | null>(null)
const editingProfile = ref<{ id?: string, data?: Record<string, unknown> } | null>(null)
const editingInteraction = ref<{ id?: string, data?: Record<string, unknown> } | null>(null)

/** 表单组件引用(用于触发表单 submit) */
const ruleFormRef = ref<InstanceType<typeof RuleForm> | null>(null)
const profileFormRef = ref<InstanceType<typeof DrugProfileForm> | null>(null)
const interactionFormRef = ref<InstanceType<typeof InteractionForm> | null>(null)

// ==================== 规则列表 ====================
const ruleLoading = ref(false)
const ruleList = ref<MedicationSafetyRuleRecord[]>([])

/** 规则表格列 */
const ruleColumns = computed<TableColumn<MedicationSafetyRuleRecord>[]>(() => [
  { accessorKey: 'code', header: '编码', width: 180 },
  { accessorKey: 'name', header: '名称', width: 160 },
  { accessorKey: 'rule_type', header: '类型', width: 200 },
  {
    accessorKey: 'severity',
    header: '严重度',
    width: 90,
    cell: info => (info.getValue() as string) ?? '-',
  },
  {
    accessorKey: 'is_blocking',
    header: '阻断',
    width: 70,
    cell: info => info.getValue() ? '是' : '否',
  },
  { accessorKey: 'current_version', header: '版本', width: 70 },
  {
    accessorKey: 'active',
    header: '状态',
    width: 80,
    cell: info => info.getValue() ? '启用' : '停用',
  },
  {
    id: 'operation',
    header: '操作',
    width: 150,
    align: 'center',
    fixed: 'right',
  },
])

/** 加载规则列表 */
async function loadRules() {
  if (!tenantStore.currentTenantId) {
    ruleList.value = []
    return
  }
  ruleLoading.value = true
  try {
    const res = await apiMedicationSafety.listRules(tenantStore.currentTenantId)
    ruleList.value = res.data.list
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载规则失败')
  }
  finally {
    ruleLoading.value = false
  }
}

// ==================== 药品档案列表 ====================
const profileLoading = ref(false)
const profileList = ref<DrugProfileRecord[]>([])

/** 药品档案表格列 */
const profileColumns = computed<TableColumn<DrugProfileRecord>[]>(() => [
  {
    accessorKey: 'catalog_item',
    header: '药品',
    cell: info => (info.getValue() as { name?: string } | undefined)?.name ?? '-',
  },
  { accessorKey: 'active_ingredient', header: '活性成分', cell: info => info.getValue() ?? '-' },
  {
    accessorKey: 'min_dose_mg_kg',
    header: '剂量范围(mg/kg)',
    cell: info => {
      const min = info.getValue() as number | null
      const row = info.row.original
      const max = row.max_dose_mg_kg
      if (min == null && max == null) {
        return '-'
      }
      return `${min ?? '?'} ~ ${max ?? '?'}`
    },
  },
  {
    accessorKey: 'max_duration_days',
    header: '最大疗程(天)',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'antimicrobial_class',
    header: '抗菌类别',
    cell: info => info.getValue() ?? '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 100,
    align: 'center',
    fixed: 'right',
  },
])

/** 加载药品档案列表 */
async function loadProfiles() {
  if (!tenantStore.currentTenantId) {
    profileList.value = []
    return
  }
  profileLoading.value = true
  try {
    const res = await apiMedicationSafety.listDrugProfiles(tenantStore.currentTenantId)
    profileList.value = res.data.list
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载药品档案失败')
  }
  finally {
    profileLoading.value = false
  }
}

// ==================== 交互禁忌列表 ====================
const interactionLoading = ref(false)
const interactionList = ref<DrugInteractionRecord[]>([])

/** 交互禁忌表格列 */
const interactionColumns = computed<TableColumn<DrugInteractionRecord>[]>(() => [
  { accessorKey: 'ingredient_a', header: '成分 A' },
  { accessorKey: 'ingredient_b', header: '成分 B' },
  { accessorKey: 'severity', header: '严重度', width: 90 },
  { accessorKey: 'description', header: '描述', cell: info => info.getValue() ?? '-' },
  {
    accessorKey: 'active',
    header: '状态',
    width: 80,
    cell: info => info.getValue() ? '启用' : '停用',
  },
  {
    id: 'operation',
    header: '操作',
    width: 100,
    align: 'center',
    fixed: 'right',
  },
])

/** 加载交互禁忌列表 */
async function loadInteractions() {
  if (!tenantStore.currentTenantId) {
    interactionList.value = []
    return
  }
  interactionLoading.value = true
  try {
    const res = await apiMedicationSafety.listInteractions(tenantStore.currentTenantId)
    interactionList.value = res.data.list
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '加载相互作用禁忌失败')
  }
  finally {
    interactionLoading.value = false
  }
}

/**
 * 切换 tab 时加载对应数据(首次进入加载规则)
 */
function onTabChange() {
  if (tabActive.value === 'rules') {
    loadRules()
  }
  else if (tabActive.value === 'profiles') {
    loadProfiles()
  }
  else {
    loadInteractions()
  }
}

// ==================== 规则弹窗 ====================
const { open: openRuleModal, update: updateRuleModal } = useFaModal().create({
  destroyOnClose: true,
  closeOnClickOverlay: false,
  beforeClose: (action, done) => {
    if (action === 'confirm') {
      ruleFormRef.value?.submit().then((success) => {
        if (!success) {
          return
        }
        loadRules()
        done()
      })
    }
    else {
      done()
    }
  },
  content: () => h(RuleForm, {
    ref: ruleFormRef,
    tenantId: tenantStore.currentTenantId ?? '',
    id: editingRule.value?.id,
    initialData: editingRule.value?.data,
  }),
})

/** 新增规则 */
function onCreateRule() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  editingRule.value = null
  updateRuleModal({ title: '新增规则' })
  openRuleModal()
}

/** 编辑规则 */
function onEditRule(row: MedicationSafetyRuleRecord) {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  editingRule.value = { id: row.id, data: row as unknown as Record<string, unknown> }
  updateRuleModal({ title: `编辑规则「${row.name}」` })
  openRuleModal()
}

/** 启停规则 */
function onToggleRule(row: MedicationSafetyRuleRecord) {
  const next = !row.active
  apiMedicationSafety.toggleRule(row.id, next).then(() => {
    useFaToast().success(next ? '已启用' : '已停用')
    loadRules()
  }).catch((e: unknown) => {
    useFaToast().error((e as Error)?.message || '操作失败')
  })
}

// ==================== 药品档案弹窗 ====================
const { open: openProfileModal, update: updateProfileModal } = useFaModal().create({
  destroyOnClose: true,
  closeOnClickOverlay: false,
  beforeClose: (action, done) => {
    if (action === 'confirm') {
      profileFormRef.value?.submit().then((success) => {
        if (!success) {
          return
        }
        loadProfiles()
        done()
      })
    }
    else {
      done()
    }
  },
  content: () => h(DrugProfileForm, {
    ref: profileFormRef,
    tenantId: tenantStore.currentTenantId ?? '',
    id: editingProfile.value?.id,
    initialData: editingProfile.value?.data,
  }),
})

/** 新增药品档案 */
function onCreateProfile() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  editingProfile.value = null
  updateProfileModal({ title: '新增药品档案' })
  openProfileModal()
}

/** 编辑药品档案 */
function onEditProfile(row: DrugProfileRecord) {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  editingProfile.value = { id: row.id, data: row as unknown as Record<string, unknown> }
  updateProfileModal({ title: '编辑药品档案' })
  openProfileModal()
}

// ==================== 交互禁忌弹窗 ====================
const { open: openInteractionModal, update: updateInteractionModal } = useFaModal().create({
  destroyOnClose: true,
  closeOnClickOverlay: false,
  beforeClose: (action, done) => {
    if (action === 'confirm') {
      interactionFormRef.value?.submit().then((success) => {
        if (!success) {
          return
        }
        loadInteractions()
        done()
      })
    }
    else {
      done()
    }
  },
  content: () => h(InteractionForm, {
    ref: interactionFormRef,
    tenantId: tenantStore.currentTenantId ?? '',
    id: editingInteraction.value?.id,
    initialData: editingInteraction.value?.data,
  }),
})

/** 新增交互禁忌 */
function onCreateInteraction() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  editingInteraction.value = null
  updateInteractionModal({ title: '新增相互作用禁忌' })
  openInteractionModal()
}

/** 编辑交互禁忌 */
function onEditInteraction(row: DrugInteractionRecord) {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  editingInteraction.value = { id: row.id, data: row as unknown as Record<string, unknown> }
  updateInteractionModal({ title: '编辑相互作用禁忌' })
  openInteractionModal()
}

// 首次加载
loadRules()
</script>

<template>
  <div>
    <EntityPageHeader
      compact
      title="用药安全"
      description="用药安全规则引擎:规则配置 / 药品安全档案 / 药物相互作用禁忌(确定性、可解释、版本化、可审计)"
    />
    <FaPageMain>
      <FaTabs
        v-model="tabActive"
        :list="[
          { label: '安全规则', value: 'rules' },
          { label: '药品档案', value: 'profiles' },
          { label: '相互作用', value: 'interactions' },
        ]"
        @change="onTabChange"
      >
        <!-- ==================== 规则 ==================== -->
        <template #rules>
          <FaTable
            v-loading="ruleLoading"
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="ruleColumns"
            :data="ruleList"
          >
            <template #toolbar>
              <FaButton type="primary" @click="onCreateRule">
                <FaIcon name="i-ri:add-line" />
                新增规则
              </FaButton>
            </template>
            <template #cell-operation="{ row }">
              <div class="flex-center gap-2">
                <FaButton variant="outline" size="icon-sm" @click="onEditRule(row.original)">
                  <FaIcon name="i-ri:edit-line" />
                </FaButton>
                <FaButton variant="outline" size="icon-sm" @click="onToggleRule(row.original)">
                  <FaIcon :name="row.original.active ? 'i-ri:pause-line' : 'i-ri:play-line'" />
                </FaButton>
              </div>
            </template>
          </FaTable>
        </template>

        <!-- ==================== 药品档案 ==================== -->
        <template #profiles>
          <FaTable
            v-loading="profileLoading"
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="profileColumns"
            :data="profileList"
          >
            <template #toolbar>
              <FaButton type="primary" @click="onCreateProfile">
                <FaIcon name="i-ri:add-line" />
                新增药品档案
              </FaButton>
            </template>
            <template #cell-operation="{ row }">
              <div class="flex-center gap-2">
                <FaButton variant="outline" size="icon-sm" @click="onEditProfile(row.original)">
                  <FaIcon name="i-ri:edit-line" />
                </FaButton>
              </div>
            </template>
          </FaTable>
        </template>

        <!-- ==================== 相互作用 ==================== -->
        <template #interactions>
          <FaTable
            v-loading="interactionLoading"
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="interactionColumns"
            :data="interactionList"
          >
            <template #toolbar>
              <FaButton type="primary" @click="onCreateInteraction">
                <FaIcon name="i-ri:add-line" />
                新增相互作用
              </FaButton>
            </template>
            <template #cell-operation="{ row }">
              <div class="flex-center gap-2">
                <FaButton variant="outline" size="icon-sm" @click="onEditInteraction(row.original)">
                  <FaIcon name="i-ri:edit-line" />
                </FaButton>
              </div>
            </template>
          </FaTable>
        </template>
      </FaTabs>
    </FaPageMain>
  </div>
</template>
