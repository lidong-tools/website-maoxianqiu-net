<script setup lang="ts">
import type { FormExpose } from '@fantastic-admin/components'
import apiRole from '@/api/modules/role'
import apiUser from '@/api/modules/user'

export interface Props {
  id?: string
  storeId?: string
  storeOptions?: Array<{ label: string, value: string }>
}
const props = withDefaults(
  defineProps<Props>(),
  {
    id: '',
    storeId: '',
    storeOptions: () => [],
  },
)

interface UserFormModel {
  id: string
  account: string
  password: string
  realName: string
  phone: string
  storeId: string
  roleId: string
  status: string
}

const loading = ref(false)
const formRef = useTemplateRef<FormExpose>('formRef')
const model = ref<UserFormModel>({
  id: props.id,
  account: '',
  password: '',
  realName: '',
  phone: '',
  storeId: props.storeId,
  roleId: '',
  status: 'active',
})

const isEdit = computed(() => model.value.id !== '')

const roleOptions = ref<Array<{ label: string, value: string }>>([])

onMounted(() => {
  apiRole.list().then((res: any) => {
    roleOptions.value = (res.data ?? []).map((role: any) => ({ label: role.name, value: role.id }))
  })
  if (model.value.id !== '') {
    getInfo()
  }
})

function getInfo() {
  loading.value = true
  apiUser.detail(model.value.id).then((res: any) => {
    loading.value = false
    const profile = res.data.profile ?? {}
    model.value.account = profile.account ?? ''
    model.value.realName = profile.real_name ?? ''
    model.value.phone = profile.phone ?? ''
    model.value.status = profile.status ?? 'active'
  }).catch(() => {
    loading.value = false
  })
}

const validationSchema = {
  account(value: string) {
    if (isEdit.value) {
      return true
    }
    return value ? true : '请输入账号'
  },
  password(value: string) {
    if (isEdit.value) {
      return true
    }
    return value && value.length >= 6 ? true : '请输入至少6位密码'
  },
  storeId(value: string) {
    if (isEdit.value) {
      return true
    }
    return value ? true : '请选择店铺'
  },
  roleId(value: string) {
    if (isEdit.value) {
      return true
    }
    return value ? true : '请选择角色'
  },
}

async function submit() {
  const result = await formRef.value?.validate()
  if (!result?.valid) {
    return false
  }

  if (model.value.id === '') {
    await apiUser.create({
      account: model.value.account,
      password: model.value.password,
      realName: model.value.realName,
      phone: model.value.phone,
      storeId: model.value.storeId,
      roleId: model.value.roleId,
    })
    useFaToast().success('新增成功')
  }
  else {
    await apiUser.update({
      id: model.value.id,
      realName: model.value.realName,
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
      :label-width="100"
    >
      <FaFormItem name="account" label="账号" required>
        <FaInput v-model="model.account" placeholder="登录邮箱" :disabled="isEdit" class="w-full" />
      </FaFormItem>
      <FaFormItem v-if="!isEdit" name="password" label="密码" required>
        <FaInput v-model="model.password" type="password" placeholder="初始密码(至少6位)" class="w-full" />
      </FaFormItem>
      <FaFormItem name="realName" label="姓名">
        <FaInput v-model="model.realName" placeholder="真实姓名" class="w-full" />
      </FaFormItem>
      <FaFormItem name="phone" label="手机号">
        <FaInput v-model="model.phone" placeholder="手机号" class="w-full" />
      </FaFormItem>
      <template v-if="!isEdit">
        <FaFormItem name="storeId" label="店铺" required>
          <FaSelect v-model="model.storeId" :options="props.storeOptions" />
        </FaFormItem>
        <FaFormItem name="roleId" label="角色" required>
          <FaSelect v-model="model.roleId" :options="roleOptions" />
        </FaFormItem>
      </template>
      <FaFormItem v-else name="status" label="状态">
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
