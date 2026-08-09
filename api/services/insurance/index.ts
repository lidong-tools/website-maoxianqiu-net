import { PutObjectCommand } from '@aws-sdk/client-s3'
import process from 'node:process'
import { err } from '../../lib/errors.js'
import { createR2Client, generatePrivateObjectKey } from '../../lib/r2.js'
import { getPdfProvider } from '../../providers/pdf/index.js'
import { aggregatePackItems } from './aggregate.js'
import { renderInsuranceClaimHtml } from './render.js'
import { buildInsuranceSnapshot } from './snapshot.js'
import type {
  CreateInsurancePackInput,
  InsurancePack,
  InsurancePackItem,
  InsurancePackWithItems,
  InsuranceSourceType,
  Service,
} from './types.js'

/**
 * Stage-04 Agent-06 — 保险理赔包服务编排(api/services/insurance)
 *
 * 流程:
 *   createPack    聚合合格材料(白名单) → RPC create_insurance_claim_pack(幂等)
 *   updatePackItems 仅 draft 可编辑清单 → RPC update_insurance_claim_pack_items
 *   generatePack  快照 → 安全 HTML → PdfProvider → R2 私有对象 → files 记录
 *                 → RPC create_insurance_claim_export(幂等 + 乐观并发)
 *   listExports   导出历史
 *   transitionPack 状态机(RPC transition_insurance_claim_pack)
 *
 * 安全约束:
 *   - 写操作一律 service role(Hono Command + RPC),authenticated 只读;
 *   - PDF bytes 上传私有桶,归档 document_archives 不可变(hash 一次性写入);
 *   - 幂等:create 用 (tenant_id, idempotency_key),export 用 (pack_id, idempotency_key)。
 */

/** 材料来源类型数组(复用 types.ts 定义,供路由 zod 使用) */
export { INSURANCE_SOURCE_TYPES } from './types.js'

export interface GeneratePackParams {
  packId: string
  tenantId: string
  storeId?: string | null
  userId: string
  idempotencyKey?: string
}

export interface GeneratePackResult {
  export: Record<string, unknown>
  archive: Record<string, unknown>
  pack: Record<string, unknown>
  pdf: { fileId: string, sha256: string, sizeBytes: number, provider: string }
}

/**
 * 创建理赔包(draft):先按白名单聚合合格材料,再落库
 * @param service service role 客户端
 * @param input 理赔包输入(已通过作用域授权)
 * @returns 理赔包头 + 材料清单
 */
export async function createPack(
  service: Service,
  input: CreateInsurancePackInput & { userId: string },
): Promise<InsurancePackWithItems> {
  // 1) 聚合合格材料(未发布 Lab / 未发布 Imaging / Draft 处方被排除)
  const items = await aggregatePackItems(service, input)

  // 2) RPC 落库(幂等:tenant_id + idempotency_key)
  const { data, error } = await service.rpc('create_insurance_claim_pack', {
    p_tenant_id: input.tenantId,
    p_store_id: input.storeId ?? null,
    p_customer_id: input.customerId,
    p_pet_id: input.petId,
    p_encounter_id: input.encounterId ?? null,
    p_admission_id: input.admissionId ?? null,
    p_created_by: input.userId,
    p_idempotency_key: input.idempotencyKey ?? null,
    p_items: items,
  })

  if (error) {
    if (error.message.includes('INSURANCE_MISSING_PARTY')) {
      throw err.badRequest('缺少客户或宠物信息')
    }
    throw err.internal(`创建理赔包失败: ${error.message}`)
  }

  return {
    pack: (data as { pack: InsurancePack }).pack,
    items: (data as { items: InsurancePackItem[] }).items,
  }
}

/**
 * 更新理赔包材料清单(仅 draft)
 * @param service service role 客户端
 * @param packId 理赔包 id
 * @param items 新清单(服务端按白名单已校验)
 * @param userId 操作人
 * @returns 更新后的理赔包 + 清单
 */
export async function updatePackItems(
  service: Service,
  packId: string,
  items: InsurancePackItem[],
  userId: string,
): Promise<InsurancePackWithItems> {
  const { data, error } = await service.rpc('update_insurance_claim_pack_items', {
    p_pack_id: packId,
    p_items: items,
    p_updated_by: userId,
  })

  if (error) {
    if (error.message.includes('INSURANCE_PACK_NOT_FOUND')) {
      throw err.notFound('理赔包不存在')
    }
    if (error.message.includes('INSURANCE_PACK_NOT_EDITABLE')) {
      throw err.conflict('仅草稿状态的理赔包可编辑清单')
    }
    throw err.internal(`更新材料清单失败: ${error.message}`)
  }

  return {
    pack: (data as { pack: InsurancePack }).pack,
    items: (data as { items: InsurancePackItem[] }).items,
  }
}

