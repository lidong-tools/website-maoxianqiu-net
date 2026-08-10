<script setup lang="ts">
/**
 * 工作台详情抽屉:点击表格行打开,展示宠物/主人上下文与岗位专属信息,
 * 抽屉底部复用表格行同一套动作配置;存在 encounterId 时加载患者 workspace。
 */
import type { EncounterWorkspace, WorkbenchRole, WorkbenchRow } from '@/types/patient-journey'
import apiJourney from '@/api/modules/patient-journey'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import {
  CHARGE_STATUS_LABELS,
  JOURNEY_SOURCE_TYPE_LABELS,
} from '@/types/patient-journey'
import { roleStatusLabel, WORKBENCH_ACTION_META } from '../composables/useRoleWorkbench'

const props = withDefaults(defineProps<{
  visible: boolean
  row?: WorkbenchRow | null
  role: WorkbenchRole
  /** 行级动作 loading */
  isRowLoading?: (rowId: string, action?: string) => boolean
  /** 分诊保存中(仅分诊岗位按钮) */
  triageSaving?: boolean
}>(), {
  row: null,
  isRowLoading: () => false,
  triageSaving: false,
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'action': [row: WorkbenchRow, action: string]
  /** 保存分诊表单 */
  'saveTriage': [row: WorkbenchRow, form: TriageFormValue]
}>()

interface TriageFormValue {
  weightKg: number
  temperatureC: number
  heartRate: number
  respiratoryRate: number
  painScore: number
  acuity: string
  allergyNotes: string
  chiefComplaint: string
  notes: string
}

const QUEUE_ROLES: WorkbenchRole[] = ['frontdesk', 'triage', 'doctor', 'manager']

const workspace = ref<EncounterWorkspace | null>(null)
const workspaceLoading = ref(false)
const workspaceError = ref('')

/** 分诊表单(分诊岗位专用,重置到默认值) */
const triageForm = reactive<TriageFormValue>({
  weightKg: 0,
  temperatureC: 0,
  heartRate: 0,
  respiratoryRate: 0,
  painScore: 0,
  acuity: 'routine',
  allergyNotes: '',
  chiefComplaint: '',
  notes: '',
})

const isQueueRole = computed(() => QUEUE_ROLES.includes(props.role))

/** 当前行状态中文标签 */
const statusLabel = computed(() => props.row ? roleStatusLabel(props.role, props.row.status) : '-')

/** 状态标签配色(与表格共用规则) */
function statusVariant(status: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (isQueueRole.value) {
    return ({ waiting: 'warning', called: 'info', in_consultation: 'success', checked_in: 'warning', triage: 'warning', missed: 'neutral' } as Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>)[status] ?? 'neutral'
  }
  if (props.role === 'cashier') {
    if (status === 'paid') {
      return 'success'
    }
    if (status === 'invoiced') {
      return 'info'
    }
    if (status === 'voided') {
      return 'neutral'
    }
    return 'warning'
  }
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'failed') {
    return 'danger'
  }
  if (status === 'in_progress') {
    return 'info'
  }
  return 'warning'
}

/** 加载患者工作区(仅详情需要,失败不影响主列表) */
async function loadWorkspace(encounterId: string) {
  workspaceLoading.value = true
  workspaceError.value = ''
  try {
    workspace.value = await apiJourney.getWorkspace(encounterId)
  }
  catch (error: any) {
    workspaceError.value = error?.message || '患者上下文加载失败'
    workspace.value = null
  }
  finally {
    workspaceLoading.value = false
  }
}

watch(() => props.visible, (visible) => {
  if (!visible) {
    return
  }
  const encounterId = props.row?.encounter_id
  if (encounterId) {
    loadWorkspace(encounterId)
  }
  else {
    workspace.value = null
  }
  // 每次打开重置分诊表单
  Object.assign(triageForm, {
    weightKg: 0,
    temperatureC: 0,
    heartRate: 0,
    respiratoryRate: 0,
    painScore: 0,
    acuity: 'routine',
    allergyNotes: '',
    chiefComplaint: '',
    notes: '',
  })
})

