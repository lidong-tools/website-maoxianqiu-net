import type { InsurancePackItem, InsuranceSnapshot, InsuranceSourceType, Service } from './types.js'
import { err } from '../../lib/errors.js'

/**
 * Stage-04 Agent-06 — 理赔包导出数据快照构建
 *
 * 原则(文档 §6):
 *   - 快照只存必要字段(证明"当时提交内容"),不存无边界医疗全文;
 *   - 记录 source refs + source status/version,半年后源修订仍可证明当时快照;
 *   - 快照 sha256 落 insurance_claim_exports.data_hash,与 PDF bytes sha256 分离。
 */

/** 各来源的文档标题 */
const SOURCE_TITLE: Record<InsuranceSourceType, string> = {
  encounter: '就诊病历',
  medical_record_summary: '病历摘要',
  prescription: '处方',
  invoice: '收费发票',
  lab_report: '检验报告',
  imaging_report: '影像报告',
  discharge_summary: '出院记录',
  vaccination_certificate: '疫苗证明',
}

async function fetchEncounterSnapshot(
  service: Service,
  encounterId: string,
  pack: { tenantId: string, customerId: string, petId: string },
) {
  const { data, error } = await service
    .from('encounters')
    .select('id, status, started_at, ended_at, chief_complaint, diagnosis_text, doctor_id')
    .eq('id', encounterId)
    .maybeSingle()
  if (error || !data) {
    throw err.notFound('就诊记录不存在')
  }
  let doctorName: string | undefined
  if (data.doctor_id) {
    const { data: emp } = await service
      .from('employees')
      .select('name')
      .eq('tenant_id', pack.tenantId)
      .eq('user_id', data.doctor_id)
      .maybeSingle()
    doctorName = emp?.name
  }
  return {
    id: data.id,
    startedAt: data.started_at ?? undefined,
    endedAt: data.ended_at ?? undefined,
    status: data.status,
    chiefComplaint: data.chief_complaint ?? undefined,
    diagnosisText: data.diagnosis_text ?? undefined,
    doctorName,
  }
}

/** 单份来源文档的快照内容(按类型保留必要字段) */
async function buildDocumentContent(
  service: Service,
  item: InsurancePackItem,
): Promise<Record<string, unknown>> {
  switch (item.source_type) {
    case 'prescription': {
      const { data: rx, error } = await service
        .from('prescriptions')
        .select('id, status, created_at, prescription_items(id, drug_name, dosage, frequency, quantity, unit, instructions)')
        .eq('id', item.source_id)
        .maybeSingle()
      if (error || !rx) {
        return { sourceId: item.source_id, status: 'missing' }
      }
      return {
        sourceId: rx.id,
        status: rx.status,
        createdAt: rx.created_at,
        items: (rx.prescription_items as Array<Record<string, unknown>> | null ?? []).map(it => ({
          drugName: it.drug_name,
          dosage: it.dosage ?? null,
          frequency: it.frequency ?? null,
          quantity: it.quantity,
          unit: it.unit ?? null,
          instructions: it.instructions ?? null,
        })),
      }
    }
    case 'invoice': {
      const { data: inv, error } = await service
        .from('invoices')
        .select('id, invoice_no, status, subtotal, discount_amount, tax_amount, total, paid_amount, created_at, invoice_items(name, quantity, amount)')
        .eq('id', item.source_id)
        .maybeSingle()
      if (error || !inv) {
        return { sourceId: item.source_id, status: 'missing' }
      }
      return {
        sourceId: inv.id,
        invoiceNo: inv.invoice_no,
        status: inv.status,
        subtotal: inv.subtotal,
        discountAmount: inv.discount_amount,
        taxAmount: inv.tax_amount,
        total: inv.total,
        paidAmount: inv.paid_amount,
        createdAt: inv.created_at,
        items: (inv.invoice_items as Array<Record<string, unknown>> | null ?? []).map(it => ({
          name: it.name,
          quantity: it.quantity,
          amount: it.amount,
        })),
      }
    }
    case 'lab_report': {
      const { data: lab, error } = await service
        .from('lab_orders')
        .select('id, order_no, status, completed_at')
        .eq('id', item.source_id)
        .maybeSingle()
      if (error || !lab) {
        return { sourceId: item.source_id, status: 'missing' }
      }
      return { sourceId: lab.id, orderNo: lab.order_no, status: lab.status, completedAt: lab.completed_at }
    }
    case 'imaging_report': {
      const { data: rpt, error } = await service
        .from('imaging_reports')
        .select('id, version, status, published_at, findings, impression, imaging_orders(order_no, imaging_type)')
        .eq('id', item.source_id)
        .maybeSingle()
      if (error || !rpt) {
        return { sourceId: item.source_id, status: 'missing' }
      }
      const order = (rpt.imaging_orders as { order_no?: string, imaging_type?: string } | null) ?? {}
      return {
        sourceId: rpt.id,
        orderNo: order.order_no,
        imagingType: order.imaging_type,
        version: rpt.version,
        status: rpt.status,
        publishedAt: rpt.published_at,
        findings: rpt.findings ?? null,
        impression: rpt.impression ?? null,
      }
    }
    case 'discharge_summary': {
      const { data: adm, error } = await service
        .from('admissions')
        .select('id, status, admitted_at, discharged_at, discharge_reason, total_charge')
        .eq('id', item.source_id)
        .maybeSingle()
      if (error || !adm) {
        return { sourceId: item.source_id, status: 'missing' }
      }
      return {
        sourceId: adm.id,
        status: adm.status,
        admittedAt: adm.admitted_at,
        dischargedAt: adm.discharged_at,
        dischargeReason: adm.discharge_reason ?? null,
        totalCharge: adm.total_charge,
      }
    }
    case 'medical_record_summary': {
      return { sourceId: item.source_id, refType: 'encounter', status: 'signed' }
    }
    case 'vaccination_certificate': {
      const { data: cert, error } = await service
        .from('vaccine_certificates')
        .select('id, certificate_no, status, issued_date')
        .eq('id', item.source_id)
        .maybeSingle()
      if (error || !cert) {
        return { sourceId: item.source_id, status: 'missing' }
      }
      return { sourceId: cert.id, certificateNo: cert.certificate_no, status: cert.status, issuedDate: cert.issued_date }
    }
    default: {
      return { sourceId: item.source_id, status: 'unknown' }
    }
  }
}

