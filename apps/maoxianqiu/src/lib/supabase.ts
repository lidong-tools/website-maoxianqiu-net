import { createClient } from '@supabase/supabase-js'

// 浏览器直连 Supabase(anon key),数据访问由 RLS 兜底
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)

/**
 * 审计 S3.1 §27:Password Recovery 竞态补强。
 * PASSWORD_RECOVERY 事件可能在 reset-password.vue 的 onAuthStateChange 监听注册前
 * 已经触发(PKCE 回跳常见 ?code= 形式),因此在这里全局捕获一次并写入
 * sessionStorage 标志。reset-password.vue 读取该标志作为兜底,
 * 不再依赖 user_metadata.recovery(该字段不是稳定的 Recovery Session 判断依据)。
 */
supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    sessionStorage.setItem('mxq:recovery-pending', '1')
  }
})
