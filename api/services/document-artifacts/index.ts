import { PutObjectCommand } from '@aws-sdk/client-s3'
import process from 'node:process'
import { err } from '../../lib/errors.js'
import { createR2Client, generatePrivateObjectKey } from '../../lib/r2.js'
import { getPdfProvider } from '../../providers/pdf/index.js'
import type { Service } from '../insurance/types.js'

/**
 * Stage-04 Agent-06 — 通用文档归档服务(api/services/document-artifacts)
 *
 * 职责:
 *   - 按 documentType 读取业务实体关键字段(列白名单,不复制无边界全文);
 *   - 渲染自包含 HTML → PdfProvider → R2 私有对象 → files 记录;
 *   - 落 document_archives(不可变归档,hash 一次性写入);
 *   - 归档查询 / 预签名下载 / 签名请求创建。
 *
 * 安全约束:
 *   - 每个 documentType 必须映射"业务二次权限门"(如 encounter.view),禁止只凭
 *     documents.pdf.generate 读取全部病历(文档 §13);
 *   - HTML 渲染无外部资源(SSRF 防护);
 *   - 写操作一律 service role(Hono Command),authenticated 只读。
 */

/** 展示列白名单:列名 → 中文标签 */
type ColumnMap = Record<string, string>

/** 文档类型 → 源表/业务权限门/展示列 */
const DOCUMENT_SOURCES: Record<string, {
  table: string
  permission: string
  title: string
  columns: ColumnMap
  /** 附加的扁平字段(如 invoice 的 invoice_no 别名) */
  labels?: Record<string, string>
}> = {
  encounter: {
    table: 'encounters',
    permission: 'encounter.view',
    title: '就诊病历',
    columns: {
      status: '状态',
      started_at: '开始时间',
      ended_at: '结束时间',
      chief_complaint: '主诉',
      diagnosis_text: '诊断',
    },
  },
  medical_record_summary: {
    table: 'encounters',
    permission: 'encounter.view',
    title: '病历摘要',
    columns: {
      status: '状态',
      started_at: '开始时间',
      diagnosis_text: '诊断',
    },
  },
  prescription: {
    table: 'prescriptions',
    permission: 'prescription.view',
    title: '处方',
    columns: {
      status: '状态',
      created_at: '开具时间',
      remark: '备注',
    },
  },
  invoice: {
    table: 'invoices',
    permission: 'invoice.view',
    title: '收费发票',
    columns: {
      invoice_no: '发票号',
      status: '状态',
      subtotal: '小计',
      discount_amount: '折扣',
      tax_amount: '税额',
      total: '合计',
      paid_amount: '已付',
      created_at: '开票时间',
    },
  },
  lab_report: {
    table: 'lab_orders',
    permission: 'lab.view',
    title: '检验报告',
    columns: {
      order_no: '申请单号',
      status: '状态',
      requested_at: '申请时间',
      completed_at: '完成时间',
      remark: '备注',
    },
  },
  imaging_report: {
    table: 'imaging_reports',
    permission: 'imaging.view',
    title: '影像报告',
    columns: {
      version: '版本',
      status: '状态',
      findings: '所见',
      impression: '印象',
      published_at: '发布时间',
    },
  },
  discharge_summary: {
    table: 'admissions',
    permission: 'inpatient.view',
    title: '出院记录',
    columns: {
      status: '状态',
      admitted_at: '入院时间',
      discharged_at: '出院时间',
      discharge_reason: '出院原因',
      total_charge: '总费用',
    },
  },
  vaccination_certificate: {
    table: 'vaccine_certificates',
    permission: 'vaccine.view',
    title: '疫苗证明',
    columns: {
      certificate_no: '证书号',
      status: '状态',
      issued_date: '签发日期',
    },
  },
}

export interface GeneratePdfArchiveParams {
  documentType: string
  entityId: string
  userId: string
  /** 由路由层解析出的实体归属(租户/门店),用于作用域授权 */
  tenantId: string
  storeId?: string | null
}

export interface PdfArchiveResult {
  archive: Record<string, unknown>
  file: { id: string, sha256: string, sizeBytes: number, provider: string }
}

/** HTML 转义(阻断业务数据注入) */
function esc(v: unknown): string {
  if (v === null || v === undefined) {
    return ''
  }
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 值展示:对象/数组序列化为 JSON(数组已由列白名单限制,不会出现无边界全文) */
function fmt(v: unknown): string {
  if (v === null || v === undefined) {
    return '-'
  }
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    }
    catch {
      return String(v)
    }
  }
  return String(v)
}

