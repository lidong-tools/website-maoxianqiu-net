import type { Context } from 'hono'
import { createHash } from 'node:crypto'
import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import { loadContext, resolveRequestedTenant } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'
import { getAdapter } from '../services/documents/adapters'
import { renderDocument } from '../services/documents'
import { validateTemplateHtml } from '../services/documents/renderer'
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  PAPER_SIZES,
  type DocumentType,
  type PaperSize,
} from '../services/documents/types'

/**
 * S32-C 业务文档与打印中心 V2 路由
 *
 * 路由清单:
 *   GET   /documents/templates              模板列表(门店覆盖/租户默认/系统默认)
 *   POST  /documents/templates              创建模板(门店覆盖或租户默认)
 *   PATCH /documents/templates/:id          更新模板(升版本 + 审计)
 *   POST  /documents/preview                预览(渲染 HTML,不落历史)
 *   POST  /documents/render                 渲染(渲染 HTML + 落历史 + 审计)
 *   POST  /documents/print                  打印(渲染 HTML + 落历史 + 审计)
 *   GET   /documents/history                渲染/打印历史
 *
 * 权限:
 *   documents.view            查看/预览/渲染/历史
 *   documents.print           打印
 *   documents.template.manage 模板管理
 *   医疗类文档(影像/出院/寄养)额外校验业务权限门(imaging.view / inpatient.view / boarding.view)
 *
 * 安全:
 *   模板只允许安全变量 {{path}} / {{#each}},服务端渲染器不执行任意 JS。
 */

const documentsRoutes = new Hono<AppEnv>()

documentsRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

// ===== 常量 =====
/** documentType → 审计 entity_type(与既有 print.data 命名一致) */
const AUDIT_ENTITY_TYPE: Record<DocumentType, string> = {
  prescription: 'prescription',
  invoice: 'invoice',
  medical_record_summary: 'encounter',
  lab_report: 'lab_order',
  imaging_report: 'imaging_report',
  discharge_summary: 'admission',
  vaccination_certificate: 'vaccine_certificate',
  boarding_handover: 'boarding_stay',
}

function getAuditEntityType(dt: DocumentType): string {
  return AUDIT_ENTITY_TYPE[dt]
}

/**
 * 计算渲染 HTML 的 SHA-256 摘要(合规重放/内容一致性校验)
 * @param html 渲染后的文档 HTML
 * @returns 十六进制哈希
 */
function hashRenderedHtml(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex')
}

/** 校验模板内容安全(允许 null 表示通过,返回错误信息字符串) */
function assertTemplateSafe(templateHtml: string): void {
  const problem = validateTemplateHtml(templateHtml)
  if (problem) {
    throw err.badRequest(problem)
  }
}

// ===== GET /documents/templates =====
/**
 * 模板列表
 * - 权限:documents.view(dataScope)
 * - 返回当前租户可见模板(系统 + 租户 + 门店覆盖),并标注 level
 */
documentsRoutes.get('/templates', async (c) => {
  const tenantId = resolveRequestedTenant(c, c.req.query('tenantId')) ?? ''
  const storeId = c.req.query('storeId') || undefined
  const documentType = c.req.query('documentType') || undefined
  const onlyActive = c.req.query('onlyActive') === 'true'

  const scope = await requireScopedPermission(c, {
    code: 'documents.view',
    tenantId,
    dataScope: true,
  })
  if (storeId && !scope.isPlatformAdmin && !scope.allowedStoreIds.includes(storeId)) {
    throw err.forbidden('无权访问该门店的文档模板')
  }

  const service = createServiceClient()
  const { data, error } = await service
    .from('document_templates')
    .select('*')
    .or(`tenant_id.eq.${scope.tenantId},tenant_id.is.null`)
    .order('document_type', { ascending: true })
    .order('updated_at', { ascending: false })

  if (error) {
    throw err.internal(`查询文档模板失败: ${error.message}`)
  }

  const rows = (data ?? []).filter((row: any) => {
    // 门店过滤:指定门店 → 只保留该系统/租户/该门店模板;未指定 → 只保留系统/租户模板
    if (storeId) {
      if (row.store_id !== null && row.store_id !== storeId) {
        return false
      }
    }
    else if (row.store_id !== null) {
      return false
    }
    if (documentType && row.document_type !== documentType) {
      return false
    }
    if (onlyActive && !row.is_active) {
      return false
    }
    return true
  })

  const list = rows.map((row: any) => {
    const level = row.store_id
      ? 'store'
      : row.tenant_id
        ? 'tenant'
        : 'system'
    return { ...row, level, documentTypeLabel: DOCUMENT_TYPE_LABELS[row.document_type as DocumentType] ?? row.document_type }
  })

  return ok(c, { list, total: list.length })
})

