/**
 * S32-B 经营报表与驾驶舱 — 公共工具
 *
 * 时区处理(S32-B 规格 §11 + 审计 #24 Store Timezone Override):
 *   - 日期切片按 Store Timezone → Tenant Timezone 优先顺序:
 *     单门店报表若门店配置了 stores.timezone 则按门店时区切日,否则沿用租户时区;
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

/** 分页大小:低于 PostgREST 单次返回上限,循环拉全避免静默截断(审计 v2 §14) */
export const FETCH_PAGE_SIZE = 500

/**
 * 分页拉全查询结果(规避 PostgREST 行数上限导致的静默截断)
 *
 * 背景:PostgREST 对单次请求有行数上限,若直接 select 全量行,超出部分会被
 * 静默截断,JS 侧聚合得到"少算但正常"的数字,对 BI 比接口报错更危险
 * (审计 v2 §14:Analytics Data Completeness P0)。
 * 本助手按 [from, to] 分页循环拉取,直到单页不足一页为止,保证聚合完整。
 *
 * @param tableName 表名/业务名(用于错误提示)
 * @param pageFn    单页查询构造器,接收 from(含)/to(含),返回 service client 查询结果
 * @returns 全量行数组
 */
export async function fetchAll<T>(
  tableName: string,
  // 用 PromiseLike 而非 Promise:PostgrestFilterBuilder 是 thenable,
  // 不是完整 Promise,声成 Promise 会触发 TS2739(缺 catch/finally)
  pageFn: (from: number, to: number) => PromiseLike<{ data: T[] | null, error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += FETCH_PAGE_SIZE) {
    const { data, error } = await pageFn(from, from + FETCH_PAGE_SIZE - 1)
    if (error) {
      throw new Error(`${tableName}查询失败: ${error.message}`)
    }
    const rows = (data as T[] | null) ?? []
    out.push(...rows)
    if (rows.length < FETCH_PAGE_SIZE) {
      break
    }
  }
  return out
}

/** 数值归一化(兼容 numeric 字符串) */
export function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0) || 0
}

export function toInt(v: unknown): number {
  return Math.round(toNum(v))
}

/**
 * 数组分块(审计 v3 §11):大 ID 集合的 .in() 查询按块分批,
 * 避免单次 PostgREST 查询/URL 过长(大医院发票/商品量级下可能 414/超限)。
 */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size))
  }
  return out
}

export type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * 解析报表时区(S32-B 审计 #24 Store Timezone Override)
 *   - 指定门店且该门店配置了 stores.timezone → 优先使用门店时区;
 *   - 否则回退租户时区(tenants.timezone,缺省 Asia/Shanghai)。
 */
export async function resolveTenantTimezone(
  service: ServiceClient,
  tenantId: string,
  storeId?: string,
): Promise<string> {
  // 门店级时区覆盖(单门店报表场景)
  if (storeId) {
    const { data: store } = await service
      .from('stores')
      .select('timezone')
      .eq('tenant_id', tenantId)
      .eq('id', storeId)
      .maybeSingle()
    const storeTz = (store as { timezone?: string | null } | null)?.timezone
    if (storeTz) {
      return storeTz
    }
  }
  // 租户级时区回退
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
 * 缺省 = 当前租户时区的本月;日期按租户/门店时区解释为闭区间;最长 366 天。
 * storeId 可选:指定门店且配置了 stores.timezone 时按门店时区切日(审计 #24)。
 */
export async function resolvePeriod(
  service: ServiceClient,
  tenantId: string,
  startAt?: string,
  endAt?: string,
  storeId?: string,
): Promise<AnalyticsPeriod> {
  const tz = await resolveTenantTimezone(service, tenantId, storeId)
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