/** 渲染通用归档 HTML(自包含,无外部资源) */
export function renderGenericDocumentHtml(params: {
  title: string
  docNo: string
  columns: ColumnMap
  row: Record<string, unknown>
  tenantName?: string
  storeName?: string
  generatedAt: string
}): string {
  const kvRows = Object.entries(params.columns)
    .filter(([col]) => params.row[col] !== null && params.row[col] !== undefined)
    .map(([col, label]) => `
      <tr><th>${esc(label)}</th><td>${esc(fmt(params.row[col]))}</td></tr>`)
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${esc(params.title)}-${esc(params.docNo)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; color: #1f2937; font-size: 13px; line-height: 1.6; padding: 32px; }
  h1 { font-size: 20px; text-align: center; margin-bottom: 4px; }
  .sub { text-align: center; color: #6b7280; font-size: 12px; margin-bottom: 20px; }
  .block { border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; margin-bottom: 16px; }
  .block h2 { font-size: 14px; margin-bottom: 10px; border-left: 3px solid #2563eb; padding-left: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; font-size: 12px; vertical-align: top; }
  th { background: #f9fafb; width: 140px; }
  .footer { text-align: center; color: #9ca3af; font-size: 11px; margin-top: 24px; }
</style>
</head>
<body>
  <h1>${esc(params.title)}</h1>
  <div class="sub">编号: ${esc(params.docNo)} · 生成时间: ${esc(params.generatedAt)}</div>
  <div class="block">
    <h2>${esc(params.title)}内容</h2>
    <table>${kvRows}</table>
  </div>
  <div class="footer">本材料由门店系统自动生成,仅供存档与业务使用。</div>
</body>
</html>`
}

/**
 * 上传 PDF 到 R2 私有桶(服务端直传)
 */
async function uploadToR2(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (!process.env.R2_BUCKET_NAME) {
    throw new Error('R2 configuration is missing')
  }
  const client = createR2Client()
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey.startsWith('/') ? objectKey.slice(1) : objectKey,
    ContentType: contentType,
    Body: bytes,
  }))
}

/**
 * 生成通用业务文档 PDF 归档
 * @param service service role 客户端
 * @param params 文档类型 + 实体 id + 归属(租户/门店已由路由层校验)
 * @returns 归档行 + 文件信息
 */
export async function generatePdfArchive(
  service: Service,
  params: GeneratePdfArchiveParams,
): Promise<PdfArchiveResult> {
  const source = DOCUMENT_SOURCES[params.documentType]
  if (!source) {
    throw err.badRequest(`不支持的文档类型: ${params.documentType}`)
  }

  // 1) 读取业务实体(列白名单)
  const { data: row, error } = await service
    .from(source.table)
    .select('*')
    .eq('id', params.entityId)
    .maybeSingle()
  if (error || !row) {
    throw err.notFound(`${source.title}不存在`)
  }

  // 2) 渲染自包含 HTML
  const docNo = String(row.invoice_no ?? row.order_no ?? row.certificate_no ?? row.id ?? params.entityId)
  const html = renderGenericDocumentHtml({
    title: source.title,
    docNo,
    columns: source.columns,
    row,
    generatedAt: new Date().toISOString(),
  })

  // 3) PdfProvider 渲染 PDF
  const pdf = await getPdfProvider().renderHtml(html, { title: `${source.title}-${docNo}`, paperSize: 'A4' })

  // 4) 上传 R2 私有对象
  const objectKey = generatePrivateObjectKey({
    tenantId: params.tenantId,
    storeId: params.storeId ?? undefined,
    domain: 'medical-record',
    fileName: `${source.title}-${docNo}.pdf`,
  })
  await uploadToR2(objectKey, pdf.bytes, 'application/pdf')

  // 5) files 记录(pending → uploaded)
  const { data: fileRecord, error: intentError } = await service.rpc('create_upload_intent', {
    p_tenant_id: params.tenantId,
    p_store_id: params.storeId ?? null,
    p_category: 'medical-record',
    p_original_name: `${source.title}-${docNo}.pdf`,
    p_mime_type: 'application/pdf',
    p_size_bytes: pdf.bytes.byteLength,
    p_uploaded_by: params.userId,
    p_object_key: objectKey,
  })
  if (intentError) {
    throw err.internal(`创建文件记录失败: ${intentError.message}`)
  }
  const { error: completeError } = await service.rpc('complete_upload', {
    p_file_id: fileRecord.id,
    p_checksum: pdf.sha256,
    p_size_bytes: pdf.bytes.byteLength,
    p_operator_id: params.userId,
  })
  if (completeError) {
    throw err.internal(`完成文件上传失败: ${completeError.message}`)
  }

  // 6) 落不可变归档
  const { data: archive, error: archiveError } = await service
    .from('document_archives')
    .insert({
      tenant_id: params.tenantId,
      store_id: params.storeId ?? null,
      document_type: params.documentType,
      entity_type: params.documentType,
      entity_id: params.entityId,
      file_id: fileRecord.id,
      sha256: pdf.sha256,
      mime_type: 'application/pdf',
      size_bytes: pdf.bytes.byteLength,
      status: 'active',
      customer_visible: false,
      published: false,
      created_by: params.userId,
    })
    .select('*')
    .single()
  if (archiveError) {
    throw err.internal(`创建归档失败: ${archiveError.message}`)
  }

  return {
    archive: archive as Record<string, unknown>,
    file: { id: fileRecord.id, sha256: pdf.sha256, sizeBytes: pdf.bytes.byteLength, provider: pdf.provider },
  }
}

export interface ListArchivesParams {
  tenantId: string
  storeId?: string | null
  documentType?: string
  entityId?: string
  status?: string
  page?: number
  pageSize?: number
}

/**
 * 归档列表(按租户/门店收敛,分页)
 */
export async function listArchives(
  service: Service,
  params: ListArchivesParams,
): Promise<{ list: Array<Record<string, unknown>>, total: number }> {
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20))

  let query = service
    .from('document_archives')
    .select('*, files(original_name, mime_type, size_bytes)', { count: 'exact' })
    .eq('tenant_id', params.tenantId)

  if (params.storeId) {
    query = query.eq('store_id', params.storeId)
  }
  if (params.documentType) {
    query = query.eq('document_type', params.documentType)
  }
  if (params.entityId) {
    query = query.eq('entity_id', params.entityId)
  }
  if (params.status) {
    query = query.eq('status', params.status)
  }

  const from = (page - 1) * pageSize
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1)

  if (error) {
    throw err.internal(`查询归档失败: ${error.message}`)
  }
  return { list: (data ?? []) as Array<Record<string, unknown>>, total: count ?? 0 }
}

/**
 * 归档详情
 */
export async function getArchive(service: Service, archiveId: string): Promise<Record<string, unknown>> {
  const { data, error } = await service
    .from('document_archives')
    .select('*, files(object_key, original_name, mime_type, size_bytes, checksum)')
    .eq('id', archiveId)
    .maybeSingle()
  if (error || !data) {
    throw err.notFound('归档不存在')
  }
  return data as Record<string, unknown>
}

export interface CreateSignatureParams {
  tenantId: string
  storeId?: string | null
  archiveId: string
  signerType?: string
  signerName?: string
  signerEmail?: string
  userId: string
  idempotencyKey?: string
}

/**
 * 创建签名请求(内部 Provider 首版,仅表达内部流程)
 * @param service service role 客户端
 * @param params 签名请求参数(租户/门店已由路由层校验)
 * @returns 签名请求记录
 */
export async function createSignatureRequest(
  service: Service,
  params: CreateSignatureParams,
): Promise<Record<string, unknown>> {
  // 1) RPC 幂等创建(tenant_id + idempotency_key)
  const { data: request, error } = await service.rpc('create_signature_request', {
    p_tenant_id: params.tenantId,
    p_store_id: params.storeId ?? null,
    p_archive_id: params.archiveId,
    p_signer_type: params.signerType ?? 'customer',
    p_signer_name: params.signerName ?? null,
    p_signer_email: params.signerEmail ?? null,
    p_provider: 'internal',
    p_provider_request_id: null,
    p_created_by: params.userId,
    p_idempotency_key: params.idempotencyKey ?? null,
  })
  if (error) {
    if (error.message.includes('ARCHIVE_NOT_FOUND')) {
      throw err.notFound('归档不存在')
    }
    if (error.message.includes('ARCHIVE_TENANT_MISMATCH')) {
      throw err.forbidden('归档不属于该租户')
    }
    if (error.message.includes('ARCHIVE_NOT_ACTIVE')) {
      throw err.conflict('归档非 active 状态,不可发起签名')
    }
    throw err.internal(`创建签名请求失败: ${error.message}`)
  }
  return request as Record<string, unknown>
}

export const DOCUMENT_TYPES = Object.keys(DOCUMENT_SOURCES)

/** 文档类型 → 源表映射(供路由层做实体归属解析与二次权限门) */
export const DOCUMENT_SOURCE_TABLES: Record<string, { table: string, permission: string, title: string }> =
  Object.fromEntries(
    Object.entries(DOCUMENT_SOURCES).map(([type, s]) => [type, {
      table: s.table,
      permission: s.permission,
      title: s.title,
    }]),
  )
