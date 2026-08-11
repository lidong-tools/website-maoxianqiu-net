import type { AppEnv } from '../lib/types.js'
import process from 'node:process'
import { Hono } from 'hono'
import { z } from 'zod'
import { err } from '../lib/errors.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { retryDelivery } from '../services/messaging/engine.js'

/**
 * Cron 调度路由(F-R-2: 3.8.1-04 定时/自动触达闭环)
 *
 * 由 vercel.json crons 定时调用(Vercel Cron 不携带登录态,鉴权走共享密钥):
 *   - POST /api/cron/reminders  每天 09:00:扫描到期提醒 + 消费 queued 投递真实发送
 *   - POST /api/cron/campaigns  每天 08:00:扫描到期的 scheduled 活动 → 自动发布 + 生成投递
 *
 * 安全与可靠性:
 *   - 鉴权:请求头 x-cron-secret(或 Authorization: Bearer)必须匹配 CRON_SECRET;
 *     未配置 CRON_SECRET 时仅开发环境放行(便于本地手工触发),生产环境直接拒绝
 *   - 幂等:同一 run_id(请求头 x-cron-run-id,缺省按 action+日期生成)已在 jobs 表
 *     记录 completed 则直接返回既有结果;底层 RPC 亦各自幂等(唯一索引/CAS claim)
 *   - dryRun:?dryRun=true 只统计不执行,用于本地验证调度链路
 *   - 失败隔离:单个租户/RPC/投递失败不中断整体,汇总到结果中
 *
 * 注意:不挂 authMiddleware(无登录态),不修改 operations.ts/diagnostics.ts(其他 agent 文件域),
 * 直接通过 service client 调 scan_diag_reminders / scan_reminders RPC 生成到期提醒与 queued 投递,
 * queued 投递复用 engine.retryDelivery(真实 Provider,替换旧 send_delivery Mock 链路)。
 */
const cronRoutes = new Hono<AppEnv>()

/** 生产环境判定(与 messaging engine 一致) */
function isProductionEnv(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
}

/**
 * 校验 Cron 调度鉴权:CRON_SECRET 匹配 x-cron-secret 或 Bearer token。
 * 未配置 CRON_SECRET 时开发环境放行(便于本地手工触发),生产环境拒绝。
 */
function assertCronAuthorized(c: Parameters<typeof ok>[0]): void {
  const secret = (process.env.CRON_SECRET || '').trim()
  if (!secret) {
    if (!isProductionEnv()) {
      return
    }
    throw err.forbidden('CRON_SECRET 未配置,拒绝调度请求')
  }
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const header = c.req.header('x-cron-secret') ?? ''
  if (header !== secret && bearer !== secret) {
    throw err.forbidden('调度密钥不匹配')
  }
}

/** 从请求上下文解析可选的 run_id 幂等键(缺省按 action+UTC 日期生成) */
function resolveRunId(c: Parameters<typeof ok>[0], action: string): string {
  const explicit = c.req.header('x-cron-run-id')?.trim()
  if (explicit) {
    return explicit
  }
  return `${action}-${new Date().toISOString().slice(0, 13)}`
}

/**
 * 幂等检查:同 run_id 同 action 已有 completed 记录则返回既有结果。
 * 返回 hit=true 时调用方直接返回,不重复执行。
 */
async function checkIdempotency(
  c: Parameters<typeof ok>[0],
  action: string,
  runId: string,
): Promise<{ hit: boolean, payload: Record<string, unknown> | null }> {
  const service = createServiceClient()
  const { data, error } = await service
    .from('jobs')
    .select('payload')
    .eq('queue', 'cron')
    .eq('payload->>run_id', runId)
    .eq('payload->>action', action)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw err.internal(`幂等检查失败: ${error.message}`)
  }
  if (data) {
    return { hit: true, payload: (data.payload as Record<string, unknown>) ?? null }
  }
  return { hit: false, payload: null }
}

/** 记录一次 cron 执行结果到 jobs 表(queue='cron',幂等审计) */
async function recordCronRun(action: string, runId: string, result: Record<string, unknown>, status: 'completed' | 'failed'): Promise<void> {
  const service = createServiceClient()
  const { error } = await service.from('jobs').insert({
    queue: 'cron',
    payload: { run_id: runId, action, ...result },
    status,
  })
  if (error) {
    console.warn(`[cron] 记录执行结果失败: ${error.message}`, { action, runId })
  }
}

