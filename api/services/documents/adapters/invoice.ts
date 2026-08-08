import { err } from '../../../lib/errors.js'
import { fetchDocumentBase } from '../base.js'
import { fmtMoney, fmtDateTime, toNum } from '../format.js'
import type { DocumentAdapter, Service } from '../types.js'

/**
 * 收费单 Adapter(S32-C)
 * 数据源:invoices + invoice_items
 */
export const invoiceAdapter: DocumentAdapter = {
  documentType: 'invoice',
  businessPermission: null,

  async resolveScope(service: Service, entityId: string) {
    const { data, error } = await service
      .from('invoices')
      .select('tenant_id, store_id')
      .eq('id', entityId)
      .maybeSingle()
    if (error || !data) {
      throw err.notFound('收费单不存在')
    }
    return { tenantId: data.tenant_id, storeId: data.store_id }
  },

  async fetch(service: Service, entityId: string) {
    const { data: inv, error: invErr } = await service
      .from('invoices')
      .select('tenant_id, store_id, invoice_no, customer_id, pet_id, subtotal, discount_amount, discount_reason, tax_amount, total, paid_amount, status, payment_method, due_date, created_by, created_at')
      .eq('id', entityId)
      .maybeSingle()
    if (invErr || !inv) {
      throw err.notFound('收费单不存在')
    }

    const base = await fetchDocumentBase(service, {
      tenantId: inv.tenant_id,
      storeId: inv.store_id,
      customerId: inv.customer_id,
      petId: inv.pet_id,
      operatorUserId: inv.created_by,
    })

    const { data: items, error: itemsErr } = await service
      .from('invoice_items')
      .select('name, unit_price, quantity, discount_amount, amount, category')
      .eq('invoice_id', entityId)
      .order('sort_order', { ascending: true })
    if (itemsErr) {
      throw err.internal(`加载发票明细失败: ${itemsErr.message}`)
    }

    const section = {
      invoiceNo: inv.invoice_no,
      status: inv.status,
      subtotal: fmtMoney(inv.subtotal),
      discountAmount: fmtMoney(inv.discount_amount),
      discountReason: inv.discount_reason ?? '-',
      taxAmount: fmtMoney(inv.tax_amount),
      total: fmtMoney(inv.total),
      paidAmount: fmtMoney(inv.paid_amount),
      paymentMethod: inv.payment_method ?? '-',
      dueDate: fmtDateOrDash(inv.due_date),
      createdAt: fmtDateTime(inv.created_at),
      items: (items ?? []).map(it => ({
        name: it.name,
        unitPrice: fmtMoney(it.unit_price),
        quantity: toNum(it.quantity),
        discountAmount: fmtMoney(it.discount_amount),
        amount: fmtMoney(it.amount),
        category: it.category ?? '-',
      })),
    }

    return { base, section }
  },
}

function fmtDateOrDash(v?: string | null): string {
  return v ? fmtDateTime(v).slice(0, 10) : '-'
}
