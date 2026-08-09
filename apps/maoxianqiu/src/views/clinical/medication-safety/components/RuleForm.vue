<script setup lang="ts">
import type { MedicationSafetyRuleInput, MedicationSafetyRuleType } from '@/types/medication-safety'
import apiMedicationSafety from '@/api/modules/medication-safety'

defineOptions({
  name: 'MedicationSafetyRuleForm',
})

const props = defineProps<{
  tenantId: string
  /** 编辑模式规则 id */
  id?: string
  /** 初始数据(编辑模式) */
  initialData?: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'success'): void
}>()

const form = ref({
  code: '',
  name: '',
  ruleType: 'dose_range' as MedicationSafetyRuleType,
  severity: 'warning' as 'info' | 'warning' | 'error',
  isBlocking: false,
  speciesText: '',
  active: true,
  maxDurationDays: undefined as number | undefined,
  maxDailyFrequency: undefined as number | undefined,
  message: '',
  recommendation: '',
})

const isEdit = computed(() => !!props.id)

/** 规则类型选项 */
const ruleTypeOptions = [
  { label: '重复药品(duplicate_drug)', value: 'duplicate_drug' },
  { label: '重复成分(duplicate_ingredient)', value: 'duplicate_ingredient' },
  { label: '剂量范围(dose_range)', value: 'dose_range' },
  { label: '疗程上限(duration_limit)', value: 'duration_limit' },
  { label: '频次上限(frequency_limit)', value: 'frequency_limit' },
  { label: '物种禁忌(species_contraindication)', value: 'species_contraindication' },
  { label: '年龄约束(age_constraint)', value: 'age_constraint' },
  { label: '体重约束(weight_constraint)', value: 'weight_constraint' },
  { label: '抗菌药物提示(antimicrobial_notice)', value: 'antimicrobial_notice' },
  { label: '药物相互作用(drug_interaction)', value: 'drug_interaction' },
]

/** 是否展示 condition 配置(duration/frequency 由规则参数驱动) */
const showDurationConfig = computed(() => form.value.ruleType === 'duration_limit')
const showFrequencyConfig = computed(() => form.value.ruleType === 'frequency_limit')

/**
 * 加载编辑数据(编辑模式由父组件传入 initialData 回填)
 */
watch(() => props.id, (id) => {
  if (!id || !props.initialData) {
    return
  }
  const d = props.initialData
  form.value.code = (d.code as string) ?? ''
  form.value.name = (d.name as string) ?? ''
  form.value.ruleType = (d.rule_type as MedicationSafetyRuleType) ?? 'dose_range'
  form.value.severity = (d.severity as 'info' | 'warning' | 'error') ?? 'warning'
  form.value.isBlocking = (d.is_blocking as boolean) ?? false
  form.value.speciesText = Array.isArray(d.species) ? (d.species as string[]).join(',') : ''
  form.value.active = (d.active as boolean) ?? true
  const condition = (d.condition as Record<string, unknown>) ?? {}
  form.value.maxDurationDays = Number(condition.max_duration_days) || undefined
  form.value.maxDailyFrequency = Number(condition.max_daily_frequency) || undefined
  form.value.message = (d.message as string) ?? ''
  form.value.recommendation = (d.recommendation as string) ?? ''
}, { immediate: true })

/**
 * 提交保存(创建或更新;更新时版本 +1)
 * @returns 是否成功
 */
async function submit(): Promise<boolean> {
  if (!form.value.name.trim()) {
    useFaToast().warning('规则名称不能为空')
    return false
  }
  if (!props.id && !form.value.code.trim()) {
    useFaToast().warning('规则编码不能为空')
    return false
  }
  if (showDurationConfig.value && !form.value.maxDurationDays) {
    useFaToast().warning('请填写疗程上限(天)')
    return false
  }
  if (showFrequencyConfig.value && !form.value.maxDailyFrequency) {
    useFaToast().warning('请填写每日频次上限')
    return false
  }

  // 依据规则类型组装 condition(其余类型由 drug_profiles / interactions 数据驱动)
  const condition: Record<string, unknown> = {}
  if (showDurationConfig.value) {
    condition.max_duration_days = form.value.maxDurationDays
  }
  if (showFrequencyConfig.value) {
    condition.max_daily_frequency = form.value.maxDailyFrequency
  }

  const payload: MedicationSafetyRuleInput = {
    tenantId: props.tenantId,
    ruleId: props.id,
    code: form.value.code.trim(),
    name: form.value.name.trim(),
    ruleType: form.value.ruleType,
    severity: form.value.severity,
    isBlocking: form.value.isBlocking,
    species: form.value.speciesText ? form.value.speciesText.split(',').map(s => s.trim()).filter(Boolean) : [],
    active: form.value.active,
    condition,
    message: form.value.message.trim() || undefined,
    recommendation: form.value.recommendation.trim() || undefined,
  }

  try {
    if (props.id) {
      await apiMedicationSafety.updateRule(props.id, payload)
    }
    else {
      await apiMedicationSafety.createRule(payload)
    }
    emit('success')
    return true
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '保存失败')
    return false
  }
}

defineExpose({ submit })
</script>

<template>
  <div class="p-2 flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
    <div class="gap-4 grid grid-cols-2">
      <FaLabel label="规则编码" :required="!isEdit">
        <FaInput v-model="form.code" :disabled="isEdit" placeholder="如 duration_limit" />
      </FaLabel>
      <FaLabel label="规则名称" required>
        <FaInput v-model="form.name" placeholder="如 疗程上限" />
      </FaLabel>
      <FaLabel label="规则类型" required>
        <FaSelect v-model="form.ruleType" :options="ruleTypeOptions" />
      </FaLabel>
      <FaLabel label="严重度">
        <FaSelect
          v-model="form.severity"
          :options="[
            { label: '提示(info)', value: 'info' },
            { label: '警告(warning)', value: 'warning' },
            { label: '错误(error)', value: 'error' },
          ]"
        />
      </FaLabel>
      <FaLabel label="是否阻断">
        <FaSwitch v-model="form.isBlocking" />
      </FaLabel>
      <FaLabel label="启用">
        <FaSwitch v-model="form.active" />
      </FaLabel>
      <FaLabel label="适用物种(逗号分隔,留空=全物种)" class="col-span-2">
        <FaInput v-model="form.speciesText" placeholder="如 dog,cat" />
      </FaLabel>
      <FaLabel v-if="showDurationConfig" label="疗程上限(天)" required class="col-span-2">
        <FaInputNumber v-model="form.maxDurationDays" :min="1" placeholder="如 30" />
      </FaLabel>
      <FaLabel v-if="showFrequencyConfig" label="每日频次上限" required class="col-span-2">
        <FaInputNumber v-model="form.maxDailyFrequency" :min="1" :max="12" placeholder="如 4" />
      </FaLabel>
      <FaLabel label="提示文案" class="col-span-2">
        <FaInput v-model="form.message" placeholder="触发时展示的提示信息" />
      </FaLabel>
      <FaLabel label="处置建议" class="col-span-2">
        <FaTextarea v-model="form.recommendation" placeholder="给医生的处置建议" />
      </FaLabel>
    </div>
  </div>
</template>
