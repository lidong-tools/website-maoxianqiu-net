import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { err } from '../lib/errors.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * Regulatory 监管运营域 Command 路由(S3.1-PARALLEL-01)
 *
 * 覆盖(独立工作包,不与主线 clinical/inventory/compliance 混编):
 *   - 动物诊疗许可证 institution_licenses(新增/编辑/状态变更)
 *   - 年度动物诊疗活动报告 annual_regulatory_reports(生成快照/提交)
 *   - 疫情事件台账 epidemic_events(上报/维护/隔离/解除)
 *   - 医疗废弃物台账 medical_waste_records(新增/维护/交接)
 *
 * 安全:
 *   - 全部走 Hono Command + PostgreSQL RPC(service-role-only),
 *     禁止前端直连改状态/正文;查询走 Supabase + RLS;
 *   - requireScopedPermission 返回的 scope 是唯一可信 tenantId/storeId 来源,
 *     涉及 :id 的实体先按 id 查库取归属再做作用域授权;
 *   - 普通业务 UI 不输入 tenantId/storeId UUID:storeId 由 StorePicker 提供,
 *     tenantId 一律由服务端按门店归属推导;
 *   - 操作人由服务端按登录用户反查在职员工档案推导(resolveCurrentEmployee),
 *     禁止客户端传 operatorEmployeeId;
 *   - 关键状态流转 RPC 内事务写 audit_logs。
 */
const regulatoryRoutes = new Hono<AppEnv>()

regulatoryRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/**
 * 将 RPC 抛出的监管业务错误码映射为 HTTP 错误
 * - NOT_FOUND 类 → 404
 * - 状态/业务规则类 → 422
 * - 其余 → 500
 */
function mapRpcError(error: { message: string }) {
  const msg = error.message
  // 资源不存在
  if ([
    'LICENSE_NOT_FOUND',
    'REPORT_NOT_FOUND',
    'EPIDEMIC_NOT_FOUND',
    'WASTE_NOT_FOUND',
    'STORE_NOT_FOUND',
    'OPERATOR_NOT_FOUND',
    'EMPLOYEE_NOT_FOUND',
  ].some(k => msg.includes(k))) {
    return err.notFound(msg.replace(/^ERROR:\s*/, ''))
  }
  // 状态/业务规则类(许可证、报告状态机、疫情状态机、废弃物交接)
  // S31-MERGE-B:B02 跨租户关联校验 / B05 许可证状态机 / B06 疫情状态机错误码
  if ([
    'LICENSE_NO_REQUIRED',
    'INVALID_LICENSE_STATUS',
    'LICENSE_DUPLICATE',
    'LICENSE_STATUS_UNCHANGED',
    'LICENSE_NOT_EDITABLE',
    'INVALID_LICENSE_TRANSITION',
    'INVALID_REPORT_YEAR',
    'REPORT_ALREADY_SUBMITTED',
    'REPORT_NOT_GENERATED',
    'SUSPECTED_DISEASE_REQUIRED',
    'INVALID_EPIDEMIC_STATUS',
    'INVALID_EPIDEMIC_TRANSITION',
    'EPIDEMIC_NOT_EDITABLE',
    'EPIDEMIC_NOT_ISOLATABLE',
    'EPIDEMIC_NOT_RESOLVABLE',
    'WASTE_TYPE_REQUIRED',
    'INVALID_WASTE_QUANTITY',
    'INVALID_WASTE_STATUS',
    'WASTE_NOT_EDITABLE',
    'WASTE_ALREADY_HANDED_OVER',
    'WASTE_RECEIVER_REQUIRED',
    // B02:关联对象跨租户/归属不一致
    'FILE_SCOPE_MISMATCH',
    'CUSTOMER_SCOPE_MISMATCH',
    'PET_SCOPE_MISMATCH',
    'ENCOUNTER_SCOPE_MISMATCH',
    'RELATED_ENTITY_MISMATCH',
  ].some(k => msg.includes(k))) {
    return err.unprocessable(msg.replace(/^ERROR:\s*/, ''))
  }
  return err.internal(`监管操作失败: ${msg}`)
}

