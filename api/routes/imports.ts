import type { AppEnv } from '../lib/types.js'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { getRequestIdempotencyKey } from '../lib/idempotency.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext, resolveRequestedTenant } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createPresignedDownloadUrl } from '../lib/r2.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'
import { parseSpreadsheet } from '../services/imports/codec.js'
import { buildTemplateCsv, buildTemplateXlsx } from '../services/imports/template.js'
import { buildDefaultMapping, parseImportRows } from '../services/imports/parse.js'
import {
  DEFAULT_DUPLICATE_STRATEGY,
  getTypeMeta,
  IMPORT_JOB_TYPES,
} from '../services/imports/fields.js'
import type { DuplicateStrategy, ImportJobStatus, ImportJobType } from '../services/imports/fields.js'
import { applyMapped, validateRow } from '../services/imports/validate.js'
import type { RowError, Scope } from '../services/imports/validate.js'
import { loadLookupContext } from '../services/imports/lookup.js'
import { executeRow } from '../services/imports/execute.js'
import {
  MAX_ERRORS_STORED,
  MAX_IMPORT_ROWS,
  MAX_LIST_LIMIT,
  MAX_PREVIEW_ROWS,
} from '../services/imports/constants.js'

/**
 * 导入中心 V2(S32-A)
 *
 * 路由清单:
 *   - GET  /imports/templates/:type     下载模板(xlsx/csv)
 *   - GET  /imports                     导入任务列表
 *   - POST /imports/upload              上传并解析,建任务
 *   - POST /imports/:id/mapping         保存字段映射
 *   - POST /imports/:id/validate        校验数据(写错误明细)
 *   - POST /imports/:id/start           执行导入(写业务数据/生成命令)
 *   - GET  /imports/:id                 任务详情
 *   - GET  /imports/:id/errors          错误明细
 *   - POST /imports/:id/cancel          取消
 *
 * 权限:
 *   imports.view(读) / imports.create(上传/映射) / imports.execute(校验/执行) / imports.cancel(取消)
 *
 * 边界:库存期初只生成命令队列;员工只生成待邀请队列(见 S32-A-HANDOFF)。
 */
const importsRoutes = new Hono<AppEnv>()

importsRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const TYPE_ENUM = z.enum(IMPORT_JOB_TYPES as [ImportJobType, ...ImportJobType[]])
const STRATEGY_ENUM = z.enum(['skip', 'update', 'create_duplicate'])