// ===== POST /documents/templates =====
const createTemplateSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误').nullable().optional(),
  documentType: z.enum(DOCUMENT_TYPES),
  name: z.string().min(1, '模板名称不能为空').max(100),
  templateHtml: z.string().min(1, '模板内容不能为空'),
  templateJson: z.record(z.string(), z.any()).optional(),
  paperSize: z.enum(PAPER_SIZES).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

/**
 * 创建模板
 * - 权限:documents.template.manage
 * - 系统默认模板(tenant_id null)不可通过 API 创建,仅种子写入
 */
documentsRoutes.post('/templates', async (c) => {
  const input = await parseJsonBody(c, createTemplateSchema)
  assertTemplateSafe(input.templateHtml)

  const scope = await requireScopedPermission(c, {
    code: 'documents.template.manage',
    tenantId: input.tenantId,
    storeId: input.storeId ?? undefined,
  })

  const service = createServiceClient()
  const user = c.get('user')

  const { data, error } = await service
    .from('document_templates')
    .insert({
      tenant_id: scope.tenantId,
      store_id: input.storeId ?? null,
      document_type: input.documentType,
      name: input.name,
      version: 1,
      template_html: input.templateHtml,
      template_json: input.templateJson ?? {},
      paper_size: input.paperSize ?? 'A4',
      is_default: input.isDefault ?? false,
      is_active: input.isActive ?? true,
      created_by: user.id,
    })
    .select()
    .maybeSingle()

  if (error) {
    throw err.internal(`创建文档模板失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'documents.template.create',
    entityType: 'document_template',
    entityId: data?.id,
    tenantId: scope.tenantId,
    storeId: input.storeId ?? undefined,
    metadata: { documentType: input.documentType, name: input.name },
  })

  return ok(c, data)
})

// ===== PATCH /documents/templates/:id =====
const updateTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  templateHtml: z.string().min(1).optional(),
  templateJson: z.record(z.string(), z.any()).optional(),
  paperSize: z.enum(PAPER_SIZES).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

/**
 * 更新模板
 * - 权限:documents.template.manage(以模板自身 tenant/store 校验作用域)
 * - 每次更新 version + 1,并写审计
 */
documentsRoutes.patch('/templates/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, updateTemplateSchema)
  if (input.templateHtml) {
    assertTemplateSafe(input.templateHtml)
  }

  const service = createServiceClient()
  const { data: existing, error: existingErr } = await service
    .from('document_templates')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (existingErr || !existing) {
    throw err.notFound('文档模板不存在')
  }
  if (!existing.tenant_id) {
    throw err.badRequest('系统默认模板不可修改,请创建租户级模板覆盖')
  }

  const scope = await requireScopedPermission(c, {
    code: 'documents.template.manage',
    tenantId: existing.tenant_id,
    storeId: existing.store_id ?? undefined,
  })

  const patch: Record<string, unknown> = {
    version: existing.version + 1,
  }
  if (input.name !== undefined) {
    patch.name = input.name
  }
  if (input.templateHtml !== undefined) {
    patch.template_html = input.templateHtml
  }
  if (input.templateJson !== undefined) {
    patch.template_json = input.templateJson
  }
  if (input.paperSize !== undefined) {
    patch.paper_size = input.paperSize
  }
  if (input.isDefault !== undefined) {
    patch.is_default = input.isDefault
  }
  if (input.isActive !== undefined) {
    patch.is_active = input.isActive
  }

  const { data, error } = await service
    .from('document_templates')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle()

  if (error) {
    throw err.internal(`更新文档模板失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'documents.template.update',
    entityType: 'document_template',
    entityId: id,
    tenantId: scope.tenantId,
    storeId: existing.store_id ?? undefined,
    metadata: { documentType: existing.document_type, version: data?.version },
  })

  return ok(c, data)
})

