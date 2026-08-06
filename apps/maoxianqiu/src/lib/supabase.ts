import { createClient } from '@supabase/supabase-js'

// 浏览器直连 Supabase(anon key),数据访问由 RLS 兜底
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)
