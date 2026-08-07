<script setup lang="ts">
/**
 * PetForm — 宠物建档表单(AUD-004)
 * 客户 → 宠物建档主闭环的核心表单,替代手填宠物 UUID/在客户详情新建宠物
 *
 * 通过 v-model 绑定 PetFormModel(model.ts):
 *   - species / gender 使用下拉选择,禁止手填枚举值
 *   - riskTags 以逗号分隔输入,提交方负责转换为 string[]
 */
import type { PetFormModel } from './model'
import { PET_SPECIES_LABELS } from '@/types/customer'

defineOptions({
  name: 'BusinessPetForm',
})

const form = defineModel<PetFormModel>({ required: true })

/** 物种选项(固定枚举) */
const speciesOptions = Object.entries(PET_SPECIES_LABELS).map(([value, label]) => ({
  label,
  value,
}))

/** 性别选项 */
const genderOptions = [
  { label: '公', value: 'male' },
  { label: '母', value: 'female' },
  { label: '未知', value: 'unknown' },
]
</script>

<template>
  <div class="gap-4 grid grid-cols-1 md:grid-cols-2">
    <FaLabel label="宠物名字" required>
      <FaInput v-model="form.name" placeholder="请输入宠物名字" class="w-full" />
    </FaLabel>
    <FaLabel label="物种">
      <FaSelect v-model="form.species" :options="speciesOptions" class="w-full" />
    </FaLabel>
    <FaLabel label="品种">
      <FaInput v-model="form.breed" placeholder="如:金毛 / 英短" class="w-full" />
    </FaLabel>
    <FaLabel label="性别">
      <FaSelect v-model="form.gender" :options="genderOptions" class="w-full" />
    </FaLabel>
    <FaLabel label="出生日期">
      <FaInput v-model="form.birthDate" type="date" class="w-full" />
    </FaLabel>
    <FaLabel label="当前体重(kg)">
      <FaInput v-model="form.weight" type="number" placeholder="可留空" class="w-full" />
    </FaLabel>
    <FaLabel label="毛色">
      <FaInput v-model="form.color" placeholder="如:白色 / 橘色" class="w-full" />
    </FaLabel>
    <FaLabel label="芯片号">
      <FaInput v-model="form.microchip" placeholder="如:982 000 123 456 789" class="w-full" />
    </FaLabel>
    <FaLabel label="风险标签(逗号分隔)">
      <FaInput
        v-model="form.riskTags"
        placeholder="如:对青霉素过敏, 攻击性, 慢性病"
        class="w-full"
      />
    </FaLabel>
    <FaLabel label="性格特征">
      <FaInput v-model="form.temperament" placeholder="如:温顺 / 胆小" class="w-full" />
    </FaLabel>
    <FaLabel label="绝育" class="md:col-span-2">
      <FaSwitch v-model="form.isNeutered" />
    </FaLabel>
    <FaLabel label="医疗备注(过敏史/慢病史)" class="md:col-span-2">
      <FaInput
        v-model="form.medicalNotes"
        type="textarea"
        :rows="3"
        placeholder="详细描述过敏史、慢病史等"
        class="w-full"
      />
    </FaLabel>
  </div>
</template>