interface ImportJobRow {
  id: string
  tenant_id: string
  store_id: string | null
  type: ImportJobType
  status: ImportJobStatus
  source_file_id: string | null
  mapping: Record<string, string> | null
  duplicate_strategy: DuplicateStrategy | null
  total_rows: number
  valid_rows: number
  invalid_rows: number
  success_count: number
  failed_count: number
  error_summary: Record<string, unknown>
  execution_key: string | null
  started_at: string | null
  finished_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

async function loadJob(service: ReturnType<typeof createServiceClient>, id: string): Promise<ImportJobRow> {
  const { data, error } = await service.from('import_jobs').select('*').eq('id', id).maybeSingle()
  if (error) {
    throw err.internal(`查询导入任务失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('导入任务不存在')
  }
  return data as ImportJobRow
}

/** 校验调用者可访问该任务(租户/门店作用域) */
async function authorizeJob(
  c: Parameters<typeof requireScopedPermission>[0],
  job: ImportJobRow,
  code: string,
  dataScope = false,
) {
  return requireScopedPermission(c, {
    code,
    tenantId: job.tenant_id,
    storeId: job.store_id ?? undefined,
    dataScope,
  })
}

/** 读取文件内容(R2 预签名下载) */
async function fetchFileContent(
  service: ReturnType<typeof createServiceClient>,
  fileId: string,
  tenantId: string,
): Promise<{ buf: Buffer, name: string, mime: string }> {
  const { data: file, error } = await service
    .from('files')
    .select('id, tenant_id, object_key, status, original_name, mime_type')
    .eq('id', fileId)
    .maybeSingle()
  if (error || !file) {
    throw err.notFound('文件不存在')
  }
  if (file.tenant_id !== tenantId) {
    throw err.forbidden('无权访问该文件')
  }
  if (file.status !== 'uploaded') {
    throw err.conflict('文件未上传完成或已归档')
  }
  const url = await createPresignedDownloadUrl(file.object_key)
  const res = await fetch(url)
  if (!res.ok) {
    throw err.internal('读取文件内容失败')
  }
  return { buf: Buffer.from(await res.arrayBuffer()), name: file.original_name ?? '', mime: file.mime_type ?? '' }
}

/** 从任务文件解析出结构化行 */
async function parseJobFile(
  service: ReturnType<typeof createServiceClient>,
  job: ImportJobRow,
): Promise<{ headers: string[], rows: { rowNumber: number, cells: Record<string, string> }[] }> {
  if (!job.source_file_id) {
    throw err.conflict('导入任务缺少数据文件')
  }
  const { buf, name, mime } = await fetchFileContent(service, job.source_file_id, job.tenant_id)
  const table = parseSpreadsheet(buf, name, mime)
  return parseImportRows(table.rows)
}

function buildPreview(
  meta: ReturnType<typeof getTypeMeta>,
  rows: { rowNumber: number, cells: Record<string, string> }[],
  mapping: Record<string, string>,
  limit = MAX_PREVIEW_ROWS,
) {
  return rows.slice(0, limit).map(row => ({ rowNumber: row.rowNumber, values: applyMapped(row, mapping) }))
}

function scopeOfJob(job: ImportJobRow): Scope {
  return { tenantId: job.tenant_id, storeId: job.store_id }
}

// ============================================================
// 模板下载
// ============================================================
/**
 * 下载导入模板
 * GET /imports/templates/:type?format=xlsx|csv&tenantId=xxx
 * - 权限:imports.view
 */
importsRoutes.get('/templates/:type', async (c) => {
  const type = c.req.param('type') as ImportJobType
  if (!IMPORT_JOB_TYPES.includes(type)) {
    throw err.badRequest('不支持的导入类型')
  }
  const format = c.req.query('format') === 'csv' ? 'csv' : 'xlsx'
  const tenantId = resolveRequestedTenant(c, c.req.query('tenantId'))
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  await requireScopedPermission(c, { code: 'imports.view', tenantId })

  const meta = getTypeMeta(type)
  const toArrayBuffer = (buf: Buffer): ArrayBuffer => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  if (format === 'csv') {
    const buf = buildTemplateCsv(meta)
    return c.newResponse(toArrayBuffer(buf), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${type}-import-template.csv"`,
    })
  }
  const buf = buildTemplateXlsx(meta)
  return c.newResponse(toArrayBuffer(buf), 200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${type}-import-template.xlsx"`,
  })
})

// ============================================================
// 任务列表
// ============================================================
/**
 * GET /imports?tenantId&storeId&type&status&from&limit
 * - 权限:imports.view(dataScope 允许门店角色)
 */
