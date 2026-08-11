<script setup lang="ts">
import type { BillingType, CatalogCategory, DrugForm, VaccineType } from '@/types/catalog'
import apiCatalog from '@/api/modules/catalog'
import {
  BILLING_TYPE_LABELS,
  DRUG_FORM_LABELS,
  VACCINE_TYPE_LABELS,
} from '@/types/catalog'

defineOptions({
  name: 'CatalogItemForm',
})

const props = defineProps<{
  id?: string
  tenantId: string
  categoryId?: string | null
  /** 类目列表(供选择) */
  categories: CatalogCategory[]
  /** 初始数据(编辑模式) */
  initialData?: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'success'): void
}>()

const form = ref({
  code: '',
  name: '',
  categoryId: props.categoryId ?? '',
  unit: '',
  defaultPrice: 0,
  costPrice: 0,
  billingType: 'service' as BillingType,
  description: '',
  tagsText: '',
  isActive: true,
  // 基础字段(B-R-6):通用条码/厂商
  barcode: '',
  manufacturer: '',
  // 药品扩展
  drugForm: 'other' as DrugForm,
  strength: '',
  drugManufacturer: '',
  drugBarcode: '',
  isControlled: false,
  storageCondition: '',
  shelfLifeDays: undefined as number | undefined,
  approvalNumber: '',
  genericName: '',
  dosageUnit: '',
  stockUnit: '',
  conversionRate: undefined as number | undefined,
  isRx: false,
  // 疫苗扩展
  vaccineType: 'other' as VaccineType,
  vaccineManufacturer: '',
  protocolCourse: 1,
  intervalDays: undefined as number | undefined,
  isRequired: false,
  recommendedSpecies: '',
  recommendedAge: '',
  contraindications: '',
  reminderRules: '',
})

const isEdit = computed(() => !!props.id)
const showDrugExt = computed(() => form.value.billingType === 'drug')
const showVaccineExt = computed(() => form.value.billingType === 'vaccine')

/**
 * 加载编辑数据
 */
watch(() => props.id, async (id) => {
  if (id && props.initialData) {
    const d = props.initialData
    form.value.code = (d.code as string) ?? ''
    form.value.name = (d.name as string) ?? ''
    form.value.categoryId = (d.category_id as string) ?? ''
    form.value.unit = (d.unit as string) ?? ''
    form.value.defaultPrice = Number(d.default_price) || 0
    form.value.costPrice = Number(d.cost_price) || 0
    form.value.billingType = (d.billing_type as BillingType) ?? 'service'
    form.value.description = (d.description as string) ?? ''
    form.value.tagsText = Array.isArray(d.tags) ? (d.tags as string[]).join(',') : ''
    form.value.isActive = d.is_active !== false
    // 基础字段(B-R-6):通用条码/厂商
    form.value.barcode = (d.barcode as string) ?? ''
    form.value.manufacturer = (d.manufacturer as string) ?? ''
    // 药品扩展
    const drugExt = d.drug_extension as Record<string, unknown> | null
    if (drugExt) {
      form.value.drugForm = (drugExt.drug_form as DrugForm) ?? 'other'
      form.value.strength = (drugExt.strength as string) ?? ''
      form.value.drugManufacturer = (drugExt.manufacturer as string) ?? ''
      form.value.drugBarcode = (drugExt.barcode as string) ?? ''
      form.value.isControlled = drugExt.is_controlled === true
      form.value.storageCondition = (drugExt.storage_condition as string) ?? ''
      form.value.shelfLifeDays = drugExt.shelf_life_days ? Number(drugExt.shelf_life_days) : undefined
      // B-R-4:药品扩展新字段
      form.value.approvalNumber = (drugExt.approval_number as string) ?? ''
      form.value.genericName = (drugExt.generic_name as string) ?? ''
      form.value.dosageUnit = (drugExt.dosage_unit as string) ?? ''
      form.value.stockUnit = (drugExt.stock_unit as string) ?? ''
      form.value.conversionRate = drugExt.conversion_rate ? Number(drugExt.conversion_rate) : undefined
      form.value.isRx = drugExt.is_rx === true
    }
    // 疫苗扩展
    const vaccineExt = d.vaccine_extension as Record<string, unknown> | null
    if (vaccineExt) {
      form.value.vaccineType = (vaccineExt.vaccine_type as VaccineType) ?? 'other'
      form.value.vaccineManufacturer = (vaccineExt.manufacturer as string) ?? ''
      form.value.protocolCourse = Number(vaccineExt.protocol_course) || 1
      form.value.intervalDays = vaccineExt.interval_days ? Number(vaccineExt.interval_days) : undefined
      form.value.isRequired = vaccineExt.is_required === true
      // B-R-9:疫苗扩展新字段
      form.value.recommendedSpecies = (vaccineExt.recommended_species as string) ?? ''
      form.value.recommendedAge = (vaccineExt.recommended_age as string) ?? ''
      form.value.contraindications = (vaccineExt.contraindications as string) ?? ''
      form.value.reminderRules = (vaccineExt.reminder_rules as string) ?? ''
    }
  }
  else if (!id) {
    // 新增模式重置
    form.value = {
      code: '',
      name: '',
      categoryId: props.categoryId ?? '',
      unit: '',
      defaultPrice: 0,
      costPrice: 0,
      billingType: 'service',
      description: '',
      tagsText: '',
      isActive: true,
      barcode: '',
      manufacturer: '',
      drugForm: 'other',
      strength: '',
      drugManufacturer: '',
      drugBarcode: '',
      isControlled: false,
      storageCondition: '',
      shelfLifeDays: undefined,
      approvalNumber: '',
      genericName: '',
      dosageUnit: '',
      stockUnit: '',
      conversionRate: undefined,
      isRx: false,
      vaccineType: 'other',
      vaccineManufacturer: '',
      protocolCourse: 1,
      intervalDays: undefined,
      isRequired: false,
      recommendedSpecies: '',
      recommendedAge: '',
      contraindications: '',
      reminderRules: '',
    }
  }
}, { immediate: true })