/** 查询全部生效租户 id(dryRun 时仅统计租户数) */
async function listTenantIds(service: ReturnType<typeof createServiceClient>): Promise<string[]> {
  const { data, error } = await service
    .from('tenants')
    .select('id')
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(500)
  if (error) {
    throw err.internal(`查询租户列表失败: ${error.message}`)
  }
  return (data ?? []).map(row => row.id as string)
}

/**
 * 消费 queued 投递(分批)→ engine.retryDelivery 走真实 Provider。
 * 替换旧 send_delivery Mock 链路:queued → sending → sent/failed(CAS claim 防并发重复发送)。
 * dryRun 时不执行,仅统计将消费条数。
 */
async function consumeQueuedDeliveries(
  service: ReturnType<typeof createServiceClient>,
  batch: number,
  dryRun: boolean,
): Promise<{ consumed: number, sent: number, failed: number, errors: string[] }> {
  const { data, error } = await service
    .from('message_deliveries')
    .select('id')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(batch)
  if (error) {
    throw err.internal(`查询 queued 投递失败: ${error.message}`)
  }
  const rows = (data ?? []) as Array<{ id: string }>
  const result = { consumed: rows.length, sent: 0, failed: 0, errors: [] as string[] }
  if (dryRun) {
    return result
  }
  for (const row of rows) {
    try {
      const { result: sendResult } = await retryDelivery(row.id)
      if (sendResult.status === 'sent' || sendResult.status === 'delivered') {
        result.sent += 1
      }
      else {
        result.failed += 1
      }
    }
    catch (e) {
      result.failed += 1
      result.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

// ===== POST /api/cron/reminders =====
// 扫描到期提醒(scan_diag_reminders 生成 diag_reminders;scan_reminders 生成 queued 投递)
// + 消费 queued 投递真实发送
cronRoutes.post('/reminders', async (c) => {
  assertCronAuthorized(c)
  const parsed = z.object({
    dryRun: z.coerce.boolean().default(false),
    batch: z.coerce.number().int().min(1).max(500).default(50),
  }).safeParse(c.req.query())
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { _root: parsed.error.issues.map(i => i.message) })
  }
  const { dryRun, batch } = parsed.data
  const action = 'cron.reminders'
  const runId = resolveRunId(c, action)

  // 幂等:同 run_id 已执行完成则直接返回
  const idem = await checkIdempotency(c, action, runId)
  if (idem.hit) {
    return ok(c, { ...(idem.payload ?? {}), idempotent: true, dryRun })
  }

  const service = createServiceClient()
  const tenants = await listTenantIds(service)
  const summary = {
    tenants_scanned: 0,
    diag_reminders_inserted: 0,
    reminders_created: 0,
    queued_consumed: 0,
    sent: 0,
    failed: 0,
    errors: [] as string[],
  }

  // 1. 逐租户扫描到期提醒(dryRun 时跳过 RPC)
  if (!dryRun) {
    for (const tenantId of tenants) {
      try {
        const { data: diagRes, error: diagErr } = await service.rpc('scan_diag_reminders', {
          p_tenant_id: tenantId,
          p_store_id: null,
          p_lookahead_days: 7,
        })
        if (diagErr) {
          summary.errors.push(`scan_diag_reminders ${tenantId}: ${diagErr.message}`)
        }
        else {
          const row = diagRes as { inserted_count?: number } | null
          summary.diag_reminders_inserted += row?.inserted_count ?? 0
        }

        const { data: remindRes, error: remindErr } = await service.rpc('scan_reminders', {
          p_tenant_id: tenantId,
          p_store_id: null,
        })
        if (remindErr) {
          summary.errors.push(`scan_reminders ${tenantId}: ${remindErr.message}`)
        }
        else {
          const row = remindRes as { scanned_count?: number } | null
          summary.reminders_created += row?.scanned_count ?? 0
        }
        summary.tenants_scanned += 1
      }
      catch (e) {
        summary.errors.push(`tenant ${tenantId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  else {
    summary.tenants_scanned = tenants.length
  }

  // 2. 消费 queued 投递(真实 Provider 发送,替换 send_delivery Mock)
  const consumed = await consumeQueuedDeliveries(service, batch, dryRun)
  summary.queued_consumed = consumed.consumed
  summary.sent = consumed.sent
  summary.failed = consumed.failed
  summary.errors.push(...consumed.errors)

  const result: Record<string, unknown> = { run_id: runId, ...summary }
  if (!dryRun) {
    await recordCronRun(action, runId, { ...summary }, 'completed')
  }
  return ok(c, result)
})

// ===== POST /api/cron/campaigns =====
// 扫描 starts_at<=now 且 status='scheduled' 的活动 → publish_campaign 发布 → dispatch_campaign_run 生成投递
cronRoutes.post('/campaigns', async (c) => {
  assertCronAuthorized(c)
  const parsed = z.object({
    dryRun: z.coerce.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }).safeParse(c.req.query())
  if (!parsed.success) {
    throw err.badRequest('参数校验失败', { _root: parsed.error.issues.map(i => i.message) })
  }
  const { dryRun, limit } = parsed.data
  const action = 'cron.campaigns'
  const runId = resolveRunId(c, action)

  // 幂等:同 run_id 已执行完成则直接返回
  const idem = await checkIdempotency(c, action, runId)
  if (idem.hit) {
    return ok(c, { ...(idem.payload ?? {}), idempotent: true, dryRun })
  }

  const service = createServiceClient()
  const nowIso = new Date().toISOString()
  // 排期活动扫描结果汇总(具体类型便于累加统计)
  interface CampaignCronSummary {
    due_scheduled: number
    published: number
    dispatched: number
    dispatch_count: number
    skipped: string[]
    errors: string[]
  }
  const summary: CampaignCronSummary = {
    due_scheduled: 0,
    published: 0,
    dispatched: 0,
    dispatch_count: 0,
    skipped: [],
    errors: [],
  }

  // 查询全部到期的 scheduled 活动(跨租户;service role 无 RLS 限制)
  const { data: campaigns, error: campErr } = await service
    .from('marketing_campaigns')
    .select('id, tenant_id, type')
    .eq('status', 'scheduled')
    .lte('starts_at', nowIso)
    .limit(limit)
  if (campErr) {
    throw err.internal(`查询排期活动失败: ${campErr.message}`)
  }
  const rows = (campaigns ?? []) as Array<{ id: string, tenant_id: string, type: string }>
  summary.due_scheduled = rows.length

  if (dryRun) {
    return ok(c, { run_id: runId, ...summary, dryRun: true })
  }

  for (const campaign of rows) {
    try {
      // 发布(Snapshot Audience + 建 Run;manual 排期无客户名单 → 跳过记录)
      const { data: publishRes, error: publishErr } = await service.rpc('publish_campaign', {
        p_tenant_id: campaign.tenant_id,
        p_campaign_id: campaign.id,
        p_customer_ids: null,
        p_operator_id: null,
      })
      if (publishErr) {
        if (publishErr.message.includes('MANUAL_CAMPAIGN_REQUIRES_CUSTOMERS')) {
          ;(summary.skipped as string[]).push(`${campaign.id}: manual 排期需人工发布`)
        }
        else {
          ;(summary.errors as string[]).push(`publish ${campaign.id}: ${publishErr.message}`)
        }
        continue
      }
      summary.published += 1
      const runIdOfCampaign = (publishRes as { run_id?: string } | null)?.run_id
      if (!runIdOfCampaign) {
        continue
      }

      // 生成 queued 投递(模板存在时;无模板 RPC 返回 skipped=no_template)
      const { data: dispatchRes, error: dispatchErr } = await service.rpc('dispatch_campaign_run', {
        p_run_id: runIdOfCampaign,
      })
      if (dispatchErr) {
        ;(summary.errors as string[]).push(`dispatch ${campaign.id}: ${dispatchErr.message}`)
        continue
      }
      summary.dispatched += 1
      summary.dispatch_count += (dispatchRes as { dispatch_count?: number } | null)?.dispatch_count ?? 0
    }
    catch (e) {
      ;(summary.errors as string[]).push(`campaign ${campaign.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  await recordCronRun(action, runId, { ...summary }, 'completed')
  return ok(c, { run_id: runId, ...summary })
})

export default cronRoutes
