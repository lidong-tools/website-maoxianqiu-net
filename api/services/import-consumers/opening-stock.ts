/**
 * Stage-04 Agent-07: Opening Stock Import Consumer
 *
 * 消费 opening_stock_import_requests(pending) 并调用期初入账正式 Command
 * (OPENING_STOCK_COMMAND):
 *   1) CAS claim: pending → processing(processing_at),防止并发双消费
 *   2) 调 apply_opening_stock_import RPC(建批次 → 增余额 → 写 receive 流水,
 *      reference_type='opening_stock_import',幂等键防重放)
 *   3) 成功: RPC 内已标记 applied(batch_id/movement_id/applied_at)
 *      失败: status=failed(error_code/error_message)
 *
 * 边界:最终落 inventory_movements / inventory_batches,与现有库存真源一致,
 * 不另建库存真源、不直接改余额。
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface OpeningRequestRow {
  id: string
  tenant_id: string
  catalog_item_id: string
  warehouse_id: string
}

export interface ConsumeResult {
  processed: number
  applied: number
  failed: number
  skipped: number
  /** 仍处于 pending/processing 未消费的行数(数据量超过单次 limit 时存在) */
  remaining: number
  failedSamples: { id: string, code: string, message: string }[]
}

/**
 * 消费期初入账命令队列(按租户;可限定单个 import job)
 * @param opts.limit 单次最大消费条数(默认 50,同步消费避免请求超时)
 */
export async function consumeOpeningStockRequests(
  service: SupabaseClient,
  opts: { tenantId: string, jobId?: string, limit?: number, operatorId?: string | null },
): Promise<ConsumeResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const result: ConsumeResult = { processed: 0, applied: 0, failed: 0, skipped: 0, remaining: 0, failedSamples: [] }

  let q = service
    .from('opening_stock_import_requests')
    .select('id, tenant_id, catalog_item_id, warehouse_id')
    .eq('tenant_id', opts.tenantId)
    .eq('status', 'pending')
  if (opts.jobId) {
    q = q.eq('import_job_id', opts.jobId)
  }
  const { data: rows, error } = await q.limit(limit)
  if (error) {
    throw new Error(`查询期初入账命令失败: ${error.message}`)
  }
  result.remaining = Math.max(rows?.length ?? 0, 0)

  for (const row of (rows ?? []) as OpeningRequestRow[]) {
    // 1) CAS claim:pending → processing,抢不到说明已被其他消费方处理
    const { data: claimed } = await service
      .from('opening_stock_import_requests')
      .update({ status: 'processing', processing_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claimed) {
      result.skipped++
      continue
    }
    result.processed++

    // 2) 调期初入账正式 Command(RPC 内部完成建批次/增余额/写流水/标记 applied)
    const { error: rpcError } = await service.rpc('apply_opening_stock_import', {
      p_request_id: row.id,
      p_operator_id: opts.operatorId ?? null,
    })
    if (rpcError) {
      // 3) 失败:标记 failed 并记录错误
      await service.from('opening_stock_import_requests').update({
        status: 'failed',
        error_code: 'APPLY_FAILED',
        error_message: rpcError.message.slice(0, 1000),
      }).eq('id', row.id)
      result.failed++
      result.failedSamples.push({ id: row.id, code: 'APPLY_FAILED', message: rpcError.message })
      continue
    }
    result.applied++
  }

  return result
}

/**
 * 重试单条失败期初命令:failed → pending,由下一次消费重新处理
 */
export async function retryOpeningStockRequest(service: SupabaseClient, id: string): Promise<boolean> {
  const { data } = await service
    .from('opening_stock_import_requests')
    .update({ status: 'pending', error_code: null, error_message: null, processing_at: null })
    .eq('id', id)
    .eq('status', 'failed')
    .select('id')
    .maybeSingle()
  return Boolean(data)
}