/**
 * 按门店 id 查归属租户,作为 requireScopedPermission 的作用域来源
 * @param service supabase service client
 * @param storeId 门店 id
 * @returns 门店所属租户 id
 */
async function fetchStoreTenant(
  service: ReturnType<typeof createServiceClient>,
  storeId: string,
): Promise<string> {
  const { data, error } = await service
    .from('stores')
    .select('tenant_id')
    .eq('id', storeId)
    .maybeSingle()
  if (error || !data) {
    throw err.notFound('门店不存在')
  }
  return data.tenant_id
}

/**
 * 服务端推导当前操作人在【指定租户】下的员工档案(S3.1-PARALLEL-01)
 * 与主线 compliance.ts 中 resolveCurrentEmployee 行为一致的极小兼容 wrapper:
 * 禁止对 user_id 做全局 maybeSingle,必须显式限定目标租户解析。
 * @param service supabase service client
 * @param c hono context
 * @param c.get hono context getter(读取认证用户信息)
 * @param tenantId 目标租户 id(由实体归属/门店归属确定的可信租户)
 * @returns 当前操作人在该租户下的员工档案 id
 */
async function resolveCurrentEmployee(
  service: ReturnType<typeof createServiceClient>,
  c: { get: (k: string) => unknown },
  tenantId: string,
): Promise<string> {
  const user = c.get('user') as { id: string } | undefined
  if (!user?.id) {
    throw err.unauthorized('未登录')
  }
  const { data, error } = await service
    .from('employees')
    .select('id')
    .eq('user_id', user.id)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .maybeSingle()
  if (error || !data) {
    throw err.forbidden('当前账号在目标租户下未关联在职员工档案,无法执行操作')
  }
  return data.id
}

// ============================================================
// 1. 动物诊疗许可证(license.manage)
// ============================================================

const saveLicenseSchema = z.object({
  storeId: z.string().uuid('门店 id 格式错误'),
  licenseId: z.string().uuid('许可证 id 格式错误').optional().nullable(),
  licenseNo: z.string().min(1, '证号不能为空').max(100),
  issuingAuthority: z.string().max(200).optional().nullable(),
  diagnosisScope: z.string().max(500).optional().nullable(),
  issuedAt: z.string().date('日期格式错误').optional().nullable(),
  validFrom: z.string().date('日期格式错误').optional().nullable(),
  validUntil: z.string().date('日期格式错误').optional().nullable(),
  status: z.enum(['draft', 'active', 'suspended', 'revoked', 'expired']).optional(),
  certificateFileId: z.string().uuid().optional().nullable(),
  certificateQr: z.string().max(1000).optional().nullable(),
})

/**
 * 许可证新增/编辑(S3.1-PARALLEL-01-L1)
 * - 权限:license.manage
 * - 行为:storeId 由 StorePicker 提供,租户由服务端按门店推导;
 *   调 save_institution_license RPC,内部追加版本快照 + license.create/update 审计;
 *   状态变更走 /licenses/:id/status(保证 status_change 审计)。
 */
