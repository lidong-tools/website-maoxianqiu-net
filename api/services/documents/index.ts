import { err } from '../../lib/errors'
import { getAdapter } from './adapters'
import { renderTemplate } from './renderer'
import {
  DOCUMENT_SECTION_KEY,
  type DocumentData,
  type DocumentTemplateRow,
  type DocumentType,
  type PaperSize,
  type Service,
  type TemplateLevel,
} from './types'

/**
 * S32-C 业务文档与打印中心 V2 —— 服务编排
 * 渲染管道:业务 DTO → Document Data Adapter → Template Renderer → HTML
 */

export interface ResolvedTemplate {
  template: DocumentTemplateRow
  level: TemplateLevel
}

/**
 * 模板解析(读取优先级:门店覆盖 → 租户默认 → 系统默认)
 * @param tenantId  目标租户(必须非空)
 * @param storeId   目标门店(可空)
 * @param templateId 指定模板时直接返回
 */
export async function resolveTemplate(
  service: Service,
  opts: {
    tenantId: string
    storeId?: string | null
    documentType: DocumentType
    templateId?: string
  },
): Promise<ResolvedTemplate> {
  const { tenantId, storeId, documentType, templateId } = opts

  if (templateId) {
    const { data, error } = await service
      .from('document_templates')
      .select('*')
      .eq('id', templateId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('文档模板不存在')
    }
    const row = data as unknown as DocumentTemplateRow
    const level: TemplateLevel = row.store_id
      ? 'store'
      : row.tenant_id
        ? 'tenant'
        : 'system'
    return { template: row, level }
  }

  // 1) 门店覆盖
  if (storeId) {
    const { data, error } = await service
      .from('document_templates')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('store_id', storeId)
      .eq('document_type', documentType)
      .eq('is_active', true)
      .order('is_default', { ascending: false })
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!error && data) {
      return { template: data as unknown as DocumentTemplateRow, level: 'store' }
    }
  }

  // 2) 租户默认
  const { data, error } = await service
    .from('document_templates')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('store_id', null)
    .eq('document_type', documentType)
    .eq('is_active', true)
    .order('is_default', { ascending: false })
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!error && data) {
    return { template: data as unknown as DocumentTemplateRow, level: 'tenant' }
  }

  // 3) 系统默认
  const { data: sys, error: sysErr } = await service
    .from('document_templates')
    .select('*')
    .is('tenant_id', null)
    .eq('document_type', documentType)
    .eq('is_active', true)
    .order('is_default', { ascending: false })
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (sysErr || !sys) {
    throw err.notFound(`未找到 ${documentType} 的可用文档模板`)
  }
  return { template: sys as unknown as DocumentTemplateRow, level: 'system' }
}

export interface RenderOptions {
  documentType: DocumentType
  entityId: string
  templateId?: string
  paperSize?: PaperSize
}

export interface RenderedDocument {
  html: string
  documentType: DocumentType
  entityId: string
  templateId: string
  templateName: string
  templateVersion: number
  templateLevel: TemplateLevel
  paperSize: PaperSize
  data: Record<string, unknown>
}

/**
 * 渲染一份业务文档
 * 管道:Adapter 聚合真实业务 DTO → 解析模板(优先级) → 安全渲染 → HTML
 */
export async function renderDocument(
  service: Service,
  opts: RenderOptions,
): Promise<RenderedDocument> {
  const adapter = getAdapter(opts.documentType)

  // 1) 先取实体作用域,供路由层做 scoped 授权(此函数本身不鉴权)
  const scope = await adapter.resolveScope(service, opts.entityId)

  // 2) 聚合真实业务数据
  const { base, section } = await adapter.fetch(service, opts.entityId)

  // 3) 解析生效模板(门店 → 租户 → 系统)
  const { template, level } = await resolveTemplate(service, {
    tenantId: scope.tenantId,
    storeId: scope.storeId,
    documentType: opts.documentType,
    templateId: opts.templateId,
  })

  const paperSize: PaperSize = opts.paperSize ?? template.paper_size

  // 4) 组装数据树(渲染器只读此对象)
  const data: DocumentData = {
    ...base,
    entityType: opts.documentType,
    entityId: opts.entityId,
    meta: { printedAt: new Date().toISOString() },
    [DOCUMENT_SECTION_KEY[opts.documentType]]: section,
  }

  // 5) 安全渲染
  const html = renderTemplate(template.template_html, data)

  return {
    html,
    documentType: opts.documentType,
    entityId: opts.entityId,
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    templateLevel: level,
    paperSize,
    data,
  }
}
