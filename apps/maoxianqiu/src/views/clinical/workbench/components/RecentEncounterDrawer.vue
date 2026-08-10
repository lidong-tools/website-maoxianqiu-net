<script setup lang="ts">
/**
 * RecentEncounterDrawer — 当前宠物历史病历抽屉预览
 * 不跳转详情页;支持将历史诊断/治疗方案复制到当前草稿(仅复制,不自动保存)。
 */
import { ENCOUNTER_STATUS_LABELS } from '@/types/clinical'

defineOptions({
  name: 'WorkbenchRecentEncounterDrawer',
})

defineProps<{
  visible: boolean
  /** 当前宠物最近病历摘要(排除本次) */
  encounters: Record<string, any>[]
  petName?: string
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'copyToDraft': [encounter: Record<string, any>]
}>()

/** 历史病历状态展示(优先 clinical_status,回退 status) */
function statusOf(e: Record<string, any>): string {
  return e.clinical_status ?? e.status ?? ''
}

/** 复制历史诊断/方案到当前草稿并提示 */
function onCopy(e: Record<string, any>) {
  emit('copyToDraft', e)
}
</script>

<template>
  <FaDrawer
    :model-value="visible"
    :title="`${petName ?? '宠物'} · 最近病历(${encounters.length})`"
    :width="460"
    :footer="false"
    @update:model-value="emit('update:visible', $event)"
  >
    <FaScrollArea class="h-full">
      <div class="p-2 space-y-2">
        <div
          v-for="e in encounters"
          :key="e.id"
          class="p-3 border rounded-md space-y-1.5"
        >
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">
              {{ new Date(e.started_at ?? e.created_at).toLocaleDateString('zh-CN') }}
            </span>
            <EntityStatusTag
              :label="ENCOUNTER_STATUS_LABELS[statusOf(e) as keyof typeof ENCOUNTER_STATUS_LABELS] ?? statusOf(e)"
              variant="info"
              :dot="false"
            />
          </div>
          <div class="text-xs text-muted-foreground">
            <span class="text-foreground font-medium">主诉:</span>
            {{ e.chief_complaint ?? '无' }}
          </div>
          <div class="text-xs text-muted-foreground">
            <span class="text-foreground font-medium">诊断:</span>
            {{ e.diagnosis_text ?? '无' }}
          </div>
          <div class="text-xs text-muted-foreground line-clamp-3">
            <span class="text-foreground font-medium">方案:</span>
            {{ e.treatment_plan ?? '无' }}
          </div>
          <FaButton size="sm" variant="outline" class="w-full justify-start" @click="onCopy(e)">
            <FaIcon name="i-lucide:copy" />
            复制诊断与方案到当前草稿
          </FaButton>
        </div>
        <EmptyState v-if="!encounters.length" compact title="暂无历史病历" />
      </div>
    </FaScrollArea>
  </FaDrawer>
</template>