/**
 * 构建导出数据快照(pack 已生成后,读取合格来源必要字段)
 */
export async function buildInsuranceSnapshot(
  service: Service,
  input: {
    packId: string
    packNo: string
    packVersion: number
    tenantId: string
    storeId: string | null
    customerId: string
    petId: string
    encounterId: string | null
    items: InsurancePackItem[]
  },
): Promise<InsuranceSnapshot> {
  const { tenantId, storeId, customerId, petId } = input

  // 医院/门店/客户/宠物基础信息
  const [tenantRes, storeRes, customerRes, petRes] = await Promise.all([
    service.from('tenants').select('name').eq('id', tenantId).maybeSingle(),
    storeId
      ? service.from('stores').select('name, code, address, phone').eq('id', storeId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    service.from('customers').select('id, name, phone').eq('id', customerId).maybeSingle(),
    service.from('pets').select('id, name, species, breed, gender').eq('id', petId).maybeSingle(),
  ])

  // 就诊信息
  const encounter = input.encounterId
    ? await fetchEncounterSnapshot(service, input.encounterId, { tenantId, customerId, petId })
    : null

  // 各来源文档快照(并行,仅必要字段)
  const included = input.items.filter(it => it.included)
  const documents = await Promise.all(
    included.map(async (item) => {
      const content = await buildDocumentContent(service, item)
      return {
        sourceType: item.source_type,
        sourceId: item.source_id,
        title: SOURCE_TITLE[item.source_type],
        status: (content.status as string) ?? 'unknown',
        issuedAt: undefined as string | undefined,
        content,
      }
    }),
  )
  // 补充 issuedAt(来自 content 中的时间字段,统一为字符串)
  for (const doc of documents) {
    const c = doc.content
    const timeField = c.completedAt ?? c.publishedAt ?? c.dischargedAt ?? c.issuedDate ?? c.createdAt ?? c.admittedAt
    if (typeof timeField === 'string') {
      doc.issuedAt = timeField
    }
  }

  return {
    pack: {
      id: input.packId,
      packNo: input.packNo,
      version: input.packVersion,
      generatedAt: new Date().toISOString(),
    },
    hospital: { name: tenantRes.data?.name ?? '毛线球宠物医院' },
    store: storeRes.data
      ? {
          name: storeRes.data.name,
          code: storeRes.data.code ?? undefined,
          address: storeRes.data.address ?? undefined,
          phone: storeRes.data.phone ?? undefined,
        }
      : null,
    customer: customerRes.data ? { id: customerRes.data.id, name: customerRes.data.name, phone: customerRes.data.phone ?? undefined } : null,
    pet: petRes.data
      ? {
          id: petRes.data.id,
          name: petRes.data.name,
          species: petRes.data.species ?? undefined,
          breed: petRes.data.breed ?? undefined,
          gender: petRes.data.gender ?? undefined,
        }
      : null,
    encounter,
    documents,
  }
}
