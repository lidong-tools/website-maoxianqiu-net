<script setup lang="ts">
/**
 * ClinicalPlanSummary — 提交诊疗方案前的紧凑确认摘要
 * 展示四类单据数量、预计待收金额、无价格项、用药安全阻断/警告与下游去向。
 * 作为 FaModal content 使用;存在阻断项时由父组件禁止提交。
 */
import type { EncounterWorkspace } from '@/types/patient-journey'

defineOptions({
  name: 'WorkbenchClinicalPlanSummary',
})

const props = defineProps<{
  workspace: EncounterWorkspace
  /** 是否仍有未提交的下单草稿 */
  planDirty: boolean
  /** 病历是否尚未保存(有未保存修改) */
  encounterDirty: boolean
  /** 本次提交将随 plan/commit 一并原子落库的草稿摘要 */
  pendingDrafts?: Array<{ type: string, label: string }>
}>()

/** 下游去向:由未完成任务 owner_role 推导的中文说明 */
const downstreamText = computed(() => {
  const roles: Record<string, string> = {
    pharmacy: '药房发药',
    nurse: '护士执行',
    lab: '检验采样',
    imaging: '影像检查',
    cashier: '收银收费',
  }
  const taskRoles = [...new Set(props.workspace.tasks.map((task: any) => task.owner_role).filter(Boolean))]
  const lines: string[] = taskRoles.map(role => roles[role] ?? role)
  if (props.workspace.billing.pendingCount) {
    lines.push(`客户待收费 ${props.workspace.billing.pendingCount} 项`)
  }
  return lines.join(' → ') || '无下游待办'
})

/** 已开处方药品清单摘要 */
const drugSummary = computed(() => {
  return props.workspace.prescriptions.flatMap((rx) => {
    const items = rx.items ?? []
    return items.length
      ? items.map((item: any) => item.drug_name ?? '')
      : [rx.name ?? '未命名处方']
  }).filter(Boolean)
})
</script>

<template>
  <div class="space-y-3">
    <!-- 阻断警告 -->
    <div
      v-if="workspace.medicationSafety.hasBlocking"
      class="text-xs text-red-700 p-2.5 border border-red-200 rounded-md bg-red-50 dark:text-red-300 dark:border-red-800 dark:bg-red-950/40"
    >
      <div class="font-medium mb-1">
        <FaIcon name="i-lucide:shield-alert" class="mr-1 inline" />
        用药安全阻断:{{ workspace.medicationSafety.blockingChecks.length }} 项未处理
      </div>
      <div v-for="check in workspace.medicationSafety.blockingChecks" :key="check.id" class="truncate">
        · {{ check.message_snapshot }}
      </div>
    </div>

    <!-- 病历保存状态 -->
    <div v-if="encounterDirty" class="text-xs text-amber-700 p-2.5 border border-amber-200 rounded-md bg-amber-50 dark:text-amber-300 dark:border-amber-800 dark:bg-amber-950/40">
      病历尚有未保存修改,提交前请先保存草稿。
    </div>

    <!-- 四类单据数量 -->
    <div class="text-xs gap-2 grid grid-cols-2">
      <div class="p-2 border rounded-md flex items-center justify-between">
        <span class="text-muted-foreground">处方</span>
        <span class="font-medium">{{ workspace.prescriptions.length }}</span>
      </div>
      <div class="p-2 border rounded-md flex items-center justify-between">
        <span class="text-muted-foreground">检验</span>
        <span class="font-medium">{{ workspace.labOrders.length }}</span>
      </div>
      <div class="p-2 border rounded-md flex items-center justify-between">
        <span class="text-muted-foreground">影像</span>
        <span class="font-medium">{{ workspace.imagingOrders.length }}</span>
      </div>
      <div class="p-2 border rounded-md flex items-center justify-between">
        <span class="text-muted-foreground">医嘱</span>
        <span class="font-medium">{{ workspace.medicalOrders.length }}</span>
      </div>
    </div>

    <!-- 处方药品 -->
    <div v-if="drugSummary.length" class="text-xs">
      <div class="text-muted-foreground mb-1">
        处方药品
      </div>
      <div class="flex flex-wrap gap-1">
        <span v-for="(name, i) in drugSummary" :key="i" class="px-1.5 py-0.5 rounded bg-muted">
          {{ name }}
        </span>
      </div>
    </div>

    <!-- 费用与下游 -->
    <div class="text-xs space-y-1">
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">预计待收金额</span>
        <span class="font-medium">¥{{ workspace.billing.pendingAmount.toFixed(2) }}</span>
      </div>
      <div v-if="workspace.billing.noPriceCount" class="text-amber-600 flex items-center justify-between">
        <span>无有效价格项目</span>
        <span class="font-medium">{{ workspace.billing.noPriceCount }}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground">下游去向</span>
        <span class="text-right">{{ downstreamText }}</span>
      </div>
      <div v-if="workspace.medicationSafety.warningChecks.length" class="text-amber-600 flex items-center justify-between">
        <span>用药安全普通警告</span>
        <span class="font-medium">{{ workspace.medicationSafety.warningChecks.length }}</span>
      </div>
    </div>

    <!-- 本次提交将一并落库的草稿 -->
    <div v-if="pendingDrafts?.length" class="text-xs">
      <div class="text-muted-foreground mb-1">
        本次提交将一并落库
      </div>
      <div class="flex flex-wrap gap-1">
        <span v-for="(item, i) in pendingDrafts" :key="i" class="px-1.5 py-0.5 rounded bg-muted">
          {{ item.type }} {{ item.label }}
        </span>
      </div>
    </div>

    <!-- 未提交草稿提示 -->
    <div v-if="planDirty && !pendingDrafts?.length" class="text-xs text-muted-foreground">
      仍有未提交的下单草稿,提交后草稿内容不会自动带入,请确认是否已逐项提交。
    </div>
  </div>
</template>
