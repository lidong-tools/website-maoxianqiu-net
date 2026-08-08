import { err } from '../../../lib/errors.js'
import { fetchDocumentBase } from '../base.js'
import { fmtDateTime, fmtDate, fmtMoney, fmtBool } from '../format.js'
import type { DocumentAdapter, Service } from '../types.js'

/**
 * 寄养交接单 Adapter(S32-C)
 * 数据源:boarding_stays + boarding_daily_records
 * 业务权限门:boarding.view(重新校验)
 */
export const boardingAdapter: DocumentAdapter = {
  documentType: 'boarding_handover',
  businessPermission: 'boarding.view',

  async resolveScope(service: Service, entityId: string) {
    const { data, error } = await service
      .from('boarding_stays')
      .select('tenant_id, store_id')
      .eq('id', entityId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('寄养记录不存在')
    }
    return { tenantId: data.tenant_id, storeId: data.store_id }
  },

  async fetch(service: Service, entityId: string) {
    const { data: stay, error: stayErr } = await service
      .from('boarding_stays')
      .select('tenant_id, store_id, boarding_no, customer_id, pet_id, cage_id, check_in_at, expected_check_out_at, checked_out_at, status, diet_notes, walking_notes, medication_notes, vaccine_verified, risk_acknowledged, emergency_contact, total_charge, created_by')
      .eq('id', entityId)
      .maybeSingle()
    if (stayErr || !stay) {
      throw err.notFound('寄养记录不存在')
    }

    const base = await fetchDocumentBase(service, {
      tenantId: stay.tenant_id,
      storeId: stay.store_id,
      customerId: stay.customer_id,
      petId: stay.pet_id,
      operatorUserId: stay.created_by,
    })

    const { data: records, error: recordsErr } = await service
      .from('boarding_daily_records')
      .select('record_date, feeding, walking, medication, condition, note')
      .eq('boarding_stay_id', entityId)
      .order('record_date', { ascending: true })
    if (recordsErr) {
      throw err.internal(`加载寄养护理记录失败: ${recordsErr.message}`)
    }

    // emergency_contact 为 jsonb { name, phone, relation }
    const ec = (stay.emergency_contact ?? {}) as { name?: string, phone?: string, relation?: string }

    const section = {
      boardingNo: stay.boarding_no,
      status: stay.status,
      checkInAt: fmtDateTime(stay.check_in_at),
      expectedCheckOutAt: fmtDateTime(stay.expected_check_out_at),
      checkedOutAt: fmtDateTime(stay.checked_out_at),
      dietNotes: stay.diet_notes ?? '-',
      walkingNotes: stay.walking_notes ?? '-',
      medicationNotes: stay.medication_notes ?? '-',
      vaccineVerified: fmtBool(stay.vaccine_verified),
      riskAcknowledged: fmtBool(stay.risk_acknowledged),
      emergencyContact: {
        name: ec.name ?? '-',
        phone: ec.phone ?? '-',
        relation: ec.relation ?? '-',
      },
      totalCharge: fmtMoney(stay.total_charge),
      cageId: stay.cage_id ?? '-',
      dailyRecords: (records ?? []).map(r => ({
        recordDate: fmtDate(r.record_date),
        feeding: r.feeding ?? '-',
        walking: r.walking ?? '-',
        medication: r.medication ?? '-',
        condition: r.condition ?? '-',
        note: r.note ?? '-',
      })),
    }

    return { base, section }
  },
}
