<script setup lang="ts">
import type { FormExpose } from '@fantastic-admin/components'
import apiRole from '@/api/modules/role'
import { PERMISSIONS } from '../../permissions'

export interface Props {
  id?: string
}
const props = withDefaults(
  defineProps<Props>(),
  {
    id: '',
  },
)

interface RoleFormModel {
  id: string
  code: string
  name: string
  description: string
  permissions: string[]
  isSystem: boolean
}

const loading = ref(false)
const formRef = useTemplateRef<FormExpose>('formRef')
const model = ref<RoleFormModel>({
  id: props.id,
  code: '',
  name: '',
  description: '',
  permissions: [],
  isSystem: false,
})

const validationSchema = {
  code(value: string) {
    return value ? true : '请输入角色编码'
  },
  name(value: string) {
    return value ? true : '请输入角色名称'
  },
}

onMounted(() => {
  if (model.value.id !== '') {
    getInfo()
  }
})

function getInfo() {
  loading.value = true
  apiRole.list().then((res: any) => {
    loading.value = false
    const item = res.data.find((role: any) => role.id === model.value.id)
    if (item) {
      model.value.code = item.code
      model.value.name = item.name
      model.value.description = item.description ?? ''
      // MXQ-3010:使用聚合后的 permission_codes(union role_permissions + roles.permissions)
      model.value.permissions = item.permission_codes ?? item.permissions ?? []
      model.value.isSystem = item.is_system
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
    await apiRole.create({
      code: model.value.code,
      name: model.value.name,
      description: model.value.description,
      permissions: model.value.permissions,
    })
    useFaToast().success('新增成功')
  }
  else {
    // 基本信息 update
    await apiRole.update({
      id: model.value.id,
      name: model.value.name,
      description: model.value.description,
    })
    // MXQ-3010:权限替换走 replacePermissions RPC(系统角色后端拦截)
    if (!model.value.isSystem) {
      await apiRole.replacePermissions({
        roleId: model.value.id,
        permissionCodes: model.value.permissions,
      })
    }
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
      <FaFormItem name="code" label="角色编码" required>
        <FaInput
          v-model="model.code"
          placeholder="如 store_manager"
          :disabled="model.id !== ''"
          class="w-full"
        />
      </FaFormItem>
      <FaFormItem name="name" label="角色名称" required>
        <FaInput v-model="model.name" placeholder="如 店长" class="w-full" />
      </FaFormItem>
      <FaFormItem name="description" label="描述">
        <FaInput v-model="model.description" placeholder="角色职责说明" class="w-full" />
      </FaFormItem>
      <FaFormItem name="permissions" label="权限">
        <FaCheckboxGroup
          v-model="model.permissions"
          :options="PERMISSIONS.map(item => ({ label: item.label, value: item.code }))"
          :disabled="model.isSystem"
        />
        <div v-if="model.isSystem" class="text-xs text-muted-foreground mt-1">
          系统内置角色权限由系统维护,不可修改
        </div>
      </FaFormItem>
    </FaForm>
  </div>
</template>
