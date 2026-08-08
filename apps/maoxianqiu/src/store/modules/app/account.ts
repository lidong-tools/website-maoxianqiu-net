import { supabase } from '@/lib/supabase'
import router from '@/router'

export const useAppAccountStore = defineStore('appAccount', () => {
  const appSettingsStore = useAppSettingsStore()
  const appTabbarStore = useAppTabbarStore()
  const appRouteStore = useAppRouteStore()
  const appMenuStore = useAppMenuStore()

  // 账号信息
  const token = ref(localStorage.getItem('token') ?? '')
  const account = ref(localStorage.getItem('account') ?? '')
  const avatar = ref(localStorage.getItem('avatar') ?? '')
  const realName = ref(localStorage.getItem('realName') ?? '')
  // P0-17:当前登录用户 id(用于判断"自己发起的审批"等)
  const userId = ref(localStorage.getItem('userId') ?? '')

  // 权限信息
  const permissions = ref<string[]>([])

  // 登录状态
  const isLogin = computed(() => {
    if (token.value) {
      return true
    }
    return false
  })

  // 展示名:优先真实姓名,否则邮箱前缀
  const displayName = computed(() => {
    return realName.value || account.value.split('@')[0] || '未设置'
  })

  // 从 supabase 会话同步本地状态
  function syncFromSession(session: any) {
    const user = session?.user
    const accessToken = session?.access_token ?? ''
    token.value = accessToken
    account.value = user?.email ?? ''
    avatar.value = user?.user_metadata?.avatar ?? ''
    realName.value = user?.user_metadata?.real_name ?? ''
    userId.value = user?.id ?? ''
    if (accessToken) {
      localStorage.setItem('token', accessToken)
      localStorage.setItem('account', account.value)
      localStorage.setItem('avatar', avatar.value)
      localStorage.setItem('realName', realName.value)
      localStorage.setItem('userId', userId.value)
    }
    else {
      localStorage.removeItem('token')
      localStorage.removeItem('account')
      localStorage.removeItem('avatar')
      localStorage.removeItem('realName')
      localStorage.removeItem('userId')
    }
  }

  // 加载个人资料(真实姓名/手机号),写入本地 store 与 profiles 保持一致
  async function loadProfile() {
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      return
    }
    const { data: profile } = await supabase
      .from('profiles')
      .select('real_name, phone, avatar')
      .eq('id', userId)
      .maybeSingle()
    if (profile?.real_name) {
      realName.value = profile.real_name
      localStorage.setItem('realName', profile.real_name)
    }
    if (profile?.avatar) {
      avatar.value = profile.avatar
      localStorage.setItem('avatar', profile.avatar)
    }
  }

  // 登录(浏览器直连 Supabase)
  async function login(data: {
    account: string
    password: string
  }) {
    const { data: res, error } = await supabase.auth.signInWithPassword({
      email: data.account,
      password: data.password,
    })
    if (error) {
      throw new Error(error.message)
    }
    syncFromSession(res.session)
    await loadProfile()
    await useAppTenantStore().initContext()
    // P0-01:登录后同步上下文权限,避免导航前 UI 使用过期权限
    await getPermissions()
  }

  // 注册(浏览器直连 Supabase)
  async function register(data: {
    account: string
    password: string
  }) {
    const { error } = await supabase.auth.signUp({
      email: data.account,
      password: data.password,
      options: {
        data: {
          account: data.account,
        },
      },
    })
    if (error) {
      throw new Error(error.message)
    }
  }

  // 找回密码(浏览器直连 Supabase,发送重置邮件)
  async function resetPassword(account: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(account)
    if (error) {
      throw new Error(error.message)
    }
  }

  // 修改密码:原密码必须参与认证
  async function editPassword(data: {
    password: string
    newPassword: string
  }) {
    const email = account.value
    if (!email) {
      throw new Error('当前账号异常,请重新登录')
    }
    // 1. 用原密码重新认证当前用户
    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email,
      password: data.password,
    })
    if (reauthError) {
      throw new Error('原密码不正确')
    }
    // 2. 认证通过后修改密码
    const { error } = await supabase.auth.updateUser({ password: data.newPassword })
    if (error) {
      throw new Error(error.message)
    }
  }

  // 手动登出
  function logout(redirect = router.currentRoute.value.fullPath) {
    supabase.auth.signOut()
    logoutCleanStatus()
    router.push({
      name: 'login',
      query: {
        ...(redirect !== appSettingsStore.settings.app.home.fullPath && router.currentRoute.value.name !== 'login' && { redirect }),
      },
    })
  }

  // 请求登出
  function requestLogout() {
    supabase.auth.signOut()
    logoutCleanStatus()
    router.push({
      name: 'login',
      query: {
        ...(
          router.currentRoute.value.fullPath !== appSettingsStore.settings.app.home.fullPath
          && router.currentRoute.value.name !== 'login'
          && {
            redirect: router.currentRoute.value.fullPath,
          }
        ),
      },
    })
  }

  // 登出后清除状态
  function logoutCleanStatus() {
    localStorage.removeItem('token')
    localStorage.removeItem('account')
    localStorage.removeItem('avatar')
    localStorage.removeItem('realName')
    localStorage.removeItem('userId')
    token.value = ''
    account.value = ''
    avatar.value = ''
    realName.value = ''
    userId.value = ''
    permissions.value = []
    useAppTenantStore().clear()
    appSettingsStore.updateSettings({}, true)
    appTabbarStore.clean()
    appRouteStore.removeRoutes()
    appMenuStore.setActived(0)
  }

  // 获取权限(P0-01:唯一事实来源 = /api/me/context,不再浏览器直查 store_members/roles)
  async function getPermissions() {
    const appTenantStore = useAppTenantStore()
    if (!appTenantStore.isReady) {
      await appTenantStore.initContext()
    }
    permissions.value = appTenantStore.permissions
  }

  // 初始化会话(应用启动时同步已登录状态)
  async function initSession() {
    const { data } = await supabase.auth.getSession()
    syncFromSession(data.session)
    if (data.session) {
      await loadProfile()
    }
  }

  // 监听登出/失效,清理本地状态
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      logoutCleanStatus()
    }
  })

  return {
    token,
    account,
    avatar,
    realName,
    userId,
    displayName,
    permissions,
    isLogin,
    login,
    register,
    resetPassword,
    editPassword,
    logout,
    requestLogout,
    getPermissions,
    loadProfile,
    initSession,
  }
})
