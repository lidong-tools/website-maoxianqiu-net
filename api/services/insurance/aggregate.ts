import { err } from '../../lib/errors.js'
import type { InsurancePackItem, InsuranceSourceType, Service } from './types.js'
import { INSURANCE_INCLUDED_STATUSES } from './types.js'

/**
 * Stage-04 Agent-06 — 保险理赔包材料清单聚合
 *
 * 只聚合"已签/已发布/合规可输出"的来源(INSURANCE_INCLUDED_STATUSES):
 *   - encounter:completed/signed
 *   - prescription:dispensed
 *   - invoice:paid/partially_paid/confirmed
 *   - lab_report:completed(结果已发布)
 *   - imaging_report:published
 *   - discharge_summary:discharged
 *   - vaccination_certificate:issued
 * 未发布 Lab / 未发布 Imaging / Draft Prescription 不会进入清单。
 */

/** 材料展示顺序基准 */
const ORDER_BASE: Record<InsuranceSourceType, number> = {
  encounter: 10,
  medical_record_summary: 20,
  prescription: 30,
  invoice: 40,
  lab_report: 50,
  imaging_report: 60,
  discharge_summary: 70,
  vaccination_certificate: 80,
}

/** 必填材料(疫苗接种证书非必填,其余必填) */
function isRequiredSource(type: InsuranceSourceType): boolean {
  return type !== 'vaccination_certificate'
}

export interface AggregateInput {
  tenantId: string
  storeId?: string | null
  customerId: string
  petId: string
  encounterId?: string | null
  admissionId?: string | null
}

/**
 * 解析理赔包的租户/门店作用域
 * 优先 encounter → admission → customer 归属(供路由 scoped 授权)
 */
export async function resolvePackScope(
  service: Service,
  input: { encounterId?: string | null, admissionId?: string | null, tenantId?: string, customerId?: string },
): Promise<{ tenantId: string, storeId: string | null }> {
  if (input.encounterId) {
    const { data, error } = await service
      .from('encounters')
      .select('tenant_id, store_id')
      .eq('id', input.encounterId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('就诊记录不存在')
    }
    return { tenantId: data.tenant_id, storeId: data.store_id }
  }
  if (input.admissionId) {
    const { data, error } = await service
      .from('admissions')
      .select('tenant_id, store_id')
      .eq('id', input.admissionId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('住院记录不存在')
    }
    return { tenantId: data.tenant_id, storeId: data.store_id }
  }
  if (!input.tenantId) {
    throw err.badRequest('缺少租户标识或业务单据')
  }
  return { tenantId: input.tenantId, storeId: null }
}

function toItem(
  type: InsuranceSourceType,
  sourceId: string,
  summary: string,
  orderOffset = 0,
): InsurancePackItem {
  return {
    source_type: type,
    source_id: sourceId,
    display_order: ORDER_BASE[type] + orderOffset,
    required: isRequiredSource(type),
    included: true,
    summary,
  }
}

/**
 * 聚合合格材料清单(读操作,不写库)
 */
