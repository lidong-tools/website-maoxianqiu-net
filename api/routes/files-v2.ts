import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import {
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
  generatePrivateObjectKey,
  headObject,
} from '../lib/r2'
import { getContext, loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * 文件 Command 路由(MXQ-4003~4006)
 *
 * 状态机:
 *   pending --completeUpload--> uploaded --archiveFile--> archived
 *   pending --(失败)--> error --(重试)--> pending
 *
 * 安全:
 *   - 上传意图须 file.upload 权限
 *   - 完成上传须 file.upload 权限 + 文件归属校验
 *   - 下载须 file.download 权限 + 文件归属校验 + 审计
 *   - 归档须 file.archive 权限
 *   - 物理删除 R2 对象须 file.delete 权限(仅超管,延迟清理任务调用)
 */
const fileCommandRoutes = new Hono<AppEnv>()

fileCommandRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const ALLOWED_CATEGORIES = [
  'pet-avatar',
  'customer-consent',
  'medical-record',
  'lab-report',
  'image',
  'import',
  'export',
  'general',
] as const

const ALLOWED_ENTITY_TYPES = [
  'customer',
  'pet',
  'encounter',
  'prescription',
  'lab_report',
  'inventory',
  'store',
  'tenant',
] as const

const ALLOWED_PURPOSES = [
  'attachment',
  'avatar',
  'consent',
  'report',
  'image',
  'export',
] as const

/** 文件分类(与前端 apps/maoxianqiu/src/types/file.ts 对齐) */
type FileCategory = (typeof ALLOWED_CATEGORIES)[number]

/**
 * 允许的 MIME 类型(按分类限制)
 * 与前端 apps/maoxianqiu/src/types/file.ts 的 ALLOWED_MIME_BY_CATEGORY 保持一致
 */
const ALLOWED_MIME_BY_CATEGORY: Record<FileCategory, RegExp> = {
  'pet-avatar': /^image\/(jpeg|png|webp)$/,
  'customer-consent': /^application\/pdf$|^image\/(jpeg|png)$/,
  'medical-record': /^application\/pdf$|^image\/(jpeg|png|webp)$/,
  'lab-report': /^application\/pdf$|^image\/(jpeg|png)$/,
  'image': /^image\/(jpeg|png|webp|gif)$/,
  'import': /^(application\/(vnd\.(ms-excel|openxmlformats-officedocument\.spreadsheetml\.sheet|csv)|json))$|^text\/csv$/,
  'export': /^(application\/(pdf|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|csv|json))$|^text\/csv$/,
  'general': /^image\/|^application\/pdf$|^application\/(msword|vnd\.openxmlformats-officedocument\.)/,
}

/**
 * 单文件最大尺寸(字节,导入/导出文件放宽到 100MB)
 * 与前端 apps/maoxianqiu/src/types/file.ts 的 MAX_FILE_SIZE 保持一致
 */
const MAX_FILE_SIZE: Record<FileCategory, number> = {
  'pet-avatar': 5 * 1024 * 1024,
  'customer-consent': 10 * 1024 * 1024,
  'medical-record': 50 * 1024 * 1024,
  'lab-report': 50 * 1024 * 1024,
  'image': 20 * 1024 * 1024,
  'import': 100 * 1024 * 1024,
  'export': 100 * 1024 * 1024,
  'general': 50 * 1024 * 1024,
}

const uploadIntentSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误').optional(),
  storeId: z.string().uuid().optional(),
  category: z.enum(ALLOWED_CATEGORIES),
  filename: z.string().min(1, '文件名不能为空').max(255),
  contentType: z.string().min(1, 'MIME 不能为空'),
  sizeBytes: z.number().int().nonnegative(),
  entityType: z.enum(ALLOWED_ENTITY_TYPES).optional(),
  entityId: z.string().uuid().optional(),
  purpose: z.enum(ALLOWED_PURPOSES).optional(),
}).refine(
  data => (data.entityType && data.entityId) || (!data.entityType && !data.entityId),
  { message: 'entityType 与 entityId 必须同时提供或同时省略' },
)

