<script setup lang="ts">
/**
 * MedicalOrderEditor — 医嘱快速编辑器
 * 类型(注射/输液/治疗/处置/护理/用药/其他)+ 项目 + 剂量 + 频次 + 数量 + 单位 + 执行说明
 * + 计划执行时间 + 指定执行护士。
 * 提交走 createMedicalOrder(自动生成护士任务)。
 */
import type { MedicalOrderDraft } from '../composables/useClinicalPlanDraft'
import BusinessEmployeePicker from '@/components/business/EmployeePicker/index.vue'

defineOptions({
  name: 'WorkbenchMedicalOrderEditor',
})

defineProps<{
  draft: MedicalOrderDraft
  submitting: boolean
  readonly: boolean
}>()

const emit = defineEmits<{
  update: [field: string, value: unknown]
  submit: []
}>()

/** 医嘱类型选项 */
const ORDER_TYPE_OPTIONS = [
  { label: '注射', value: 'injection' },
  { label: '输液', value: 'infusion' },
  { label: '治疗', value: 'treatment' },
  { label: '处置', value: 'disposal' },
  { label: '护理', value: 'nursing' },
  { label: '用药', value: 'medication' },
  { label: '其他', value: 'other' },
]
</script>

<template>
  <div class="p-2 border rounded-md space-y-2">
    <div class="gap-2 grid grid-cols-2">
      <FaLabel label="医嘱类型">
        <FaSelect :model-value="draft.orderType" :options="ORDER_TYPE_OPTIONS" :disabled="readonly" class="w-full" @update:model-value="(v) => emit('update', 'orderType', v)" />
      </FaLabel>
      <FaLabel label="项目名称">
        <FaInput :model-value="draft.itemName" :disabled="readonly" placeholder="如:皮下补液/伤口换药" class="w-full" @update:model-value="(v) => emit('update', 'itemName', v)" />
      </FaLabel>
    </div>
    <div class="gap-2 grid grid-cols-4">
      <FaLabel label="剂量">
        <FaInput :model-value="draft.dosage" :disabled="readonly" placeholder="如:5ml" class="w-full" @update:model-value="(v) => emit('update', 'dosage', v)" />
      </FaLabel>
      <FaLabel label="频次">
        <FaInput :model-value="draft.frequency" :disabled="readonly" placeholder="如:每日1次" class="w-full" @update:model-value="(v) => emit('update', 'frequency', v)" />
      </FaLabel>
      <FaLabel label="数量">
        <FaInput :model-value="draft.quantity" type="number" :disabled="readonly" class="w-full" @update:model-value="(v) => emit('update', 'quantity', v)" />
      </FaLabel>
      <FaLabel label="单位">
        <FaInput :model-value="draft.unit" :disabled="readonly" placeholder="如:次" class="w-full" @update:model-value="(v) => emit('update', 'unit', v)" />
      </FaLabel>
    </div>
    <FaLabel label="执行说明">
      <FaTextarea :model-value="draft.instructions" :disabled="readonly" :rows="2" placeholder="执行注意事项(可选)" class="w-full" @update:model-value="(v) => emit('update', 'instructions', v)" />
    </FaLabel>
    <div class="gap-2 grid grid-cols-2">
      <FaLabel label="计划执行时间">
        <FaInput :model-value="draft.scheduledAt" type="datetime-local" :disabled="readonly" class="w-full" @update:model-value="(v) => emit('update', 'scheduledAt', v)" />
      </FaLabel>
      <FaLabel label="执行护士">
        <BusinessEmployeePicker
          :model-value="draft.assigneeId"
          value-key="user_id"
          :disabled="readonly"
          placeholder="搜索选择执行护士(可空=待分派)"
          class="w-full"
          @update:model-value="(v) => emit('update', 'assigneeId', v ?? '')"
        />
      </FaLabel>
    </div>

    <div class="flex justify-end">
      <FaButton size="sm" :disabled="readonly" :loading="submitting" @click="emit('submit')">
        <FaIcon name="i-lucide:send" />
        开立医嘱
      </FaButton>
    </div>
  </div>
</template>
