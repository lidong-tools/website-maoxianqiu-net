import type { AppEnv } from '../lib/types'
import process from 'node:process'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { ApiError, err } from '../lib/errors'
import { requireScopedPermission } from '../lib/permission'
import { getContext, loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

/**
 * Operations 领域 Command 路由(MXQ-12001~12009)
 *
 * 路由清单:
 *   - POST /operations/points/adjust              (MXQ-12002 调整积分)
 *   - POST /operations/reminders/scan             (MXQ-12004 提醒扫描)
 *   - POST /operations/deliveries/:id/send        (MXQ-12005 触发发送)
 *   - POST /operations/imports                    (MXQ-12006 创建导入任务)
 *   - GET  /operations/imports/:id                (MXQ-12006 导入任务详情)
 *   - POST /operations/print                      (MXQ-12007 创建打印任务)
 *   - GET  /operations/print/:id                  (MXQ-12007 打印任务详情)
 *   - POST /operations/reports/:code/generate     (MXQ-12008 生成报表快照)
 *   - GET  /operations/reports                    (MXQ-12008 报表定义列表)
 *   - GET  /operations/security-events            (MXQ-12009 安全事件,仅超管)
 *
 * 状态机:
 *   reminders:     pending → sent / pending → cancelled
 *   deliveries:    queued → sent / queued → failed / queued → retry → sent
 *   import_tasks:  pending → processing → completed | failed
 *   print_jobs:    queued → printed / queued → failed
 */
const operationsRoutes = new Hono<AppEnv>()

operationsRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

// ===== MXQ-12002 调整积分 =====
const adjustPointsSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
  delta: z.number().int().refine(v => v !== 0, 'delta 不可为 0'),
  reason: z.enum(['purchase', 'redeem', 'adjust', 'expiry']),
  referenceId: z.string().uuid().optional(),
  referenceType: z.string().max(64).optional(),
})

/**
 * 调整积分(MXQ-12002)
 * - 权限:points.adjust
 * - 行为:调 adjust_points RPC,事务化更新余额 + 写流水 + 幂等控制
 * - 幂等键通过 idempotency-key header 传入
 */
operationsRoutes.post('/points/adjust', async (c) => {
  const input = await parseJsonBody(c, adjustPointsSchema)
  const scope = await requireScopedPermission(c, { code: 'points.adjust', tenantId: input.tenantId })

  const service = createServiceClient()
  const user = c.get('user')
  const idempotencyKey = c.req.header('idempotency-key') || null

  const { data, error: rpcError } = await service.rpc('adjust_points', {
    p_tenant_id: scope.tenantId,
    p_customer_id: input.customerId,
    p_delta: input.delta,
    p_reason: input.reason,
    p_reference_id: input.referenceId ?? null,
    p_reference_type: input.referenceType ?? null,
    p_operator_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (rpcError) {
    if (rpcError.message.includes('INVALID_DELTA')) {
      throw err.badRequest('积分变动值不可为 0')
    }
    if (rpcError.message.includes('INVALID_REASON')) {
      throw err.badRequest('积分变动原因无效')
    }
    if (rpcError.message.includes('INSUFFICIENT_POINTS')) {
      throw err.unprocessable('积分余额不足')
    }
    throw err.internal(`调整积分失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'points.adjust',
    entityType: 'point_transaction',
    entityId: data?.transaction_id ?? null,
    tenantId: input.tenantId,
    metadata: {
      customerId: input.customerId,
      delta: input.delta,
      reason: input.reason,
      balanceAfter: data?.balance_after,
    },
  })

  return ok(c, data)
})

// ===== MXQ-12004 提醒扫描 =====
const scanRemindersSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
})

/**
 * 扫描到期提醒(MXQ-12004)
 * - 权限:reminder.manage
 * - 行为:调 scan_reminders RPC,扫描 pending 且到期的提醒,生成发送任务
 */
operationsRoutes.post('/reminders/scan', async (c) => {
  const input = await parseJsonBody(c, scanRemindersSchema)
  const scope = await requireScopedPermission(c, { code: 'reminder.manage', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const { data, error: rpcError } = await service.rpc('scan_reminders', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
  })

  if (rpcError) {
    throw err.internal(`扫描提醒失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'reminders.scan',
    entityType: 'reminder',
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: data,
  })

  return ok(c, data)
})

// ===== MXQ-12005 触发发送 =====
/** 真实消息供应商是否已配置(MESSAGE_PROVIDER=real 且带供应商凭据) */
function isRealMessageProviderConfigured(): boolean {
  return process.env.MESSAGE_PROVIDER === 'real'
}

/** 当前是否为生产环境 */
function isProductionEnv(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
}

/**
 * 触发发送(MXQ-12005)
 * - 权限:message.manage
 * - 行为:调 send_delivery RPC,供应商适配模拟发送
 *   (queued/retry → sent/failed,写 provider_message_id 与发送结果)
 * - 幂等:已终态(sent/failed)的交付重复调用直接返回,不重复发送
 * - P0-07 消息退出 MVP:未配置真实供应商(MESSAGE_PROVIDER=real)时,
 *   生产环境直接返回 PROVIDER_NOT_CONFIGURED,不调用 RPC、不把 delivery 标记为 sent
 */
operationsRoutes.post('/deliveries/:id/send', async (c) => {
  const deliveryId = c.req.param('id')

  // P0-07:生产环境禁止 Mock 发送。若未配置真实供应商,拒绝执行且不标记 sent
  if (isProductionEnv() && !isRealMessageProviderConfigured()) {
    throw new ApiError(
      422,
      'PROVIDER_NOT_CONFIGURED',
      '生产环境未配置消息供应商,消息功能暂不可用(MVP 阶段已延期)',
    )
  }

  const service = createServiceClient()
  // 先查 delivery 实体获取 tenant/store,再授权(防止跨租户直接操作)
  const { data: delivery, error: fetchError } = await service
    .from('message_deliveries')
    .select('id, tenant_id, store_id, status')
    .eq('id', deliveryId)
    .maybeSingle()
  if (fetchError || !delivery) {
    throw err.notFound('发送任务不存在')
  }
  await requireScopedPermission(c, {
    code: 'message.manage',
    tenantId: delivery.tenant_id,
    storeId: delivery.store_id ?? undefined,
  })

  const { data, error: rpcError } = await service.rpc('send_delivery', {
    p_delivery_id: deliveryId,
  })

  if (rpcError) {
    if (rpcError.message.includes('DELIVERY_NOT_FOUND')) {
      throw err.notFound('发送任务不存在')
    }
    throw err.internal(`发送失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'delivery.send',
    entityType: 'message_delivery',
    entityId: deliveryId,
    tenantId: data?.tenant_id,
    metadata: {
      providerMessageId: data?.provider_message_id,
      reminderId: data?.reminder_id,
    },
  })

  return ok(c, data)
})

// ===== MXQ-12006 导入任务 =====
const createImportSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  type: z.enum(['customer', 'pet', 'product', 'inventory']),
  fileId: z.string().uuid().optional(),
})

/**
 * 创建导入任务(MXQ-12006)
 * - 权限:imports.manage
 * - 行为:调 create_import_task RPC,事务化建任务 + 入队 jobs
 */
operationsRoutes.post('/imports', async (c) => {
  const input = await parseJsonBody(c, createImportSchema)
  const scope = await requireScopedPermission(c, { code: 'imports.manage', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error: rpcError } = await service.rpc('create_import_task', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_type: input.type,
    p_file_id: input.fileId ?? null,
    p_created_by: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('INVALID_IMPORT_TYPE')) {
      throw err.badRequest('导入类型无效')
    }
    throw err.internal(`创建导入任务失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'imports.create',
    entityType: 'import_task',
    entityId: data?.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: { type: input.type, fileId: input.fileId },
  })

  return ok(c, data)
})

/**
 * 查询导入任务详情(MXQ-12006)
 * - 权限:imports.manage
 * - 行为:service role 直查,绕过 RLS 限制(API 层做权限校验)
 */
operationsRoutes.get('/imports/:id', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  // 先查导入任务实体获取 tenant,再授权(防止跨租户直接读取)
  const { data, error } = await service
    .from('import_tasks')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    throw err.internal(`查询导入任务失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('导入任务不存在')
  }

  // 跨租户隔离:仅调用者所属租户的导入任务可读
  await requireScopedPermission(c, { code: 'imports.manage', tenantId: data.tenant_id, storeId: data.store_id ?? undefined })

  return ok(c, data)
})

// ===== MXQ-12007 打印 =====
const createPrintSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid().optional(),
  templateId: z.string().uuid('模板 id 格式错误'),
  entityType: z.string().min(1, '实体类型不可为空').max(64),
  entityId: z.string().uuid('实体 id 格式错误'),
})

/**
 * 创建打印任务(MXQ-12007)
 * - 权限:print.manage
 * - 行为:调 create_print_job RPC,事务化建打印任务
 */
operationsRoutes.post('/print', async (c) => {
  const input = await parseJsonBody(c, createPrintSchema)
  const scope = await requireScopedPermission(c, { code: 'print.manage', tenantId: input.tenantId, storeId: input.storeId })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error: rpcError } = await service.rpc('create_print_job', {
    p_tenant_id: scope.tenantId,
    p_store_id: scope.storeId ?? null,
    p_template_id: input.templateId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_operator_id: user.id,
  })

  if (rpcError) {
    throw err.internal(`创建打印任务失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'print.create',
    entityType: 'print_job',
    entityId: data?.id,
    tenantId: input.tenantId,
    storeId: input.storeId,
    metadata: {
      templateId: input.templateId,
      entityType: input.entityType,
      entityId: input.entityId,
    },
  })

  return ok(c, data)
})

