import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext, resolveRequestedStore, resolveRequestedTenant } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'
import { resolvePackScope } from '../services/insurance/aggregate.js'
import {
  createPack,
  generatePack,
  getPack,
  listExports,
  transitionPack,
  updatePackItems,
} from '../services/insurance/index.js'
import { INSURANCE_SOURCE_TYPES } from '../services/insurance/types.js'

/**
 * 保险理赔包 Command/查询路由(Stage-04 Agent-06)
 *
 * 端点:
 *   POST /insurance/claim-packs                      创建理赔包(draft,自动聚合合格材料)
 *   POST /insurance/claim-packs/:id/items           更新材料清单(仅 draft)
 *   POST /insurance/claim-packs/:id/generate        生成理赔材料 PDF(幂等 + 乐观并发)
 *   GET  /insurance/claim-packs/:id                 详情(含清单)
 *   GET  /insurance/claim-packs/:id/exports         导出历史
 *   POST /insurance/claim-packs/:id/transition      状态转换
 *
 * 权限:
 *   insurance.view          查看/整理理赔材料
 *   insurance.generate      生成理赔材料导出
 *   documents.pdf.generate  PDF 生成
 *   documents.archive.view  归档查看
 *
 * 安全:
 *   - 全部写操作走 Hono Command + service role RPC;
 *   - 租户/门店作用域统一 requireScopedPermission 收敛;
 *   - generate 带 Idempotency-Key(header)或 body idempotencyKey。
 */
const insuranceRoutes = new Hono<AppEnv>()

insuranceRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const SOURCE_TYPE_ENUM = z.enum(INSURANCE_SOURCE_TYPES)

const createPackSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误').optional(),
  storeId: z.string().uuid().optional(),
  customerId: z.string().uuid('客户 id 格式错误'),
  petId: z.string().uuid('宠物 id 格式错误'),
  encounterId: z.string().uuid().optional(),
  admissionId: z.string().uuid().optional(),
})

/**
 * 创建理赔包(MXQ-A6-01)
 * 服务端按白名单(INSURANCE_INCLUDED_STATUSES)自动聚合合格材料,
 * 未发布 Lab / 未发布 Imaging / Draft 处方不会进入清单。
 */
insuranceRoutes.post('/claim-packs', async (c) => {
  const input = await parseJsonBody(c, createPackSchema)

  const tenantId = resolveRequestedTenant(c, input.tenantId)
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  const storeId = resolveRequestedStore(c, input.storeId)

  // 作用域授权:租户 + 门店收敛(创建/整理理赔材料)
  await requireScopedPermission(c, { code: 'insurance.view', tenantId, storeId })

  const user = c.get('user')
  const service = createServiceClient()

  // 若提供了 encounter/admission,以其真实归属覆盖租户作用域(防止跨租户拼装)
  const scope = await resolvePackScope(service, {
    encounterId: input.encounterId,
    admissionId: input.admissionId,
    tenantId,
  })
  await requireScopedPermission(c, { code: 'insurance.view', tenantId: scope.tenantId, storeId: scope.storeId ?? storeId })

  const result = await createPack(service, {
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? storeId ?? null,
    customerId: input.customerId,
    petId: input.petId,
    encounterId: input.encounterId,
    admissionId: input.admissionId,
    userId: user.id,
    idempotencyKey: getRequestIdempotencyKey(c) || undefined,
  })

  await writeAudit(c, {
    action: 'insurance.packCreated',
    entityType: 'insurance_claim_pack',
    entityId: result.pack.id,
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? storeId,
    metadata: { packNo: result.pack.pack_no, itemCount: result.items.length },
  })

  return ok(c, result)
})

const updateItemsSchema = z.object({
  items: z.array(z.object({
    source_type: SOURCE_TYPE_ENUM,
    source_id: z.string().uuid(),
    display_order: z.number().int().nonnegative().default(0),
    required: z.boolean().default(false),
    included: z.boolean().default(true),
  })).max(200, '材料清单数量超限'),
})

/**
 * 更新理赔包材料清单(仅 draft 可编辑)
 */
insuranceRoutes.post('/claim-packs/:id/items', async (c) => {
  const packId = c.req.param('id')
  const input = await parseJsonBody(c, updateItemsSchema)
  const user = c.get('user')

  const service = createServiceClient()
  const pack = await getPack(service, packId)

  await requireScopedPermission(c, {
    code: 'insurance.view',
    tenantId: pack.pack.tenant_id,
    storeId: pack.pack.store_id ?? undefined,
  })

  const result = await updatePackItems(service, packId, input.items, user.id)

  await writeAudit(c, {
    action: 'insurance.packItemsUpdated',
    entityType: 'insurance_claim_pack',
    entityId: packId,
    tenantId: pack.pack.tenant_id,
    storeId: pack.pack.store_id ?? undefined,
    metadata: { itemCount: result.items.length },
  })

  return ok(c, result)
})

