import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit.js'
import { err } from '../lib/errors.js'
import { requireScopedPermission } from '../lib/permission.js'
import { loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { parseJsonBody } from '../lib/validation.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'

/**
 * Compliance 合规域 Command 路由(S3.1-1)
 *
 * 覆盖:
 *   - 病历归档(门急诊/住院)+ 归档后修订(Amendment)申请/审批/执行
 *   - 执业兽医备案管理(幂等 upsert)
 *   - 处方开具(受控药二重权限校验)/延长有效期
 *
 * 安全:
 *   - 全部走 Hono Command + PostgreSQL RPC(service-role-only),
 *     禁止前端直连改状态/正文;
 *   - requireScopedPermission 返回的 scope 是唯一可信 tenantId/storeId 来源,
 *     涉及 :id 的实体先按 id 查库取归属再做作用域授权;
 *   - 受控药品处方额外校验 prescription.controlled_issue 权限码;
 *   - 登录用户 id 通过 c.get('user').id 传给 RPC(p_prescriber_user_id 等);
 *   - 归档后正文不可变由 DB 触发器兜底,apply_record_amendment 显式放行。
 */
const complianceRoutes = new Hono<AppEnv>()

complianceRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

/**
 * 将 RPC 抛出的合规业务错误码映射为 HTTP 错误(S3.1-1)
 * - NOT_FOUND 类 → 404
 * - 状态/业务规则类 → 422
 * - 其余 → 500
 */
function mapRpcError(error: { message: string }) {
  const msg = error.message
  // 资源不存在
  if (['ENCOUNTER_NOT_FOUND', 'ADMISSION_NOT_FOUND', 'PRESCRIPTION_NOT_FOUND', 'AMENDMENT_NOT_FOUND', 'OPERATOR_NOT_FOUND', 'EMPLOYEE_NOT_FOUND'].some(k => msg.includes(k))) {
    return err.notFound('资源不存在')
  }
  // 开方人无有效执业兽医备案
  if (msg.includes('PRESCRIBER_NOT_REGISTERED')) {
    return err.unprocessable('开方人无有效执业兽医备案,禁止开具处方')
  }
  // 状态/业务规则类(归档、修订流、处方状态机、受控药、有效期)
  if ([
    'ENCOUNTER_NOT_SIGNABLE',
    'ENCOUNTER_ALREADY_ARCHIVED',
    'ADMISSION_NOT_DISCHARGED',
    'ADMISSION_ALREADY_ARCHIVED',
    'RECORD_NOT_ARCHIVED',
    'AMENDMENT_ALREADY_PENDING',
    'AMENDMENT_NOT_PENDING',
    'AMENDMENT_NOT_APPROVED',
    'PRESCRIPTION_NOT_DRAFT',
    'PRESCRIPTION_NOT_ISSUED',
    'PRESCRIPTION_ALREADY_ISSUED',
    'PRESCRIPTION_NOT_DISPENSABLE',
    'PRESCRIPTION_EXPIRED',
    'ARCHIVED_RECORD_IMMUTABLE',
    'INVALID_RECORD_TYPE',
    'INVALID_DECISION',
    'INVALID_REGISTRATION_STATUS',
    'AMENDMENT_REASON_REQUIRED',
    'LICENSE_NO_REQUIRED',
    'PRESCRIBER_NOT_FOUND',
    'CONTROLLED_MIX_CLASS',
    'CONTROLLED_MIX_REGULAR',
    'NARCOTIC_DAILY_LIMIT',
    'VALIDITY_EXCEEDS_MAX',
    'VALIDITY_NOT_EXTENDED',
    'PRESCRIPTION_VALIDITY_IN_PAST',
  ].some(k => msg.includes(k))) {
    return err.unprocessable(msg.replace(/^ERROR:\s*/, ''))
  }
  return err.internal(`合规操作失败: ${msg}`)
}

/**
 * 按病历类型查记录归属(租户/门店),作为 requireScopedPermission 的作用域来源
 * @param service supabase service client
 * @param recordType 病历类型(encounter/admission)
 * @param recordId 病历 id
 * @returns 记录的 tenantId/storeId
 */
async function fetchRecordScope(
  service: ReturnType<typeof createServiceClient>,
  recordType: 'encounter' | 'admission',
  recordId: string,
): Promise<{ tenantId: string, storeId: string | null }> {
  const table = recordType === 'encounter' ? 'encounters' : 'admissions'
  const { data, error } = await service
    .from(table)
    .select('tenant_id, store_id')
    .eq('id', recordId)
    .maybeSingle()
  if (error || !data) {
    throw err.notFound(recordType === 'encounter' ? '门(急)诊病历不存在' : '住院病历不存在')
  }
  return { tenantId: data.tenant_id, storeId: data.store_id ?? null }
}

/**
 * 服务端推导当前操作人在【指定租户】下的员工档案(F01 审计修复)
 * 操作人一律由登录用户(auth user)反查在职员工档案得到,禁止客户端传 employee id。
 * 禁止对 user_id 做全局 maybeSingle——多租户账号会在多个租户存在 active 员工,
 * 全局查询因多行返回失败且会取错作用域;必须显式限定目标租户后解析。
 * @param service supabase service client
 * @param c hono context(仅访问 .get,不依赖具体 Hono 类型)
 * @param c.get 读取请求上下文中存储的值(如 user)
 * @param tenantId 目标租户 id(已由实体归属/目标员工档案确定的可信租户)
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

const archiveRecordSchema = z.object({
  recordType: z.enum(['encounter', 'admission']),
  recordId: z.string().uuid('病历 id 格式错误'),
})

/**
 * 病历归档(S3.1-1-A1)
 * - 权限:medical_record.archive
 * - 行为:按 recordType 调 archive_encounter / archive_admission RPC,
 *   归档后 retention_until = 归档日 + 3 年;操作人由服务端推导(R03)
 */
complianceRoutes.post('/records/archive', async (c) => {
  const input = await parseJsonBody(c, archiveRecordSchema)
  const service = createServiceClient()
  const scopeRow = await fetchRecordScope(service, input.recordType, input.recordId)
  await requireScopedPermission(c, {
    code: 'medical_record.archive',
    tenantId: scopeRow.tenantId,
    storeId: scopeRow.storeId ?? undefined,
  })
  // F01:按实体归属租户解析当前操作人
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, scopeRow.tenantId)

  const rpcName = input.recordType === 'encounter' ? 'archive_encounter' : 'archive_admission'
  const idParam = input.recordType === 'encounter' ? 'p_encounter_id' : 'p_admission_id'
  const { data, error } = await service.rpc(rpcName, {
    [idParam]: input.recordId,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'medical_record.archive',
    entityType: input.recordType,
    entityId: input.recordId,
    tenantId: scopeRow.tenantId,
    storeId: scopeRow.storeId ?? undefined,
    metadata: { operatorEmployeeId },
  })
  return ok(c, data)
})

