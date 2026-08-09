import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext, resolveRequestedTenant, resolveRequestedStore } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'
import { createPresignedDownloadUrl } from '../lib/r2.js'
import {
  createSignatureRequest,
  DOCUMENT_SOURCE_TABLES,
  generatePdfArchive,
  getArchive,
  listArchives,
} from '../services/document-artifacts/index.js'

/**
 * 通用文档归档 Command/查询路由(Stage-04 Agent-06)
 *
 * 端点:
 *   POST /document-artifacts/:documentType/:entityId/pdf   生成业务文档 PDF 归档
 *   GET  /document-artifacts/archives                     归档列表(分页)
 *   GET  /document-artifacts/archives/:id/download        归档预签名下载
 *   GET  /document-artifacts/archives/:id/signatures      归档签名请求列表
 *   POST /document-artifacts/archives/:id/sign            发起签名请求(内部 Provider 首版)
 *
 * 权限:
 *   documents.pdf.generate    PDF 生成
 *   documents.archive.view    归档查看/下载
 *   documents.signature.manage 签名请求管理
 *   二次业务权限门:encounter.view / prescription.view / invoice.view / lab.view /
 *                imaging.view / inpatient.view / vaccine.view
 */
const documentArtifactRoutes = new Hono<AppEnv>()

documentArtifactRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const DOCUMENT_TYPE_ENUM = z.enum(Object.keys(DOCUMENT_SOURCE_TABLES) as [string, ...string[]])

const generatePdfSchema = z.object({
  customerVisible: z.boolean().optional(),
})

/**
 * 生成业务文档 PDF 归档
 * - 权限:documents.pdf.generate + 该文档类型的业务二次权限门
 * - 归档不可变:sha256/size 一次性写入,业务修订 → 新 archive,旧 → superseded
 */
documentArtifactRoutes.post('/:documentType/:entityId/pdf', async (c) => {
  const documentType = c.req.param('documentType')
  const entityId = c.req.param('entityId')
  const input = await parseJsonBody(c, generatePdfSchema)
  const user = c.get('user')

  const source = DOCUMENT_SOURCE_TABLES[documentType]
  if (!source) {
    throw err.badRequest(`不支持的文档类型: ${documentType}`)
  }

  const service = createServiceClient()

  // 1) 读取实体归属(租户/门店),用于作用域授权
  const { data: entity, error: fetchError } = await service
    .from(source.table)
    .select('id, tenant_id, store_id')
    .eq('id', entityId)
    .maybeSingle()
  if (fetchError || !entity) {
    throw err.notFound(`${source.title}不存在`)
  }

  // 2) 双重权限:PDF 生成 + 业务二次权限门(禁止只凭 documents.view 读取医疗数据)
  await requireScopedPermission(c, {
    code: 'documents.pdf.generate',
    tenantId: entity.tenant_id,
    storeId: entity.store_id ?? undefined,
  })
  await requireScopedPermission(c, {
    code: source.permission,
    tenantId: entity.tenant_id,
    storeId: entity.store_id ?? undefined,
  })

  // 3) 生成归档
  const result = await generatePdfArchive(service, {
    documentType,
    entityId,
    userId: user.id,
    tenantId: entity.tenant_id,
    storeId: entity.store_id,
  })

  // 4) 若要求客户可见,标记 customer_visible(不直接 published)
  if (input.customerVisible) {
    await service
      .from('document_archives')
      .update({ customer_visible: true })
      .eq('id', result.archive.id)
  }

  await writeAudit(c, {
    action: 'documentArchive.pdfGenerated',
    entityType: 'document_archives',
    entityId: String(result.archive.id ?? ''),
    tenantId: entity.tenant_id,
    storeId: entity.store_id ?? undefined,
    metadata: {
      documentType,
      sourceEntityId: entityId,
      fileId: result.file.id,
      sha256: result.file.sha256,
      provider: result.file.provider,
    },
  })

  return ok(c, result)
})

const listArchivesSchema = z.object({
  documentType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  status: z.enum(['active', 'superseded', 'archived']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
})

/**
 * 归档列表(租户/门店收敛 + 分页)
 */
documentArtifactRoutes.get('/archives', async (c) => {
  const q = c.req.query()
  const parsed = listArchivesSchema.safeParse({
    documentType: q.documentType,
    entityId: q.entityId,
    status: q.status,
    page: q.page,
    pageSize: q.pageSize,
  })
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', {
      _root: parsed.error.issues.map(i => i.message),
    })
  }

  const tenantId = resolveRequestedTenant(c)
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  const storeId = resolveRequestedStore(c)

  // 归档查看权限(租户级;storeId 缺省时允许 tenant-wide 角色)
  const scope = await requireScopedPermission(c, {
    code: 'documents.archive.view',
    tenantId,
    storeId,
    dataScope: true,
  })

  const service = createServiceClient()
  const result = await listArchives(service, {
    tenantId,
    storeId: storeId ?? null,
    documentType: parsed.data.documentType,
    entityId: parsed.data.entityId,
    status: parsed.data.status,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  })

  await writeAudit(c, {
    action: 'documentArchive.list',
    entityType: 'document_archives',
    tenantId,
    storeId,
    metadata: {
      documentType: parsed.data.documentType,
      entityId: parsed.data.entityId,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      allowedStoreCount: scope.allowedStoreIds.length,
    },
  })

  return ok(c, result)
})