/**
 * 查询打印任务详情(MXQ-12007)
 * - 权限:print.manage
 * - 行为:service role 直查,绕过 RLS 限制
 */
operationsRoutes.get('/print/:id', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  // 先查打印任务实体获取 tenant,再授权(防止跨租户直接读取)
  const { data, error } = await service
    .from('print_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    throw err.internal(`查询打印任务失败: ${error.message}`)
  }
  if (!data) {
    throw err.notFound('打印任务不存在')
  }

  // 跨租户隔离:仅调用者所属租户的打印任务可读
  await requireScopedPermission(c, { code: 'print.manage', tenantId: data.tenant_id, storeId: data.store_id ?? undefined })

  return ok(c, data)
})

// ===== P0-05 打印真实业务数据 DTO =====

/** 打印实体类型(与前端 PRINT_TEMPLATE_TYPE_LABELS 对齐) */
type PrintEntityType = 'invoice' | 'medical_record' | 'prescription' | 'lab_report' | 'vaccine_certificate'
const PRINT_ENTITY_TYPES: PrintEntityType[] = ['invoice', 'medical_record', 'prescription', 'lab_report', 'vaccine_certificate']

/** 打印单据通用信息(医院/门店/客户/宠物/医生/操作员) */
interface PrintBase {
  hospital: { name: string, shortName?: string }
  store: { name: string, code?: string, address?: string, phone?: string } | null
  customer: { name: string, phone?: string, gender?: string } | null
  pet: { name: string, species?: string, breed?: string, gender?: string, weight?: number } | null
  doctor: { name: string, title?: string } | null
  operator: { name: string } | null
  createdAt: string
}

/** 收费单打印区段 */
interface InvoicePrintSection {
  invoiceNo: string
  status: string
  subtotal: number
  discountAmount: number
  discountReason?: string | null
  taxAmount: number
  total: number
  paidAmount: number
  paymentMethod?: string | null
  dueDate?: string | null
  items: Array<{
    name: string
    unitPrice: number
    quantity: number
    discountAmount: number
    amount: number
    category?: string
  }>
}

/** 病历打印区段 */
interface MedicalRecordPrintSection {
  status: string
  startedAt?: string | null
  endedAt?: string | null
  chiefComplaint?: string | null
  historyPresent?: string | null
  examFindings?: string | null
  diagnosisCodes: string[]
  diagnosisText?: string | null
  treatmentPlan?: string | null
  followUpDate?: string | null
  signedAt?: string | null
}

/** 处方打印区段 */
interface PrescriptionPrintSection {
  status: string
  items: Array<{
    drugName: string
    dosage?: string | null
    frequency?: string | null
    durationDays?: number | null
    quantity: number
    unit?: string | null
    instructions?: string | null
  }>
}

/** 检验报告打印区段 */
interface LabReportPrintSection {
  orderNo: string
  status: string
  requestedAt?: string | null
  completedAt?: string | null
  analytes: Array<{
    name: string
    resultValue?: string | null
    unit?: string | null
    refRange?: string | null
    isAbnormal: boolean
    isCritical: boolean
    flag?: string | null
    note?: string | null
  }>
}