/**
 * 创建上传意图(MXQ-4003)
 * - 权限:file.upload
 * - 行为:落 pending 文件记录 + 生成预签名上传 URL + (可选)预建 attachments
 * - object_key: {env}/tenant/{tenantId}/store/{storeId}/{category}/{yyyy}/{mm}/{uuid}.{ext}
 */
fileCommandRoutes.post('/upload-intents', async (c) => {
  const input = await parseJsonBody(c, uploadIntentSchema)

  // 租户归属校验:tenantId 缺失时回退到调用者首个成员关系,仍不匹配则拒绝
  const context = getContext(c)
  const tenantId = input.tenantId ?? context.memberships[0]?.tenant_id
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  // P0-02 scoped:统一做租户+门店作用域授权(含权限码校验),替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, {
    code: 'file.upload',
    tenantId,
    storeId: input.storeId,
  })

  // 按分类白名单校验 MIME 类型与大小(与前端 apps/maoxianqiu/src/types/file.ts 保持一致)
  if (!ALLOWED_MIME_BY_CATEGORY[input.category].test(input.contentType)) {
    throw err.badRequest(`文件类型不允许: ${input.contentType}`)
  }
  if (input.sizeBytes > MAX_FILE_SIZE[input.category]) {
    throw err.badRequest('文件大小超出分类限制')
  }

  const service = createServiceClient()
  const user = c.get('user')

  // 生成私有 object_key
  const objectKey = generatePrivateObjectKey({
    tenantId,
    storeId: input.storeId,
    domain: input.category,
    fileName: input.filename,
  })

  // 调 RPC 落库
  const { data: fileRecord, error: rpcError } = await service.rpc('create_upload_intent', {
    p_tenant_id: tenantId,
    p_store_id: input.storeId ?? null,
    p_category: input.category,
    p_original_name: input.filename,
    p_mime_type: input.contentType,
    p_size_bytes: input.sizeBytes,
    p_uploaded_by: user.id,
    p_object_key: objectKey,
  })

  if (rpcError) {
    if (rpcError.message.includes('INVALID_FILE_CATEGORY')) {
      throw err.badRequest('文件分类无效')
    }
    throw err.internal(`创建上传意图失败: ${rpcError.message}`)
  }

  // 生成预签名上传 URL
  const uploadUrl = await createPresignedUploadUrl(objectKey, input.contentType)
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()

  // 可选:预建 attachment 关联
  let attachmentId: string | undefined
  if (input.entityType && input.entityId) {
    const { data: attachment, error: attachError } = await service
      .from('attachments')
      .insert({
        tenant_id: tenantId,
        file_id: fileRecord.id,
        entity_type: input.entityType,
        entity_id: input.entityId,
        purpose: input.purpose ?? 'attachment',
        created_by: user.id,
      })
      .select('id')
      .single()
    if (attachError) {
      // attachment 建失败不阻断上传,记录警告
      console.warn('[files] 预建 attachment 失败', attachError.message)
    }
    else {
      attachmentId = attachment.id
    }
  }

  await writeAudit(c, {
    action: 'file.uploadIntent',
    entityType: 'file',
    entityId: fileRecord.id,
    tenantId,
    storeId: input.storeId,
    metadata: {
      category: input.category,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      objectKey,
    },
  })

  return ok(c, {
    fileId: fileRecord.id,
    objectKey,
    uploadUrl,
    expiresAt,
    attachmentId,
  })
})

const completeSchema = z.object({
  checksum: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
})

/**
 * 完成上传(MXQ-4004)
 * - 权限:file.upload
 * - 行为:HEAD 校验对象存在 → 调 complete_upload RPC 标记 uploaded
 * - 校验对象不存在时返回 409,提示前端重新上传
 */
