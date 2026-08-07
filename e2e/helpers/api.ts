import type { APIRequestContext, Page } from '@playwright/test'
import process from 'node:process'

/**
 * E2E API 与数据断言辅助工具(P0-09)
 *
 * - 后端 API 根路径:优先 E2E_API_BASE 环境变量,否则取页面 origin + '/api'(staging 同域部署)
 * - token:从 localStorage 读取(前端 useAppAccountStore 持久化键 `token`)
 * - 数据库断言:利用已登录用户 JWT + anon key 直连 Supabase REST(RLS 兜底),
 *   用于验证业务闭环产生的真实数据(余额/流水/状态),替代仅 UI 断言
 */

/**
 * 解析后端 API 根路径。
 * @param page 页面实例(用于推导同域 origin)
 * @returns API 根路径(不带末尾斜杠)
 */
export function apiBaseFor(page: Page): string {
  const custom = process.env.E2E_API_BASE
  return (custom ?? `${new URL(page.url()).origin}/api`).replace(/\/+$/, '')
}

/**
 * 从 localStorage 提取 Supabase access token(前端持久化键)。
 * @param page 页面实例(须已登录)
 * @returns token 字符串;未登录时为空串
 */
export async function getAccessToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('token') ?? '')
}

/**
 * 生成带业务前缀的幂等键(关键写操作必须唯一,防重复过账)。
 * @param prefix 业务前缀(如 inventory/clinical/billing)
 * @returns 幂等键字符串
 */
export function newIdemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Hono API 成功响应包装(断言时取 .data) */
export interface OkBody<T = unknown> {
  ok: boolean
  data: T
  requestId?: string
}

/**
 * 创建带 Bearer 认证的 Hono API 客户端。
 * @param request Playwright request fixture
 * @param base API 根路径
 * @param token Supabase access token
 * @returns { get, post } 方法,非 2xx 直接抛错
 */
export function createApiClient(request: APIRequestContext, base: string, token: string) {
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  const check = async (res: Awaited<ReturnType<APIRequestContext['get']>>, label: string) => {
    if (!res.ok()) {
      const text = await res.text().catch(() => '')
      throw new Error(`${label} 失败(${res.status()}): ${text}`)
    }
    return res
  }
  return {
    base,
    /**
     * GET 请求(断言响应体)。
     * @param path API 子路径(如 /customers/:id)
     * @returns 完整响应体
     */
    async get<T = unknown>(path: string): Promise<T> {
      const res = await check(await request.get(`${base}${path}`, { headers }), `GET ${path}`)
      return res.json() as Promise<T>
    },
    /**
     * POST 请求(断言响应体)。
     * @param path API 子路径
     * @param data 请求体(默认 {})
     * @returns 完整响应体
     */
    async post<T = unknown>(path: string, data?: unknown): Promise<T> {
      const res = await check(await request.post(`${base}${path}`, { headers, data: data ?? {} }), `POST ${path}`)
      return res.json() as Promise<T>
    },
  }
}

/**
 * 在页面上下文内用 Supabase REST 查询(读取),复用已登录用户 JWT + anon key。
 * 用于数据库断言(余额/流水/业务状态),避免前端再次引入直连逻辑。
 * @param page 页面实例(须已登录)
 * @param table 表名(如 inventory_balances / inventory_movements)
 * @param query PostgREST 查询串(如 select=*&id=eq.xxx)
 * @returns 查询结果数组
 */
export async function supabaseSelect<T>(page: Page, table: string, query = 'select=*'): Promise<T> {
  const url = process.env.VITE_SUPABASE_URL ?? ''
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? ''
  if (!url || !anonKey) {
    throw new Error('缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY,无法直连 Supabase 断言')
  }
  return page.evaluate(async ({ url, anonKey, table, query }) => {
    const token = localStorage.getItem('token') ?? ''
    const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(`Supabase REST 查询 ${table} 失败(${res.status})`)
    }
    return res.json()
  }, { url, anonKey, table, query })
}

/**
 * 在页面上下文内用 Supabase REST 插入(写),复用已登录用户 JWT + anon key。
 * 用于前端本就"浏览器直连"的写操作(如护理任务创建),RLS 兜底校验权限。
 * @param page 页面实例(须已登录)
 * @param table 表名
 * @param row 待插入行(字段名为下划线格式)
 * @returns 返回的插入行数组(Prefer: return=representation)
 */
export async function supabaseInsert<T>(page: Page, table: string, row: Record<string, unknown>): Promise<T> {
  const url = process.env.VITE_SUPABASE_URL ?? ''
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? ''
  if (!url || !anonKey) {
    throw new Error('缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY,无法直连 Supabase 写入')
  }
  return page.evaluate(async ({ url, anonKey, table, row }) => {
    const token = localStorage.getItem('token') ?? ''
    const res = await fetch(`${url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(row),
    })
    if (!res.ok) {
      throw new Error(`Supabase REST 插入 ${table} 失败(${res.status}): ${await res.text()}`)
    }
    return res.json()
  }, { url, anonKey, table, row })
}