export async function aggregatePackItems(
  service: Service,
  input: AggregateInput,
): Promise<InsurancePackItem[]> {
  const items: InsurancePackItem[] = []

  // 1) 就诊(病历/诊断)
  if (input.encounterId) {
    const { data: enc, error: encErr } = await service
      .from('encounters')
      .select('id, status, started_at, diagnosis_text, chief_complaint')
      .eq('id', input.encounterId)
      .maybeSingle()
    if (encErr || !enc) {
      throw err.notFound('就诊记录不存在')
    }
    if (INSURANCE_INCLUDED_STATUSES.encounter.includes(enc.status)) {
      items.push(toItem('encounter', enc.id, `就诊病历(${enc.status})`))
    }
  }

  // 2) 处方(仅已发药)
  if (input.encounterId) {
    const { data: rxs, error: rxErr } = await service
      .from('prescriptions')
      .select('id, status, created_at')
      .eq('encounter_id', input.encounterId)
      .in('status', INSURANCE_INCLUDED_STATUSES.prescription)
    if (rxErr) {
      throw err.internal(`查询处方失败: ${rxErr.message}`)
    }
    for (const rx of rxs ?? []) {
      items.push(toItem('prescription', rx.id, `处方(${rx.status})`))
    }
  }

  // 3) 发票(已确认/已支付)
  if (input.encounterId) {
    const { data: invs, error: invErr } = await service
      .from('invoices')
      .select('id, invoice_no, status, total, created_at')
      .eq('encounter_id', input.encounterId)
      .in('status', INSURANCE_INCLUDED_STATUSES.invoice)
    if (invErr) {
      throw err.internal(`查询发票失败: ${invErr.message}`)
    }
    for (const inv of invs ?? []) {
      items.push(toItem('invoice', inv.id, `发票 ${inv.invoice_no}(${inv.status})`))
    }
  }

  // 4) 检验报告(已完成/结果已发布)
  if (input.encounterId) {
    const { data: labs, error: labErr } = await service
      .from('lab_orders')
      .select('id, order_no, status, completed_at')
      .eq('encounter_id', input.encounterId)
      .in('status', INSURANCE_INCLUDED_STATUSES.lab_report)
    if (labErr) {
      throw err.internal(`查询检验报告失败: ${labErr.message}`)
    }
    for (const lab of labs ?? []) {
      items.push(toItem('lab_report', lab.id, `检验报告 ${lab.order_no}(${lab.status})`))
    }
  }

  // 5) 影像报告(已发布)
  if (input.encounterId) {
    const { data: imaging, error: imgErr } = await service
      .from('imaging_orders')
      .select(`
        id,
        order_no,
        imaging_type,
        status,
        imaging_reports!inner(id, status)
      `)
      .eq('encounter_id', input.encounterId)
      .eq('imaging_reports.status', 'published')
    if (imgErr) {
      throw err.internal(`查询影像报告失败: ${imgErr.message}`)
    }
    for (const order of imaging ?? []) {
      const reports = (order.imaging_reports as Array<{ id: string, status: string }> | null) ?? []
      for (const rpt of reports) {
        items.push(toItem('imaging_report', rpt.id, `影像报告 ${order.order_no}(${rpt.status})`))
      }
    }
  }

  // 6) 出院记录(已出院)
  if (input.admissionId) {
    const { data: adm, error: admErr } = await service
      .from('admissions')
      .select('id, status, discharged_at')
      .eq('id', input.admissionId)
      .maybeSingle()
    if (admErr || !adm) {
      throw err.notFound('住院记录不存在')
    }
    if (INSURANCE_INCLUDED_STATUSES.discharge_summary.includes(adm.status)) {
      items.push(toItem('discharge_summary', adm.id, `出院记录(${adm.status})`))
    }
  }
  else if (input.encounterId) {
    // 若该宠物存在已出院住院,自动带入出院记录
    const { data: admList, error: admErr } = await service
      .from('admissions')
      .select('id, status, discharged_at')
      .eq('tenant_id', input.tenantId)
      .eq('pet_id', input.petId)
      .in('status', INSURANCE_INCLUDED_STATUSES.discharge_summary)
      .order('discharged_at', { ascending: false })
      .limit(5)
    if (!admErr) {
      for (const adm of admList ?? []) {
        items.push(toItem('discharge_summary', adm.id, `出院记录(${adm.status})`))
      }
    }
  }

  // 7) 疫苗证明(已签发)
  const { data: certs, error: certErr } = await service
    .from('vaccine_certificates')
    .select('id, certificate_no, status, issued_date')
    .eq('tenant_id', input.tenantId)
    .eq('pet_id', input.petId)
    .in('status', INSURANCE_INCLUDED_STATUSES.vaccination_certificate)
  if (certErr) {
    throw err.internal(`查询疫苗证明失败: ${certErr.message}`)
  }
  for (const cert of certs ?? []) {
    items.push(toItem('vaccination_certificate', cert.id, `疫苗证明 ${cert.certificate_no}(${cert.status})`))
  }

  // 按展示顺序排序
  return items.sort((a, b) => a.display_order - b.display_order)
}