fileCommandRoutes.post('/:id/complete', async (c) => {
  const fileId = c.req.param('id')
  const input = await parseJsonBody(c, completeSchema)

  const service = createServiceClient()
  const user = c.get('user')

  // 先取文件记录做归属校验
  const { data: file, error: fetchError } = await service
    .from('files')
    .select('id, tenant_id, store_id, object_key, status, uploaded_by')
    .eq('id', fileId)
    .maybeSingle()

  if (fetchError || !file) {
    throw err.notFound('文件不存在')
  }

  // 权限校验(带 storeId 以收敛门店范围)+ 租户归属校验(tenant 级文件 store_id 为空时必须校验租户)
  // P0-02 scoped:统一作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, {
    code: 'file.upload',
    tenantId: file.tenant_id,
    storeId: file.store_id ?? undefined,
  })
  // 仅上传者本人可完成上传(历史数据 uploaded_by 为空时放行,以租户归属校验为准)
  if (file.uploaded_by && file.uploaded_by !== user.id) {
    throw err.forbidden('仅上传者可完成该文件上传')
  }

  // HEAD 校验对象已上传到 R2
  const headResult = await headObject(file.object_key)
  if (!headResult) {
    // 对象不存在,标记 error 状态
    await service.from('files').update({ status: 'error', updated_at: new Date().toISOString() }).eq('id', fileId)
    throw err.conflict('对象未上传到存储,请重试')
  }

  // 调 RPC 标记 uploaded
  const { data: updated, error: rpcError } = await service.rpc('complete_upload', {
    p_file_id: fileId,
    p_checksum: input.checksum ?? null,
    p_size_bytes: headResult.size,
    p_operator_id: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('FILE_NOT_FOUND')) {
      throw err.notFound('文件不存在')
    }
    if (rpcError.message.includes('FILE_ALREADY_ARCHIVED')) {
      throw err.conflict('文件已归档,无法完成上传')
    }
    throw err.internal(`完成上传失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'file.uploadComplete',
    entityType: 'file',
    entityId: fileId,
    tenantId: file.tenant_id,
    storeId: file.store_id ?? undefined,
    metadata: {
      sizeBytes: headResult.size,
      etag: headResult.etag,
      checksum: input.checksum,
    },
  })

  return ok(c, updated)
})

const downloadUrlSchema = z.object({
  filename: z.string().max(255).optional(),
})

/**
 * 获取下载 URL(MXQ-4005)
 * - 权限:file.download
 * - 行为:校验归属 → 生成短期预签名下载 URL → 审计
 * - 归档文件不可下载(409)
 */
fileCommandRoutes.post('/:id/download-url', async (c) => {
  const fileId = c.req.param('id')
  const input = await parseJsonBody(c, downloadUrlSchema)

  const service = createServiceClient()

  const { data: file, error: fetchError } = await service
    .from('files')
    .select('id, tenant_id, store_id, object_key, original_name, status, category')
    .eq('id', fileId)
    .maybeSingle()

  if (fetchError || !file) {
    throw err.notFound('文件不存在')
  }

  // 权限校验(带 storeId 以收敛门店范围)+ 租户归属校验(tenant 级文件 store_id 为空时必须校验租户归属)
  // P0-02 scoped:统一作用域授权,替代 requirePermission + assertTenantAccess
  await requireScopedPermission(c, {
    code: 'file.download',
    tenantId: file.tenant_id,
    storeId: file.store_id ?? undefined,
  })

  if (file.status === 'archived') {
    throw err.conflict('文件已归档,不可下载')
  }
  if (file.status === 'pending') {
    throw err.conflict('文件尚未上传完成')
  }

  const downloadUrl = await createPresignedDownloadUrl(file.object_key)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  await writeAudit(c, {
    action: 'file.download',
    entityType: 'file',
    entityId: fileId,
    tenantId: file.tenant_id,
    storeId: file.store_id ?? undefined,
    metadata: {
      objectKey: file.object_key,
      originalName: file.original_name,
      requestedFilename: input.filename,
      category: file.category,
    },
  })

  return ok(c, {
    fileId,
    downloadUrl,
    expiresAt,
  })
})

const archiveSchema = z.object({
  reason: z.string().max(500).optional(),
})

/**
 * 归档文件(MXQ-4006)
 * - 权限:file.archive
 * - 行为:调 archive_file RPC 软删除,标记 archived_at,不删 R2 对象
 */
fileCommandRoutes.post('/:id/archive', async (c) => {
  const fileId = c.req.param('id')
  const input = await parseJsonBody(c, archiveSchema)

  const service = createServiceClient()
  const user = c.get('user')

  const { data: file, error: fetchError } = await service
    .from('files')
    .select('id, tenant_id, store_id, status')
    .eq('id', fileId)
    .maybeSingle()

  if (fetchError || !file) {
    throw err.notFound('文件不存在')
  }

  // P0-02 scoped:统一作用域授权,替代 requirePermission
  await requireScopedPermission(c, {
    code: 'file.archive',
    tenantId: file.tenant_id,
    storeId: file.store_id ?? undefined,
  })

  const { data: updated, error: rpcError } = await service.rpc('archive_file', {
    p_file_id: fileId,
    p_archived_by: user.id,
    p_reason: input.reason ?? null,
  })

  if (rpcError) {
    if (rpcError.message.includes('FILE_NOT_FOUND')) {
      throw err.notFound('文件不存在')
    }
    if (rpcError.message.includes('FILE_ALREADY_ARCHIVED')) {
      throw err.conflict('文件已归档')
    }
    throw err.internal(`归档失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'file.archive',
    entityType: 'file',
    entityId: fileId,
    tenantId: file.tenant_id,
    storeId: file.store_id ?? undefined,
    metadata: { reason: input.reason },
  })

  return ok(c, updated)
})