const requestAmendmentSchema = z.object({
  recordType: z.enum(['encounter', 'admission']),
  recordId: z.string().uuid('病历 id 格式错误'),
  reason: z.string().min(1, '修订原因不能为空').max(1000),
})

/**
 * 归档后修订申请(S3.1-1-A2)
 * - 权限:medical_record.amend.request
 * - 行为:调 request_record_amendment RPC,生成 before_snapshot,
 *   同一记录存在 pending 时拒绝重复申请;申请人由服务端推导(R03)
 */
complianceRoutes.post('/records/amendments/request', async (c) => {
  const input = await parseJsonBody(c, requestAmendmentSchema)
  const service = createServiceClient()
  const scopeRow = await fetchRecordScope(service, input.recordType, input.recordId)
  await requireScopedPermission(c, {
    code: 'medical_record.amend.request',
    tenantId: scopeRow.tenantId,
    storeId: scopeRow.storeId ?? undefined,
  })
  // F01:按实体归属租户解析当前操作人
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, scopeRow.tenantId)

  const { data, error } = await service.rpc('request_record_amendment', {
    p_medical_record_type: input.recordType,
    p_medical_record_id: input.recordId,
    p_reason: input.reason,
    p_requested_by_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'medical_record.amend.request',
    entityType: 'medical_record_amendment',
    entityId: (data as { id?: string })?.id,
    tenantId: scopeRow.tenantId,
    storeId: scopeRow.storeId ?? undefined,
    metadata: { recordType: input.recordType, recordId: input.recordId, reason: input.reason, requestedByEmployeeId: operatorEmployeeId },
  })
  return ok(c, data)
})
const reviewAmendmentSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(1000).optional().nullable(),
})

