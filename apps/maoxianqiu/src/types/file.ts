/**
 * Files 领域类型定义(MXQ-4001~4007)
 * 与 supabase/migrations/20260806000014_files_attachments.sql 对齐
 */

/** 文件存储桶类型 */
export type FileBucket = 'private' | 'public'

/** 文件分类(对应业务用途) */
export type FileCategory
  = | 'pet-avatar'
    | 'customer-consent'
    | 'medical-record'
    | 'lab-report'
    | 'image'
    | 'import'
    | 'export'
    | 'general'

/** 文件状态机:pending → uploaded → archived;error 为异常态 */
export type FileStatus = 'pending' | 'uploaded' | 'archived' | 'error'

/** 附件关联的业务实体类型 */
export type AttachmentEntityType
  = | 'customer'
    | 'pet'
    | 'encounter'
    | 'prescription'
    | 'lab_report'
    | 'inventory'
    | 'store'
    | 'tenant'

/** 附件用途 */
export type AttachmentPurpose
  = | 'attachment'
    | 'avatar'
    | 'consent'
    | 'report'
    | 'image'
    | 'export'

/** files 表记录 */
export interface FileRecord {
  id: string
  tenant_id: string
  store_id: string | null
  bucket: FileBucket
  object_key: string
  original_name: string
  mime_type: string
  size_bytes: number
  checksum: string | null
  category: FileCategory
  status: FileStatus
  uploaded_by: string | null
  uploaded_at: string | null
  archived_at: string | null
  archived_by: string | null
  archived_reason: string | null
  created_at: string
  updated_at: string
}

/** attachments 表记录 */
export interface AttachmentRecord {
  id: string
  tenant_id: string
  file_id: string
  entity_type: AttachmentEntityType
  entity_id: string
  purpose: AttachmentPurpose
  sort_order: number
  created_by: string | null
  created_at: string
}

/** 附件含文件详情(联表查询结果) */
export interface AttachmentWithFile extends AttachmentRecord {
  file?: FileRecord | null
}

/**
 * 上传意图请求(MXQ-4003)
 * 前端发起上传前先创建 intent,获取预签名 URL 后直传 R2。
 */
export interface CreateUploadIntentInput {
  tenantId: string
  storeId?: string
  category: FileCategory
  filename: string
  contentType: string
  sizeBytes: number
  /** 可选:提前绑定业务实体 */
  entityType?: AttachmentEntityType
  entityId?: string
  purpose?: AttachmentPurpose
}

/** 上传意图响应 */
export interface UploadIntentResult {
  fileId: string
  objectKey: string
  uploadUrl: string
  expiresAt: string
  /** 已绑定的附件 id(若请求时提供 entityType/entityId) */
  attachmentId?: string
}

/** 完成上传请求(MXQ-4004) */
export interface CompleteUploadInput {
  fileId: string
  /** 客户端计算的 sha256,服务端校验(可选) */
  checksum?: string
  /** 客户端声明的最终大小,服务端以 HEAD 为准 */
  sizeBytes?: number
}

/** 下载 URL 请求(MXQ-4005) */
export interface DownloadUrlInput {
  fileId: string
  /** 可选:下载文件名,设置响应 Content-Disposition */
  filename?: string
}

/** 下载 URL 响应 */
export interface DownloadUrlResult {
  fileId: string
  downloadUrl: string
  expiresAt: string
}

/** 归档文件请求(MXQ-4006) */
export interface ArchiveFileInput {
  fileId: string
  reason?: string
}

/** 文件状态机转换矩阵 */
export const FILE_STATUS_TRANSITIONS: Record<FileStatus, FileStatus[]> = {
  pending: ['uploaded', 'error'],
  uploaded: ['archived'],
  archived: [],
  error: ['pending'],
}

/**
 * 校验状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 * @returns 是否允许转换
 */
export function canTransitionFileStatus(from: FileStatus, to: FileStatus): boolean {
  return FILE_STATUS_TRANSITIONS[from].includes(to)
}

/** 文件分类标签映射(UI 显示用) */
export const FILE_CATEGORY_LABELS: Record<FileCategory, string> = {
  'pet-avatar': '宠物头像',
  'customer-consent': '客户授权书',
  'medical-record': '病历附件',
  'lab-report': '检验报告',
  'image': '影像截图',
  'import': '导入文件',
  'export': '导出文件',
  'general': '通用',
}

/** 文件状态标签映射(UI 显示用) */
export const FILE_STATUS_LABELS: Record<FileStatus, string> = {
  pending: '待上传',
  uploaded: '已上传',
  archived: '已归档',
  error: '异常',
}

/** 允许的 MIME 类型(按分类限制) */
export const ALLOWED_MIME_BY_CATEGORY: Record<FileCategory, RegExp> = {
  'pet-avatar': /^image\/(jpeg|png|webp)$/,
  'customer-consent': /^application\/pdf$|^image\/(jpeg|png)$/,
  'medical-record': /^application\/pdf$|^image\/(jpeg|png|webp)$/,
  'lab-report': /^application\/pdf$|^image\/(jpeg|png)$/,
  'image': /^image\/(jpeg|png|webp|gif)$/,
  'import': /^(application\/(vnd\.(ms-excel|openxmlformats-officedocument\.spreadsheetml\.sheet|csv)|csv|json))$|^text\/csv$/,
  'export': /^(application\/(pdf|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|csv|json))$|^text\/csv$/,
  'general': /^image\/|^application\/pdf$|^application\/(msword|vnd\.openxmlformats-officedocument\.)/,
}

/** 单文件最大尺寸(50MB,导入/导出文件放宽到 100MB) */
export const MAX_FILE_SIZE: Record<FileCategory, number> = {
  'pet-avatar': 5 * 1024 * 1024,
  'customer-consent': 10 * 1024 * 1024,
  'medical-record': 50 * 1024 * 1024,
  'lab-report': 50 * 1024 * 1024,
  'image': 20 * 1024 * 1024,
  'import': 100 * 1024 * 1024,
  'export': 100 * 1024 * 1024,
  'general': 50 * 1024 * 1024,
}