/**
 * 理赔包详情(含材料清单)
 */
export async function getPack(service: Service, packId: string): Promise<InsurancePackWithItems> {
  const { data: pack, error } = await service
    .from('insurance_claim_packs')
    .select('*')
    .eq('id', packId)
    .maybeSingle()
  if (error || !pack) {
    throw err.notFound('理赔包不存在')
  }

  const { data: items, error: itemError } = await service
    .from('insurance_claim_pack_items')
    .select('*')
    .eq('pack_id', packId)
    .order('display_order', { ascending: true })
  if (itemError) {
    throw err.internal(`查询材料清单失败: ${itemError.message}`)
  }

  return {
    pack: pack as InsurancePack,
    items: (items ?? []) as InsurancePackItem[],
  }
}

/**
 * 将 Uint8Array 上传到 R2 私有桶(服务端直传,不经浏览器)
 * @param objectKey R2 对象 key
 * @param bytes PDF 二进制
 * @param contentType MIME 类型
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
 * 生成理赔包 PDF(核心命令,幂等)
 *
 * 步骤:
 *   1) 幂等检查:同 pack + idempotency_key 已生成 → 直接返回已有结果;
 *   2) 状态校验:非终态(draft/generated)才可生成;
 *   3) 快照:读取必要字段 + data_hash(不存无边界医疗全文);
 *   4) 渲染:renderInsuranceClaimHtml → 自包含 HTML;
 *   5) PdfProvider:renderHtml → bytes + sha256;
 *   6) R2:私有对象直传;
 *   7) files:create_upload_intent → complete_upload(复用既有文件生命周期);
 *   8) RPC create_insurance_claim_export:归档行 + 导出行 + 版本推进(乐观并发)。
 */
