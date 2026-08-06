import axios from 'axios'

// 请求重试配置
const MAX_RETRY_COUNT = 3 // 最大重试次数
const RETRY_DELAY = 1000 // 重试延迟时间（毫秒）

// 扩展 AxiosRequestConfig 类型
declare module 'axios' {
  export interface AxiosRequestConfig {
    retry?: boolean
    retryCount?: number
  }
}

const api = axios.create({
  baseURL: (import.meta.env.DEV && import.meta.env.VITE_ENABLE_PROXY) ? '/proxy/' : import.meta.env.VITE_APP_API_BASEURL,
  timeout: 1000 * 60,
  responseType: 'json',
})

api.interceptors.request.use(
  (request) => {
    const appAccountStore = useAppAccountStore()
    if (request.headers) {
      request.headers['Accept-Language'] = 'zh-CN'
      if (appAccountStore.isLogin) {
        // MXQ-2003:统一 Authorization: Bearer(迁移期同时保留 Token 供旧接口兼容)
        request.headers.Authorization = `Bearer ${appAccountStore.token}`
        request.headers.Token = appAccountStore.token
      }
    }
    return request
  },
)

interface NewFailureBody {
  ok: false
  error: {
    code?: string
    message?: string
    fieldErrors?: Record<string, string[]>
  }
  requestId?: string
}

function showError(message: string, requestId?: string) {
  useFaToast().error('Error', {
    description: requestId ? `${message}（requestId: ${requestId}）` : message,
  })
}

// 处理 HTTP 状态错误(新旧格式通用)
function handleHttpError(error: any) {
  const status = error.response?.status
  const data: NewFailureBody | undefined = error.response?.data
  const message = data?.error?.message || error.message || '请求失败'
  const requestId = data?.requestId

  if (status === 401) {
    useAppAccountStore().requestLogout()
  }
  else if (status === 403) {
    showError(message || '无权限操作', requestId)
  }
  else if (status === 409) {
    showError(message || '数据已变更,请刷新后重试', requestId)
  }
  else if (status === 422) {
    showError(message || '业务规则校验失败', requestId)
  }
  else {
    showError(message, requestId)
  }
  return Promise.reject(error)
}

api.interceptors.response.use(
  (response) => {
    const body = response.data
    /**
     * MXQ-2009:兼容新旧两种响应格式
     * 新格式:{ ok: true, data, requestId } / { ok: false, error: { code, message, fieldErrors }, requestId }
     * 旧格式:{ status: 1 | 0, error: string, data }
     */
    if (typeof body === 'object' && body !== null) {
      // 新格式
      if (typeof body.ok === 'boolean') {
        if (body.ok) {
          return Promise.resolve(body)
        }
        showError(body.error?.message || '请求失败', body.requestId)
        return Promise.reject(body)
      }
      // 旧格式
      if (body.status === 1) {
        if (body.error) {
          useFaToast().warning('Warning', {
            description: body.error,
          })
          return Promise.reject(body)
        }
        return Promise.resolve(body)
      }
      if (body.status === 0) {
        useAppAccountStore().requestLogout()
      }
      return Promise.resolve(body)
    }
    return Promise.reject(body)
  },
  async (error) => {
    // 获取请求配置
    const config = error.config
    // 如果配置不存在或未启用重试，则直接处理错误
    if (!config || !config.retry) {
      return handleHttpError(error)
    }
    // 设置重试次数
    config.retryCount = config.retryCount || 0
    // 判断是否超过重试次数
    if (config.retryCount >= MAX_RETRY_COUNT) {
      return handleHttpError(error)
    }
    // 重试次数自增
    config.retryCount += 1
    // 延迟重试
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
    // 重新发起请求
    return api(config)
  },
)

export default api
