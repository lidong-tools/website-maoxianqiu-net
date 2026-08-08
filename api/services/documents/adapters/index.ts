import type { DocumentAdapter, DocumentType } from '../types.js'
import { boardingAdapter } from './boarding.js'
import { dischargeAdapter } from './discharge.js'
import { imagingAdapter } from './imaging.js'
import { invoiceAdapter } from './invoice.js'
import { labReportAdapter } from './lab-report.js'
import { medicalRecordAdapter } from './medical-record.js'
import { prescriptionAdapter } from './prescription.js'
import { vaccinationAdapter } from './vaccination.js'

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
