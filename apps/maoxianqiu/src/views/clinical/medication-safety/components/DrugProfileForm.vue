<script setup lang="ts">
import type { DrugProfileInput } from '@/types/medication-safety'
import apiCatalog from '@/api/modules/catalog'
import apiMedicationSafety from '@/api/modules/medication-safety'

defineOptions({
  name: 'MedicationSafetyDrugProfileForm',
})

const props = defineProps<{
  tenantId: string
  /** 编辑模式档案 id */
  id?: string
  /** 初始数据(编辑模式) */
  initialData?: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'success'): void
}>()

const drugOptions = ref<{ label: string, value: string }[]>([])

const form = ref({
  catalogItemId: '',
  activeIngredient: '',
  strength: '',
  strengthUnit: '',
  route: 'oral' as 'oral' | 'injection' | 'topical' | 'other',
  antimicrobialClass: '',
  minDoseMgKg: undefined as number | undefined,
  maxDoseMgKg: undefined as number | undefined,
  minAgeMonths: undefined as number | undefined,
  maxAgeMonths: undefined as number | undefined,
  minWeightKg: undefined as number | undefined,
  maxWeightKg: undefined as number | undefined,
  maxDurationDays: undefined as number | undefined,
  speciesContraindicationsText: '',
})

const isEdit = computed(() => !!props.id)

/**
 * 加载药品目录(billing_type=drug)供选择
 */
async function loadDrugCatalog() {
  if (!props.tenantId) {
    return
  }
  try {
    const res: any = await apiCatalog.listItems({
      tenantId: props.tenantId,
      billingType: 'drug',
      isActive: true,
    })
    drugOptions.value = ((res.data ?? []) as { id: string, code: string, name: string }[]).map(d => ({
      label: `${d.name}(${d.code})`,
      value: d.id,
    }))
  }
  catch {
    drugOptions.value = []
  }
}

/**
 * 加载编辑数据(编辑模式由父组件传入 initialData 回填)
 */
watch(() => props.id, (id) => {
  if (!id || !props.initialData) {
    return
  }
  const d = props.initialData
  form.value.catalogItemId = (d.catalog_item_id as string) ?? ''
  form.value.activeIngredient = (d.active_ingredient as string) ?? ''
  form.value.strength = (d.strength as string) ?? ''
  form.value.strengthUnit = (d.strength_unit as string) ?? ''
  form.value.route = (d.route as typeof form.value.route) ?? 'oral'
  form.value.antimicrobialClass = (d.antimicrobial_class as string) ?? ''
  form.value.minDoseMgKg = d.min_dose_mg_kg != null ? Number(d.min_dose_mg_kg) : undefined
  form.value.maxDoseMgKg = d.max_dose_mg_kg != null ? Number(d.max_dose_mg_kg) : undefined
  form.value.minAgeMonths = d.min_age_months != null ? Number(d.min_age_months) : undefined
  form.value.maxAgeMonths = d.max_age_months != null ? Number(d.max_age_months) : undefined
  form.value.minWeightKg = d.min_weight_kg != null ? Number(d.min_weight_kg) : undefined
  form.value.maxWeightKg = d.max_weight_kg != null ? Number(d.max_weight_kg) : undefined
  form.value.maxDurationDays = d.max_duration_days != null ? Number(d.max_duration_days) : undefined
  form.value.speciesContraindicationsText = Array.isArray(d.species_contraindications)
    ? (d.species_contraindications as string[]).join(',')
    : ''
}, { immediate: true })

loadDrugCatalog()

/**
 * 提交保存(upsert 药品安全档案)
 * @returns 是否成功
 */
async function submit(): Promise<boolean> {
  if (!form.value.catalogItemId) {
    useFaToast().warning('请选择目录药品')
    return false
  }
  const payload: DrugProfileInput = {
    tenantId: props.tenantId,
    catalogItemId: form.value.catalogItemId,
    activeIngredient: form.value.activeIngredient.trim() || undefined,
    strength: form.value.strength.trim() || undefined,
    strengthUnit: form.value.strengthUnit.trim() || undefined,
    route: form.value.route,
    antimicrobialClass: form.value.antimicrobialClass.trim() || undefined,
    minDoseMgKg: form.value.minDoseMgKg,
    maxDoseMgKg: form.value.maxDoseMgKg,
    minAgeMonths: form.value.minAgeMonths,
    maxAgeMonths: form.value.maxAgeMonths,
    minWeightKg: form.value.minWeightKg,
    maxWeightKg: form.value.maxWeightKg,
    maxDurationDays: form.value.maxDurationDays,
    speciesContraindications: form.value.speciesContraindicationsText
      ? form.value.speciesContraindicationsText.split(',').map(s => s.trim()).filter(Boolean)
      : [],
  }

  try {
    await apiMedicationSafety.upsertDrugProfile(payload)
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
      <FaLabel label="目录药品" required class="col-span-2">
        <FaSelect v-model="form.catalogItemId" :options="drugOptions" filterable placeholder="选择药品目录项" />
      </FaLabel>
      <FaLabel label="活性成分">
        <FaInput v-model="form.activeIngredient" placeholder="如 amoxicillin" />
      </FaLabel>
      <FaLabel label="抗菌药物类别">
        <FaInput v-model="form.antimicrobialClass" placeholder="如 penicillin" />
      </FaLabel>
      <FaLabel label="规格">
        <FaInput v-model="form.strength" placeholder="如 250mg" />
      </FaLabel>
      <FaLabel label="规格单位">
        <FaInput v-model="form.strengthUnit" placeholder="如 mg/片" />
      </FaLabel>
      <FaLabel label="给药途径">
        <FaSelect
          v-model="form.route"
          :options="[
            { label: '口服', value: 'oral' },
            { label: '注射', value: 'injection' },
            { label: '外用', value: 'topical' },
            { label: '其他', value: 'other' },
          ]"
        />
      </FaLabel>
      <FaLabel label="最小剂量(mg/kg)">
        <FaInputNumber v-model="form.minDoseMgKg" :min="0" placeholder="如 5" />
      </FaLabel>
      <FaLabel label="最大剂量(mg/kg)">
        <FaInputNumber v-model="form.maxDoseMgKg" :min="0" placeholder="如 10" />
      </FaLabel>
      <FaLabel label="最小年龄(月)">
        <FaInputNumber v-model="form.minAgeMonths" :min="0" placeholder="如 3" />
      </FaLabel>
      <FaLabel label="最大年龄(月)">
        <FaInputNumber v-model="form.maxAgeMonths" :min="0" placeholder="如 96" />
      </FaLabel>
      <FaLabel label="最小体重(kg)">
        <FaInputNumber v-model="form.minWeightKg" :min="0" placeholder="如 2" />
      </FaLabel>
      <FaLabel label="最大体重(kg)">
        <FaInputNumber v-model="form.maxWeightKg" :min="0" placeholder="如 40" />
      </FaLabel>
      <FaLabel label="最大疗程(天)">
        <FaInputNumber v-model="form.maxDurationDays" :min="1" placeholder="如 30" />
      </FaLabel>
      <FaLabel label="物种禁忌(逗号分隔)" class="col-span-2">
        <FaInput v-model="form.speciesContraindicationsText" placeholder="如 cat" />
      </FaLabel>
    </div>
  </div>
</template>