/** 抽屉内的分诊保存 */
function onSaveTriage() {
  if (props.row) {
    emit('saveTriage', props.row, { ...triageForm })
  }
}

/** 主动作配置 */
const actionMeta = computed(() => props.row?.primaryAction ? WORKBENCH_ACTION_META[props.row.primaryAction] : undefined)

/** 次要动作:查看患者(抽屉里直接打开病历) */
const secondaryActions = computed(() => {
  const items: Array<{ label: string, icon?: string, onClick: () => void }> = []
  const row = props.row
  if (!row) {
    return items
  }
  const allowed = row.allowedActions ?? []
  if (row.encounter_id && !['open', 'view', 'continue'].includes(row.primaryAction ?? '')) {
    items.push({ label: '查看患者', icon: 'i-lucide:eye', onClick: () => emit('action', row, 'open') })
  }
  if (props.role === 'cashier' && allowed.includes('void') && row.status === 'pending') {
    items.push({ label: '异议作废', icon: 'i-lucide:ban', onClick: () => emit('action', row, 'void') })
  }
  return items
})

/** 抽屉标题:宠物名或业务对象 */
const drawerTitle = computed(() => {
  const row = props.row
  if (!row) {
    return '待办详情'
  }
  return `${row.pet?.name ?? '宠物'} · ${row.display?.businessNo ?? row.display?.title ?? '详情'}`
})

/** 生命体征摘要(来自 workspace 或行扩展) */
const vitalSigns = computed(() => {
  const triage = (workspace.value?.triage ?? (props.row as any)?.triage) as Record<string, any> | null
  if (!triage) {
    return null
  }
  const rows: Array<{ label: string, value: string }> = []
  if (triage.weight_kg != null) {
    rows.push({ label: '体重', value: `${triage.weight_kg} kg` })
  }
  if (triage.temperature_c != null) {
    rows.push({ label: '体温', value: `${triage.temperature_c} ℃` })
  }
  if (triage.heart_rate != null) {
    rows.push({ label: '心率', value: `${triage.heart_rate}` })
  }
  if (triage.respiratory_rate != null) {
    rows.push({ label: '呼吸', value: `${triage.respiratory_rate}` })
  }
  if (triage.pain_score != null) {
    rows.push({ label: '疼痛', value: `${triage.pain_score}/10` })
  }
  return rows.length ? rows : null
})

/** 风险标记 */
const riskFlags = computed(() => {
  const triage = (workspace.value?.triage ?? (props.row as any)?.triage) as Record<string, any> | null
  return (triage?.risk_flags as string[] | null) ?? []
})
</script>

