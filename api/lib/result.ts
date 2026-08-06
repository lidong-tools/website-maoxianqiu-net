import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from './types'
import { ApiError } from './errors'

export interface ErrorBody {
  code: string
  message: string
  fieldErrors?: Record<string, string[]>
}

export interface SuccessBody<T> {
  ok: true
  data: T
  requestId: string
}

export interface FailureBody {
  ok: false
  error: ErrorBody
  requestId: string
}

function requestId(c: Context<AppEnv>): string {
  return c.get('requestId') ?? ''
}

/** 统一成功响应:{ ok, data, requestId } */
export function ok<T>(c: Context<AppEnv>, data: T, customRequestId?: string) {
  const body: SuccessBody<T> = {
    ok: true,
    data,
    requestId: customRequestId ?? requestId(c),
  }
  return c.json(body, 200)
}

/** 统一失败响应:HTTP 状态 + { ok, error, requestId } */
export function fail(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  error: ErrorBody,
  customRequestId?: string,
) {
  const body: FailureBody = {
    ok: false,
    error,
    requestId: customRequestId ?? requestId(c),
  }
  return c.json(body, status)
}

/** 将任意错误归一为统一失败响应(ApiError 保留状态码,未知错误为 500) */
export function failError(c: Context<AppEnv>, e: unknown, customRequestId?: string) {
  if (e instanceof ApiError) {
    return fail(c, e.status as ContentfulStatusCode, {
      code: e.code,
      message: e.message,
      fieldErrors: e.fieldErrors,
    }, customRequestId)
  }
  return fail(c, 500, {
    code: 'INTERNAL_ERROR',
    message: '服务器内部错误',
  }, customRequestId)
}
