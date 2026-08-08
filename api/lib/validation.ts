import type { Context } from 'hono'
import type { ZodType } from 'zod'
import type { AppEnv } from './types.js'
import { err } from './errors.js'

/** 将 Zod 校验结果转为 { field: messages } 结构 */
export function formatZodErrors(issues: { path: PropertyKey[], message: string }[]): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {}
  for (const issue of issues) {
    const key = issue.path.join('.') || '_root'
    ;(fieldErrors[key] ??= []).push(issue.message)
  }
  return fieldErrors
}

/**
 * 在路由内解析并校验 JSON body(MXQ-2004)
 * 校验失败抛 400 + fieldErrors,可被统一 error handler 捕获。
 */
export async function parseJsonBody<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => null)
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw err.badRequest('参数校验失败', formatZodErrors(result.error.issues))
  }
  return result.data
}

/**
 * Zod 校验中间件(可选):校验通过后数据挂在 c.set('validated'),
 * 路由内需再次断言类型。推荐直接使用 parseJsonBody 以保留完整类型。
 */
export function validateJson<T>(schema: ZodType<T>) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const raw = await c.req.json().catch(() => null)
    const result = schema.safeParse(raw)
    if (!result.success) {
      throw err.badRequest('参数校验失败', formatZodErrors(result.error.issues))
    }
    c.set('validated', result.data)
    await next()
  }
}