/** 疫苗证明打印区段 */
interface VaccineCertificatePrintSection {
  certificateNo: string
  status: string
  issuedDate?: string | null
  vaccinations: Array<{
    vaccineName?: string | null
    doseNo?: number | null
    administeredDate?: string | null
    batchNo?: string | null
    manufacturer?: string | null
    nextDueDate?: string | null
  }>
}

/** 统一打印 DTO(P0-05) */
interface PrintData extends PrintBase {
  entityType: PrintEntityType
  entityId: string
  invoice?: InvoicePrintSection
  medicalRecord?: MedicalRecordPrintSection
  prescription?: PrescriptionPrintSection
  labReport?: LabReportPrintSection
  vaccineCertificate?: VaccineCertificatePrintSection
}

/** 格式化金额为 number(兼容 numeric 字符串) */
function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0) || 0
}

/**
 * 并行加载打印单据通用信息(医院/门店/客户/宠物/医生/操作员)
 * @param service supabase service client
 * @param tenantId 租户 id
 * @param storeId 门店 id(可空)
 * @param customerId 客户 id(可空)
 * @param petId 宠物 id(可空)
 * @param doctorUserId 医生 auth.users id(可空)
 * @param operatorUserId 操作员 auth.users id(可空)
 * @returns 通用信息
 */
