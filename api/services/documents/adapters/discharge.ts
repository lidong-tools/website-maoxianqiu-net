import type { DocumentAdapter, Service } from '../types.js'
import { err } from '../../../lib/errors.js'
import { fetchDocumentBase } from '../base.js'
import { fmtDateTime, fmtMoney } from '../format.js'

/**
 * 住院出院记录 Adapter(S32-C)
 * 数据源:admissions(已出院记录)
 * 业务权限门:inpatient.view(重新校验)
 */
export const dischargeAdapter: DocumentAdapter = {
  documentType: 'discharge_summary',
  businessPermission: 'inpatient.view',

  async resolveScope(service: Service, entityId: string) {
    const { data, error } = await service
      .from('admissions')
      .select('tenant_id, store_id')
      .eq('id', entityId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('住院记录不存在')
    }
    return { tenantId: data.tenant_id, storeId: data.store_id }
  },

  async fetch(service: Service, entityId: string) {
    const { data: adm, error: admErr } = await service
      .from('admissions')
      .select('tenant_id, store_id, customer_id, pet_id, cage_id, doctor_id, admission_reason, admitted_at, status, discharged_at, discharge_reason, discharge_notes, total_charge')
      .eq('id', entityId)
      .maybeSingle()
    if (admErr || !adm) {
      throw err.notFound('住院记录不存在')
    }

    const base = await fetchDocumentBase(service, {
      tenantId: adm.tenant_id,
      storeId: adm.store_id,
      customerId: adm.customer_id,
      petId: adm.pet_id,
      doctorUserId: adm.doctor_id,
    })

    const section = {
      status: adm.status,
      admittedAt: fmtDateTime(adm.admitted_at),
      dischargedAt: fmtDateTime(adm.discharged_at),
      admissionReason: adm.admission_reason ?? '-',
      dischargeReason: adm.discharge_reason ?? '-',
      dischargeNotes: adm.discharge_notes ?? '-',
      totalCharge: fmtMoney(adm.total_charge),
      doctorName: base.doctor?.name ?? '-',
      cageId: adm.cage_id ?? '-',
    }

    return { base, section }
  },
}