/**
 * 提交表单(新增/编辑)
 * 返回 true 表示成功(供 Modal 关闭判断)
 */
async function submit(): Promise<boolean> {
  if (!form.value.code.trim() || !form.value.name.trim()) {
    useFaToast().warning('编码和名称不能为空')
    return false
  }

  const tags = form.value.tagsText
    ? form.value.tagsText.split(',').map(t => t.trim()).filter(Boolean)
    : []

  try {
    if (isEdit.value && props.id) {
      await apiCatalog.updateItem({
        id: props.id,
        categoryId: form.value.categoryId || null,
        name: form.value.name,
        description: form.value.description || undefined,
        unit: form.value.unit || undefined,
        defaultPrice: form.value.defaultPrice,
        costPrice: form.value.costPrice,
        tags,
        billingType: form.value.billingType,
        isActive: form.value.isActive,
        // B-R-6:通用条码/厂商
        barcode: form.value.barcode || null,
        manufacturer: form.value.manufacturer || null,
      })
      // 药品扩展
      if (showDrugExt.value) {
        await apiCatalog.upsertDrugExtension({
          catalogItemId: props.id,
          drugForm: form.value.drugForm,
          strength: form.value.strength || null,
          manufacturer: form.value.drugManufacturer || null,
          barcode: form.value.drugBarcode || null,
          isControlled: form.value.isControlled,
          storageCondition: form.value.storageCondition || null,
          shelfLifeDays: form.value.shelfLifeDays ?? null,
          // B-R-4:药品扩展新字段
          approvalNumber: form.value.approvalNumber || null,
          genericName: form.value.genericName || null,
          dosageUnit: form.value.dosageUnit || null,
          stockUnit: form.value.stockUnit || null,
          conversionRate: form.value.conversionRate ?? null,
          isRx: form.value.isRx,
        })
      }
      // 疫苗扩展
      if (showVaccineExt.value) {
        await apiCatalog.upsertVaccineExtension({
          catalogItemId: props.id,
          vaccineType: form.value.vaccineType,
          manufacturer: form.value.vaccineManufacturer || null,
          protocolCourse: form.value.protocolCourse,
          intervalDays: form.value.intervalDays ?? null,
          isRequired: form.value.isRequired,
          // B-R-9:疫苗扩展新字段
          recommendedSpecies: form.value.recommendedSpecies || null,
          recommendedAge: form.value.recommendedAge || null,
          contraindications: form.value.contraindications || null,
          reminderRules: form.value.reminderRules || null,
        })
      }
    }
    else {
      const res = await apiCatalog.createItem({
        tenantId: props.tenantId,
        categoryId: form.value.categoryId || null,
        code: form.value.code,
        name: form.value.name,
        description: form.value.description || undefined,
        unit: form.value.unit || undefined,
        defaultPrice: form.value.defaultPrice,
        costPrice: form.value.costPrice,
        tags,
        billingType: form.value.billingType,
        // B-R-6:通用条码/厂商
        barcode: form.value.barcode || null,
        manufacturer: form.value.manufacturer || null,
      })
      const newItemId = (res as any)?.data?.id
      // 药品扩展
      if (showDrugExt.value && newItemId) {
        await apiCatalog.upsertDrugExtension({
          catalogItemId: newItemId,
          drugForm: form.value.drugForm,
          strength: form.value.strength || null,
          manufacturer: form.value.drugManufacturer || null,
          barcode: form.value.drugBarcode || null,
          isControlled: form.value.isControlled,
          storageCondition: form.value.storageCondition || null,
          shelfLifeDays: form.value.shelfLifeDays ?? null,
          // B-R-4:药品扩展新字段
          approvalNumber: form.value.approvalNumber || null,
          genericName: form.value.genericName || null,
          dosageUnit: form.value.dosageUnit || null,
          stockUnit: form.value.stockUnit || null,
          conversionRate: form.value.conversionRate ?? null,
          isRx: form.value.isRx,
        })
      }
      // 疫苗扩展
      if (showVaccineExt.value && newItemId) {
        await apiCatalog.upsertVaccineExtension({
          catalogItemId: newItemId,
          vaccineType: form.value.vaccineType,
          manufacturer: form.value.vaccineManufacturer || null,
          protocolCourse: form.value.protocolCourse,
          intervalDays: form.value.intervalDays ?? null,
          isRequired: form.value.isRequired,
          // B-R-9:疫苗扩展新字段
          recommendedSpecies: form.value.recommendedSpecies || null,
          recommendedAge: form.value.recommendedAge || null,
          contraindications: form.value.contraindications || null,
          reminderRules: form.value.reminderRules || null,
        })
      }
    }
    useFaToast().success(isEdit.value ? '已更新' : '已创建')
    emit('success')
    return true
  }
  catch (e: unknown) {
    useFaToast().error((e as Error)?.message || '操作失败')
    return false
  }
}