async function fetchPrintBase(
  service: ReturnType<typeof createServiceClient>,
  opts: {
    tenantId: string
    storeId?: string | null
    customerId?: string | null
    petId?: string | null
    doctorUserId?: string | null
    operatorUserId?: string | null
  },
): Promise<PrintBase> {
  const [tenantRes, storeRes, customerRes, petRes, doctorRes, operatorRes] = await Promise.all([
    service.from('tenants').select('name, short_name').eq('id', opts.tenantId).maybeSingle(),
    opts.storeId
      ? service.from('stores').select('name, code, address, phone').eq('id', opts.storeId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    opts.customerId
      ? service.from('customers').select('name, phone, gender').eq('id', opts.customerId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    opts.petId
      ? service.from('pets').select('name, species, breed, gender, weight').eq('id', opts.petId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    opts.doctorUserId
      ? service.from('employees').select('name, title').eq('tenant_id', opts.tenantId).eq('user_id', opts.doctorUserId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    opts.operatorUserId
      ? service.from('employees').select('name').eq('tenant_id', opts.tenantId).eq('user_id', opts.operatorUserId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  const t = tenantRes.data
  const s = storeRes.data
  const c = customerRes.data
  const p = petRes.data
  const d = doctorRes.data
  const o = operatorRes.data

  return {
    hospital: { name: t?.name ?? '毛线球宠物医院', shortName: t?.short_name ?? undefined },
    store: s ? { name: s.name, code: s.code ?? undefined, address: s.address ?? undefined, phone: s.phone ?? undefined } : null,
    customer: c ? { name: c.name, phone: c.phone ?? undefined, gender: c.gender ?? undefined } : null,
    pet: p
      ? {
          name: p.name,
          species: p.species ?? undefined,
          breed: p.breed ?? undefined,
          gender: p.gender ?? undefined,
          weight: p.weight ? toNum(p.weight) : undefined,
        }
      : null,
    doctor: d ? { name: d.name, title: d.title ?? undefined } : null,
    operator: o ? { name: o.name } : null,
    createdAt: new Date().toISOString(),
  }
}

/**
 * 获取收费单打印数据
 */
async function buildInvoicePrint(service: ReturnType<typeof createServiceClient>, entityId: string): Promise<{ base: PrintBase, section: InvoicePrintSection }> {
  const { data: inv, error: invErr } = await service
    .from('invoices')
    .select('tenant_id, store_id, invoice_no, customer_id, pet_id, subtotal, discount_amount, discount_reason, tax_amount, total, paid_amount, status, payment_method, due_date, created_by, created_at')
    .eq('id', entityId)
    .maybeSingle()
  if (invErr || !inv) {
    throw err.notFound('收费单不存在')
  }

  const base = await fetchPrintBase(service, {
    tenantId: inv.tenant_id,
    storeId: inv.store_id,
    customerId: inv.customer_id,
    petId: inv.pet_id,
    operatorUserId: inv.created_by,
  })

  const { data: items, error: itemsErr } = await service
    .from('invoice_items')
    .select('name, unit_price, quantity, discount_amount, amount, category')
    .eq('invoice_id', entityId)
    .order('sort_order', { ascending: true })
  if (itemsErr) {
    throw err.internal(`加载发票明细失败: ${itemsErr.message}`)
  }

  const section: InvoicePrintSection = {
    invoiceNo: inv.invoice_no,
    status: inv.status,
    subtotal: toNum(inv.subtotal),
    discountAmount: toNum(inv.discount_amount),
    discountReason: inv.discount_reason ?? null,
    taxAmount: toNum(inv.tax_amount),
    total: toNum(inv.total),
    paidAmount: toNum(inv.paid_amount),
    paymentMethod: inv.payment_method ?? null,
    dueDate: inv.due_date ?? null,
    items: (items ?? []).map(it => ({
      name: it.name,
      unitPrice: toNum(it.unit_price),
      quantity: toNum(it.quantity),
      discountAmount: toNum(it.discount_amount),
      amount: toNum(it.amount),
      category: it.category ?? undefined,
    })),
  }
  return { base, section }
}

/**
 * 获取病历打印数据
 */
async function buildMedicalRecordPrint(service: ReturnType<typeof createServiceClient>, entityId: string): Promise<{ base: PrintBase, section: MedicalRecordPrintSection }> {
  const { data: enc, error: encErr } = await service
    .from('encounters')
    .select('tenant_id, store_id, customer_id, pet_id, doctor_id, started_at, ended_at, status, chief_complaint, history_present, exam_findings, diagnosis_codes, diagnosis_text, treatment_plan, follow_up_date, signed_at')
    .eq('id', entityId)
    .maybeSingle()
  if (encErr || !enc) {
    throw err.notFound('病历记录不存在')
  }

  const base = await fetchPrintBase(service, {
    tenantId: enc.tenant_id,
    storeId: enc.store_id,
    customerId: enc.customer_id,
    petId: enc.pet_id,
    doctorUserId: enc.doctor_id,
  })

  const section: MedicalRecordPrintSection = {
    status: enc.status,
    startedAt: enc.started_at ?? null,
    endedAt: enc.ended_at ?? null,
    chiefComplaint: enc.chief_complaint ?? null,
    historyPresent: enc.history_present ?? null,
    examFindings: enc.exam_findings ?? null,
    diagnosisCodes: enc.diagnosis_codes ?? [],
    diagnosisText: enc.diagnosis_text ?? null,
    treatmentPlan: enc.treatment_plan ?? null,
    followUpDate: enc.follow_up_date ?? null,
    signedAt: enc.signed_at ?? null,
  }
  return { base, section }
}

/**
 * 获取处方打印数据
 */
async function buildPrescriptionPrint(service: ReturnType<typeof createServiceClient>, entityId: string): Promise<{ base: PrintBase, section: PrescriptionPrintSection }> {
  const { data: rx, error: rxErr } = await service
    .from('prescriptions')
    .select('tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status, created_at')
    .eq('id', entityId)
    .maybeSingle()
  if (rxErr || !rx) {
    throw err.notFound('处方不存在')
  }

  const base = await fetchPrintBase(service, {
    tenantId: rx.tenant_id,
    storeId: rx.store_id,
    customerId: rx.customer_id,
    petId: rx.pet_id,
    doctorUserId: rx.doctor_id,
  })

  const { data: items, error: itemsErr } = await service
    .from('prescription_items')
    .select('drug_name, dosage, frequency, duration_days, quantity, unit, instructions')
    .eq('prescription_id', entityId)
    .order('sort_order', { ascending: true })
  if (itemsErr) {
    throw err.internal(`加载处方明细失败: ${itemsErr.message}`)
  }

  const section: PrescriptionPrintSection = {
    status: rx.status,
    items: (items ?? []).map(it => ({
      drugName: it.drug_name,
      dosage: it.dosage ?? null,
      frequency: it.frequency ?? null,
      durationDays: it.duration_days ?? null,
      quantity: toNum(it.quantity),
      unit: it.unit ?? null,
      instructions: it.instructions ?? null,
    })),
  }
  return { base, section }
}

/**
 * 获取检验报告打印数据
 */
async function buildLabReportPrint(service: ReturnType<typeof createServiceClient>, entityId: string): Promise<{ base: PrintBase, section: LabReportPrintSection }> {
  const { data: order, error: orderErr } = await service
    .from('lab_orders')
    .select('tenant_id, store_id, customer_id, pet_id, order_no, status, requested_by, requested_at, completed_at')
    .eq('id', entityId)
    .maybeSingle()
  if (orderErr || !order) {
    throw err.notFound('检验报告不存在')
  }

  const base = await fetchPrintBase(service, {
    tenantId: order.tenant_id,
    storeId: order.store_id,
    customerId: order.customer_id,
    petId: order.pet_id,
    operatorUserId: order.requested_by,
  })

  const { data: analytes, error: analytesErr } = await service
    .from('lab_order_analytes')
    .select('analyte_id, result_value, result_numeric, is_abnormal, is_critical, flag, note')
    .eq('lab_order_id', entityId)
    .order('created_at', { ascending: true })
  if (analytesErr) {
    throw err.internal(`加载检验结果失败: ${analytesErr.message}`)
  }

  // 批量加载检验项目定义(name/unit/ref_range_text)
  const analyteIds = [...new Set((analytes ?? []).map(a => a.analyte_id).filter(Boolean))] as string[]
  let analyteDefs: Array<{ id: string, name: string, unit?: string, ref_range_text?: string }> = []
  if (analyteIds.length > 0) {
    const { data, error: defErr } = await service
      .from('lab_analytes')
      .select('id, name, unit, ref_range_text')
      .in('id', analyteIds)
    if (!defErr) {
      analyteDefs = data ?? []
    }
  }
  const defMap = new Map(analyteDefs.map(d => [d.id, d]))

  const section: LabReportPrintSection = {
    orderNo: order.order_no,
    status: order.status,
    requestedAt: order.requested_at ?? null,
    completedAt: order.completed_at ?? null,
    analytes: (analytes ?? []).map((a) => {
      const def = a.analyte_id ? defMap.get(a.analyte_id) : undefined
      return {
        name: def?.name ?? '未知项目',
        resultValue: a.result_value ?? (a.result_numeric != null ? String(a.result_numeric) : null),
        unit: def?.unit ?? null,
        refRange: def?.ref_range_text ?? null,
        isAbnormal: a.is_abnormal ?? false,
        isCritical: a.is_critical ?? false,
        flag: a.flag ?? null,
        note: a.note ?? null,
      }
    }),
  }
  return { base, section }
}

/**
 * 获取疫苗证明打印数据
 */
async function buildVaccineCertificatePrint(service: ReturnType<typeof createServiceClient>, entityId: string): Promise<{ base: PrintBase, section: VaccineCertificatePrintSection }> {
  const { data: cert, error: certErr } = await service
    .from('vaccine_certificates')
    .select('tenant_id, store_id, pet_id, customer_id, vaccination_id, certificate_no, issued_date, issued_by, status')
    .eq('id', entityId)
    .maybeSingle()
  if (certErr || !cert) {
    throw err.notFound('疫苗证明不存在')
  }

  const base = await fetchPrintBase(service, {
    tenantId: cert.tenant_id,
    storeId: cert.store_id,
    customerId: cert.customer_id,
    petId: cert.pet_id,
    operatorUserId: cert.issued_by,
  })

  // 加载关联疫苗接种记录
  const { data: vax, error: vaxErr } = await service
    .from('vaccinations')
    .select('vaccine_catalog_item_id, dose_no, administered_date, batch_no, manufacturer, next_due_date')
    .eq('id', cert.vaccination_id)
    .maybeSingle()
  if (vaxErr) {
    throw err.internal(`加载疫苗记录失败: ${vaxErr.message}`)
  }

  // 疫苗名称(优先取 catalog_items.name,缺失时回退到 certificate_data/'-')
  let vaccineName: string | null = null
  if (vax?.vaccine_catalog_item_id) {
    const { data: item } = await service
      .from('catalog_items')
      .select('name')
      .eq('id', vax.vaccine_catalog_item_id)
      .maybeSingle()
    vaccineName = item?.name ?? null
  }

  const section: VaccineCertificatePrintSection = {
    certificateNo: cert.certificate_no,
    status: cert.status,
    issuedDate: cert.issued_date ?? null,
    vaccinations: vax
      ? [{
          vaccineName,
          doseNo: vax.dose_no ?? null,
          administeredDate: vax.administered_date ?? null,
          batchNo: vax.batch_no ?? null,
          manufacturer: vax.manufacturer ?? null,
          nextDueDate: vax.next_due_date ?? null,
        }]
      : [],
  }
  return { base, section }
}

/**
 * 获取打印真实业务数据(P0-05)
 * GET /api/operations/print-data/:entityType/:entityId
 * - 权限:print.manage(先查实体取 tenant/store 再 scoped 授权)
 * - 行为:聚合真实业务数据并返回标准 DTO,前端模板只负责渲染
 */
operationsRoutes.get('/print-data/:entityType/:entityId', async (c) => {
  const entityType = c.req.param('entityType') as PrintEntityType
  const entityId = c.req.param('entityId')

  if (!PRINT_ENTITY_TYPES.includes(entityType)) {
    throw err.badRequest('不支持的打印实体类型')
  }

  const service = createServiceClient()

  // 先查实体获取 tenant_id/store_id,再 scoped 授权(防止跨租户/门店读取)
  const entityRes = await (async () => {
    switch (entityType) {
      case 'invoice':
        return service.from('invoices').select('tenant_id, store_id').eq('id', entityId).maybeSingle()
      case 'medical_record':
        return service.from('encounters').select('tenant_id, store_id').eq('id', entityId).maybeSingle()
      case 'prescription':
        return service.from('prescriptions').select('tenant_id, store_id').eq('id', entityId).maybeSingle()
      case 'lab_report':
        return service.from('lab_orders').select('tenant_id, store_id').eq('id', entityId).maybeSingle()
      case 'vaccine_certificate':
        return service.from('vaccine_certificates').select('tenant_id, store_id').eq('id', entityId).maybeSingle()
    }
  })()

  if (entityRes.error || !entityRes.data) {
    throw err.notFound('打印实体不存在')
  }
  const entity = entityRes.data as { tenant_id: string, store_id: string | null }

  await requireScopedPermission(c, {
    code: 'print.manage',
    tenantId: entity.tenant_id,
    storeId: entity.store_id ?? undefined,
  })

  // 聚合真实业务数据
  let base: PrintBase
  let section: PrintData['invoice'] | PrintData['medicalRecord'] | PrintData['prescription'] | PrintData['labReport'] | PrintData['vaccineCertificate']

  switch (entityType) {
    case 'invoice': {
      const r = await buildInvoicePrint(service, entityId)
      base = r.base
      section = r.section
      break
    }
    case 'medical_record': {
      const r = await buildMedicalRecordPrint(service, entityId)
      base = r.base
      section = r.section
      break
    }
    case 'prescription': {
      const r = await buildPrescriptionPrint(service, entityId)
      base = r.base
      section = r.section
      break
    }
    case 'lab_report': {
      const r = await buildLabReportPrint(service, entityId)
      base = r.base
      section = r.section
      break
    }
    case 'vaccine_certificate': {
      const r = await buildVaccineCertificatePrint(service, entityId)
      base = r.base
      section = r.section
      break
    }
  }

  const data: PrintData = {
    ...base,
    entityType,
    entityId,
    [entityType === 'invoice' ? 'invoice' : entityType === 'medical_record' ? 'medicalRecord' : entityType === 'prescription' ? 'prescription' : entityType === 'lab_report' ? 'labReport' : 'vaccineCertificate']: section,
  } as PrintData

  await writeAudit(c, {
    action: 'print.data',
    entityType: entityType === 'invoice' ? 'invoice' : entityType === 'medical_record' ? 'encounter' : entityType === 'prescription' ? 'prescription' : entityType === 'lab_report' ? 'lab_order' : 'vaccine_certificate',
    entityId,
    tenantId: entity.tenant_id,
    storeId: entity.store_id ?? undefined,
    metadata: { entityType },
  })

  return ok(c, data)
})

// ===== MXQ-12008 报表 =====
const generateReportSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '起始日期格式应为 YYYY-MM-DD'),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '结束日期格式应为 YYYY-MM-DD'),
})

/**
 * 生成报表快照(MXQ-12008)
 * - 权限:reports.view
 * - 行为:调 generate_report_snapshot RPC,按报表定义 category 执行聚合查询并落快照
 * - 实时明细:见 GET /operations/report-data/:reportCode(P0-06 统一报表真源)
 */
operationsRoutes.post('/reports/:code/generate', async (c) => {
  const reportCode = c.req.param('code')
  const input = await parseJsonBody(c, generateReportSchema)
  const scope = await requireScopedPermission(c, { code: 'reports.view', tenantId: input.tenantId })

  const service = createServiceClient()
  const user = c.get('user')
  const { data, error: rpcError } = await service.rpc('generate_report_snapshot', {
    p_tenant_id: scope.tenantId,
    p_report_code: reportCode,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_generated_by: user.id,
  })

  if (rpcError) {
    if (rpcError.message.includes('REPORT_DEFINITION_NOT_FOUND')) {
      throw err.notFound('报表定义不存在或未启用')
    }
    if (rpcError.message.includes('INVALID_PERIOD')) {
      throw err.badRequest('起始日期不能晚于结束日期')
    }
    throw err.internal(`生成报表失败: ${rpcError.message}`)
  }

  await writeAudit(c, {
    action: 'reports.generate',
    entityType: 'report_snapshot',
    entityId: data?.id,
    tenantId: input.tenantId,
    metadata: {
      reportCode,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    },
  })

  return ok(c, data)
})

/**
 * 查询报表定义列表(MXQ-12008)
 * - 权限:reports.view
 * - 行为:service role 直查,绕过 RLS 限制
 */
operationsRoutes.get('/reports', async (c) => {
  const tenantId = c.req.query('tenantId')
  const category = c.req.query('category')
  const onlyActive = c.req.query('onlyActive') === 'true'

  // 租户归属校验:tenantId 由客户端提供时必须属于调用者(防止跨租户直查);
  // 未提供时优先取请求上下文租户(getContext(c).tenantId),仅兜底回退 memberships[0]
  const scope = await requireScopedPermission(c, {
    code: 'reports.view',
    tenantId: tenantId ?? getContext(c).tenantId ?? (getContext(c).memberships[0]?.tenant_id ?? ''),
  })

  const service = createServiceClient()
  let query = service
    .from('report_definitions')
    .select('*', { count: 'exact' })
    // 未指定 tenant 时,仅返回调用者所属租户的报表定义;指定时由 requireScopedPermission 保证归属
    .eq('tenant_id', scope.tenantId)
  if (category) {
    query = query.eq('category', category)
  }
  if (onlyActive) {
    query = query.eq('is_active', true)
  }

  const { data, error, count } = await query.order('created_at', { ascending: false })

  if (error) {
    throw err.internal(`查询报表列表失败: ${error.message}`)
  }

  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ===== MXQ-12009 安全事件 =====
/**
 * 查询安全事件列表(MXQ-12009)
 * - 权限:security.view(seed 中仅 system_admin 角色被授予该权限码,保持"仅超管可读"语义)
 * - 行为:service role 直查 security_events(仅 service_role 写入)
 */
operationsRoutes.get('/security-events', async (c) => {
  const tenantId = c.req.query('tenantId')
  const eventType = c.req.query('eventType')
  const severity = c.req.query('severity')
  const from = Number(c.req.query('from') ?? 0)
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)

  // 租户归属校验:tenantId 由客户端提供时必须属于调用者(防止跨租户直查);
  // 未提供时优先取请求上下文租户(getContext(c).tenantId),仅兜底回退 memberships[0]
  const scope = await requireScopedPermission(c, {
    code: 'security.view',
    tenantId: tenantId ?? getContext(c).tenantId ?? getContext(c).memberships[0]?.tenant_id ?? '',
  })

  const service = createServiceClient()
  let query = service
    .from('security_events')
    .select('*', { count: 'exact' })
    // 强制限定到授权作用域租户
    .eq('tenant_id', scope.tenantId)
  if (eventType) {
    query = query.eq('event_type', eventType)
  }
  if (severity) {
    query = query.eq('severity', severity)
  }
  query = query.range(from, from + limit - 1)

  const { data, error, count } = await query.order('created_at', { ascending: false })

  if (error) {
    throw err.internal(`查询安全事件失败: ${error.message}`)
  }

  await writeAudit(c, {
    action: 'security.events.view',
    entityType: 'security_event',
    metadata: {
      filters: { tenantId: scope.tenantId, eventType, severity, from, limit },
      total: count,
    },
  })

  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ============================================================
// 会员中心产品化(Agent-02 S3.1)
// 路由清单:
//   - GET  /operations/membership-tiers          会员等级列表
//   - POST /operations/membership-tiers          新建等级
//   - PATCH /operations/membership-tiers/:id     更新等级(禁用物理删除已使用等级)
//   - GET  /operations/customer-memberships      客户会员列表(含客户姓名/手机/等级)
//   - PATCH /operations/customer-memberships/:id 调整等级/有效期
//   - GET  /operations/point-transactions        积分流水(只读,不可改)
//   - GET  /operations/discount-rules            折扣规则列表
//   - POST /operations/discount-rules            新建折扣规则
//   - PATCH /operations/discount-rules/:id       更新折扣规则
//   - DELETE /operations/discount-rules/:id      删除折扣规则
//   - POST /operations/membership-pricing-preview 有效会员定价预览(RPC)
// ============================================================

// ===== 会员等级 =====
const membershipTierSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  code: z.string().min(1, '等级编码不能为空').max(50),
  name: z.string().min(1, '等级名称不能为空').max(50),
  discountPercent: z.number().min(0, '折扣不可为负').max(100, '折扣不可超过 100%'),
  pointsMultiplier: z.number().min(0, '积分倍率不可为负').max(100),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

/**
 * 会员等级列表
 * - 权限:membership.view
 */
operationsRoutes.get('/membership-tiers', async (c) => {
  const tenantId = c.req.query('tenantId')
  const onlyActive = c.req.query('onlyActive') === 'true'
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  const scope = await requireScopedPermission(c, {
    code: 'membership.view',
    tenantId,
    dataScope: true,
  })

  const service = createServiceClient()
  let query = service
    .from('membership_tiers')
    .select('*', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
  if (onlyActive) {
    query = query.eq('is_active', true)
  }
  const { data, error, count } = await query.order('sort_order', { ascending: true })
  if (error) {
    throw err.internal(`查询会员等级失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

/**
 * 新建会员等级
 * - 权限:membership.manage(租户级)
 * - code 租户内唯一由 DB 唯一索引兜底
 */
operationsRoutes.post('/membership-tiers', async (c) => {
  const input = await parseJsonBody(c, membershipTierSchema)
  const scope = await requireScopedPermission(c, { code: 'membership.manage', tenantId: input.tenantId })
  const service = createServiceClient()
  const { data, error } = await service
    .from('membership_tiers')
    .insert({
      tenant_id: scope.tenantId,
      code: input.code,
      name: input.name,
      discount_percent: input.discountPercent,
      points_multiplier: input.pointsMultiplier,
      is_active: input.isActive ?? true,
      sort_order: input.sortOrder ?? 0,
    })
    .select()
    .single()
  if (error) {
    throw err.internal(`新建会员等级失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'membership.tier.create',
    entityType: 'membership_tier',
    entityId: data.id,
    tenantId: scope.tenantId,
    metadata: { code: input.code, name: input.name, discountPercent: input.discountPercent },
  })
  return ok(c, data)
})

const membershipTierPatchSchema = z.object({
  code: z.string().min(1, '等级编码不能为空').max(50).optional(),
  name: z.string().min(1, '等级名称不能为空').max(50).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  pointsMultiplier: z.number().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

/**
 * 更新会员等级
 * - 权限:membership.manage
 * - 禁止物理删除已使用等级;停用走 is_active=false
 */
operationsRoutes.patch('/membership-tiers/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, membershipTierPatchSchema)
  const service = createServiceClient()

  const { data: existing, error: fetchErr } = await service
    .from('membership_tiers')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr || !existing) {
    throw err.notFound('会员等级不存在')
  }
  const scope = await requireScopedPermission(c, { code: 'membership.manage', tenantId: existing.tenant_id })

  const { data, error } = await service
    .from('membership_tiers')
    .update({
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.discountPercent !== undefined ? { discount_percent: input.discountPercent } : {}),
      ...(input.pointsMultiplier !== undefined ? { points_multiplier: input.pointsMultiplier } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
    })
    .eq('id', id)
    .eq('tenant_id', scope.tenantId)
    .select()
    .single()
  if (error) {
    throw err.internal(`更新会员等级失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'membership.tier.update',
    entityType: 'membership_tier',
    entityId: id,
    tenantId: scope.tenantId,
    metadata: { code: input.code, name: input.name, isActive: input.isActive },
  })
  return ok(c, data)
})

// ===== 客户会员 =====
/**
 * 客户会员列表
 * - 权限:membership.view
 * - 返回客户姓名/手机(不能以 UUID 为主要识别)
 * - 支持按客户关键词过滤(姓名/手机)
 */
operationsRoutes.get('/customer-memberships', async (c) => {
  const tenantId = c.req.query('tenantId')
  const keyword = c.req.query('keyword')
  const from = Number(c.req.query('from') ?? 0)
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  const scope = await requireScopedPermission(c, {
    code: 'membership.view',
    tenantId,
    dataScope: true,
  })

  const service = createServiceClient()
  let query = service
    .from('customer_memberships')
    .select('*, customer:customers(id, name, phone), tier:membership_tiers(id, code, name, discount_percent, points_multiplier)', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
  if (keyword) {
    // 先查匹配的客户 id,再按 customer_id 过滤(跨表关键词)
    const { data: matchedCustomers, error: customerErr } = await service
      .from('customers')
      .select('id')
      .eq('tenant_id', scope.tenantId)
      .or(`name.ilike.%${keyword}%,phone.ilike.%${keyword}%`)
      .limit(200)
    if (customerErr) {
      throw err.internal(`查询客户失败: ${customerErr.message}`)
    }
    const ids = (matchedCustomers ?? []).map((r: { id: string }) => r.id)
    if (ids.length === 0) {
      return ok(c, { list: [], total: 0 })
    }
    query = query.in('customer_id', ids)
  }
  query = query.range(from, from + limit - 1)
  const { data, error, count } = await query.order('joined_at', { ascending: false })
  if (error) {
    throw err.internal(`查询客户会员失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

/**
 * 会员/折扣规则引用同租户校验(审计 34-35)
 *
 * service role 绕过 RLS,仅靠 FK 只能证明 UUID 存在、不能证明属于当前租户,
 * 因此 Create 与 Patch 都必须显式校验引用的 tier/store/catalogItem 属于 scope.tenantId。
 * 对每个「非 null 且非 undefined」的引用做校验;null(显式清空)时跳过。
 * 错误文案与 Create 保持一致。
 */
async function validateMembershipReferenceScope(
  service: ReturnType<typeof createServiceClient>,
  tenantId: string,
  refs: { tierId?: string | null, storeId?: string | null, catalogItemId?: string | null },
): Promise<void> {
  if (refs.tierId) {
    const { data: tier } = await service
      .from('membership_tiers')
      .select('id')
      .eq('id', refs.tierId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (!tier) {
      throw err.badRequest('会员等级不属于当前租户')
    }
  }
  if (refs.storeId) {
    const { data: store } = await service
      .from('stores')
      .select('id')
      .eq('id', refs.storeId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (!store) {
      throw err.badRequest('门店不属于当前租户')
    }
  }
  if (refs.catalogItemId) {
    const { data: ci } = await service
      .from('catalog_items')
      .select('id')
      .eq('id', refs.catalogItemId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (!ci) {
      throw err.badRequest('目录项目不属于当前租户')
    }
  }
}

const customerMembershipPatchSchema = z.object({
  tierId: z.string().uuid('等级 id 格式错误').optional(),
  expiresAt: z.string().nullable().optional(),
})

/**
 * 调整客户会员等级/有效期
 * - 权限:membership.manage
 */
operationsRoutes.patch('/customer-memberships/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, customerMembershipPatchSchema)
  const service = createServiceClient()

  const { data: existing, error: fetchErr } = await service
    .from('customer_memberships')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr || !existing) {
    throw err.notFound('客户会员关系不存在')
  }
  const scope = await requireScopedPermission(c, { code: 'membership.manage', tenantId: existing.tenant_id })

  // 审计 34-35:更新 tierId 时重新校验等级属于当前租户(service role 绕过 RLS,FK 不足以保证同租户)
  if (input.tierId !== undefined) {
    await validateMembershipReferenceScope(service, scope.tenantId, { tierId: input.tierId })
  }

  const { data, error } = await service
    .from('customer_memberships')
    .update({
      ...(input.tierId !== undefined ? { tier_id: input.tierId } : {}),
      ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : null } : {}),
    })
    .eq('id', id)
    .eq('tenant_id', scope.tenantId)
    .select()
    .single()
  if (error) {
    throw err.internal(`调整客户会员失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'membership.customer.update',
    entityType: 'customer_membership',
    entityId: id,
    tenantId: scope.tenantId,
    metadata: { tierId: input.tierId, expiresAt: input.expiresAt ?? null },
  })
  return ok(c, data)
})

// ===== 积分流水 =====
/**
 * 积分流水列表(只读,流水不可 update/delete)
 * - 权限:points.view
 * - 支持按客户过滤
 */
operationsRoutes.get('/point-transactions', async (c) => {
  const tenantId = c.req.query('tenantId')
  const customerId = c.req.query('customerId')
  const from = Number(c.req.query('from') ?? 0)
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  const scope = await requireScopedPermission(c, {
    code: 'points.view',
    tenantId,
    dataScope: true,
  })

  const service = createServiceClient()
  let query = service
    .from('point_transactions')
    .select('*, customer:customers(id, name, phone)', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
  if (customerId) {
    query = query.eq('customer_id', customerId)
  }
  query = query.range(from, from + limit - 1)
  const { data, error, count } = await query.order('created_at', { ascending: false })
  if (error) {
    throw err.internal(`查询积分流水失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

// ===== 折扣规则 =====
const discountRuleSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  tierId: z.string().uuid('等级 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误').nullable().optional(),
  catalogItemId: z.string().uuid('项目 id 格式错误').nullable().optional(),
  catalogType: z.string().max(50).nullable().optional(),
  discountPercent: z.number().min(0, '折扣不可为负').max(100, '折扣不可超过 100%'),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

/**
 * 折扣规则列表
 * - 权限:membership.view
 * - 按 tierId 可选过滤
 */
operationsRoutes.get('/discount-rules', async (c) => {
  const tenantId = c.req.query('tenantId')
  const tierId = c.req.query('tierId')
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }
  const scope = await requireScopedPermission(c, {
    code: 'membership.view',
    tenantId,
    dataScope: true,
  })

  const service = createServiceClient()
  let query = service
    .from('membership_discount_rules')
    .select('*, tier:membership_tiers(id, code, name)', { count: 'exact' })
    .eq('tenant_id', scope.tenantId)
  if (tierId) {
    query = query.eq('tier_id', tierId)
  }
  const { data, error, count } = await query.order('priority', { ascending: true })
  if (error) {
    throw err.internal(`查询折扣规则失败: ${error.message}`)
  }
  return ok(c, { list: data ?? [], total: count ?? 0 })
})

/**
 * 新建折扣规则
 * - 权限:membership.manage
 */
operationsRoutes.post('/discount-rules', async (c) => {
  const input = await parseJsonBody(c, discountRuleSchema)
  const scope = await requireScopedPermission(c, { code: 'membership.manage', tenantId: input.tenantId })
  const service = createServiceClient()

  // P0-11 + 审计 34-35:跨租户实体校验(service role 绕过 RLS,必须显式证明同租户;Create 与 Patch 共用)
  await validateMembershipReferenceScope(service, scope.tenantId, {
    tierId: input.tierId,
    storeId: input.storeId,
    catalogItemId: input.catalogItemId,
  })

  const { data, error } = await service
    .from('membership_discount_rules')
    .insert({
      tenant_id: scope.tenantId,
      tier_id: input.tierId,
      store_id: input.storeId ?? null,
      catalog_item_id: input.catalogItemId ?? null,
      catalog_type: input.catalogType ?? null,
      discount_percent: input.discountPercent,
      priority: input.priority ?? 100,
      is_active: input.isActive ?? true,
    })
    .select()
    .single()
  if (error) {
    throw err.internal(`新建折扣规则失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'membership.discountRule.create',
    entityType: 'membership_discount_rule',
    entityId: data.id,
    tenantId: scope.tenantId,
    metadata: { tierId: input.tierId, discountPercent: input.discountPercent },
  })
  return ok(c, data)
})

const discountRulePatchSchema = z.object({
  tierId: z.string().uuid('等级 id 格式错误').optional(),
  storeId: z.string().uuid('门店 id 格式错误').nullable().optional(),
  catalogItemId: z.string().uuid('项目 id 格式错误').nullable().optional(),
  catalogType: z.string().max(50).nullable().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

/**
 * 更新折扣规则
 * - 权限:membership.manage
 */
operationsRoutes.patch('/discount-rules/:id', async (c) => {
  const id = c.req.param('id')
  const input = await parseJsonBody(c, discountRulePatchSchema)
  const service = createServiceClient()

  const { data: existing, error: fetchErr } = await service
    .from('membership_discount_rules')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr || !existing) {
    throw err.notFound('折扣规则不存在')
  }
  const scope = await requireScopedPermission(c, { code: 'membership.manage', tenantId: existing.tenant_id })

  // 审计 34-35:更新 tierId/storeId/catalogItemId 时重新做与 Create 一致的同租户校验
  // (storeId/catalogItemId 传 null 表示显式清空,校验函数内部对 null 跳过)
  await validateMembershipReferenceScope(service, scope.tenantId, {
    tierId: input.tierId,
    storeId: input.storeId,
    catalogItemId: input.catalogItemId,
  })

  const { data, error } = await service
    .from('membership_discount_rules')
    .update({
      ...(input.tierId !== undefined ? { tier_id: input.tierId } : {}),
      ...(input.storeId !== undefined ? { store_id: input.storeId } : {}),
      ...(input.catalogItemId !== undefined ? { catalog_item_id: input.catalogItemId } : {}),
      ...(input.catalogType !== undefined ? { catalog_type: input.catalogType } : {}),
      ...(input.discountPercent !== undefined ? { discount_percent: input.discountPercent } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
    })
    .eq('id', id)
    .eq('tenant_id', scope.tenantId)
    .select()
    .single()
  if (error) {
    throw err.internal(`更新折扣规则失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'membership.discountRule.update',
    entityType: 'membership_discount_rule',
    entityId: id,
    tenantId: scope.tenantId,
    metadata: { tierId: input.tierId, discountPercent: input.discountPercent },
  })
  return ok(c, data)
})

/**
 * 删除折扣规则
 * - 权限:membership.manage
 */
operationsRoutes.delete('/discount-rules/:id', async (c) => {
  const id = c.req.param('id')
  const service = createServiceClient()

  const { data: existing, error: fetchErr } = await service
    .from('membership_discount_rules')
    .select('tenant_id')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr || !existing) {
    throw err.notFound('折扣规则不存在')
  }
  const scope = await requireScopedPermission(c, { code: 'membership.manage', tenantId: existing.tenant_id })

  const { error } = await service
    .from('membership_discount_rules')
    .delete()
    .eq('id', id)
    .eq('tenant_id', scope.tenantId)
  if (error) {
    throw err.internal(`删除折扣规则失败: ${error.message}`)
  }
  await writeAudit(c, {
    action: 'membership.discountRule.delete',
    entityType: 'membership_discount_rule',
    entityId: id,
    tenantId: scope.tenantId,
    metadata: {},
  })
  return ok(c, { isSuccess: true })
})

// ===== 有效会员定价预览 =====
const pricingPreviewSchema = z.object({
  tenantId: z.string().uuid('租户 id 格式错误'),
  storeId: z.string().uuid('门店 id 格式错误'),
  customerId: z.string().uuid('客户 id 格式错误'),
  items: z.array(
    z.object({
      catalogItemId: z.string().uuid().nullable().optional(),
      storeCatalogItemId: z.string().uuid().nullable().optional(),
      catalogType: z.string().nullable().optional(),
      name: z.string().optional(),
      unitPrice: z.number().min(0),
      quantity: z.number().positive(),
    }),
  ).min(1, '至少一个收费项目'),
})

/**
 * 有效会员定价预览
 * - 权限:membership.view
 * - 调 preview_membership_discount RPC,返回每项折扣 + 应收汇总
 */
operationsRoutes.post('/membership-pricing-preview', async (c) => {
  const input = await parseJsonBody(c, pricingPreviewSchema)
  const scope = await requireScopedPermission(c, {
    code: 'membership.view',
    tenantId: input.tenantId,
    storeId: input.storeId,
  })

  const service = createServiceClient()
  const { data, error } = await service.rpc('preview_membership_discount', {
    p_tenant_id: scope.tenantId,
    p_store_id: input.storeId,
    p_customer_id: input.customerId,
    p_items: input.items.map(item => ({
      catalog_item_id: item.catalogItemId ?? null,
      store_catalog_item_id: item.storeCatalogItemId ?? null,
      catalog_type: item.catalogType ?? null,
      name: item.name ?? null,
      unit_price: item.unitPrice,
      quantity: item.quantity,
    })),
  })
  if (error) {
    throw err.internal(`会员定价预览失败: ${error.message}`)
  }
  return ok(c, data)
})

export default operationsRoutes
