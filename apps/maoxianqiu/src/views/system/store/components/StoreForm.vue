<script setup lang="ts">
import type { FormExpose } from '@fantastic-admin/components'
import apiStore from '@/api/modules/store'

export interface Props {
  id?: string
}
const props = withDefaults(
  defineProps<Props>(),
  {
    id: '',
  },
)

interface StoreFormModel {
  id: string
  name: string
  code: string
  address: string
  phone: string
  status: string
}

const loading = ref(false)
const formRef = useTemplateRef<FormExpose>('formRef')
const model = ref<StoreFormModel>({
  id: props.id,
  name: '',
  code: '',
  address: '',
  phone: '',
  status: 'active',
})

const validationSchema = {
  name(value: string) {
    return value ? true : '请输入店铺名称'
  },
}

onMounted(() => {
  if (model.value.id !== '') {
    getInfo()
  }
})

function getInfo() {
  loading.value = true
  apiStore.list().then((res: any) => {
    loading.value = false
    const item = (res.data.list ?? []).find((store: any) => store.id === model.value.id)
    if (item) {
      model.value.name = item.name
      model.value.code = item.code ?? ''
      model.value.address = item.address ?? ''
      model.value.phone = item.phone ?? ''
      model.value.status = item.status ?? 'active'
    }
  }).catch(() => {
    loading.value = false
  })
}

async function submit() {
  const result = await formRef.value?.validate()
  if (!result?.valid) {
    return false
  }

  if (model.value.id === '') {
    await apiStore.create({
      name: model.value.name,
      code: model.value.code,
      address: model.value.address,
      phone: model.value.phone,
      status: model.value.status,
    })
    useFaToast().success('新增成功')
  }
  else {
    await apiStore.update({
      id: model.value.id,
      name: model.value.name,
      code: model.value.code,
      address: model.value.address,
      phone: model.value.phone,
      status: model.value.status,
    })
    useFaToast().success('编辑成功')
  }

  return true
}

defineExpose({
  submit,
})
</script>

<template>
  <div v-loading="loading">
    <FaForm
      ref="formRef"
      :model="model"
      :validation-schema="validationSchema"
      label-placement="right"
      :label-width="110"
    >
      <FaFormItem name="name" label="店铺名称" required>
        <FaInput v-model="model.name" placeholder="如 爱心宠物医院·总店" class="w-full" />
      </FaFormItem>
      <FaFormItem name="code" label="店铺编码">
        <FaInput v-model="model.code" placeholder="唯一编码,如 ST001" class="w-full" />
      </FaFormItem>
      <FaFormItem name="address" label="地址">
        <FaInput v-model="model.address" placeholder="门店地址" class="w-full" />
      </FaFormItem>
      <FaFormItem name="phone" label="联系电话">
        <FaInput v-model="model.phone" placeholder="联系电话" class="w-full" />
      </FaFormItem>
      <FaFormItem name="status" label="状态">
        <FaSelect
          v-model="model.status"
          :options="[
            { label: '启用', value: 'active' },
            { label: '停用', value: 'disabled' },
          ]"
        />
      </FaFormItem>
    </FaForm>
  </div>
</template>