// ===== 渲染/预览/打印通用逻辑 =====
const renderBodySchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  entityId: z.string().uuid('业务单据 id 格式错误'),
  templateId: z.string().uuid().optional(),
  paperSize: z.enum(PAPER_SIZES).optional(),
})

interface RenderInput {
  documentType: DocumentType
  entityId: string
  templateId?: string
  paperSize?: PaperSize
}

/**
 * 鉴权 + 渲染文档
 * - 先取实体 tenant/store 再做 scoped 授权(防止跨租户/门店)
 * - 医疗类文档额外校验业务权限门
 */
async function authorizeAndRender(c: Context<AppEnv>, input: RenderInput) {
  const adapter = getAdapter(input.documentType)
  const service = createServiceClient()

  // 1) 实体作用域(先取 tenant/store 再授权)
  const scope = await adapter.resolveScope(service, input.entityId)

  // 2) 授权:业务权限门(无则 documents.view/print)+ 必须拥有 documents.view
  const gateCode = adapter.businessPermission ?? 'documents.view'
  const access = await requireScopedPermission(c, {
    code: gateCode,
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
    dataScope: true,
  })
  if (!access.permissions.includes('documents.view')) {
    throw err.forbidden('缺少权限: documents.view')
  }

  // 3) 渲染
  return renderDocument(service, {
    documentType: input.documentType,
    entityId: input.entityId,
    templateId: input.templateId,
    paperSize: input.paperSize,
  })
}

// ===== POST /documents/preview =====
/**
 * 预览文档(核心:左模板/纸型,右实时预览)
 * - 权限:documents.view(+ 医疗业务门)
 * - 不落历史、不审计(仅渲染)
 */
documentsRoutes.post('/preview', async (c) => {
  const input = await parseJsonBody(c, renderBodySchema)
  const rendered = await authorizeAndRender(c, input)
  return ok(c, {
    html: rendered.html,
    documentType: rendered.documentType,
    entityId: rendered.entityId,
    templateId: rendered.templateId,
    templateName: rendered.templateName,
    templateVersion: rendered.templateVersion,
    templateLevel: rendered.templateLevel,
    paperSize: rendered.paperSize,
  })
})

// ===== POST /documents/render =====
/**
 * 渲染文档(正式输出)
 * - 权限:documents.view(+ 医疗业务门)
 * - 落 document_history(action=render)+ 审计
 */
documentsRoutes.post('/render', async (c) => {
  const input = await parseJsonBody(c, renderBodySchema)
  const rendered = await authorizeAndRender(c, input)

  const service = createServiceClient()
  const user = c.get('user')
  const scope = await getAdapter(input.documentType).resolveScope(service, input.entityId)

  await service.from('document_history').insert({
    tenant_id: scope.tenantId,
    store_id: scope.storeId,
    document_type: input.documentType,
    entity_type: input.documentType,
    entity_id: input.entityId,
    template_id: rendered.templateId,
    template_version: rendered.templateVersion,
    paper_size: rendered.paperSize,
    render_hash: hashRenderedHtml(rendered.html),
    action: 'render',
    operator_id: user.id,
  })

  await writeAudit(c, {
    action: 'documents.render',
    entityType: getAuditEntityType(input.documentType),
    entityId: input.entityId,
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
    metadata: { documentType: input.documentType, templateId: rendered.templateId },
  })

  return ok(c, {
    html: rendered.html,
    documentType: rendered.documentType,
    entityId: rendered.entityId,
    templateId: rendered.templateId,
    templateName: rendered.templateName,
    templateVersion: rendered.templateVersion,
    templateLevel: rendered.templateLevel,
    paperSize: rendered.paperSize,
  })
})

