<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import axios from 'axios'

defineOptions({
  name: 'LoginForm',
})

const props = defineProps<{
  account?: string
}>()

const emits = defineEmits<{
  onLogin: [account?: string]
  onResetPassword: [account?: string]
}>()

const appAccountStore = useAppAccountStore()

const title = import.meta.env.VITE_APP_TITLE
const loading = ref(false)

interface LoginModel {
  account: string
  password: string
  remember: boolean
}

const model = ref<LoginModel>({
  account: props.account ?? localStorage.getItem('login_account') ?? '',
  password: '',
  remember: localStorage.getItem('login_account') !== null,
})

const validationSchema = toTypedSchema(z.object({
  account: z.string().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
  remember: z.boolean(),
}))

/**
 * 上报登录安全事件(R-3 登录提醒)
 * 使用原生 axios(非 api 实例)以避免触发全局拦截器的错误提示与 401 登出;
 * 已登录场景手动携带 token,登录失败场景(无会话)走后端匿名 login_failed 通道。
 * @param eventType 事件类型(login_success / login_failed)
 * @param account 登录账号
 */
async function reportLoginEvent(eventType: 'login_success' | 'login_failed', account: string) {
  try {
    const appTenantStore = useAppTenantStore()
    const baseURL = (import.meta.env.DEV && import.meta.env.VITE_ENABLE_PROXY)
      ? '/proxy/'
      : import.meta.env.VITE_APP_API_BASEURL
    await axios.post(`${baseURL}operations/security-events`, {
      tenantId: appTenantStore.currentTenantId || undefined,
      eventType,
      severity: eventType === 'login_failed' ? 'warning' : 'info',
      metadata: { account },
    }, {
      headers: appAccountStore.token
        ? { Authorization: `Bearer ${appAccountStore.token}`, Token: appAccountStore.token }
        : {},
    })
  }
  catch {
    // 安全事件上报失败不影响登录流程(仅落库/发送提醒,失败静默)
  }
}

function onSubmit(values: LoginModel) {
  loading.value = true
  appAccountStore.login(values).then(() => {
    if (values.remember) {
      localStorage.setItem('login_account', values.account)
    }
    else {
      localStorage.removeItem('login_account')
    }
    // R-3 登录成功安全事件(登录态已就绪,可携带租户上下文)
    void reportLoginEvent('login_success', values.account)
    emits('onLogin', values.account)
  }).catch((error: Error) => {
    useFaToast().error('登录失败', {
      description: error.message,
    })
    // R-3 登录失败安全事件(无会话,匿名写入;记录账号与 IP 便于审计定位)
    void reportLoginEvent('login_failed', values.account)
  }).finally(() => {
    loading.value = false
  })
}
</script>

<template>
  <div class="p-12 flex-col-stretch-center min-h-500px w-full">
    <div class="mb-6 space-y-2">
      <h3 class="text-4xl font-bold">
        欢迎使用 👋🏻
      </h3>
      <p class="text-sm text-muted-foreground lg:text-base">
        {{ title }}
      </p>
    </div>
    <FaForm
      :model="model"
      :validation-schema="validationSchema"
      @submit="onSubmit"
    >
      <FaFormItem name="account">
        <FaInput type="text" placeholder="用户名" class="w-full">
          <template #start>
            <FaIcon name="i-lucide:user" />
          </template>
        </FaInput>
      </FaFormItem>
      <FaFormItem name="password">
        <FaInput type="password" placeholder="密码" class="w-full">
          <template #start>
            <FaIcon name="i-lucide:lock" />
          </template>
        </FaInput>
      </FaFormItem>
      <div class="flex-start-between">
        <FaFormItem name="remember" class="min-w-0">
          <FaCheckbox>
            记住我
          </FaCheckbox>
        </FaFormItem>
        <FaButton variant="link" class="p-0 h-auto" type="button" @click="emits('onResetPassword', model.account)">
          忘记密码了?
        </FaButton>
      </div>
      <FaButton :loading="loading" size="lg" class="w-full" type="submit">
        登录
      </FaButton>
      <div class="text-sm mt-4 flex-center gap-2">
        <span class="text-secondary-foreground op-50">没有账号？请联系医院管理员邀请。</span>
      </div>
    </FaForm>
  </div>
</template>
