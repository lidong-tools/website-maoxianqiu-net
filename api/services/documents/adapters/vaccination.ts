import { err } from '../../../lib/errors.js'
import { fetchDocumentBase } from '../base.js'
import { fmtDateTime, fmtDate } from '../format.js'
import type { DocumentAdapter, Service } from '../types.js'

/**
 * 疫苗免疫证明 Adapter(S32-C)
 * 数据源:vaccine_certificates + vaccinations + catalog_items(疫苗名称)
 */
export const vaccinationAdapter: DocumentAdapter = {
  documentType: 'vaccination_certificate',
  businessPermission: null,

  async resolveScope(service: Service, entityId: string) {
    const { data, error } = await service
      .from('vaccine_certificates')
      .select('tenant_id, store_id')
      .eq('id', entityId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('疫苗证明不存在')
    }
    return { tenantId: data.tenant_id, storeId: data.store_id }
  },

  async fetch(service: Service, entityId: string) {
    const { data: cert, error: certErr } = await service
      .from('vaccine_certificates')
      .select('tenant_id, store_id, pet_id, customer_id, vaccination_id, certificate_no, issued_date, issued_by, status')
      .eq('id', entityId)
      .maybeSingle()
    if (certErr || !cert) {
      throw err.notFound('疫苗证明不存在')
    }

    const base = await fetchDocumentBase(service, {
      tenantId: cert.tenant_id,
      storeId: cert.store_id,
      customerId: cert.customer_id,
      petId: cert.pet_id,
      operatorUserId: cert.issued_by,
    })

    const { data: vax, error: vaxErr } = await service
      .from('vaccinations')
      .select('vaccine_catalog_item_id, dose_no, administered_date, batch_no, manufacturer, next_due_date')
      .eq('id', cert.vaccination_id)
      .maybeSingle()
    if (vaxErr) {
      throw err.internal(`加载疫苗记录失败: ${vaxErr.message}`)
    }

    let vaccineName: string | null = null
    if (vax?.vaccine_catalog_item_id) {
      const { data: item } = await service
        .from('catalog_items')
        .select('name')
        .eq('id', vax.vaccine_catalog_item_id)
        .maybeSingle()
      vaccineName = item?.name ?? null
    }

    const section = {
      certificateNo: cert.certificate_no,
      status: cert.status,
      issuedDate: fmtDateTime(cert.issued_date),
      vaccinations: vax
        ? [{
            vaccineName: vaccineName ?? '-',
            doseNo: vax.dose_no ?? '-',
            administeredDate: fmtDateTime(vax.administered_date),
            batchNo: vax.batch_no ?? '-',
            manufacturer: vax.manufacturer ?? '-',
            nextDueDate: fmtDate(vax.next_due_date),
          }]
        : [],
    }

    return { base, section }
  },
}
