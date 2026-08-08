<script setup lang="ts">
import EditPassword from '@/components/AppAccountForm/edit-password.vue'
import { supabase } from '@/lib/supabase'

const appAccountStore = useAppAccountStore()
const appTenantStore = useAppTenantStore()
const appSettingsStore = useAppSettingsStore()

const active = ref(0)
const tabs = ref([
  {
    title: '基本资料',
    description: '头像、姓名、联系方式',
  },
  {
    title: '账号安全',
    description: '修改密码、登录信息',
  },
  {
    title: '偏好设置',
    description: '主题等页面偏好',
  },
])

// ===== 基本资料 =====
const loadingProfile = ref(true)
const saving = ref(false)
const profile = ref({
  avatar: '',
  realName: '',
  phone: '',
})
const employeeInfo = ref<{ employeeNo: string, title: string } | null>(null)

async function loadProfileInfo() {
  loadingProfile.value = true
  try {
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      return
    }
    const { data: p } = await supabase
      .from('profiles')
      .select('avatar, real_name, phone')
      .eq('id', userId)
      .maybeSingle()
    profile.value.avatar = p?.avatar ?? ''
    profile.value.realName = p?.real_name ?? ''
    profile.value.phone = p?.phone ?? ''

    const tenantId = appTenantStore.currentTenantId
    if (tenantId) {
      const { data: emp } = await supabase
        .from('employees')
        .select('employee_no, title')
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      const e = emp as { employee_no?: string, title?: string } | null
      employeeInfo.value = e ? { employeeNo: e.employee_no ?? '', title: e.title ?? '' } : null
    }
  }
  finally {
    loadingProfile.value = false
  }
}

async function saveProfile() {
  saving.value = true
  try {
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      throw new Error('登录状态异常，请重新登录')
    }
    const { error } = await supabase
      .from('profiles')
      .update({
        avatar: profile.value.avatar || null,
        real_name: profile.value.realName,
        phone: profile.value.phone || null,
      })
      .eq('id', userId)
    if (error) {
      throw new Error(error.message)
    }
    await appAccountStore.loadProfile()
    useFaToast().success('保存成功')
  }
  catch (e) {
    useFaToast().error('保存失败', {
      description: (e as Error).message,
    })
  }
  finally {
    saving.value = false
  }
}

// 当前工作上下文展示
const currentTenant = computed(() => {
  const c = appTenantStore.context
  return c?.tenants.find(t => t.id === appTenantStore.currentTenantId) ?? c?.tenants[0] ?? null
})

const currentStore = computed(() => {
  const c = appTenantStore.context
  if (!c) {
    return null
  }
  for (const t of c.tenants) {
    const store = t.stores.find(s => s.id === appTenantStore.currentStoreId)
    if (store) {
      return store
    }
  }
  return null
})

// ===== 偏好设置 =====
const colorScheme = ref<'' | 'light' | 'dark'>(appSettingsStore.currentColorScheme ?? '')
function onColorSchemeChange() {
  if (colorScheme.value !== '') {
    appSettingsStore.setColorScheme(colorScheme.value)
  }
  else {
    appSettingsStore.setColorScheme('')
  }
}

onMounted(loadProfileInfo)
</script>

<template>
  <div class="min-h-full w-full">
    <div class="border-b border-e bg-background flex flex-row right-0 top-0 fixed z-1 overflow-auto md:(flex-col h-full w-44 inset-s-0 bottom-0)">
      <div v-for="(tab, index) in tabs" :key="index" class="px-4 py-3 flex-shrink-0 cursor-pointer transition-background-color space-y-1 hover-bg-accent/50" :class="{ 'bg-accent hover-bg-accent!': active === index }" @click="active = index">
        <div class="text-base text-accent-foreground leading-tight">
          {{ tab.title }}
        </div>
        <div class="text-xs text-accent-foreground/50">
          {{ tab.description }}
        </div>
      </div>
    </div>
    <div class="p-6 pt-20 min-h-full md:(ms-44 pt-6)">
      <!-- 基本资料 -->
      <div v-if="active === 0" class="max-w-150">
        <h3 class="text-xl font-bold">
          基本资料
        </h3>
        <p class="text-sm text-muted-foreground mt-1">
          维护你的个人展示信息，员工编号、医院与角色由管理员配置。
        </p>
        <div class="mt-6 flex-center-start gap-4">
          <FaAvatar :src="profile.avatar || ''" :fallback="appAccountStore.displayName.slice(0, 2)" shape="square" class="text-xl size-16" />
          <div class="min-w-0">
            <div class="text-lg font-semibold">
              {{ profile.realName || appAccountStore.displayName }}
            </div>
            <div class="text-sm text-muted-foreground">
              {{ appAccountStore.account }}
            </div>
          </div>
        </div>
        <div v-loading="loadingProfile" class="mt-6 space-y-4">
          <FaLabel label="头像 URL" class="block">
            <FaInput v-model="profile.avatar" placeholder="头像图片地址(可选)" class="w-full" />
          </FaLabel>
          <FaLabel label="姓名" class="block">
            <FaInput v-model="profile.realName" placeholder="你的姓名" class="w-full" />
          </FaLabel>
          <FaLabel label="手机号" class="block">
            <FaInput v-model="profile.phone" placeholder="手机号(可选)" class="w-full" />
          </FaLabel>
          <FaDivider class="my-2" />
          <FaDescriptions
            :items="[
              { label: '登录邮箱', value: appAccountStore.account },
              { label: '员工编号', value: employeeInfo?.employeeNo ?? '-' },
              { label: '职称', value: employeeInfo?.title ?? '-' },
              { label: '所属医院', value: currentTenant?.name ?? '-' },
              { label: '所属门店', value: currentStore?.name ?? '-' },
              { label: '角色', value: currentStore?.roles?.join('、') ?? '-' },
            ]" label-width="96px" :column="1"
          />
          <div class="pt-2">
            <FaButton type="primary" :loading="saving" @click="saveProfile">
              保存
            </FaButton>
          </div>
        </div>
      </div>

      <!-- 账号安全 -->
      <div v-else-if="active === 1" class="max-w-150">
        <h3 class="text-xl font-bold">
          账号安全
        </h3>
        <p class="text-sm text-muted-foreground mt-1">
          定期修改密码可以提高账号安全性。
        </p>
        <FaDescriptions
          class="mt-6"
          :items="[
            { label: '当前登录邮箱', value: appAccountStore.account },
          ]" label-width="96px" :column="1"
        />
        <EditPassword class="mt-4" />
      </div>

      <!-- 偏好设置 -->
      <div v-else class="max-w-150">
        <h3 class="text-xl font-bold">
          偏好设置
        </h3>
        <p class="text-sm text-muted-foreground mt-1">
          这里仅维护个人 UI 偏好，业务规则请到系统设置中配置。
        </p>
        <div class="mt-6 space-y-5">
          <FaLabel label="主题" class="block">
            <FaSelect
              v-model="colorScheme"
              :options="[
                { label: '跟随系统', value: '' },
                { label: '浅色', value: 'light' },
                { label: '深色', value: 'dark' },
              ]" class="max-w-60 w-full"
              @change="onColorSchemeChange"
            />
          </FaLabel>
          <p class="text-sm text-muted-foreground">
            主题选择会即时应用到整个系统。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
