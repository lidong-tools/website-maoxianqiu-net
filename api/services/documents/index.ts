import type { DocumentData, DocumentTemplateRow, DocumentType, PaperSize, Service, TemplateLevel } from './types.js'
import { err } from '../../lib/errors.js'
import { getAdapter } from './adapters/index.js'
import { renderTemplate } from './renderer.js'
import {
  DOCUMENT_SECTION_KEY,

} from './types.js'

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
 * @param service      service-role 客户端
 * @param opts.tenantId  目标租户(必须非空)
 * @param opts.storeId   目标门店(可空)
 * @param opts.templateId 指定模板时,额外校验作用域(租户/门店/文档类型/启用态)
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
    // 作用域校验:指定模板必须与目标实体同文档类型、同租户/门店作用域,且处于启用态
    if (row.document_type !== documentType) {
      throw err.badRequest('指定模板与当前文档类型不匹配')
    }
    if (row.tenant_id !== null && row.tenant_id !== tenantId) {
      throw err.forbidden('指定模板不属于当前租户')
    }
    if (row.store_id !== null && row.store_id !== storeId) {
      throw err.forbidden('指定模板不属于当前门店')
    }
    if (!row.is_active) {
      throw err.badRequest('指定模板已停用,请选择启用中的模板')
    }
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
 * 读取生效的打印显示项配置(R-5 3.4.2.3-03)
 * print_settings 为门店级配置,按 (tenant_id, store_id, paper_size) 唯一键查询;
 * 未传门店或未命中时返回空配置(等价全部开关默认开启)。
 * @param service service-role 客户端
 * @param opts.tenantId 目标租户
 * @param opts.storeId 目标门店(可空)
 * @param opts.paperSize 纸型(模板侧为大写,存储侧为小写,查询时归一)
 */
async function loadPrintConfig(
  service: Service,
  opts: { tenantId: string, storeId?: string | null, paperSize: PaperSize },
): Promise<Record<string, unknown>> {
  const { tenantId, storeId, paperSize } = opts
  if (!storeId) {
    return {}
  }
  const { data, error } = await service
    .from('print_settings')
    .select('config')
    .eq('tenant_id', tenantId)
    .eq('store_id', storeId)
    .eq('paper_size', paperSize.toLowerCase())
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  if (error || !data) {
    return {}
  }
  const cfg = data.config
  return cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {}
}

/**
 * 按打印显示项配置裁剪数据树(R-5)
 * 关闭的开关将对应字段置空/置 null,渲染器对空值不输出({{path}} 渲染为空);
 * 抬头/页脚/声明文本注入 printConfig 供模板使用(如 {{printConfig.header}})。
 * @param data 已组装的数据树(原地修改)
 * @param config print_settings.config(缺省视为开关全部开启)
 */
function applyPrintConfig(data: DocumentData, config: Record<string, unknown>): void {
  const isOn = (key: string): boolean => config[key] !== false
  if (!isOn('showCustomerPhone') && data.customer) {
    data.customer.phone = undefined
  }
  if (!isOn('showPetInfo')) {
    data.pet = null
  }
  if (!isOn('showOperator')) {
    data.operator = null
  }
  if (!isOn('showDoctor')) {
    data.doctor = null
  }
  if (!isOn('showSubtotal')) {
    const inv = data.invoice as Record<string, unknown> | undefined
    if (inv) {
      inv.subtotal = undefined
    }
  }
  data.printConfig = {
    header: typeof config.header === 'string' ? config.header : '',
    footer: typeof config.footer === 'string' ? config.footer : '',
    statement: typeof config.statement === 'string' ? config.statement : '',
  }
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

  // 4.5) R-5(3.4.2.3-03):读取打印显示项配置,按开关裁剪字段显隐 + 注入抬头/页脚/声明
  const printConfig = await loadPrintConfig(service, {
    tenantId: scope.tenantId,
    storeId: scope.storeId,
    paperSize,
  })
  applyPrintConfig(data, printConfig)

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