export async function generatePack(
  service: Service,
  params: GeneratePackParams,
): Promise<GeneratePackResult> {
  const { packId, tenantId, userId, idempotencyKey } = params

  // 1) 幂等:同 pack + key 已生成过 → 直接返回
  if (idempotencyKey) {
    const { data: existing } = await service
      .from('insurance_claim_exports')
      .select('*, document_archives(*)')
      .eq('pack_id', packId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle()
    if (existing) {
      const archive = (existing as { document_archives: Record<string, unknown> | null }).document_archives
      return {
        export: existing as unknown as Record<string, unknown>,
        archive: (archive ?? {}) as Record<string, unknown>,
        pack: (await getPack(service, packId)).pack as unknown as Record<string, unknown>,
        pdf: {
          fileId: String(archive?.file_id ?? ''),
          sha256: String(archive?.sha256 ?? ''),
          sizeBytes: Number(archive?.size_bytes ?? 0),
          provider: String(archive?.provider ?? 'mock'),
        },
      }
    }
  }

  // 2) 读取理赔包 + 状态校验
  const current = await getPack(service, packId)
  if (current.pack.status === 'archived' || current.pack.status === 'cancelled') {
    throw err.conflict('终态理赔包不可再生成')
  }

  // 3) 快照(证明"当时提交内容")
  const snapshot = await buildInsuranceSnapshot(service, {
    packId: current.pack.id,
    packNo: current.pack.pack_no,
    packVersion: current.pack.version,
    tenantId: current.pack.tenant_id,
    storeId: current.pack.store_id,
    customerId: current.pack.customer_id,
    petId: current.pack.pet_id,
    encounterId: current.pack.encounter_id,
    items: current.items,
  })
  const dataHash = createHashOfJson(snapshot)

  // 4) 渲染自包含 HTML(无外部资源,SSRF 防护)
  const html = renderInsuranceClaimHtml(snapshot)

  // 5) PdfProvider 渲染 PDF
  const pdf = await getPdfProvider().renderHtml(html, {
    title: `保险理赔材料-${current.pack.pack_no}`,
    paperSize: 'A4',
  })

  // 6) 上传 R2 私有对象
  const objectKey = generatePrivateObjectKey({
    tenantId: current.pack.tenant_id,
    storeId: current.pack.store_id ?? undefined,
    domain: 'export',
    fileName: `${current.pack.pack_no}-v${current.pack.version}.pdf`,
  })
  await uploadToR2(objectKey, pdf.bytes, 'application/pdf')

  // 7) 创建 files 记录(pending → uploaded,复用既有生命周期)
  const { data: fileRecord, error: intentError } = await service.rpc('create_upload_intent', {
    p_tenant_id: current.pack.tenant_id,
    p_store_id: current.pack.store_id ?? null,
    p_category: 'export',
    p_original_name: `${current.pack.pack_no}-v${current.pack.version}.pdf`,
    p_mime_type: 'application/pdf',
    p_size_bytes: pdf.bytes.byteLength,
    p_uploaded_by: userId,
    p_object_key: objectKey,
  })
  if (intentError) {
    throw err.internal(`创建文件记录失败: ${intentError.message}`)
  }
  const { error: completeError } = await service.rpc('complete_upload', {
    p_file_id: fileRecord.id,
    p_checksum: pdf.sha256,
    p_size_bytes: pdf.bytes.byteLength,
    p_operator_id: userId,
  })
  if (completeError) {
    throw err.internal(`完成文件上传失败: ${completeError.message}`)
  }

  // 8) RPC:归档行 + 导出行 + 版本推进(乐观并发要求 p_pack_version = version + 1)
  const { data, error } = await service.rpc('create_insurance_claim_export', {
    p_pack_id: packId,
    p_pack_version: current.pack.version + 1,
    p_data_snapshot: snapshot,
    p_data_hash: dataHash,
    p_file_id: fileRecord.id,
    p_sha256: pdf.sha256,
    p_mime_type: 'application/pdf',
    p_size_bytes: pdf.bytes.byteLength,
    p_generated_by: userId,
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (error) {
    if (error.message.includes('INSURANCE_PACK_NOT_FOUND')) {
      throw err.notFound('理赔包不存在')
    }
    if (error.message.includes('INSURANCE_PACK_TERMINAL')) {
      throw err.conflict('终态理赔包不可生成')
    }
    if (error.message.includes('INSURANCE_VERSION_CONFLICT')) {
      throw err.conflict('理赔包版本已变更,请刷新后重试')
    }
    throw err.internal(`生成导出失败: ${error.message}`)
  }

  const result = data as { export: Record<string, unknown>, archive: Record<string, unknown>, pack: Record<string, unknown> }
  return {
    export: result.export,
    archive: result.archive,
    pack: result.pack,
    pdf: { fileId: fileRecord.id, sha256: pdf.sha256, sizeBytes: pdf.bytes.byteLength, provider: pdf.provider },
  }
}

/**
 * 理赔包导出历史(含归档引用)
 */
export async function listExports(
  service: Service,
  packId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from('insurance_claim_exports')
    .select('*, document_archives(file_id, sha256, mime_type, size_bytes, status, created_at)')
    .eq('pack_id', packId)
    .order('generated_at', { ascending: false })
  if (error) {
    throw err.internal(`查询导出历史失败: ${error.message}`)
  }
  return (data ?? []) as Array<Record<string, unknown>>
}

/**
 * 理赔包状态转换(draft/generated → archived/cancelled;generated → draft)
 * @param service service role 客户端
 * @param packId 理赔包 id
 * @param status 目标状态
 * @param userId 操作人
 */
export async function transitionPack(
  service: Service,
  packId: string,
  status: string,
  userId: string,
): Promise<InsurancePack> {
  const { data, error } = await service.rpc('transition_insurance_claim_pack', {
    p_pack_id: packId,
    p_status: status,
    p_actor_id: userId,
  })
  if (error) {
    if (error.message.includes('INSURANCE_PACK_NOT_FOUND')) {
      throw err.notFound('理赔包不存在')
    }
    if (error.message.includes('INSURANCE_PACK_TERMINAL')) {
      throw err.conflict('终态理赔包不可再转换')
    }
    if (error.message.includes('INSURANCE_INVALID_TRANSITION') || error.message.includes('INSURANCE_INVALID_STATUS')) {
      throw err.unprocessable(`不允许的状态转换: ${status}`)
    }
    throw err.internal(`状态转换失败: ${error.message}`)
  }
  return data as InsurancePack
}

/**
 * 计算 JSON 快照的 sha256(hex)
 * @param snapshot 快照对象
 * @returns 64 位 hex 摘要
 */
function createHashOfJson(snapshot: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

export type { InsurancePack, InsurancePackItem, InsurancePackWithItems, InsuranceSourceType } from './types.js'
