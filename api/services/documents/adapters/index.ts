import type { DocumentAdapter, DocumentType } from '../types'
import { boardingAdapter } from './boarding'
import { dischargeAdapter } from './discharge'
import { imagingAdapter } from './imaging'
import { invoiceAdapter } from './invoice'
import { labReportAdapter } from './lab-report'
import { medicalRecordAdapter } from './medical-record'
import { prescriptionAdapter } from './prescription'
import { vaccinationAdapter } from './vaccination'

/**
 * S32-C 业务 Adapter 注册表
 * 每种业务对象都通过 Adapter 提供文档数据;模板不得直接查询数据库。
 */
export const documentAdapters: Record<DocumentType, DocumentAdapter> = {
  prescription: prescriptionAdapter,
  invoice: invoiceAdapter,
  medical_record_summary: medicalRecordAdapter,
  lab_report: labReportAdapter,
  imaging_report: imagingAdapter,
  discharge_summary: dischargeAdapter,
  vaccination_certificate: vaccinationAdapter,
  boarding_handover: boardingAdapter,
}

export function getAdapter(documentType: DocumentType): DocumentAdapter {
  return documentAdapters[documentType]
}
