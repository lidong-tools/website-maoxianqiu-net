import type {
  ApproveDiscountInput,
  CreateInvoiceInput,
  CreateInvoiceResult,
  Invoice,
  InvoiceItem,
  InvoiceWithItems,
  Payment,
  ProcessPaymentInput,
  ProcessPaymentResult,
  ProcessRefundInput,
  ProcessRefundResult,
  ReceiptData,
  Refund,
} from '@/types/billing'
import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * Billing 领域 API 模块(MXQ-8001~8007)
 *
 * 设计原则:
 *   - 收费/退款走 Hono Command + PostgreSQL RPC,禁止前端直连改发票状态/已付金额
 *   - 查询类(发票/明细/支付/退款)浏览器直连 supabase,RLS 兜底
 *   - 幂等:支付/退款命令须带 idempotency-key(Header),同一 key 重复请求返回原结果
 *   - 金额一致性:create_invoice RPC 内校验 items.amount = unit_price * quantity - discount_amount
 *     invoice.total = sum(items.amount) - invoice.discount_amount + invoice.tax_amount
 *   - payments / refunds 不可变:仅 select/insert,前端无 update/delete 入口
 */
export default {
  /**
   * 发票列表(浏览器直连,RLS 按门店过滤)
   * @param params 查询参数(租户/门店/状态/客户/关键词)
   * @param params.tenantId 租户 id(可选)
   * @param params.storeId 门店 id(可选)
   * @param params.status 发票状态(可选)
   * @param params.customerId 客户 id(可选)
   * @param params.keyword 发票号关键词(可选)
   * @param params.from 起始行(可选)
   * @param params.limit 行数(可选)
   */
  async listInvoices(params: {
    tenantId?: string
    storeId?: string
    status?: string
    customerId?: string
    keyword?: string
    from?: number
    limit?: number
  } = {}) {
    let query = supabase
      .from('invoices')
      .select('*', { count: 'exact' })
    if (params.tenantId) {
      query = query.eq('tenant_id', params.tenantId)
    }
    if (params.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params.status) {
      query = query.eq('status', params.status)
    }
    if (params.customerId) {
      query = query.eq('customer_id', params.customerId)
    }
    if (params.keyword) {
      query = query.or(`invoice_no.ilike.%${params.keyword}%`)
    }
    if (params.from !== undefined && params.limit !== undefined) {
      query = query.range(params.from, params.from + params.limit - 1)
    }
    const { data, error, count } = await query.order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as Invoice[], total: count ?? 0 } }
  },

  /**
   * 发票详情(含明细/支付/退款,浏览器直联)
   * @param id 发票 id
   */
  async getInvoiceDetail(id: string) {
    const { data, error } = await supabase
      .from('invoices')
      .select(`
        *,
        items:invoice_items(*),
        payments:payments(*),
        refunds:refunds(*)
      `)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: data as unknown as InvoiceWithItems }
  },

  /**
   * 发票明细列表(浏览器直连)
   * @param invoiceId 发票 id
   */
  async listInvoiceItems(invoiceId: string) {
    const { data, error } = await supabase
      .from('invoice_items')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('sort_order', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as InvoiceItem[] } }
  },

  /**
   * 支付记录列表(浏览器直连,不可变)
   * @param invoiceId 发票 id
   */
  async listPayments(invoiceId: string) {
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as Payment[] } }
  },

  /**
   * 退款记录列表(浏览器直连,不可变)
   * @param invoiceId 发票 id
   */
  async listRefunds(invoiceId: string) {
    const { data, error } = await supabase
      .from('refunds')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as Refund[] } }
  },

  /**
   * 审批记录列表(浏览器直连)
   * @param invoiceId 发票 id
   */
  async listApprovalsByInvoice(invoiceId: string) {
    const { data, error } = await supabase
      .from('approvals')
      .select('*')
      .eq('entity_type', 'invoice_discount')
      .eq('entity_id', invoiceId)
      .order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: data ?? [] } }
  },

  /**
   * 创建发票(MXQ-8001)
   * 走 Hono Command + create_invoice RPC,事务化建发票+明细+审批记录
   * @param data 发票参数
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  createInvoice(data: CreateInvoiceInput, idempotencyKey: string) {
    return api.post('billing/invoices', data, {
      headers: { 'idempotency-key': idempotencyKey },
    }) as Promise<{ data: CreateInvoiceResult }>
  },

  /**
   * 确认发票(MXQ-8002)
   * 走 Hono Command + confirm_invoice RPC,大额折扣需先审批
   * @param invoiceId 发票 id
   */
  confirmInvoice(invoiceId: string) {
    return api.post(`billing/invoices/${invoiceId}/confirm`, {})
  },

  /**
   * 取消发票(MXQ-8001)
   * 走 Hono Command + cancel_invoice RPC,仅 draft/confirmed 可取消
   * @param invoiceId 发票 id
   * @param reason 取消原因
   */
  cancelInvoice(invoiceId: string, reason?: string) {
    return api.post(`billing/invoices/${invoiceId}/cancel`, { reason })
  },

  /**
   * 大额折扣审批(MXQ-8002,manager 操作)
   * 走 Hono Command + approve_discount RPC
   * @param data 审批参数
   */
  approveDiscount(data: ApproveDiscountInput) {
    return api.post(`billing/approvals/${data.approvalId}/decide`, {
      status: data.status,
      reason: data.reason,
    })
  },

  /**
   * 处理支付(MXQ-8003)
   * 走 Hono Command + process_payment RPC,事务化记录支付+更新已付金额+状态机
   * @param data 支付参数
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  processPayment(data: ProcessPaymentInput, idempotencyKey: string) {
    return api.post('billing/payments', data, {
      headers: { 'idempotency-key': idempotencyKey },
    }) as Promise<{ data: ProcessPaymentResult }>
  },

  /**
   * 处理退款(MXQ-8004)
   * 走 Hono Command + process_refund RPC,事务化记录退款+扣减已付金额+状态机
   * @param data 退款参数
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  processRefund(data: ProcessRefundInput, idempotencyKey: string) {
    return api.post('billing/refunds', data, {
      headers: { 'idempotency-key': idempotencyKey },
    }) as Promise<{ data: ProcessRefundResult }>
  },

  /**
   * 生成小票(MXQ-8007)
   * 走 Hono Command + generate_receipt RPC,返回完整小票数据(含门店/明细/支付/找零)
   * @param invoiceId 发票 id
   */
  generateReceipt(invoiceId: string) {
    return api.post(`billing/invoices/${invoiceId}/receipt`, {}) as Promise<{ data: ReceiptData }>
  },
}

/**
 * 生成幂等键(浏览器原生 crypto.randomUUID)
 * 用于支付/退款/创建发票等命令,同一 key 重复请求返回原结果,防止重复扣减
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID()
}