/**
 * 修订申请审批(S3.1-1-A2)
 * - 权限:medical_record.amend.approve
 * - 行为:先查 medical_record_amendments 拿归属再授权,调 review_record_amendment RPC;
 *   审批人由服务端推导(R03)
 */
complianceRoutes.post('/records/amendments/:id/review', async (c) => {
  const amendmentId = c.req.param('id')
  const input = await parseJsonBody(c, reviewAmendmentSchema)
  const service = createServiceClient()

  const { data: amendment, error: fetchErr } = await service
    .from('medical_record_amendments')
    .select('id, tenant_id, store_id, status')
    .eq('id', amendmentId)
    .maybeSingle()
  if (fetchErr || !amendment) {
    throw err.notFound('修订申请不存在')
  }
  await requireScopedPermission(c, {
    code: 'medical_record.amend.approve',
    tenantId: amendment.tenant_id,
    storeId: amendment.store_id ?? undefined,
  })
  // F01:按修订申请归属租户解析当前操作人
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, amendment.tenant_id)

  const { data, error } = await service.rpc('review_record_amendment', {
    p_amendment_id: amendmentId,
    p_decision: input.decision,
    p_reviewer_employee_id: operatorEmployeeId,
    p_reason: input.reason ?? null,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: input.decision === 'approved' ? 'medical_record.amend.approve' : 'medical_record.amend.reject',
    entityType: 'medical_record_amendment',
    entityId: amendmentId,
    tenantId: amendment.tenant_id,
    storeId: amendment.store_id,
    metadata: { decision: input.decision, reviewerEmployeeId: operatorEmployeeId, reason: input.reason },
  })
  return ok(c, data)
})

const applyAmendmentSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
})

/**
 * 执行修订(S3.1-1-A2)
 * - 权限:medical_record.amend.request
 * - 行为:先查表取归属再授权,调 apply_record_amendment RPC,
 *   创建新版本并保留 before/after 快照(原始版本永远保留);执行人由服务端推导(R03)
 */
complianceRoutes.post('/records/amendments/:id/apply', async (c) => {
  const amendmentId = c.req.param('id')
  const input = await parseJsonBody(c, applyAmendmentSchema)
  const service = createServiceClient()

  const { data: amendment, error: fetchErr } = await service
    .from('medical_record_amendments')
    .select('id, tenant_id, store_id, status')
    .eq('id', amendmentId)
    .maybeSingle()
  if (fetchErr || !amendment) {
    throw err.notFound('修订申请不存在')
  }
  await requireScopedPermission(c, {
    code: 'medical_record.amend.request',
    tenantId: amendment.tenant_id,
    storeId: amendment.store_id ?? undefined,
  })
  // F01:按修订申请归属租户解析当前操作人
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, amendment.tenant_id)

  const { data, error } = await service.rpc('apply_record_amendment', {
    p_amendment_id: amendmentId,
    p_apply_payload: input.payload,
    p_applied_by_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'medical_record.amend.apply',
    entityType: 'medical_record_amendment',
    entityId: amendmentId,
    tenantId: amendment.tenant_id,
    storeId: amendment.store_id,
    metadata: { appliedByEmployeeId: operatorEmployeeId },
  })
  return ok(c, data)
})

