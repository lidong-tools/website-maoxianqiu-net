<script setup lang="ts">
/**
 * PetCreateDrawer — 宠物建档抽屉(AUD-004)
 * 在客户详情页打开,调用 create_pet RPC 完成客户 → 宠物建档,
 * 成功后通过 created 事件通知父组件刷新宠物列表。
 *
 * 使用方式:
 *   <BusinessPetCreateDrawer v-model="visible" :customer-id="id" :tenant-id="tid" @created="onCreated" />
 */
import type { PetFormModel } from '../PetForm/model'
import type { CreatePetInput, PetRecord } from '@/types/customer'
import apiPet from '@/api/modules/pet'
import { createEmptyPetForm } from '../PetForm/model'

defineOptions({
  name: 'BusinessPetCreateDrawer',
})

const props = defineProps<{
  /** 宠物归属客户 id */
  customerId: string
  /** 租户 id */
  tenantId: string
}>()

const emit = defineEmits<{
  created: [pet: PetRecord]
}>()

/** 抽屉显隐(父组件 v-model) */
const model = defineModel<boolean>({ default: false })

const submitting = ref(false)
const form = ref<PetFormModel>(createEmptyPetForm())

// 打开抽屉时重置表单
watch(model, (val) => {
  if (val) {
    form.value = createEmptyPetForm()
  }
})

/**
 * 提交建档:调用 create_pet RPC
 */
async function onSubmit() {
  if (!form.value.name.trim()) {
    useFaToast().warning('请填写宠物名字')
    return
  }
  if (submitting.value) {
    return
  }

  submitting.value = true
  try {
    const riskTags = form.value.riskTags
      .split(/[,，]/)
      .map(t => t.trim())
      .filter(Boolean)

    const input: CreatePetInput = {
      tenantId: props.tenantId,
      customerId: props.customerId,
      name: form.value.name.trim(),
      species: form.value.species || undefined,
      breed: form.value.breed.trim() || undefined,
      gender: form.value.gender,
      birthDate: form.value.birthDate || undefined,
      weight: form.value.weight,
      isNeutered: form.value.isNeutered,
      microchip: form.value.microchip.trim() || undefined,
      color: form.value.color.trim() || undefined,
      riskTags,
      temperament: form.value.temperament.trim() || undefined,
      medicalNotes: form.value.medicalNotes.trim() || undefined,
    }
    const res: any = await apiPet.create(input)
    useFaToast().success('宠物建档成功')
    model.value = false
    emit('created', res.data as PetRecord)
  }
  catch (e: any) {
    useFaToast().error('建档失败', { description: e?.message })
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <FaDrawer v-model="model" title="新增宠物" :width="600">
    <BusinessPetForm v-model="form" />
    <template #footer>
      <div class="flex gap-2 justify-end">
        <FaButton variant="outline" @click="model = false">
          取消
        </FaButton>
        <FaButton type="primary" :loading="submitting" @click="onSubmit">
          保存
        </FaButton>
      </div>
    </template>
  </FaDrawer>
</template>
