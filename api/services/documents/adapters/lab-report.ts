import type { DocumentAdapter, Service } from '../types.js'
import { err } from '../../../lib/errors.js'
import { fetchDocumentBase } from '../base.js'
import { fmtDateTime } from '../format.js'

/**
 * 检验报告 Adapter(S32-C)
 * 数据源:lab_orders + lab_order_analytes + lab_analytes
 */
export const labReportAdapter: DocumentAdapter = {
  documentType: 'lab_report',
  businessPermission: null,

  async resolveScope(service: Service, entityId: string) {
    const { data, error } = await service
      .from('lab_orders')
      .select('tenant_id, store_id')
      .eq('id', entityId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('检验报告不存在')
    }
    return { tenantId: data.tenant_id, storeId: data.store_id }
  },

  async fetch(service: Service, entityId: string) {
    const { data: order, error: orderErr } = await service
      .from('lab_orders')
      .select('tenant_id, store_id, customer_id, pet_id, order_no, status, requested_by, requested_at, completed_at')
      .eq('id', entityId)
      .maybeSingle()
    if (orderErr || !order) {
      throw err.notFound('检验报告不存在')
    }

    const base = await fetchDocumentBase(service, {
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

    const section = {
      orderNo: order.order_no,
      status: order.status,
      requestedAt: fmtDateTime(order.requested_at),
      completedAt: fmtDateTime(order.completed_at),
      analytes: (analytes ?? []).map((a) => {
        const def = a.analyte_id ? defMap.get(a.analyte_id) : undefined
        const raw = a.result_value ?? (a.result_numeric != null ? String(a.result_numeric) : null)
        const isCritical = a.is_critical ?? false
        const isAbnormal = a.is_abnormal ?? false
        return {
          name: def?.name ?? '未知项目',
          resultValue: raw ?? '-',
          resultDisplay: raw == null ? '-' : `${raw}${isCritical ? '⚠' : isAbnormal ? '*' : ''}`,
          resultClass: isCritical ? 'abnormal' : isAbnormal ? 'abnormal' : '',
          unit: def?.unit ?? '-',
          refRange: def?.ref_range_text ?? '-',
          isAbnormal,
          isCritical,
          flag: a.flag ?? '-',
          note: a.note ?? '-',
        }
      }),
    }

    return { base, section }
  },
}
