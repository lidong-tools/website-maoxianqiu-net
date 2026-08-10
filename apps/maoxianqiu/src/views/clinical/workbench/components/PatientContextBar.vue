<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- 安全条派生文本使用单行提前返回 */
/**
 * PatientContextBar — 顶部患者安全条
 * 单行优先展示宠物/主人核心信息、分诊与生命体征、过敏/风险、
 * 本次旅程阶段、待付款与阻断数。过敏/危急信息不可折叠。
 */
import type { EncounterWorkspace } from '@/types/patient-journey'

defineOptions({
  name: 'WorkbenchPatientContextBar',
})

const props = defineProps<{
  workspace: EncounterWorkspace
}>()

/** 物种中文名 */
const SPECIES_LABELS: Record<string, string> = {
  dog: '犬',
  cat: '猫',
  rabbit: '兔',
  bird: '鸟',
  reptile: '爬虫',
  other: '其他',
}

/** 分诊分级中文名 */
const ACUITY_LABELS: Record<string, string> = {
  routine: '常规',
  priority: '优先',
  urgent: '紧急',
  emergency: '危重',
}

const pet = computed(() => props.workspace.pet)
const customer = computed(() => props.workspace.customer)
const triage = computed(() => props.workspace.triage)

/** 宠物年龄描述(按出生日期推算) */
const petAgeText = computed(() => {
  const birth = pet.value?.birth_date
  if (!birth) { return '年龄未知' }
  const years = (Date.now() - new Date(birth).getTime()) / (365.25 * 24 * 3600 * 1000)
  if (years >= 1) { return `${Math.floor(years)}岁` }
  const months = Math.max(1, Math.floor(years * 12))
  return `${months}个月`
})

/** 性别中文 */
const petGenderText = computed(() => {
  const g = pet.value?.gender
  if (g === 'male') { return '公' }
  if (g === 'female') { return '母' }
  return '未知'
})

/** 过敏与风险标签(危险信息,常驻展示) */
const dangerItems = computed(() => {
  const items: string[] = []
  ;(pet.value?.risk_tags ?? []).forEach((tag: string) => items.push(String(tag)))
  if (triage.value?.allergy_notes) { items.push(`过敏:${triage.value.allergy_notes}`) }
  return items
})

/** 生命体征摘要文本 */
const vitalsText = computed(() => {
  const t = triage.value
  const parts: string[] = []
  if (t?.weight_kg != null) { parts.push(`${t.weight_kg}kg`) }
  if (t?.temperature_c != null) { parts.push(`${t.temperature_c}℃`) }
  if (t?.heart_rate != null) { parts.push(`HR ${t.heart_rate}`) }
  if (t?.respiratory_rate != null) { parts.push(`RR ${t.respiratory_rate}`) }
  if (t?.pain_score != null) { parts.push(`疼痛${t.pain_score}`) }
  return parts.join(' · ')
})

/** 旅程阶段中文 */
const JOURNEY_STAGE_LABELS: Record<string, string> = {
  consultation: '问诊中',
  payment: '待收费',
  diagnostics: '检查中',
  discharge: '待离院',
  closed: '已结束',
}

/** 未完成下游任务数 */
const openTaskCount = computed(() =>
  props.workspace.tasks.filter((task: any) => ['pending', 'claimed', 'in_progress'].includes(task.status)).length,
)

/** 阻断项目(支付/任务/用药安全) */
const blockerCount = computed(() => props.workspace.blockers.length)
</script>

<template>
  <div class="text-sm px-3 py-2 border rounded-lg bg-card flex flex-wrap gap-x-4 gap-y-1 items-center">
    <!-- 宠物核心信息 -->
    <div class="flex gap-2 min-w-0 items-center">
      <div class="bg-primary-50 text-primary rounded-full flex shrink-0 size-8 items-center justify-center">
        <span class="text-sm font-semibold">{{ pet?.name?.slice(0, 1) ?? '宠' }}</span>
      </div>
      <div class="min-w-0">
        <div class="font-medium flex gap-1.5 items-center">
          <span class="truncate">{{ pet?.name ?? '未知宠物' }}</span>
          <EntityStatusTag
            v-if="workspace.journeyStage"
            :label="JOURNEY_STAGE_LABELS[workspace.journeyStage] ?? workspace.journeyStage"
            variant="info"
            :dot="false"
          />
        </div>
        <div class="text-xs text-muted-foreground truncate">
          {{ SPECIES_LABELS[pet?.species ?? ''] ?? pet?.species ?? '' }}
          <template v-if="pet?.breed">
            · {{ pet.breed }}
          </template>
          · {{ petGenderText }} · {{ petAgeText }}
          <template v-if="pet?.weight != null">
            · {{ pet.weight }}kg
          </template>
        </div>
      </div>
    </div>

    <!-- 主人信息 -->
    <div v-if="customer" class="text-xs text-muted-foreground min-w-0">
      <div class="text-foreground font-medium truncate">
        {{ customer.name }}
      </div>
      <div v-if="customer.phone" class="truncate">
        {{ customer.phone }}
      </div>
    </div>

    <!-- 分诊与生命体征 -->
    <div v-if="triage" class="text-xs text-muted-foreground min-w-0">
      <div class="flex gap-1 items-center">
        <span class="text-foreground font-medium">分诊</span>
        <EntityStatusTag
          :label="ACUITY_LABELS[triage.acuity ?? ''] ?? triage.acuity ?? '常规'"
          :variant="triage.acuity === 'urgent' || triage.acuity === 'emergency' ? 'danger' : 'info'"
          :dot="false"
        />
      </div>
      <div v-if="vitalsText" class="truncate">
        {{ vitalsText }}
      </div>
    </div>

    <!-- 过敏与风险(危险色,不可折叠) -->
    <div v-if="dangerItems.length" class="flex flex-wrap gap-1.5 items-center">
      <span
        v-for="(item, i) in dangerItems"
        :key="i"
        class="text-xs text-red-600 font-medium px-2 py-0.5 border border-red-200 rounded-md bg-red-50 dark:border-red-800 dark:bg-red-950/40"
      >
        <FaIcon name="i-lucide:alert-triangle" class="mr-1 size-3 inline" />
        {{ item }}
      </span>
    </div>
    <div v-else class="text-xs text-muted-foreground">
      无已知风险
    </div>

    <!-- 收费与阻断 -->
    <div class="text-xs text-muted-foreground ml-auto flex shrink-0 gap-3 items-center">
      <span v-if="workspace.billing.pendingCount">
        待付款 <span class="text-foreground font-medium">¥{{ workspace.billing.pendingAmount.toFixed(2) }}</span>
        <span v-if="workspace.billing.noPriceCount" class="text-amber-600">({{ workspace.billing.noPriceCount }}项无价)</span>
      </span>
      <span v-if="openTaskCount">任务 {{ openTaskCount }}</span>
      <span v-if="blockerCount" class="text-red-600 font-medium">
        <FaIcon name="i-lucide:shield-alert" class="mr-0.5 size-3.5 inline" />
        阻断 {{ blockerCount }}
      </span>
    </div>
  </div>
</template>
