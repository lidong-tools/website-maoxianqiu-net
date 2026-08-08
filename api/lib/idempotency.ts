import type { Context } from 'hono'
import type { AppEnv } from './types.js'
import { getContext } from './request-context.js'
import { createServiceClient } from './supabase.js'

const HEADER = 'idempotency-key'

/**
 * 幂等工具(MXQ-2008)
 * 依赖 idempotency_records 表(见 MXQ-3003 migration),唯一约束 (tenant_id, idempotency_key)。
 * 过账/支付类命令在写入业务表前先占位,重复请求命中即返回已存在结果。
 */

export interface IdempotencyRecord {
  id: string
  tenant_id: string | null
  idempotency_key: string
  action: string
  entity_type: string | null
  entity_id: string | null
  result_json: unknown
  created_at: string
}

/** 读取请求幂等键(优先 header,兼容 body 传入的 idempotencyKey 由路由层解析) */
export function getRequestIdempotencyKey(c: Context<AppEnv>): string {
  return c.req.header(HEADER) ?? ''
}

/** 查询已有幂等记录 */
export async function findIdempotency(
  c: Context<AppEnv>,
  key: string,
): Promise<IdempotencyRecord | null> {
  if (!key) {
    return null
  }
  const context = getContext(c)
  const service = createServiceClient()
  const { data } = await service
    .from('idempotency_records')
    .select('*')
    .eq('tenant_id', context.tenantId ?? null)
    .eq('idempotency_key', key)
    .maybeSingle()
  return data as IdempotencyRecord | null
}

/** 记录幂等结果(唯一冲突时忽略) */
export async function storeIdempotency(
  c: Context<AppEnv>,
  input: {
    key: string
    action: string
    entityType?: string
    entityId?: string
    result?: unknown
  },
): Promise<void> {
  if (!input.key) {
    return
  }
  const context = getContext(c)
  const service = createServiceClient()
  await service
    .from('idempotency_records')
    .upsert({
      tenant_id: context.tenantId ?? null,
      idempotency_key: input.key,
      action: input.action,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      result_json: input.result ?? {},
    }, {
      onConflict: 'tenant_id,idempotency_key',
      ignoreDuplicates: true,
    })
}