// ===== POST /documents/print =====
/**
 * 打印文档
 * - 权限:documents.print(+ 医疗业务门;内部仍要求 documents.view)
 * - 落 document_history(action=print)+ 审计(医疗文档打印必须留痕)
 */
documentsRoutes.post('/print', async (c) => {
  const input = await parseJsonBody(c, renderBodySchema)
  const adapter = getAdapter(input.documentType)
  const service = createServiceClient()

  const scope = await adapter.resolveScope(service, input.entityId)

  const gateCode = adapter.businessPermission ?? 'documents.print'
  const access = await requireScopedPermission(c, {
    code: gateCode,
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
    dataScope: true,
  })
  if (!access.permissions.includes('documents.view')) {
    throw err.forbidden('缺少权限: documents.view')
  }
  if (!access.permissions.includes('documents.print')) {
    throw err.forbidden('缺少权限: documents.print')
  }

  const rendered = await renderDocument(service, {
    documentType: input.documentType,
    entityId: input.entityId,
    templateId: input.templateId,
    paperSize: input.paperSize,
  })

  const user = c.get('user')
  await service.from('document_history').insert({
    tenant_id: scope.tenantId,
    store_id: scope.storeId,
    document_type: input.documentType,
    entity_type: input.documentType,
    entity_id: input.entityId,
    template_id: rendered.templateId,
    template_version: rendered.templateVersion,
    paper_size: rendered.paperSize,
    render_hash: hashRenderedHtml(rendered.html),
    action: 'print',
    operator_id: user.id,
  })

  await writeAudit(c, {
    action: 'documents.print',
    entityType: getAuditEntityType(input.documentType),
    entityId: input.entityId,
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
    metadata: { documentType: input.documentType, templateId: rendered.templateId },
  })

  return ok(c, {
    html: rendered.html,
    documentType: rendered.documentType,
    entityId: rendered.entityId,
    templateId: rendered.templateId,
    templateName: rendered.templateName,
    templateVersion: rendered.templateVersion,
    templateLevel: rendered.templateLevel,
    paperSize: rendered.paperSize,
  })
})

// ===== GET /documents/history =====
/**
 * 渲染/打印历史
 * - 权限:documents.view(dataScope)
 */
documentsRoutes.get('/history', async (c) => {
  const tenantId = resolveRequestedTenant(c, c.req.query('tenantId')) ?? ''
  const storeId = c.req.query('storeId') || undefined
  const documentType = c.req.query('documentType') || undefined
  const from = Number(c.req.query('from') ?? 0)
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)

  const scope = await requireScopedPermission(c, {
    code: 'documents.view',
    tenantId,
    dataScope: true,
  })
  if (storeId && !scope.isPlatformAdmin && !scope.allowedStoreIds.includes(storeId)) {
    throw err.forbidden('无权访问该门店的文档历史')
  }

  const service = createServiceClient()
  let query = service
    .from('document_history')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
  if (storeId) {
    query = query.eq('store_id', storeId)
  }
  if (documentType) {
    query = query.eq('document_type', documentType)
  }
  query = query.range(from, from + limit - 1)

  const { data, error, count } = await query.order('created_at', { ascending: false })
  if (error) {
    throw err.internal(`查询文档历史失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0 })
})

export default documentsRoutes
