<script setup lang="ts">
import type { DrugInteractionInput } from '@/types/medication-safety'
import apiMedicationSafety from '@/api/modules/medication-safety'

defineOptions({
  name: 'MedicationSafetyInteractionForm',
})

const props = defineProps<{
  tenantId: string
  /** 编辑模式禁忌 id */
  id?: string
  /** 初始数据(编辑模式) */
  initialData?: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'success'): void
}>()

const form = ref({
  ingredientA: '',
  ingredientB: '',
  severity: 'warning' as 'info' | 'warning' | 'error',
  description: '',
  active: true,
})

/**
 * 加载编辑数据(编辑模式由父组件传入 initialData 回填)
 */
watch(() => props.id, (id) => {
  if (!id || !props.initialData) {
    return
  }
  const d = props.initialData
  form.value.ingredientA = (d.ingredient_a as string) ?? ''
  form.value.ingredientB = (d.ingredient_b as string) ?? ''
  form.value.severity = (d.severity as typeof form.value.severity) ?? 'warning'
  form.value.description = (d.description as string) ?? ''
  form.value.active = (d.active as boolean) ?? true
}, { immediate: true })

/**
 * 提交保存(upsert 相互作用禁忌;ingredient 服务端归一化 a<=b)
 * @returns 是否成功
 */
async function submit(): Promise<boolean> {
  if (!form.value.ingredientA.trim() || !form.value.ingredientB.trim()) {
    useFaToast().warning('两个成分均不能为空')
    return false
  }
  if (form.value.ingredientA.trim().toLowerCase() === form.value.ingredientB.trim().toLowerCase()) {
    useFaToast().warning('两个成分不能相同')
    return false
  }
  const payload: DrugInteractionInput = {
    tenantId: props.tenantId,
    ingredientA: form.value.ingredientA.trim(),
    ingredientB: form.value.ingredientB.trim(),
    severity: form.value.severity,
    description: form.value.description.trim() || undefined,
    active: form.value.active,
  }

  try {
    await apiMedicationSafety.upsertInteraction(payload)
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
      <FaLabel label="成分 A" required>
        <FaInput v-model="form.ingredientA" placeholder="如 amoxicillin" />
      </FaLabel>
      <FaLabel label="成分 B" required>
        <FaInput v-model="form.ingredientB" placeholder="如 clavulanate" />
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
      <FaLabel label="启用">
        <FaSwitch v-model="form.active" />
      </FaLabel>
      <FaLabel label="描述" class="col-span-2">
        <FaTextarea v-model="form.description" placeholder="相互作用说明" />
      </FaLabel>
    </div>
  </div>
</template>
