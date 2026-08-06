<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'

defineOptions({
  name: 'ResetPasswordForm',
})

const props = defineProps<{
  account?: string
}>()

const emits = defineEmits<{
  onLogin: [account?: string]
  onResetPassword: [account?: string]
}>()

const loading = ref(false)

interface ResetPasswordModel {
  account: string
}

const model = ref<ResetPasswordModel>({
  account: props.account ?? '',
})

const validationSchema = toTypedSchema(z.object({
  account: z.string().min(1, '请输入用户名'),
}))

function onSubmit(values: ResetPasswordModel) {
  loading.value = true
  useAppAccountStore().resetPassword(values.account).then(() => {
    useFaToast().success('重置链接已发送', {
      description: '请前往邮箱完成密码重置',
    })
    emits('onResetPassword', values.account)
  }).catch((error: Error) => {
    useFaToast().error('发送失败', {
      description: error.message,
    })
  }).finally(() => {
    loading.value = false
  })
}
</script>

<template>
  <div class="p-12 flex-col-stretch-center min-h-500px w-full">
    <FaForm :model="model" :validation-schema="validationSchema" @submit="onSubmit">
      <div class="mb-8 space-y-2">
        <h3 class="text-4xl font-bold">
          忘记密码了? 🔒
        </h3>
        <p class="text-sm text-muted-foreground lg:text-base">
          输入注册邮箱，我们将发送重置链接
        </p>
      </div>
      <FaFormItem name="account">
        <FaInput type="text" placeholder="用户名/邮箱" class="w-full">
          <template #start>
            <FaIcon name="i-lucide:user" />
          </template>
        </FaInput>
      </FaFormItem>
      <FaButton :loading="loading" size="lg" class="mt-4 w-full" type="submit">
        发送重置链接
      </FaButton>
      <div class="text-sm mt-4 flex-center gap-2">
        <FaButton variant="link" class="p-0 h-auto" type="button" @click="emits('onLogin', model.account)">
          去登录
        </FaButton>
      </div>
    </FaForm>
  </div>
</template>