/**
 * 归档详情 + 预签名下载 URL
 * - 权限:documents.archive.view
 * - 私有桶文件仅通过短时预签名 URL 访问
 */
documentArtifactRoutes.get('/archives/:id/download', async (c) => {
  const archiveId = c.req.param('id')
  const user = c.get('user')
  const service = createServiceClient()

  const archive = await getArchive(service, archiveId)

  // 作用域授权(以归档归属为准)
  await requireScopedPermission(c, {
    code: 'documents.archive.view',
    tenantId: String(archive.tenant_id),
    storeId: archive.store_id ? String(archive.store_id) : undefined,
  })

  // 从 files 记录取 object_key
  const file = archive.files as { object_key: string, original_name: string } | null
  if (!file?.object_key) {
    throw err.conflict('归档缺少文件对象')
  }

  const downloadUrl = await createPresignedDownloadUrl(file.object_key)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  await writeAudit(c, {
    action: 'documentArchive.download',
    entityType: 'document_archives',
    entityId: archiveId,
    tenantId: String(archive.tenant_id),
    storeId: archive.store_id ? String(archive.store_id) : undefined,
    metadata: {
      documentType: archive.document_type,
      entityId: archive.entity_id,
      sha256: archive.sha256,
      originalName: file.original_name,
    },
  })

  return ok(c, {
    archiveId,
    downloadUrl,
    expiresAt,
    originalName: file.original_name,
    sha256: archive.sha256,
  })
})

/**
 * 归档签名请求列表
 * - 权限:documents.archive.view(查看签名状态)
 */
documentArtifactRoutes.get('/archives/:id/signatures', async (c) => {
  const archiveId = c.req.param('id')
  const service = createServiceClient()

  const archive = await getArchive(service, archiveId)
  await requireScopedPermission(c, {
    code: 'documents.archive.view',
    tenantId: String(archive.tenant_id),
    storeId: archive.store_id ? String(archive.store_id) : undefined,
  })

  const { data, error } = await service
    .from('signature_requests')
    .select('*')
    .eq('archive_id', archiveId)
    .order('created_at', { ascending: false })
  if (error) {
    throw err.internal(`查询签名请求失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [] })
})

const signSchema = z.object({
  signerType: z.enum(['customer', 'guardian', 'other']).optional(),
  signerName: z.string().max(100).optional(),
  signerEmail: z.string().email('邮箱格式错误').optional(),
  idempotencyKey: z.string().max(128).optional(),
})

/**
 * 发起签名请求(内部 Provider 首版)
 * - 权限:documents.signature.manage
 * - 幂等:header Idempotency-Key 或 body idempotencyKey
 * - 合规边界:provider=internal 仅表达内部流程,UI 禁止宣称"已完成合法可靠电子签名"
 */
documentArtifactRoutes.post('/archives/:id/sign', async (c) => {
  const archiveId = c.req.param('id')
  const input = await parseJsonBody(c, signSchema)
  const user = c.get('user')

  const service = createServiceClient()
  const archive = await getArchive(service, archiveId)

  await requireScopedPermission(c, {
    code: 'documents.signature.manage',
    tenantId: String(archive.tenant_id),
    storeId: archive.store_id ? String(archive.store_id) : undefined,
  })

  const idempotencyKey = getRequestIdempotencyKey(c) || input.idempotencyKey || undefined

  const request = await createSignatureRequest(service, {
    tenantId: String(archive.tenant_id),
    storeId: archive.store_id ? String(archive.store_id) : null,
    archiveId,
    signerType: input.signerType,
    signerName: input.signerName,
    signerEmail: input.signerEmail,
    userId: user.id,
    idempotencyKey,
  })

  await writeAudit(c, {
    action: 'documentArchive.signatureRequested',
    entityType: 'signature_request',
    entityId: String(request.id ?? ''),
    tenantId: String(archive.tenant_id),
    storeId: archive.store_id ? String(archive.store_id) : undefined,
    metadata: {
      archiveId,
      signerType: input.signerType ?? 'customer',
      signerName: input.signerName,
      provider: request.provider,
      status: request.status,
    },
  })

  return ok(c, request)
})

export default documentArtifactRoutes