const upsertVetRegSchema = z.object({
  employeeId: z.string().uuid('员工 id 格式错误'),
  licenseNo: z.string().min(1, '执业证号不能为空').max(100),
  registrationNo: z.string().max(100).optional().nullable(),
  registrationAuthority: z.string().max(200).optional().nullable(),
  registrationRegion: z.string().max(100).optional().nullable(),
  validFrom: z.string().date('日期格式错误').optional().nullable(),
  validUntil: z.string().date('日期格式错误').optional().nullable(),
  status: z.enum(['active', 'inactive', 'expired']).optional(),
  signatureSpecimenFileId: z.string().uuid().optional().nullable(),
  electronicSignatureProvider: z.string().max(200).optional().nullable(),
  electronicSignatureSubjectId: z.string().max(200).optional().nullable(),
})

/**
 * 执业兽医备案管理(S3.1-1-A4)
 * - 权限:veterinarian_registration.manage
 * - 行为:调 upsert_veterinarian_registration RPC(tenant_id + license_no 幂等),
 *   只有有效备案的执业兽医可开具处方;租户/操作人由服务端推导(R03)
 */
complianceRoutes.post('/veterinarian-registrations/upsert', async (c) => {
  const input = await parseJsonBody(c, upsertVetRegSchema)
  const service = createServiceClient()
  // F01:先由【目标备案对象员工】确定可信目标租户,再授权、再解析当前操作人
  const { data: targetEmp, error: empErr } = await service
    .from('employees')
    .select('id, tenant_id')
    .eq('id', input.employeeId)
    .eq('status', 'active')
    .maybeSingle()
  if (empErr || !targetEmp) {
    throw err.notFound('备案对象员工不存在或未在职')
  }
  const scope = await requireScopedPermission(c, {
    code: 'veterinarian_registration.manage',
    tenantId: targetEmp.tenant_id,
  })
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, scope.tenantId)

  const { data, error } = await service.rpc('upsert_veterinarian_registration', {
    p_tenant_id: scope.tenantId,
    p_employee_id: input.employeeId,
    p_license_no: input.licenseNo,
    p_registration_no: input.registrationNo ?? null,
    p_registration_authority: input.registrationAuthority ?? null,
    p_registration_region: input.registrationRegion ?? null,
    p_valid_from: input.validFrom ?? null,
    p_valid_until: input.validUntil ?? null,
    p_status: input.status ?? 'active',
    p_signature_specimen_file_id: input.signatureSpecimenFileId ?? null,
    p_electronic_signature_provider: input.electronicSignatureProvider ?? null,
    p_electronic_signature_subject_id: input.electronicSignatureSubjectId ?? null,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'veterinarian_registration.upsert',
    entityType: 'veterinarian_registration',
    entityId: (data as { id?: string })?.id,
    tenantId: scope.tenantId,
    metadata: { employeeId: input.employeeId, licenseNo: input.licenseNo, operatorEmployeeId },
  })
  return ok(c, data)
})
const issuePrescriptionSchema = z.object({
  validUntil: z.string().datetime({ offset: true }).optional().nullable(),
})

/**
 * 处方开具(S3.1-1-A5/A6/A7)
 * - 权限:prescription.issue;含受控药时额外校验 prescription.controlled_issue
 * - 行为:先查 prescriptions 归属授权,再查明细判断是否含受控药
 *   (prescription_items join catalog_items join catalog_drug_extensions),
 *   受控药必须单独处方且麻醉药品不超过一日量;
 *   开方人由服务端推导 = 当前登录用户对应员工(R03)
 */
