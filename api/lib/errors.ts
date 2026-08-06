/**
 * 统一业务错误(API Foundation, MXQ-2001)
 * 约定 HTTP 状态:
 *   400 参数错误 / 401 未登录 / 403 无权限 / 404 不存在
 *   409 状态或并发冲突 / 422 业务规则失败 / 500 服务端错误
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const err = {
  badRequest: (message = '参数错误', fieldErrors?: Record<string, string[]>) =>
    new ApiError(400, 'BAD_REQUEST', message, fieldErrors),
  unauthorized: (message = '未登录或登录已过期') =>
    new ApiError(401, 'UNAUTHORIZED', message),
  forbidden: (message = '无权限') =>
    new ApiError(403, 'FORBIDDEN', message),
  notFound: (message = '资源不存在') =>
    new ApiError(404, 'NOT_FOUND', message),
  conflict: (message = '数据冲突', fieldErrors?: Record<string, string[]>) =>
    new ApiError(409, 'CONFLICT', message, fieldErrors),
  unprocessable: (message = '业务规则不允许', fieldErrors?: Record<string, string[]>) =>
    new ApiError(422, 'UNPROCESSABLE', message, fieldErrors),
  internal: (message = '服务器内部错误') =>
    new ApiError(500, 'INTERNAL_ERROR', message),
}