const generateSchema = z.object({
  idempotencyKey: z.string().max(128).optional(),
})

/**
 * 生成理赔材料 PDF(generate,幂等)
 * - 权限:insurance.generate + documents.pdf.generate
 * - 幂等:header Idempotency-Key 或 body idempotencyKey
 * - 乐观并发:服务端要求 pack.version + 1,冲突返回 409
 */
insuranceRoutes.post('/claim-packs/:id/generate', async (c) => {
  const packId = c.req.param('id')
  const input = await parseJsonBody(c, generateSchema)
  const user = c.get('user')

  const service = createServiceClient()
  const pack = await getPack(service, packId)

  // 双重权限:理赔生成 + PDF 归档生成
  await requireScopedPermission(c, {
    code: 'insurance.generate',
    tenantId: pack.pack.tenant_id,
    storeId: pack.pack.store_id ?? undefined,
  })
  await requireScopedPermission(c, {
    code: 'documents.pdf.generate',
    tenantId: pack.pack.tenant_id,
    storeId: pack.pack.store_id ?? undefined,
  })

  const idempotencyKey = getRequestIdempotencyKey(c) || input.idempotencyKey || undefined

  const result = await generatePack(service, {
    packId,
    tenantId: pack.pack.tenant_id,
    storeId: pack.pack.store_id,
    userId: user.id,
    idempotencyKey,
  })

  await writeAudit(c, {
    action: 'insurance.packGenerated',
    entityType: 'insurance_claim_pack',
    entityId: packId,
    tenantId: pack.pack.tenant_id,
    storeId: pack.pack.store_id ?? undefined,
    metadata: {
      exportId: String(result.export.id ?? ''),
      archiveId: String(result.archive.id ?? ''),
      fileId: result.pdf.fileId,
      sha256: result.pdf.sha256,
      version: Number(result.pack.version ?? 0),
      provider: result.pdf.provider,
    },
  })

  return ok(c, result)
})

/**
 * 理赔包详情(含材料清单)
 */
insuranceRoutes.get('/claim-packs/:id', async (c) => {
  const packId = c.req.param('id')
  const service = createServiceClient()

  const result = await getPack(service, packId)
  await requireScopedPermission(c, {
    code: 'insurance.view',
    tenantId: result.pack.tenant_id,
    storeId: result.pack.store_id ?? undefined,
  })

  return ok(c, result)
})

/**
 * 理赔包导出历史(含归档 hash/version)
 */
insuranceRoutes.get('/claim-packs/:id/exports', async (c) => {
  const packId = c.req.param('id')
  const service = createServiceClient()

  const pack = await getPack(service, packId)
  await requireScopedPermission(c, {
    code: 'insurance.view',
    tenantId: pack.pack.tenant_id,
    storeId: pack.pack.store_id ?? undefined,
  })
  await requireScopedPermission(c, {
    code: 'documents.archive.view',
    tenantId: pack.pack.tenant_id,
    storeId: pack.pack.store_id ?? undefined,
  })

  const exports = await listExports(service, packId)
  return ok(c, { pack: pack.pack, exports })
})

const transitionSchema = z.object({
  status: z.enum(['archived', 'cancelled', 'draft'], {
    message: '目标状态仅支持 archived/cancelled/draft',
  }),
})

/**
 * 理赔包状态转换
 *   draft → archived / cancelled
 *   generated → draft(重新起草) / archived / cancelled
 */
insuranceRoutes.post('/claim-packs/:id/transition', async (c) => {
  const packId = c.req.param('id')
  const input = await parseJsonBody(c, transitionSchema)
  const user = c.get('user')

  const service = createServiceClient()
  const pack = await getPack(service, packId)

  await requireScopedPermission(c, {
    code: 'insurance.view',
    tenantId: pack.pack.tenant_id,
    storeId: pack.pack.store_id ?? undefined,
  })

  const updated = await transitionPack(service, packId, input.status, user.id)

  await writeAudit(c, {
    action: 'insurance.packTransitioned',
    entityType: 'insurance_claim_pack',
    entityId: packId,
    tenantId: pack.pack.tenant_id,
    storeId: pack.pack.store_id ?? undefined,
    metadata: { from: pack.pack.status, to: input.status },
  })

  return ok(c, updated)
})

export default insuranceRoutes