regulatoryRoutes.post('/licenses/save', async (c) => {
  const input = await parseJsonBody(c, saveLicenseSchema)
  const service = createServiceClient()
  const tenantId = await fetchStoreTenant(service, input.storeId)
  await requireScopedPermission(c, {
    code: 'license.manage',
    tenantId,
    storeId: input.storeId,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, tenantId)

  const { data, error } = await service.rpc('save_institution_license', {
    p_tenant_id: tenantId,
    p_store_id: input.storeId,
    p_license_id: input.licenseId ?? null,
    p_license_no: input.licenseNo,
    p_issuing_authority: input.issuingAuthority ?? null,
    p_diagnosis_scope: input.diagnosisScope ?? null,
    p_issued_at: input.issuedAt ?? null,
    p_valid_from: input.validFrom ?? null,
    p_valid_until: input.validUntil ?? null,
    p_status: input.status ?? 'draft',
    p_certificate_file_id: input.certificateFileId ?? null,
    p_certificate_qr: input.certificateQr ?? null,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

const changeLicenseStatusSchema = z.object({
  newStatus: z.enum(['draft', 'active', 'suspended', 'revoked', 'expired']),
})

/**
 * 许可证状态变更(S3.1-PARALLEL-01-L2)
 * - 权限:license.manage
 * - 行为:先查许可证归属再授权,调 change_license_status RPC,
 *   内部追加 status_change 版本 + license.status_change 审计。
 */
regulatoryRoutes.post('/licenses/:id/status', async (c) => {
  const licenseId = c.req.param('id')
  const input = await parseJsonBody(c, changeLicenseStatusSchema)
  const service = createServiceClient()

  const { data: license, error: fetchErr } = await service
    .from('institution_licenses')
    .select('id, tenant_id, store_id')
    .eq('id', licenseId)
    .maybeSingle()
  if (fetchErr || !license) {
    throw err.notFound('许可证不存在')
  }
  await requireScopedPermission(c, {
    code: 'license.manage',
    tenantId: license.tenant_id,
    storeId: license.store_id,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, license.tenant_id)

  const { data, error } = await service.rpc('change_license_status', {
    p_license_id: licenseId,
    p_new_status: input.newStatus,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

// ============================================================
// 2. 年度动物诊疗活动报告
//    generate = regulatory_report.generate / submit = regulatory_report.submit
// ============================================================

const generateReportSchema = z.object({
  storeId: z.string().uuid('门店 id 格式错误'),
  reportYear: z.number().int().min(2000).max(2100, '年份需在 2000~2100 之间'),
})

/**
 * 生成年度报告(S3.1-PARALLEL-01-R1)
 * - 权限:regulatory_report.generate
 * - 行为:调 generate_regulatory_report RPC,生成时保存 report_snapshot
 *   (查看/导出一律读快照,历史内容固定,不实时重算);regulatory_report.generate 审计。
 */
regulatoryRoutes.post('/annual-reports/generate', async (c) => {
  const input = await parseJsonBody(c, generateReportSchema)
  const service = createServiceClient()
  const tenantId = await fetchStoreTenant(service, input.storeId)
  await requireScopedPermission(c, {
    code: 'regulatory_report.generate',
    tenantId,
    storeId: input.storeId,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, tenantId)

  const { data, error } = await service.rpc('generate_regulatory_report', {
    p_tenant_id: tenantId,
    p_store_id: input.storeId,
    p_report_year: input.reportYear,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

/**
 * 提交年度报告(S3.1-PARALLEL-01-R2)
 * - 权限:regulatory_report.submit
 * - 行为:先查报告归属再授权,调 submit_regulatory_report RPC;
 *   仅 generated 可提交;regulatory_report.submit 审计。
 */
regulatoryRoutes.post('/annual-reports/:id/submit', async (c) => {
  const reportId = c.req.param('id')
  const service = createServiceClient()

  const { data: report, error: fetchErr } = await service
    .from('annual_regulatory_reports')
    .select('id, tenant_id, store_id')
    .eq('id', reportId)
    .maybeSingle()
  if (fetchErr || !report) {
    throw err.notFound('年度报告不存在')
  }
  await requireScopedPermission(c, {
    code: 'regulatory_report.submit',
    tenantId: report.tenant_id,
    storeId: report.store_id,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, report.tenant_id)

  const { data, error } = await service.rpc('submit_regulatory_report', {
    p_report_id: reportId,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

// ============================================================
// 3. 疫情事件台账
//    save/isolate = epidemic.report / resolve = epidemic.resolve
// ============================================================

const saveEpidemicEventSchema = z.object({
  storeId: z.string().uuid('门店 id 格式错误'),
  eventId: z.string().uuid('事件 id 格式错误').optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  petId: z.string().uuid().optional().nullable(),
  encounterId: z.string().uuid().optional().nullable(),
  suspectedDisease: z.string().min(1, '疑似疫病不能为空').max(200),
  detectedAt: z.string().datetime({ offset: true }).optional().nullable(),
  isolationRequired: z.boolean().optional(),
  treatmentRestricted: z.boolean().optional(),
  restrictionReason: z.string().max(500).optional().nullable(),
  cullingRequired: z.boolean().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  status: z.enum(['detected', 'reported']).optional(),
})

/**
 * 疫情事件上报/维护(S3.1-PARALLEL-01-E1)
 * - 权限:epidemic.report
 * - 行为:系统负责记录,不替医生自动诊断;是否隔离/限制治疗由授权用户明确填写;
 *   调 save_epidemic_event RPC,创建/上报动作写 epidemic.report 审计;
 *   关联宠物/病历使用 PetPicker / EncounterPicker,不输入 UUID。
 */
regulatoryRoutes.post('/epidemic-events/save', async (c) => {
  const input = await parseJsonBody(c, saveEpidemicEventSchema)
  const service = createServiceClient()
  const tenantId = await fetchStoreTenant(service, input.storeId)
  await requireScopedPermission(c, {
    code: 'epidemic.report',
    tenantId,
    storeId: input.storeId,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, tenantId)

  const { data, error } = await service.rpc('save_epidemic_event', {
    p_tenant_id: tenantId,
    p_store_id: input.storeId,
    p_event_id: input.eventId ?? null,
    p_customer_id: input.customerId ?? null,
    p_pet_id: input.petId ?? null,
    p_encounter_id: input.encounterId ?? null,
    p_suspected_disease: input.suspectedDisease,
    p_detected_at: input.detectedAt ?? null,
    p_isolation_required: input.isolationRequired ?? false,
    p_treatment_restricted: input.treatmentRestricted ?? false,
    p_restriction_reason: input.restrictionReason ?? null,
    p_culling_required: input.cullingRequired ?? null,
    p_notes: input.notes ?? null,
    p_status: input.status ?? 'detected',
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

/**
 * 疫情事件隔离(S3.1-PARALLEL-01-E2)
 * - 权限:epidemic.report(隔离为事件维护动作)
 * - 行为:先查事件归属再授权,调 isolate_epidemic_event RPC,
 *   仅 detected/reported 可隔离;epidemic.isolate 审计。
 */
regulatoryRoutes.post('/epidemic-events/:id/isolate', async (c) => {
  const eventId = c.req.param('id')
  const service = createServiceClient()

  const { data: event, error: fetchErr } = await service
    .from('epidemic_events')
    .select('id, tenant_id, store_id')
    .eq('id', eventId)
    .maybeSingle()
  if (fetchErr || !event) {
    throw err.notFound('疫情事件不存在')
  }
  await requireScopedPermission(c, {
    code: 'epidemic.report',
    tenantId: event.tenant_id,
    storeId: event.store_id,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, event.tenant_id)

  const { data, error } = await service.rpc('isolate_epidemic_event', {
    p_event_id: eventId,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

/**
 * 疫情事件解除(S3.1-PARALLEL-01-E3)
 * - 权限:epidemic.resolve
 * - 行为:先查事件归属再授权,调 resolve_epidemic_event RPC;
 *   epidemic.resolve 审计。
 */
regulatoryRoutes.post('/epidemic-events/:id/resolve', async (c) => {
  const eventId = c.req.param('id')
  const service = createServiceClient()

  const { data: event, error: fetchErr } = await service
    .from('epidemic_events')
    .select('id, tenant_id, store_id')
    .eq('id', eventId)
    .maybeSingle()
  if (fetchErr || !event) {
    throw err.notFound('疫情事件不存在')
  }
  await requireScopedPermission(c, {
    code: 'epidemic.resolve',
    tenantId: event.tenant_id,
    storeId: event.store_id,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, event.tenant_id)

  const { data, error } = await service.rpc('resolve_epidemic_event', {
    p_event_id: eventId,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

// ============================================================
// 4. 医疗废弃物台账(waste.manage)
// ============================================================

const saveWasteRecordSchema = z.object({
  storeId: z.string().uuid('门店 id 格式错误'),
  recordId: z.string().uuid('记录 id 格式错误').optional().nullable(),
  wasteType: z.string().min(1, '废弃物类型不能为空').max(100),
  quantity: z.number().min(0).optional(),
  unit: z.string().max(50).optional().nullable(),
  generatedAt: z.string().datetime({ offset: true }).optional().nullable(),
  handlerEmployeeId: z.string().uuid().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  attachmentFileId: z.string().uuid().optional().nullable(),
  status: z.enum(['draft', 'recorded']).optional(),
})

/**
 * 废弃物新增/维护(S3.1-PARALLEL-01-W1)
 * - 权限:waste.manage
 * - 行为:调 save_waste_record RPC;仅 draft/recorded 可编辑,交接后不可修改;
 *   waste.create / waste.update 审计;员工使用 EmployeePicker。
 */
regulatoryRoutes.post('/waste/save', async (c) => {
  const input = await parseJsonBody(c, saveWasteRecordSchema)
  const service = createServiceClient()
  const tenantId = await fetchStoreTenant(service, input.storeId)
  await requireScopedPermission(c, {
    code: 'waste.manage',
    tenantId,
    storeId: input.storeId,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, tenantId)

  const { data, error } = await service.rpc('save_waste_record', {
    p_tenant_id: tenantId,
    p_store_id: input.storeId,
    p_record_id: input.recordId ?? null,
    p_waste_type: input.wasteType,
    p_quantity: input.quantity ?? 1,
    p_unit: input.unit ?? null,
    p_generated_at: input.generatedAt ?? null,
    p_handler_employee_id: input.handlerEmployeeId ?? null,
    p_notes: input.notes ?? null,
    p_attachment_file_id: input.attachmentFileId ?? null,
    p_status: input.status ?? 'draft',
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

const handoverWasteSchema = z.object({
  handlerEmployeeId: z.string().uuid().optional().nullable(),
  receiver: z.string().min(1, '接收方不能为空').max(200),
  disposalMethod: z.string().max(200).optional().nullable(),
  handoverAt: z.string().datetime({ offset: true }).optional().nullable(),
})

/**
 * 废弃物交接(S3.1-PARALLEL-01-W2)
 * - 权限:waste.manage
 * - 行为:先查记录归属再授权,调 handover_waste RPC;
 *   交接后状态 handed_over 不可修改;waste.handover 审计;
 *   交接员工/接收方必须填写,员工使用 EmployeePicker。
 */
regulatoryRoutes.post('/waste/:id/handover', async (c) => {
  const recordId = c.req.param('id')
  const input = await parseJsonBody(c, handoverWasteSchema)
  const service = createServiceClient()

  const { data: record, error: fetchErr } = await service
    .from('medical_waste_records')
    .select('id, tenant_id, store_id')
    .eq('id', recordId)
    .maybeSingle()
  if (fetchErr || !record) {
    throw err.notFound('废弃物记录不存在')
  }
  await requireScopedPermission(c, {
    code: 'waste.manage',
    tenantId: record.tenant_id,
    storeId: record.store_id,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, record.tenant_id)

  const { data, error } = await service.rpc('handover_waste', {
    p_record_id: recordId,
    p_handler_employee_id: input.handlerEmployeeId ?? null,
    p_receiver: input.receiver,
    p_disposal_method: input.disposalMethod ?? null,
    p_handover_at: input.handoverAt ?? null,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }
  return ok(c, data)
})

export default regulatoryRoutes
