/**
 * S32-B 经营报表与驾驶舱 — 公共工具
 *
 * 时区处理(S32-B 规格 §11):
 *   - 日期切片必须按 Store Timezone → Tenant Timezone(门店无时区字段,沿用租户时区);
 *   - 用 Intl 计算指定时区的本地日期键与日界,不依赖 Server UTC 直接切天;
 *   - 不引入 dayjs 等运行时依赖,纯 Intl 实现,避免影响共享构建。
 *
 * 权限(S32-B 规格 §10/§15):
 *   - 指定 storeId → 要求 analytics.view.store,数据范围收敛到该门店;
 *   - 未指定 storeId(全院) → 要求 analytics.view.tenant,数据范围为被授权门店集。
 */
import type { Context } from 'hono'
import type { AppEnv } from '../../lib/types'
import { err } from '../../lib/errors'
import { requireScopedPermission, type AccessScope } from '../../lib/permission'
import { resolveRequestedTenant } from '../../lib/request-context'
import { createServiceClient } from '../../lib/supabase'
import type { AnalyticsGroupBy, AnalyticsPeriod } from './types'

/** 时区回退(门店沿用租户时区,缺省 Asia/Shanghai) */
export const DEFAULT_TZ = 'Asia/Shanghai'
export const MAX_PERIOD_DAYS = 366

/** 数值归一化(兼容 numeric 字符串) */
export function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0) || 0
}

export function toInt(v: unknown): number {
  return Math.round(toNum(v))
}

export type ServiceClient = ReturnType<typeof createServiceClient>

/** 查询租户时区(门店无时区字段,一律沿用租户时区) */
export async function resolveTenantTimezone(
  service: ServiceClient,
  tenantId: string,
): Promise<string> {
  const { data } = await service
    .from('tenants')
    .select('timezone')
    .eq('id', tenantId)
    .maybeSingle()
  return (data as { timezone?: string } | null)?.timezone || DEFAULT_TZ
}

/** 计算某瞬间在指定时区的本地日期键 YYYY-MM-DD */
export function dayKeyInTz(iso: string | Date, tz: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const parts: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)) {
    parts[p.type] = p.value
  }
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** 计算某瞬间在指定时区的本地月份键 YYYY-MM */
export function monthKeyInTz(iso: string | Date, tz: string): string {
  return dayKeyInTz(iso, tz).slice(0, 7)
}

/**
 * 某时刻在指定时区的 UTC 偏移(毫秒)。
 * offset = 本地墙钟时间按 UTC 解释的瞬间 - 实际瞬间;
 * 即 local = utc + offset, utc = local - offset。
 */
function tzOffsetMs(tz: string, date: Date): number {
  const parts: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)) {
    parts[p.type] = p.value
  }
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return asUTC - date.getTime()
}

/** 将指定时区的本地日期(y,m,d)转为对应 UTC 瞬间(当地 00:00:00) */
export function localDateToUTC(tz: string, y: number, m: number, d: number, reference?: Date): Date {
  const ref = reference ?? new Date()
  const offset = tzOffsetMs(tz, ref)
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offset)
}

/** 解析 YYYY-MM-DD,非法抛 400 */
function parseDateKey(key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) {
    throw err.badRequest(`无效日期: ${key},需为 YYYY-MM-DD`)
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * 解析查询时间范围。
 * 缺省 = 当前租户时区的本月;日期按租户时区解释为闭区间;最长 366 天。
 */
export async function resolvePeriod(
  service: ServiceClient,
  tenantId: string,
  startAt?: string,
  endAt?: string,
): Promise<AnalyticsPeriod> {
  const tz = await resolveTenantTimezone(service, tenantId)
  const now = new Date()
  const todayKey = dayKeyInTz(now, tz)
  const [cy, cm] = todayKey.split('-').map(Number)

  const startKey = startAt ?? `${cy}-${String(cm).padStart(2, '0')}-01`
  const endKey = endAt ?? todayKey

  const startDate = parseDateKey(startKey)
  const endDate = parseDateKey(endKey)
  const days = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000)
  if (days < 0) {
    throw err.badRequest('时间范围起始日期不能晚于结束日期')
  }
  if (days > MAX_PERIOD_DAYS) {
    throw err.badRequest(`单次查询时间范围不可超过 ${MAX_PERIOD_DAYS} 天`)
  }

  const [sy, sm, sd] = startKey.split('-').map(Number)
  const [ey, em, ed] = endKey.split('-').map(Number)
  const startISO = localDateToUTC(tz, sy, sm, sd, now).toISOString()
  const endLocal = localDateToUTC(tz, ey, em, ed, now)
  const endISO = new Date(endLocal.getTime() + 86_400_000 - 1).toISOString()

  return { startDate: startKey, endDate: endKey, startISO, endISO, timezone: tz }
}

/** 解析后作用域 */
export interface AnalyticsScopeResult {
  scope: AccessScope
  /** 本次查询实际覆盖的门店 id 集合 */
  allowedStoreIds: string[]
  /** 是否为全院(多门店)模式 */
  allStores: boolean
}

/**
 * 解析报表作用域(S32-B 规格 §10 Authorization vs Context)
 *   - 传 storeId → analytics.view.store,只查该门店;
 *   - 不传 storeId → analytics.view.tenant,全院(仅租户级用户通过,数据收敛到被授权门店)。
 */
export async function resolveAnalyticsScope(
  c: Context<AppEnv>,
  opts: { tenantId?: string; storeId?: string },
): Promise<AnalyticsScopeResult> {
  const tenantId = resolveRequestedTenant(c, opts.tenantId)
  if (!tenantId) {
    throw err.badRequest('缺少租户标识')
  }

  if (opts.storeId) {
    const scope = await requireScopedPermission(c, {
      code: 'analytics.view.store',
      tenantId,
      storeId: opts.storeId,
      dataScope: true,
    })
    return { scope, allowedStoreIds: [opts.storeId], allStores: false }
  }

  const scope = await requireScopedPermission(c, {
    code: 'analytics.view.tenant',
    tenantId,
    dataScope: true,
  })
  return { scope, allowedStoreIds: scope.allowedStoreIds, allStores: true }
}

/** 门店名映射(租户内门店) */
export async function loadStoreNameMap(
  service: ServiceClient,
  tenantId: string,
  storeIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (storeIds.length === 0) {
    return map
  }
  const { data } = await service
    .from('stores')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .in('id', storeIds)
  for (const s of (data ?? []) as Array<{ id: string; name: string }>) {
    map.set(s.id, s.name || s.id.slice(0, 8))
  }
  return map
}

/** 分组键生成:day → YYYY-MM-DD,month → YYYY-MM */
export function bucketKey(groupBy: AnalyticsGroupBy, iso: string, tz: string): string {
  return groupBy === 'month' ? monthKeyInTz(iso, tz) : dayKeyInTz(iso, tz)
}

/** 分组键 → 展示标签 */
export function bucketLabel(groupBy: AnalyticsGroupBy, key: string): string {
  return groupBy === 'month' ? `${key}-01`.slice(0, 7) : key
}
