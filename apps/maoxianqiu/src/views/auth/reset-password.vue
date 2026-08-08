<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { supabase } from '@/lib/supabase'

defineOptions({
  name: 'ResetPassword',
})

const router = useRouter()
const loading = ref(false)
const recovered = ref(false)
const checking = ref(true)

interface ResetPasswordModel {
  password: string
  checkPassword: string
}

const model = ref<ResetPasswordModel>({
  password: '',
  checkPassword: '',
})

const validationSchema = toTypedSchema(
  z.object({
    password: z.string().min(6, '密码长度为6到18位').max(18, '密码长度为6到18位'),
    checkPassword: z.string().min(1, '请再次输入新密码'),
  }).refine(data => data.password === data.checkPassword, {
    message: '两次输入的密码不一致',
    path: ['checkPassword'],
  }),
)

function onSubmit(values: ResetPasswordModel) {
  loading.value = true
  supabase.auth.updateUser({ password: values.password }).then(async ({ error }) => {
    if (error) {
      useFaToast().error('设置失败', {
        description: error.message,
      })
      return
    }
    useFaToast().success('密码已重置，请使用新密码登录')
    await supabase.auth.signOut()
    router.replace({ name: 'login' })
  }).finally(() => {
    loading.value = false
  })
}

onMounted(() => {
  const route = useRoute()
  // P0-08:仅接受真实密码找回链接。Supabase 重置邮件回跳 URL 携带 type=recovery(或 token);
  // 普通已登录会话不再被当作 recovery。
  const isRecoveryLink = route.query.type === 'recovery' || !!route.query.token
  if (isRecoveryLink) {
    recovered.value = true
    checking.value = false
    return
  }
  // 邮件重置链接回跳时 Supabase 触发 PASSWORD_RECOVERY 事件并建立 recovery session
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      recovered.value = true
      checking.value = false
    }
  })
  // 审计 S3.1 §27:不再依赖 user_metadata.recovery(不是稳定的 Recovery 判断依据)。
  // supabase.ts 全局监听 PASSWORD_RECOVERY 时已写入 sessionStorage 标志,
  // 事件即使在本页监听注册前已触发(PKCE ?code= 回跳),这里也能兜底识别。
  const recoveryPending = sessionStorage.getItem('mxq:recovery-pending') === '1'
  if (recoveryPending) {
    recovered.value = true
  }
  checking.value = false
  onUnmounted(() => subscription.unsubscribe())
})
</script>

<template>
  <div class="bg-banner" />
  <div class="reset-box flex-col-center">
    <div class="p-12 rounded-md bg-background max-w-100 w-full shadow-md">
      <template v-if="checking">
        <div class="text-secondary-foreground/60 py-10 flex-col-center">
          <FaIcon name="i-mdi:loading" class="size-8 animate-spin" />
          <span class="text-sm mt-3">正在校验重置链接…</span>
        </div>
      </template>
      <template v-else-if="recovered">
        <FaForm :model="model" :validation-schema="validationSchema" @submit="onSubmit">
          <div class="mb-8 space-y-2">
            <h3 class="text-3xl font-bold">
              设置新密码 🔒
            </h3>
            <p class="text-sm text-muted-foreground">
              请输入新密码并确认，密码长度为 6~18 位
            </p>
          </div>
          <FaFormItem name="password">
            <FaInput type="password" placeholder="新密码" class="w-full">
              <template #start>
                <FaIcon name="i-lucide:lock" />
              </template>
            </FaInput>
            <FaPasswordStrength :password="model.password" />
          </FaFormItem>
          <FaFormItem name="checkPassword">
            <FaInput type="password" placeholder="确认新密码" class="w-full">
              <template #start>
                <FaIcon name="i-lucide:lock" />
              </template>
            </FaInput>
          </FaFormItem>
          <FaButton :loading="loading" size="lg" class="mt-4 w-full" type="submit">
            确认修改
          </FaButton>
        </FaForm>
      </template>
      <template v-else>
        <div class="py-10 text-center flex-col-center">
          <FaIcon name="i-mdi:alert-circle-outline" class="text-danger size-10" />
          <h3 class="text-xl font-bold mt-4">
            重置链接无效或已过期
          </h3>
          <p class="text-sm text-muted-foreground mt-2">
            请重新在登录页发起"忘记密码"，并通过最新邮件中的链接完成重置。
          </p>
          <FaButton variant="outline" class="mt-6" @click="router.replace({ name: 'login' })">
            返回登录
          </FaButton>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bg-banner {
  position: fixed;
  z-index: 0;
  width: 100%;
  height: 100%;
  background:
    radial-gradient(closest-side, oklch(var(--border) / 10%) 30%, oklch(var(--primary) / 20%) 30%, oklch(var(--border) / 30%) 50%) no-repeat,
    radial-gradient(closest-side, oklch(var(--border) / 10%) 30%, oklch(var(--primary) / 20%) 30%, oklch(var(--border) / 30%) 50%) no-repeat;
  background-position: 100% 100%, 0% 0%;
  background-size: 200vw 200vh;
  filter: blur(100px);
}

.reset-box {
  position: absolute;
  inset: 0;
}
</style>