<template>
  <FaDrawer
    :model-value="visible"
    :title="drawerTitle"
    width="560"
    :show-confirm-button="false"
    :footer="false"
    @update:model-value="emit('update:visible', $event)"
  >
    <div v-if="props.row" class="p-4 space-y-4">
      <!-- 通用上下文 -->
      <div class="space-y-1">
        <div class="text-base font-semibold">
          {{ props.row.pet?.name ?? '未命名宠物' }} <span class="text-sm text-muted-foreground font-normal">· {{ props.row.customer?.name ?? '未知客户' }}</span>
        </div>
        <div class="text-sm text-muted-foreground">
          {{ props.row.customer?.phone ?? '无联系电话' }}
          <span v-if="props.row.pet?.species"> · {{ props.row.pet.species }}<template v-if="props.row.pet.breed"> / {{ props.row.pet.breed }}</template></span>
        </div>
      </div>

      <!-- 状态与时效 -->
      <div class="flex flex-wrap gap-2 items-center">
        <EntityStatusTag :label="statusLabel" :variant="statusVariant(props.row.status)" dot />
        <EntityStatusTag v-if="props.row.priority && props.row.priority !== 'routine'" :label="props.row.priority === 'emergency' ? '急诊' : props.row.priority === 'urgent' ? '紧急' : '优先'" :variant="props.row.priority === 'routine' ? 'neutral' : 'warning'" />
        <span v-if="props.row.timing?.overdue" class="text-danger text-xs">
          已超时
        </span>
        <span v-else-if="props.row.timing?.elapsedMinutes !== undefined" class="text-xs text-muted-foreground">
          等待 {{ props.row.timing.elapsedMinutes }} 分钟
        </span>
      </div>

      <!-- 业务信息 -->
      <div class="text-sm gap-x-4 gap-y-2 grid grid-cols-2">
        <div>
          <div class="text-xs text-muted-foreground">
            业务对象
          </div>
          <div class="truncate">
            {{ props.row.display?.title ?? '-' }}
          </div>
        </div>
        <div v-if="props.row.display?.businessNo">
          <div class="text-xs text-muted-foreground">
            业务单号
          </div>
          <div class="truncate tabular-nums">
            {{ props.row.display.businessNo }}
          </div>
        </div>
        <div v-if="props.row.display?.sourceLabel">
          <div class="text-xs text-muted-foreground">
            来源
          </div>
          <div>
            {{ JOURNEY_SOURCE_TYPE_LABELS[props.row.display.sourceLabel] ?? props.row.display.sourceLabel }}
          </div>
        </div>
        <div>
          <div class="text-xs text-muted-foreground">
            创建时间
          </div>
          <div class="tabular-nums">
            {{ props.row.created_at ? new Date(props.row.created_at).toLocaleString('zh-CN') : '-' }}
          </div>
        </div>
        <div>
          <div class="text-xs text-muted-foreground">
            执行人
          </div>
          <div>
            {{ props.row.assignee?.name ?? '未指派' }}
          </div>
        </div>
        <div v-if="props.row.lastOperator">
          <div class="text-xs text-muted-foreground">
            最近操作人
          </div>
          <div>
            {{ props.row.lastOperator.name }}
          </div>
        </div>
      </div>

      <!-- 队列岗位:预约原因 / 分诊 / 生命体征 -->
      <template v-if="isQueueRole">
        <div v-if="(props.row as any).appointment?.reason" class="text-sm p-3 rounded-md bg-muted">
          <div class="text-xs text-muted-foreground mb-1">
            预约原因
          </div>
          {{ (props.row as any).appointment.reason }}
        </div>
        <div v-if="vitalSigns" class="gap-2 grid grid-cols-5">
          <div v-for="item in vitalSigns" :key="item.label" class="p-2 text-center border rounded-md">
            <div class="text-xs text-muted-foreground">
              {{ item.label }}
            </div>
            <div class="text-sm font-medium tabular-nums">
              {{ item.value }}
            </div>
          </div>
        </div>
        <div v-if="riskFlags.length" class="flex flex-wrap gap-2 items-center">
          <EntityStatusTag v-for="flag in riskFlags" :key="flag" label="风险" variant="danger" />
          <span class="text-sm">{{ riskFlags.join('、') }}</span>
        </div>
      </template>

      <!-- 收银岗位:收费明细与异议状态 -->
      <template v-if="props.role === 'cashier'">
        <div class="text-sm p-3 border rounded-md space-y-2">
          <div class="flex items-center justify-between">
            <span>{{ props.row.display?.title ?? props.row.item_name }}</span>
            <span class="text-primary font-semibold tabular-nums">¥{{ Number(props.row.amount ?? 0).toFixed(2) }}</span>
          </div>
          <div class="text-xs text-muted-foreground flex items-center justify-between">
            <span>数量 {{ Number(props.row.quantity ?? 1) }} × 单价 ¥{{ Number(props.row.unit_price ?? 0).toFixed(2) }}</span>
            <span>{{ CHARGE_STATUS_LABELS[props.row.status] ?? props.row.status }}</span>
          </div>
          <div v-if="props.row.status === 'voided'" class="text-danger text-xs">
            已作废:原记录与作废原因保留留痕
          </div>
        </div>
      </template>

      <!-- 医疗执行岗位:任务要求与来源 -->
      <template v-if="!isQueueRole && props.role !== 'cashier'">
        <div class="text-sm p-3 rounded-md bg-muted">
          <div class="text-xs text-muted-foreground mb-1">
            任务说明
          </div>
          {{ props.row.display?.subtitle || '无补充说明' }}
        </div>
      </template>

      <!-- 分诊岗位:内嵌分诊表单 -->
      <template v-if="props.role === 'triage'">
        <div class="p-3 border rounded-md space-y-3">
          <div class="text-sm font-medium">
            分诊评估
          </div>
          <div class="gap-3 grid grid-cols-2">
            <FaLabel label="体重(kg)">
              <FaNumberField v-model="triageForm.weightKg" :min="0.01" :step="0.1" />
            </FaLabel>
            <FaLabel label="体温(℃)">
              <FaNumberField v-model="triageForm.temperatureC" :min="20" :max="50" :step="0.1" />
            </FaLabel>
            <FaLabel label="心率">
              <FaNumberField v-model="triageForm.heartRate" :min="1" />
            </FaLabel>
            <FaLabel label="呼吸频率">
              <FaNumberField v-model="triageForm.respiratoryRate" :min="1" />
            </FaLabel>
            <FaLabel label="疼痛评分">
              <FaNumberField v-model="triageForm.painScore" :min="0" :max="10" />
            </FaLabel>
            <FaLabel label="分诊等级">
              <FaSelect
                v-model="triageForm.acuity" :options="[
                  { label: '常规', value: 'routine' }, { label: '优先', value: 'priority' },
                  { label: '紧急', value: 'urgent' }, { label: '急诊', value: 'emergency' },
                ]"
              />
            </FaLabel>
            <FaLabel label="主诉" class="col-span-2">
              <FaTextarea v-model="triageForm.chiefComplaint" />
            </FaLabel>
            <FaLabel label="过敏与风险" class="col-span-2">
              <FaTextarea v-model="triageForm.allergyNotes" />
            </FaLabel>
            <FaLabel label="分诊备注" class="col-span-2">
              <FaTextarea v-model="triageForm.notes" />
            </FaLabel>
          </div>
        </div>
      </template>

      <!-- 患者工作区加载状态(仅抽屉受影响) -->
      <div v-if="workspaceLoading" class="text-sm text-muted-foreground py-4 text-center">
        加载患者上下文…
      </div>
      <div v-else-if="workspaceError" class="bg-danger/10 text-danger text-sm p-3 rounded-md">
        {{ workspaceError }}
      </div>
    </div>

    <!-- 底部固定动作栏:与表格行共用动作配置(分诊岗位以保存分诊作为主动作) -->
    <template v-if="props.row && (actionMeta || secondaryActions.length || props.role === 'triage')" #footer>
      <div class="flex gap-2 w-full items-center justify-end">
        <FaButton
          v-if="props.role === 'triage'"
          size="sm"
          :loading="triageSaving || props.isRowLoading(props.row.id)"
          @click="onSaveTriage"
        >
          保存分诊
        </FaButton>
        <FaButton
          v-else-if="actionMeta"
          size="sm"
          :loading="props.isRowLoading(props.row.id, props.row.primaryAction)"
          @click="emit('action', props.row!, props.row!.primaryAction!)"
        >
          <FaIcon v-if="actionMeta.icon" :name="actionMeta.icon" />
          {{ actionMeta.label }}
        </FaButton>
        <FaButton v-for="item in secondaryActions" :key="item.label" size="sm" variant="outline" @click="item.onClick">
          <FaIcon v-if="item.icon" :name="item.icon" />
          {{ item.label }}
        </FaButton>
      </div>
    </template>
  </FaDrawer>
</template>