complianceRoutes.post('/prescriptions/:id/issue', async (c) => {
  const prescriptionId = c.req.param('id')
  const input = await parseJsonBody(c, issuePrescriptionSchema)
  const service = createServiceClient()
  const user = c.get('user')

  const { data: prescription, error: fetchErr } = await service
    .from('prescriptions')
    .select('id, tenant_id, store_id')
    .eq('id', prescriptionId)
    .maybeSingle()
  if (fetchErr || !prescription) {
    throw err.notFound('处方不存在')
  }
  await requireScopedPermission(c, {
    code: 'prescription.issue',
    tenantId: prescription.tenant_id,
    storeId: prescription.store_id ?? undefined,
  })
  // F01:按处方归属租户解析当前操作人(开方人)
  const prescriberEmployeeId = await resolveCurrentEmployee(service, c, prescription.tenant_id)

  // 受控药二重校验:明细含 controlled_class <> 'none' 时要求 prescription.controlled_issue
  const { data: items, error: itemsErr } = await service
    .from('prescription_items')
    .select('catalog_items(catalog_drug_extensions(controlled_class))')
    .eq('prescription_id', prescriptionId)
  if (itemsErr) {
    throw err.internal(`查询处方明细失败: ${itemsErr.message}`)
  }
  // supabase 嵌套 select 返回结构不可静态推导,统一断言为宽松结构后判定
  const rawItems = (items ?? []) as unknown as Array<{
    catalog_items?: { catalog_drug_extensions?: { controlled_class?: string } | { controlled_class?: string }[] | null } | null
  }>
  const hasControlled = rawItems.some((item) => {
    const ext = item.catalog_items?.catalog_drug_extensions
    const row = Array.isArray(ext) ? ext[0] : ext
    return row?.controlled_class != null && row.controlled_class !== 'none'
  })
  if (hasControlled) {
    await requireScopedPermission(c, {
      code: 'prescription.controlled_issue',
      tenantId: prescription.tenant_id,
      storeId: prescription.store_id ?? undefined,
    })
  }

  const { data, error } = await service.rpc('issue_prescription', {
    p_prescription_id: prescriptionId,
    p_prescriber_employee_id: prescriberEmployeeId,
    p_prescriber_user_id: user.id,
    p_valid_until: input.validUntil ?? null,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'prescription.issue',
    entityType: 'prescription',
    entityId: prescriptionId,
    tenantId: prescription.tenant_id,
    storeId: prescription.store_id,
    metadata: { prescriberEmployeeId, validUntil: input.validUntil, controlled: hasControlled },
  })
  return ok(c, data)
})

const extendValiditySchema = z.object({
  newValidUntil: z.string().datetime({ offset: true }),
})

/**
 * 延长处方有效期(S3.1-1-A5)
 * - 权限:prescription.extend_validity
 * - 行为:先查 prescriptions 归属授权,调 extend_prescription_validity RPC,
 *   仅 issued 可延长且不得超过开具日 + 3 天;操作人由服务端推导(R03)
 */
complianceRoutes.post('/prescriptions/:id/extend-validity', async (c) => {
  const prescriptionId = c.req.param('id')
  const input = await parseJsonBody(c, extendValiditySchema)
  const service = createServiceClient()

  const { data: prescription, error: fetchErr } = await service
    .from('prescriptions')
    .select('id, tenant_id, store_id')
    .eq('id', prescriptionId)
    .maybeSingle()
  if (fetchErr || !prescription) {
    throw err.notFound('处方不存在')
  }
  await requireScopedPermission(c, {
    code: 'prescription.extend_validity',
    tenantId: prescription.tenant_id,
    storeId: prescription.store_id ?? undefined,
  })
  // F01:按处方归属租户解析当前操作人
  const operatorEmployeeId = await resolveCurrentEmployee(service, c, prescription.tenant_id)

  const { data, error } = await service.rpc('extend_prescription_validity', {
    p_prescription_id: prescriptionId,
    p_new_valid_until: input.newValidUntil,
    p_operator_employee_id: operatorEmployeeId,
  })
  if (error) {
    throw mapRpcError(error)
  }

  await writeAudit(c, {
    action: 'prescription.extend_validity',
    entityType: 'prescription',
    entityId: prescriptionId,
    tenantId: prescription.tenant_id,
    storeId: prescription.store_id,
    metadata: { newValidUntil: input.newValidUntil, operatorEmployeeId },
  })
  return ok(c, data)
})

export default complianceRoutes
