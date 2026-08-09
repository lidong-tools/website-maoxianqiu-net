import type { Context } from 'hono'
import type { AppEnv } from './types.js'
import { getContext } from './request-context.js'
import { createServiceClient } from './supabase.js'

export interface AuditEntry {
  action: string
  entityType?: string
  entityId?: string
  storeId?: string
  tenantId?: string
  idempotencyKey?: string | null
  metadata?: Record<string, unknown>
}

/**
 * 审计写入(MXQ-2007)
 * 写入 audit_logs 表(见 MXQ-3003 migration)。审计为 best-effort:
 * 失败不阻断主流程,但不应静默吞掉关键状态变化。
 */
export async function writeAudit(c: Context<AppEnv>, entry: AuditEntry): Promise<void> {
  try {
    const context = getContext(c)
    const service = createServiceClient()
    await service.from('audit_logs').insert({
      tenant_id: entry.tenantId ?? context.tenantId ?? null,
      store_id: entry.storeId ?? context.storeId ?? null,
      user_id: context.userId,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      metadata: {
        ...(entry.metadata ?? {}),
        ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}),
      },
      request_id: context.requestId,
    })
  }
  catch (e) {
    console.error('[audit] 审计写入失败', e)
  }
}

/** 同步审计变体,供非 async 场景调用 */
export function writeAuditSync(c: Context<AppEnv>, entry: AuditEntry): void {
  void writeAudit(c, entry)
}