importsRoutes.get('/', async (c) => {
  const tenantId = resolveRequestedTenant(c, c.req.query('tenantId'))
  const storeId = c.req.query('storeId')
  const type = c.req.query('type') as ImportJobType | undefined
  const statusParam = c.req.query('status')
  const statuses = statusParam ? statusParam.split(',').map(s => s.trim()).filter(Boolean) : undefined
  const from = Number(c.req.query('from') ?? 0)
  const limit = Math.min(Number(c.req.query('limit') ?? 20), MAX_LIST_LIMIT)
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  const scope = await requireScopedPermission(c, { code: 'imports.view', tenantId, dataScope: true })

  const service = createServiceClient()
  let q = service.from('import_jobs').select('*', { count: 'exact' }).eq('tenant_id', scope.tenantId)
  if (storeId) {
    q = q.eq('store_id', storeId)
  }
  else if (scope.allowedStoreIds.length > 0) {
    // 数据范围收口:门店角色只读自己的门店 + 租户级任务
    q = q.or(`store_id.is.null,store_id.in.(${scope.allowedStoreIds.join(',')})`)
  }
  if (type && IMPORT_JOB_TYPES.includes(type)) {
    q = q.eq('type', type)
  }
  if (statuses && statuses.length > 0) {
    q = q.in('status', statuses)
  }
  q = q.range(from, from + limit - 1)
  const { data, error, count } = await q.order('created_at', { ascending: false })
  if (error) {
    throw err.internal(`查询导入任务失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ============================================================
// 上传
// ============================================================
const uploadSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional().nullable(),
  type: TYPE_ENUM,
  fileId: z.string().uuid('文件 id 格式错误'),
})

/**
 * POST /imports/upload
 * - 权限:imports.create
 * - 行为:读取文件→解析→生成默认映射→建 import_jobs(状态 uploaded)
 */
importsRoutes.post('/upload', async (c) => {
  const input = await parseJsonBody(c, uploadSchema)
  const scope = await requireScopedPermission(c, {
    code: 'imports.create',
    tenantId: input.tenantId,
    storeId: input.storeId ?? undefined,
  })

  const service = createServiceClient()
  const user = c.get('user')
  const { buf, name, mime } = await fetchFileContent(service, input.fileId, scope.tenantId)

  let table: { rows: string[][] }
  try {
    table = parseSpreadsheet(buf, name, mime)
  }
  catch (e) {
    const message = (e as { message?: string })?.message
    if (message === 'UNSUPPORTED_FILE_TYPE') {
      throw err.badRequest('仅支持 CSV / XLSX 文件')
    }
    throw err.badRequest('文件解析失败，请另存为 CSV 后重试')
  }
  const parsed = parseImportRows(table.rows)
  if (parsed.rows.length === 0) {
    throw err.badRequest('文件中没有可导入的数据行')
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    throw err.unprocessable(`单次最多导入 ${MAX_IMPORT_ROWS} 行，当前 ${parsed.rows.length} 行`)
  }

  const meta = getTypeMeta(input.type)
  const mapping = buildDefaultMapping(meta, parsed.headers)

  const { data: job, error } = await service.from('import_jobs').insert({
    tenant_id: scope.tenantId,
    store_id: scope.storeId ?? null,
    type: input.type,
    status: 'uploaded',
    source_file_id: input.fileId,
    total_rows: parsed.rows.length,
    mapping,
    duplicate_strategy: DEFAULT_DUPLICATE_STRATEGY[input.type],
    created_by: user.id,
  }).select().single()
  if (error) {
    throw err.internal(`创建导入任务失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'imports.upload',
    entityType: 'import_job',
    entityId: (job as ImportJobRow).id,
    tenantId: scope.tenantId,
    storeId: scope.storeId ?? undefined,
    metadata: { type: input.type, fileId: input.fileId, totalRows: parsed.rows.length, mapping },
  })

  return ok(c, {
    job,
    headers: parsed.headers,
    mapping,
    duplicateStrategies: meta.duplicateStrategies,
    duplicateHints: meta.duplicateHints,
    preview: buildPreview(meta, parsed.rows, mapping),
    totalRows: parsed.rows.length,
  })
})

// ============================================================
// 字段映射
// ============================================================
const mappingSchema = z.object({
  mapping: z.record(z.string(), z.string()),
  duplicateStrategy: STRATEGY_ENUM,
})

/**
 * POST /imports/:id/mapping
 * - 权限:imports.create
 */
