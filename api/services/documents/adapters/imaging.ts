import { err } from '../../../lib/errors'
import { fetchDocumentBase } from '../base'
import { fmtDateTime } from '../format'
import type { DocumentAdapter, Service } from '../types'

/**
 * 影像报告 Adapter(S32-C)
 * 数据源:imaging_orders + imaging_reports(取最新版本)
 * 业务权限门:imaging.view(重新校验,防越权读取医疗影像)
 */
export const imagingAdapter: DocumentAdapter = {
  documentType: 'imaging_report',
  businessPermission: 'imaging.view',

  async resolveScope(service: Service, entityId: string) {
    const { data, error } = await service
      .from('imaging_orders')
      .select('tenant_id, store_id')
      .eq('id', entityId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('影像检查单不存在')
    }
    return { tenantId: data.tenant_id, storeId: data.store_id }
  },

  async fetch(service: Service, entityId: string) {
    const { data: order, error: orderErr } = await service
      .from('imaging_orders')
      .select('tenant_id, store_id, order_no, encounter_id, customer_id, pet_id, requested_by, performed_by, imaging_type, status, clinical_question, notes, performed_at')
      .eq('id', entityId)
      .maybeSingle()
    if (orderErr || !order) {
      throw err.notFound('影像检查单不存在')
    }

    const base = await fetchDocumentBase(service, {
      tenantId: order.tenant_id,
      storeId: order.store_id,
      customerId: order.customer_id,
      petId: order.pet_id,
      operatorUserId: order.requested_by ?? order.performed_by,
    })

    // 取最新版本已发布的报告(优先 published,其次任意状态)
    const { data: report, error: reportErr } = await service
      .from('imaging_reports')
      .select('id, version, findings, impression, recommendation, author_id, reviewer_id, status, published_at')
      .eq('imaging_order_id', entityId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (reportErr) {
      throw err.internal(`加载影像报告失败: ${reportErr.message}`)
    }

    // 作者/审核医师姓名(employees by auth.users id)
    let authorName: string | null = null
    let reviewerName: string | null = null
    const userToName = async (uid?: string | null): Promise<string | null> => {
      if (!uid) {
        return null
      }
      const { data } = await service
        .from('employees')
        .select('name')
        .eq('tenant_id', order.tenant_id)
        .eq('user_id', uid)
        .maybeSingle()
      return data?.name ?? null
    }
    authorName = await userToName(report?.author_id ?? null)
    reviewerName = await userToName(report?.reviewer_id ?? null)

    const section = {
      orderNo: order.order_no,
      imagingType: order.imaging_type ?? '-',
      status: order.status,
      reportStatus: report?.status ?? '未出报告',
      performedAt: fmtDateTime(order.performed_at),
      clinicalQuestion: order.clinical_question ?? order.notes ?? '-',
      findings: report?.findings ?? '-',
      impression: report?.impression ?? '-',
      recommendation: report?.recommendation ?? '-',
      authorName: authorName ?? '-',
      reviewerName: reviewerName ?? '-',
      publishedAt: fmtDateTime(report?.published_at),
    }

    return { base, section }
  },
}
