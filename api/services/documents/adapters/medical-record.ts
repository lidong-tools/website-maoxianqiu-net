import { err } from '../../../lib/errors'
import { fetchDocumentBase } from '../base'
import { fmtDateTime, fmtDate } from '../format'
import type { DocumentAdapter, Service } from '../types'

/**
 * 病历摘要 Adapter(S32-C)
 * 数据源:encounters(就诊记录)
 */
export const medicalRecordAdapter: DocumentAdapter = {
  documentType: 'medical_record_summary',
  businessPermission: null,

  async resolveScope(service: Service, entityId: string) {
    const { data, error } = await service
      .from('encounters')
      .select('tenant_id, store_id')
      .eq('id', entityId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('病历记录不存在')
    }
    return { tenantId: data.tenant_id, storeId: data.store_id }
  },

  async fetch(service: Service, entityId: string) {
    const { data: enc, error: encErr } = await service
      .from('encounters')
      .select('tenant_id, store_id, customer_id, pet_id, doctor_id, started_at, ended_at, status, chief_complaint, history_present, exam_findings, diagnosis_codes, diagnosis_text, treatment_plan, follow_up_date, signed_at')
      .eq('id', entityId)
      .maybeSingle()
    if (encErr || !enc) {
      throw err.notFound('病历记录不存在')
    }

    const base = await fetchDocumentBase(service, {
      tenantId: enc.tenant_id,
      storeId: enc.store_id,
      customerId: enc.customer_id,
      petId: enc.pet_id,
      doctorUserId: enc.doctor_id,
    })

    const codes = Array.isArray(enc.diagnosis_codes) ? enc.diagnosis_codes : []

    const section = {
      status: enc.status,
      startedAt: fmtDateTime(enc.started_at),
      endedAt: fmtDateTime(enc.ended_at),
      chiefComplaint: enc.chief_complaint ?? '-',
      historyPresent: enc.history_present ?? '-',
      examFindings: enc.exam_findings ?? '-',
      diagnosisCodes: codes,
      diagnosisCodesText: codes.join('、') || enc.diagnosis_text || '-',
      diagnosisText: enc.diagnosis_text ?? '-',
      treatmentPlan: enc.treatment_plan ?? '-',
      followUpDate: fmtDate(enc.follow_up_date),
      signedAt: fmtDateTime(enc.signed_at),
    }

    return { base, section }
  },
}