/**
 * 物理删除 R2 对象(MXQ-4006,延迟清理任务专用)
 * - 权限:file.delete(仅超管)
 * - 行为:删 R2 对象 + 删 files 记录
 * - 普通业务不调用,仅由运维清理任务触发
 */
fileCommandRoutes.post('/:id/delete', async (c) => {
  const fileId = c.req.param('id')

  const service = createServiceClient()
  // 先查文件实体获取 tenant,再授权(防止跨租户直接操作)
  const { data: file, error: fetchError } = await service
    .from('files')
    .select('id, tenant_id, store_id, object_key, status')
    .eq('id', fileId)
    .maybeSingle()

  if (fetchError || !file) {
    throw err.notFound('文件不存在')
  }

  // P0-02 scoped:统一作用域授权,替代 requirePermission
  const scope = await requireScopedPermission(c, {
    code: 'file.delete',
    tenantId: file.tenant_id,
    storeId: file.store_id ?? undefined,
  })

  // 额外校验:仅超管可物理删除
  if (!scope.isPlatformAdmin) {
    throw err.forbidden('仅系统管理员可物理删除文件')
  }

  // 仅允许删除已归档文件
  if (file.status !== 'archived') {
    throw err.conflict('仅已归档文件可物理删除')
  }

  // 删 R2 对象(best-effort,记录失败但不阻断)
  try {
    const { deleteFile } = await import('../lib/r2')
    await deleteFile(file.object_key)
  }
  catch (e) {
    console.error('[files] 删除 R2 对象失败', e)
  }

  // 删 files 记录(cascade 删 attachments)
  const { error: deleteError } = await service.from('files').delete().eq('id', fileId)
  if (deleteError) {
    throw err.internal(`删除文件记录失败: ${deleteError.message}`)
  }

  await writeAudit(c, {
    action: 'file.delete',
    entityType: 'file',
    entityId: fileId,
    metadata: { objectKey: file.object_key },
  })

  return ok(c, { isSuccess: true })
})

export default fileCommandRoutes
