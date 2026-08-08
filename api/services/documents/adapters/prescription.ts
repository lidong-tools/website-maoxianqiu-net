import { err } from '../../../lib/errors'
import { fetchDocumentBase } from '../base'
import { fmtDateTime, toNum } from '../format'
import type { DocumentAdapter, Service } from '../types'

/**
 * 处方 Adapter(S32-C)
 * 数据源:prescriptions + prescription_items
 */
export const prescriptionAdapter: DocumentAdapter = {
  documentType: 'prescription',
  businessPermission: null,

  async resolveScope(service: Service, entityId: string) {
    const { data, error } = await service
      .from('prescriptions')
      .select('tenant_id, store_id')
      .eq('id', entityId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('处方不存在')
    }
    return { tenantId: data.tenant_id, storeId: data.store_id }
  },

  async fetch(service: Service, entityId: string) {
    const { data: rx, error: rxErr } = await service
      .from('prescriptions')
      .select('tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status, created_at')
      .eq('id', entityId)
      .maybeSingle()
    if (rxErr || !rx) {
      throw err.notFound('处方不存在')
    }

    const base = await fetchDocumentBase(service, {
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

    const section = {
      status: rx.status,
      createdAt: fmtDateTime(rx.created_at),
      items: (items ?? []).map(it => ({
        drugName: it.drug_name,
        dosage: it.dosage ?? '-',
        frequency: it.frequency ?? '-',
        durationDays: it.duration_days != null ? toNum(it.duration_days) : '-',
        quantity: toNum(it.quantity),
        unit: it.unit ?? '',
        instructions: it.instructions ?? '-',
      })),
    }

    return { base, section }
  },
}
