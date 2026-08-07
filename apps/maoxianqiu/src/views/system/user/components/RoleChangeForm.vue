<script setup lang="ts">
import type { FormExpose } from '@fantastic-admin/components'
import apiRole from '@/api/modules/role'
import apiUser from '@/api/modules/user'

export interface Props {
  membershipId?: string
  roleId?: string
}
const props = withDefaults(
  defineProps<Props>(),
  {
    membershipId: '',
    roleId: '',
  },
)

const loading = ref(false)
const formRef = useTemplateRef<FormExpose>('formRef')
const model = ref({
  roleId: props.roleId,
})

const roleOptions = ref<Array<{ label: string, value: string }>>([])

onMounted(() => {
  apiRole.list().then((res: any) => {
    roleOptions.value = (res.data ?? []).map((role: any) => ({ label: role.name, value: role.id }))
  })
})

const validationSchema = {
  roleId(value: string) {
    return value ? true : '请选择角色'
  },
}

async function submit() {
  const result = await formRef.value?.validate()
  if (!result?.valid) {
    return false
  }
  await apiUser.changeRole({
    employeeId: props.membershipId,
    roleId: model.value.roleId,
  })
  useFaToast().success('角色已更新')
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
      :label-width="100"
    >
      <FaFormItem name="roleId" label="角色" required>
        <FaSelect v-model="model.roleId" :options="roleOptions" />
      </FaFormItem>
    </FaForm>
  </div>
</template>
