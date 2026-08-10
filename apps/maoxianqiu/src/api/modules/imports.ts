import type {
  ImportErrorRow,
  ImportJob,
  ImportRowPreview,
  StartResult,
  UploadResult,
  ValidateResult,
} from '@/types/imports'
/**
 * Import Center V2 API（S32-A）
 * 数据迁移：模板下载 / 上传 / 映射 / 校验 / 执行 / 结果 / 取消
 */
import api from '../index'

export interface ImportListParams {
  tenantId: string
  storeId?: string
  type?: string
  status?: string
  from?: number
  limit?: number
}

async function list(params: ImportListParams) {
  const { data } = await api.get<{ list: ImportJob[], total: number }>('imports', { params })
  return data
}

async function upload(payload: { tenantId: string, storeId?: string, type: string, fileId: string }) {
  const { data } = await api.post<UploadResult>('imports/upload', payload)
  return data
}

async function saveMapping(id: string, payload: { mapping: Record<string, string>, duplicateStrategy: string }) {
  const { data } = await api.post<{
    job: ImportJob
    headers: string[]
    preview: ImportRowPreview[]
    requiredMapped: boolean
  }>(`imports/${id}/mapping`, payload)
  return data
}

async function runValidate(id: string) {
  const { data } = await api.post<ValidateResult>(`imports/${id}/validate`)
  return data
}

async function runStart(id: string) {
  const { data } = await api.post<StartResult>(`imports/${id}/start`)
  return data
}

async function detail(id: string) {
  const { data } = await api.get<{ job: ImportJob, errorCount: number }>(`imports/${id}`)
  return data
}

async function listErrors(id: string, params: { from?: number, limit?: number, rowNumber?: number }) {
  const { data } = await api.get<{ list: ImportErrorRow[], total: number }>(`imports/${id}/errors`, { params })
  return data
}

async function cancel(id: string) {
  const { data } = await api.post<ImportJob>(`imports/${id}/cancel`)
  return data
}

/**
 * 模板下载：axios 拦截器会 reject Blob 响应，故用原生 fetch 携带 token。
 */
async function downloadTemplate(type: string, tenantId: string, format: 'xlsx' | 'csv' = 'xlsx') {
  const { useAppAccountStore } = await import('@/store/modules/app/account')
  const token = useAppAccountStore().token
  const base = api.defaults.baseURL || ''
  const url = `${base}imports/templates/${type}?tenantId=${tenantId}&format=${format}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    throw new Error('模板下载失败')
  }
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = `${type}-import-template.${format}`
  a.click()
  URL.revokeObjectURL(objectUrl)
}

export default {
  list,
  upload,
  saveMapping,
  runValidate,
  runStart,
  detail,
  listErrors,
  cancel,
  downloadTemplate,
}