defineExpose({ submit })
</script>

<template>
  <div class="p-2 flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
    <div class="gap-4 grid grid-cols-2">
      <FaLabel label="编码" required>
        <FaInput v-model="form.code" :disabled="isEdit" placeholder="如 SVC-001" />
      </FaLabel>
      <FaLabel label="名称" required>
        <FaInput v-model="form.name" placeholder="如 门诊诊查费" />
      </FaLabel>
      <FaLabel label="所属类目">
        <select
          v-model="form.categoryId"
          class="px-3 border rounded border-solid bg-transparent h-9 w-full"
        >
          <option value="">
            未分类
          </option>
          <option v-for="c in categories" :key="c.id" :value="c.id">
            {{ c.name }}({{ c.code }})
          </option>
        </select>
      </FaLabel>
      <FaLabel label="收费类型">
        <select v-model="form.billingType" class="px-3 border rounded border-solid bg-transparent h-9 w-full">
          <option v-for="(label, key) in BILLING_TYPE_LABELS" :key="key" :value="key">
            {{ label }}
          </option>
        </select>
      </FaLabel>
      <FaLabel label="单位">
        <FaInput v-model="form.unit" placeholder="次/盒/支/瓶" />
      </FaLabel>
      <FaLabel label="默认售价">
        <FaInput v-model="form.defaultPrice" type="number" placeholder="0.00" />
      </FaLabel>
      <FaLabel label="成本价">
        <FaInput v-model="form.costPrice" type="number" placeholder="0.00" />
      </FaLabel>
      <FaLabel label="标签">
        <FaInput v-model="form.tagsText" placeholder="多个用逗号分隔" />
      </FaLabel>
      <FaLabel label="描述" class="col-span-2">
        <FaInput v-model="form.description" placeholder="项目说明" />
      </FaLabel>
      <FaLabel v-if="isEdit" label="启用">
        <FaSwitch v-model="form.isActive" />
      </FaLabel>
    </div>

    <!-- 药品扩展 -->
    <div v-if="showDrugExt" class="pt-4 border-t">
      <div class="font-medium mb-3">
        药品扩展信息
      </div>
      <div class="gap-4 grid grid-cols-2">
        <FaLabel label="剂型">
          <select v-model="form.drugForm" class="px-3 border rounded border-solid bg-transparent h-9 w-full">
            <option v-for="(label, key) in DRUG_FORM_LABELS" :key="key" :value="key">
              {{ label }}
            </option>
          </select>
        </FaLabel>
        <FaLabel label="规格">
          <FaInput v-model="form.strength" placeholder="如 5mg" />
        </FaLabel>
        <FaLabel label="生产厂家">
          <FaInput v-model="form.drugManufacturer" />
        </FaLabel>
        <FaLabel label="条形码">
          <FaInput v-model="form.drugBarcode" />
        </FaLabel>
        <FaLabel label="储存条件">
          <FaInput v-model="form.storageCondition" placeholder="如 常温/冷藏" />
        </FaLabel>
        <FaLabel label="保质期(天)">
          <FaInput v-model="form.shelfLifeDays" type="number" />
        </FaLabel>
        <FaLabel label="管控药品">
          <FaSwitch v-model="form.isControlled" />
        </FaLabel>
        <!-- B-R-4:批准文号/通用名/用药单位/库存单位/换算率/是否处方药 -->
        <FaLabel label="批准文号">
          <FaInput v-model="form.approvalNumber" placeholder="如 国药准字H..." />
        </FaLabel>
        <FaLabel label="通用名">
          <FaInput v-model="form.genericName" placeholder="通用名/成分" />
        </FaLabel>
        <FaLabel label="用药单位">
          <FaInput v-model="form.dosageUnit" placeholder="如 mg/ml/粒" />
        </FaLabel>
        <FaLabel label="库存单位">
          <FaInput v-model="form.stockUnit" placeholder="如 盒/瓶/支" />
        </FaLabel>
        <FaLabel label="换算率">
          <FaInput v-model="form.conversionRate" type="number" placeholder="如 1盒=10粒 填 10" />
        </FaLabel>
        <FaLabel label="处方药">
          <FaSwitch v-model="form.isRx" />
        </FaLabel>
      </div>
    </div>

    <!-- 疫苗扩展 -->
    <div v-if="showVaccineExt" class="pt-4 border-t">
      <div class="font-medium mb-3">
        疫苗扩展信息
      </div>
      <div class="gap-4 grid grid-cols-2">
        <FaLabel label="疫苗类型">
          <select v-model="form.vaccineType" class="px-3 border rounded border-solid bg-transparent h-9 w-full">
            <option v-for="(label, key) in VACCINE_TYPE_LABELS" :key="key" :value="key">
              {{ label }}
            </option>
          </select>
        </FaLabel>
        <FaLabel label="生产厂家">
          <FaInput v-model="form.vaccineManufacturer" />
        </FaLabel>
        <FaLabel label="针次">
          <FaInput v-model="form.protocolCourse" type="number" />
        </FaLabel>
        <FaLabel label="间隔天数">
          <FaInput v-model="form.intervalDays" type="number" />
        </FaLabel>
        <FaLabel label="必打疫苗">
          <FaSwitch v-model="form.isRequired" />
        </FaLabel>
        <!-- B-R-9:推荐物种/推荐年龄/接种禁忌/提醒规则 -->
        <FaLabel label="推荐物种">
          <FaInput v-model="form.recommendedSpecies" placeholder="如 犬/猫/其他" />
        </FaLabel>
        <FaLabel label="推荐年龄">
          <FaInput v-model="form.recommendedAge" placeholder="如 8周龄以上" />
        </FaLabel>
        <FaLabel label="接种禁忌">
          <FaInput v-model="form.contraindications" placeholder="如 孕期禁用/过敏禁用" />
        </FaLabel>
        <FaLabel label="提醒规则">
          <FaInput v-model="form.reminderRules" placeholder="如 每年加强一针" />
        </FaLabel>
      </div>
    </div>
  </div>
</template>
