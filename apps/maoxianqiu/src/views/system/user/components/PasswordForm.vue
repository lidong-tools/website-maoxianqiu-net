<script setup lang="ts">
import type { FormExpose } from '@fantastic-admin/components'
import apiUser from '@/api/modules/user'

export interface Props {
  id?: string
}
const props = withDefaults(
  defineProps<Props>(),
  {
    id: '',
  },
)

const formRef = useTemplateRef<FormExpose>('formRef')
const model = ref({
  password: '',
})

const validationSchema = {
  password(value: string) {
    return value && value.length >= 6 ? true : '请输入至少6位密码'
  },
}

async function submit() {
  const result = await formRef.value?.validate()
  if (!result?.valid) {
    return false
  }
  await apiUser.resetPassword({
    id: props.id,
    password: model.value.password,
  })
  useFaToast().success('密码已重置')
  return true
}

defineExpose({
  submit,
})
</script>

<template>
  <FaForm
    ref="formRef"
    :model="model"
    :validation-schema="validationSchema"
    label-placement="right"
    :label-width="100"
  >
    <FaFormItem name="password" label="新密码" required>
      <FaInput v-model="model.password" type="password" placeholder="至少6位" class="w-full" />
    </FaFormItem>
  </FaForm>
</template>