importsRoutes.post('/:id/mapping', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, mappingSchema)
  const service = createServiceClient()
  const job = await loadJob(service, id)
  await authorizeJob(c, job, 'imports.create')

  const meta = getTypeMeta(job.type)
  if (!meta.duplicateStrategies.includes(input.duplicateStrategy)) {
    throw err.badRequest(`该导入类型不支持去重策略: ${input.duplicateStrategy}`)
  }

  // 校验映射键为合法字段、值为真实表头
  const { headers } = await parseJobFile(service, job)
  const headerSet = new Set(headers)
  const fieldKeys = new Set(meta.fields.map(f => f.key))
  const sanitized: Record<string, string> = {}
  for (const [key, header] of Object.entries(input.mapping)) {
    if (fieldKeys.has(key) && headerSet.has(header)) {
      sanitized[key] = header
    }
  }
  const requiredMapped = meta.fields.filter(f => f.required).every(f => sanitized[f.key])

  const { data: updated, error } = await service.from('import_jobs').update({
    mapping: sanitized,
    duplicate_strategy: input.duplicateStrategy,
    status: 'mapped',
  }).eq('id', id).select().single()
  if (error) {
    throw err.internal(`保存映射失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'imports.mapping',
    entityType: 'import_job',
    entityId: id,
    tenantId: job.tenant_id,
    storeId: job.store_id ?? undefined,
    metadata: { mapping: sanitized, duplicateStrategy: input.duplicateStrategy },
  })

  const { rows } = await parseJobFile(service, job)
  return ok(c, {
    job: updated,
    headers,
    preview: buildPreview(meta, rows, sanitized),
    requiredMapped,
  })
})

// ============================================================
// 校验
// ============================================================
/**
 * POST /imports/:id/validate
 * - 权限:imports.execute
 * - 行为:逐行校验→清空旧错误→写错误明细→更新 valid/invalid 计数
 */
importsRoutes.post('/:id/validate', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()
  const job = await loadJob(service, id)
  await authorizeJob(c, job, 'imports.execute')

  const meta = getTypeMeta(job.type)
  const mapping = job.mapping ?? {}
  const { rows } = await parseJobFile(service, job)
  const ctx = await loadLookupContext(service, job.tenant_id, job.store_id)
  const scope = scopeOfJob(job)

  const allErrors: RowError[] = []
  let validCount = 0
  for (const row of rows) {
    const mapped = applyMapped(row, mapping)
    const errs = validateRow(meta, row, mapped, ctx, scope)
    if (errs.length === 0) {
      validCount++
    }
    else {
      allErrors.push(...errs)
    }
  }
  const invalidCount = rows.length - validCount

  // 清空旧错误并写入新错误(限量,标记阶段 validate)
  await service.from('import_job_errors').delete().eq('import_job_id', id)
  const toInsert = allErrors.slice(0, MAX_ERRORS_STORED).map(e => ({
    import_job_id: id,
    row_number: e.rowNumber,
    field: e.field ?? null,
    code: e.code,
    message: e.message,
    raw_data: e.rawData ?? null,
    stage: 'validate',
  }))
  if (toInsert.length > 0) {
    const { error } = await service.from('import_job_errors').insert(toInsert)
    if (error) {
      throw err.internal(`写入错误明细失败: ${error.message}`)
    }
  }

  const groups = groupErrors(allErrors)
  const { data: updated, error: updErr } = await service.from('import_jobs').update({
    total_rows: rows.length,
    valid_rows: validCount,
    invalid_rows: invalidCount,
    status: 'validated',
    error_summary: { errorCount: allErrors.length, errorGroups: groups },
  }).eq('id', id).select().single()
  if (updErr) {
    throw err.internal(`更新校验结果失败: ${updErr.message}`)
  }

  await writeAudit(c, {
    action: 'imports.validate',
    entityType: 'import_job',
    entityId: id,
    tenantId: job.tenant_id,
    storeId: job.store_id ?? undefined,
    metadata: { validRows: validCount, invalidRows: invalidCount, errorCount: allErrors.length },
  })

  return ok(c, {
    job: updated,
    validRows: validCount,
    invalidRows: invalidCount,
    totalRows: rows.length,
    errorCount: allErrors.length,
    errorGroups: groups,
    sampleErrors: allErrors.slice(0, 50),
  })
})

// ============================================================
// 执行
// ============================================================
/**
 * POST /imports/:id/start
 * - 权限:imports.execute
 * - 行为:原子 claim(可执行态 → processing)防止并发重复执行;
 *        逐行(重校验+执行)写入业务数据/生成命令;
 *        执行期错误持久化 import_job_errors(stage=execute);
 *        幂等:相同 Idempotency-Key 的重复请求返回既有结果。
 */
importsRoutes.post('/:id/start', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()
  const job = await loadJob(service, id)
  await authorizeJob(c, job, 'imports.execute')

  // 请求幂等键:优先 Idempotency-Key 请求头,缺省生成随机键(仍保证单执行者)
  const requestKey = getRequestIdempotencyKey(c) || randomUUID()

  // 幂等保护:同一执行键已有结果 → 直接返回既有结果,不重复执行
  if (job.execution_key) {
    if (job.execution_key !== requestKey) {
      throw err.conflict('该导入任务已被其他执行请求处理')
    }
    if (job.status === 'processing') {
      throw err.conflict('导入任务正在处理中,请勿重复提交')
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'awaiting_domain_apply') {
      return ok(c, {
        job,
        idempotent: true,
        successRows: job.success_count,
        skippedRows: 0,
        failedRows: job.failed_count,
        totalRows: job.total_rows,
        pendingOpeningCommands: 0,
        pendingEmployeeInvites: 0,
        failedSamples: [],
      })
    }
  }

  // 原子 claim:仅"已校验(validated)"任务可被唯一执行者抢到 processing(审计 v2 §9:
  // 严格状态机 uploaded→mapped→validated→processing,不允许跳过正式 Validate 步骤直接 Start)
  const { data: claimed, error: claimErr } = await service
    .from('import_jobs')
    .update({
      status: 'processing',
      started_at: new Date().toISOString(),
      execution_key: requestKey,
    })
    .eq('id', id)
    .eq('status', 'validated')
    .select('*')
    .maybeSingle()
  if (claimErr) {
    throw err.internal(`抢占导入任务失败: ${claimErr.message}`)
  }
  if (!claimed) {
    const cur = await loadJob(service, id)
    if (cur.status === 'completed' || cur.status === 'failed' || cur.status === 'cancelled' || cur.status === 'awaiting_domain_apply') {
      throw err.conflict('导入任务已处于终态,不可重复执行')
    }
    throw err.conflict('导入任务正在处理中,请勿重复提交')
  }

  const meta = getTypeMeta(job.type)
  const mapping = job.mapping ?? {}
  const strategy = job.duplicate_strategy ?? 'skip'
  const { rows } = await parseJobFile(service, job)
  const ctx = await loadLookupContext(service, job.tenant_id, job.store_id)
  const scope = scopeOfJob(job)
  const user = c.get('user')

  let successCount = 0
  let skippedCount = 0
  let failedCount = 0
  const failedSamples: RowError[] = []

  // 执行期间不可恢复异常(连接中断等):任务落 failed,而非停留在 processing
  let fatalError: string | null = null
  try {
    for (const row of rows) {
      const mapped = applyMapped(row, mapping)
      const errs = validateRow(meta, row, mapped, ctx, scope)
      if (errs.length > 0) {
        failedCount++
        failedSamples.push(...errs)
        continue
      }
      const res = await executeRow({ meta, row, mapped, strategy, ctx, scope, jobId: id, userId: user.id, service })
      if (res.status === 'success') {
        successCount++
      }
      else if (res.status === 'skipped') {
        skippedCount++
      }
      else {
        failedCount++
        failedSamples.push({ rowNumber: row.rowNumber, code: 'EXECUTE_FAILED', message: res.error ?? '执行失败', rawData: row.cells })
      }
    }
  }
  catch (e) {
    fatalError = (e as { message?: string })?.message ?? String(e)
  }

  // 执行期错误持久化(stage='execute'),页面错误详情按阶段可查
  const executeErrors = failedSamples.slice(0, MAX_ERRORS_STORED).map(e => ({
    import_job_id: id,
    row_number: e.rowNumber,
    field: e.field ?? null,
    code: e.code,
    message: e.message,
    raw_data: e.rawData ?? null,
    stage: 'execute',
  }))
  if (executeErrors.length > 0) {
    const { error: errIns } = await service.from('import_job_errors').insert(executeErrors)
    if (errIns) {
      throw err.internal(`写入执行错误明细失败: ${errIns.message}`)
    }
  }

  const finishedAt = new Date().toISOString()
  // 业务命令型导入(employee/opening-stock)只生成待邀请/期初命令,真实业务落地由
  // S32-E Integrator 消费命令队列完成,终态用 awaiting_domain_apply 而非 completed
  // (审计 v2 §10/§11:completed 仅表示业务数据已直接落地)。
  const terminalStatus = fatalError
    ? 'failed'
    : (job.type === 'employee' || job.type === 'opening-stock' ? 'awaiting_domain_apply' : 'completed')
  const { data: updated, error: updErr } = await service.from('import_jobs').update({
    success_count: successCount,
    failed_count: failedCount,
    status: terminalStatus,
    finished_at: finishedAt,
    error_summary: fatalError
      ? { fatal: fatalError, success: successCount, skipped: skippedCount, failed: failedCount }
      : { success: successCount, skipped: skippedCount, failed: failedCount },
  }).eq('id', id).select().single()
  if (updErr) {
    throw err.internal(`更新执行结果失败: ${updErr.message}`)
  }

  // 统计生成的命令队列(期初入账/员工待邀请,交由 Integrator 消费)
  const [openingCount, inviteCount] = await Promise.all([
    service.from('opening_stock_import_requests').select('id', { count: 'exact', head: true }).eq('import_job_id', id),
    service.from('employee_invite_imports').select('id', { count: 'exact', head: true }).eq('import_job_id', id),
  ])

  await writeAudit(c, {
    action: 'imports.execute',
    entityType: 'import_job',
    entityId: id,
    tenantId: job.tenant_id,
    storeId: job.store_id ?? undefined,
    metadata: { success: successCount, skipped: skippedCount, failed: failedCount, fatal: fatalError },
  })

  return ok(c, {
    job: updated,
    successRows: successCount,
    skippedRows: skippedCount,
    failedRows: failedCount,
    totalRows: rows.length,
    pendingOpeningCommands: openingCount.count ?? 0,
    pendingEmployeeInvites: inviteCount.count ?? 0,
    failedSamples: failedSamples.slice(0, 50),
  })
})

// ============================================================
// 详情 / 错误明细 / 取消
// ============================================================
/**
 * GET /imports/:id
 * - 权限:imports.view
 */
importsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()
  const job = await loadJob(service, id)
  await authorizeJob(c, job, 'imports.view')

  const { count: errorCount } = await service
    .from('import_job_errors')
    .select('id', { count: 'exact', head: true })
    .eq('import_job_id', id)

  return ok(c, { job, errorCount: errorCount ?? 0 })
})

/**
 * GET /imports/:id/errors?from&limit&rowNumber
 * - 权限:imports.view
 */
importsRoutes.get('/:id/errors', async (c) => {
  const id = c.req.param('id')
  const from = Number(c.req.query('from') ?? 0)
  const limit = Math.min(Number(c.req.query('limit') ?? 20), MAX_LIST_LIMIT)
  const rowNumber = c.req.query('rowNumber')
  const service = createServiceClient()
  const job = await loadJob(service, id)
  await authorizeJob(c, job, 'imports.view')

  let q = service.from('import_job_errors').select('*', { count: 'exact' }).eq('import_job_id', id)
  if (rowNumber) {
    q = q.eq('row_number', Number(rowNumber))
  }
  q = q.range(from, from + limit - 1)
  const { data, error, count } = await q.order('row_number', { ascending: true })
  if (error) {
    throw err.internal(`查询错误明细失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

/**
 * POST /imports/:id/cancel
 * - 权限:imports.cancel
 */
importsRoutes.post('/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()
  const job = await loadJob(service, id)
  await authorizeJob(c, job, 'imports.cancel')

  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    throw err.conflict('任务已处于终态，无法取消')
  }
  const { data: updated, error } = await service.from('import_jobs').update({
    status: 'cancelled',
    finished_at: new Date().toISOString(),
  }).eq('id', id).select().single()
  if (error) {
    throw err.internal(`取消失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'imports.cancel',
    entityType: 'import_job',
    entityId: id,
    tenantId: job.tenant_id,
    storeId: job.store_id ?? undefined,
    metadata: {},
  })

  return ok(c, updated)
})

/** 按错误码聚合 */
function groupErrors(errors: RowError[]): { code: string, count: number }[] {
  const map = new Map<string, number>()
  for (const e of errors) {
    map.set(e.code, (map.get(e.code) ?? 0) + 1)
  }
  return [...map.entries()].map(([code, count]) => ({ code, count }))
}

export default importsRoutes
