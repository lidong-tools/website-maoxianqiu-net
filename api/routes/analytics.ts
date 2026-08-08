/**
 * S32-B 经营报表与驾驶舱(Analytics)路由
 *
 * 端点:
 *   GET /api/analytics/dashboard?tenantId&storeId&startAt&endAt
 *   GET /api/analytics/revenue?tenantId&storeId&startAt&endAt&groupBy=day|month&dimension=store|payment_channel|catalog_type|doctor
 *   GET /api/analytics/customers?tenantId&storeId&startAt&endAt
 *   GET /api/analytics/clinical?tenantId&storeId&startAt&endAt
 *   GET /api/analytics/inventory?tenantId&storeId&startAt&endAt
 *   GET /api/analytics/export?report=dashboard|revenue|customers|clinical|inventory&...(同上)&dimension&groupBy
 *
 * 统一 Query:tenantId / storeId / startAt / endAt / groupBy / dimension
 *
 * 授权(S32-B 规格 §10/§15):
 *   - 传 storeId → analytics.view.store,只查该门店;
 *   - 不传 storeId(全院) → analytics.view.tenant,仅租户级用户可汇总;
 *   - 导出 → 追加 analytics.export 校验 + 审计(audit_logs)。
 *
 * 时区:按 Tenant Timezone 切日,禁止 Server UTC 直接切天(§11)。
 * 性能:SQL 聚合 + 索引,不引入 OLAP 引擎(§12)。
 */
import type { Context } from 'hono'
import type { AppEnv } from '../lib/types.js'
import { Hono } from 'hono'
import { err } from '../lib/errors.js'
import { writeAudit } from '../lib/audit.js'
import { loadContext } from '../lib/request-context.js'
import { ok } from '../lib/result.js'
import { createServiceClient } from '../lib/supabase.js'
import { authMiddleware, loadCaller } from '../middlewares/auth.js'
import {
  resolveAnalyticsScope,
  resolvePeriod,
} from '../services/analytics/common.js'
import type { RevenueFilters } from '../services/analytics/types.js'
import { buildDashboardReport } from '../services/analytics/dashboard.js'
import { buildRevenueReport } from '../services/analytics/revenue.js'
import { buildCustomerReport } from '../services/analytics/customers.js'
import { buildClinicalReport } from '../services/analytics/clinical.js'
import { buildInventoryReport } from '../services/analytics/inventory.js'
import { safeFilename, toCsv, type CsvColumn } from '../services/analytics/csv.js'
import { requireScopedPermission } from '../lib/permission.js'

const analyticsRoutes = new Hono<AppEnv>()

analyticsRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

type GroupBy = 'day' | 'month'
type Dimension = 'store' | 'payment_channel' | 'catalog_type' | 'doctor'

function parseGroupBy(v?: string): GroupBy {
  return v === 'month' ? 'month' : 'day'
}

function parseDimension(v?: string): Dimension {
  const d: Dimension[] = ['store', 'payment_channel', 'catalog_type', 'doctor']
  return d.includes(v as Dimension) ? (v as Dimension) : 'store'
}

interface ReportContext {
  service: ReturnType<typeof createServiceClient>
  filters: RevenueFilters
  storeId?: string
  allStores: boolean
}

/** 解析公共查询参数并解析作用域/时间范围 */
async function resolveReportContext(c: Context<AppEnv>): Promise<ReportContext> {
  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  const startAt = c.req.query('startAt')
  const endAt = c.req.query('endAt')

  const { scope, allowedStoreIds, allStores } = await resolveAnalyticsScope(c, {
    tenantId: tenantId ?? undefined,
    storeId: storeId ?? undefined,
  })

  const service = createServiceClient()
  const period = await resolvePeriod(service, scope.tenantId, startAt ?? undefined, endAt ?? undefined, storeId ?? undefined)

  return {
    service,
    filters: { tenantId: scope.tenantId, storeIds: allowedStoreIds, period },
    storeId: storeId ?? undefined,
    allStores,
  }
}

// ===== 驾驶舱 =====
analyticsRoutes.get('/dashboard', async (c) => {
  const ctx = await resolveReportContext(c)
  const report = await buildDashboardReport(ctx.service, ctx.filters)
  return ok(c, report)
})

// ===== 收入分析 =====
analyticsRoutes.get('/revenue', async (c) => {
  const ctx = await resolveReportContext(c)
  const groupBy = parseGroupBy(c.req.query('groupBy'))
  const dimension = parseDimension(c.req.query('dimension'))
  const report = await buildRevenueReport(ctx.service, ctx.filters, { groupBy, dimension })
  return ok(c, report)
})

// ===== 客户分析 =====
analyticsRoutes.get('/customers', async (c) => {
  const ctx = await resolveReportContext(c)
  const report = await buildCustomerReport(ctx.service, ctx.filters)
  return ok(c, report)
})

// ===== 医疗运营 =====
analyticsRoutes.get('/clinical', async (c) => {
  const ctx = await resolveReportContext(c)
  const report = await buildClinicalReport(ctx.service, ctx.filters)
  return ok(c, report)
})

// ===== 库存分析 =====
analyticsRoutes.get('/inventory', async (c) => {
  const ctx = await resolveReportContext(c)
  const report = await buildInventoryReport(ctx.service, ctx.filters)
  return ok(c, report)
})

// ===== CSV 导出(权限 + 审计) =====
analyticsRoutes.get('/export', async (c) => {
  const report = c.req.query('report') ?? 'revenue'
  const allowed: string[] = ['dashboard', 'revenue', 'customers', 'clinical', 'inventory']
  if (!allowed.includes(report)) {
    throw err.badRequest(`不支持的导出报表: ${report}`)
  }

  const tenantId = c.req.query('tenantId')
  const storeId = c.req.query('storeId')
  const startAt = c.req.query('startAt')
  const endAt = c.req.query('endAt')
  const groupBy = parseGroupBy(c.req.query('groupBy'))
  const dimension = parseDimension(c.req.query('dimension'))

  // 1) 报表数据范围(analytics.view.store / analytics.view.tenant)
  const { scope, allowedStoreIds } = await resolveAnalyticsScope(c, {
    tenantId: tenantId ?? undefined,
    storeId: storeId ?? undefined,
  })
  // 2) 导出权限(analytics.export)
  await requireScopedPermission(c, {
    code: 'analytics.export',
    tenantId: scope.tenantId,
    storeId: storeId ?? undefined,
    dataScope: true,
  })

  const service = createServiceClient()
  const period = await resolvePeriod(service, scope.tenantId, startAt ?? undefined, endAt ?? undefined, storeId ?? undefined)
  const filters: RevenueFilters = { tenantId: scope.tenantId, storeIds: allowedStoreIds, period }

  let columns: CsvColumn[] = []
  let rows: Array<Record<string, unknown>> = []
  let fileBase = ''

  switch (report) {
    case 'dashboard': {
      const r = await buildDashboardReport(service, filters)
      columns = [
        { label: '指标', key: 'label' },
        { label: '数值', key: 'value' },
        { label: '格式', key: 'format' },
        { label: '定义', key: 'definition' },
      ]
      rows = r.kpis.map(k => ({ label: k.label, value: k.value, format: k.format, definition: k.definition }))
      fileBase = '经营驾驶舱'
      break
    }
    case 'revenue': {
      const r = await buildRevenueReport(service, filters, { groupBy, dimension })
      columns = [
        { label: '分组', key: 'bucket' },
        { label: 'Gross', key: 'gross' },
        { label: '退款', key: 'refund' },
        { label: '净收入', key: 'net' },
        { label: '发票数', key: 'invoiceCount' },
        { label: '客单价', key: 'averageTicket' },
      ]
      rows = r.trend.map(t => ({ bucket: t.bucket, gross: t.gross, refund: t.refund, net: t.net, invoiceCount: t.invoiceCount, averageTicket: t.averageTicket }))
      fileBase = '收入分析'
      break
    }
    case 'customers': {
      const r = await buildCustomerReport(service, filters)
      columns = [
        { label: '指标', key: 'label' },
        { label: '数值', key: 'value' },
        { label: '定义', key: 'definition' },
      ]
      rows = r.kpis.map(k => ({ label: k.label, value: k.value, definition: k.definition }))
      fileBase = '客户分析'
      break
    }
    case 'clinical': {
      const r = await buildClinicalReport(service, filters)
      columns = [
        { label: '日期', key: 'date' },
        { label: '预约数', key: 'appointments' },
        { label: '到店数', key: 'showUps' },
        { label: 'No-show', key: 'noShows' },
        { label: '接诊数', key: 'encounters' },
        { label: '完成病历', key: 'signedEncounters' },
      ]
      rows = r.dailyRows.map(d => ({ ...d }))
      fileBase = '医疗运营'
      break
    }
    case 'inventory': {
      const r = await buildInventoryReport(service, filters)
      columns = [
        { label: '指标', key: 'label' },
        { label: '数值', key: 'value' },
        { label: '定义', key: 'definition' },
      ]
      rows = r.kpis.map(k => ({ label: k.label, value: k.value, definition: k.definition }))
      fileBase = '库存分析'
      break
    }
  }

  // 3) 审计(导出必须记录)
  await writeAudit(c, {
    action: 'analytics.export',
    entityType: `analytics.${report}`,
    tenantId: scope.tenantId,
    storeId: storeId ?? undefined,
    metadata: { startAt, endAt, groupBy, dimension, rows: rows.length },
  })

  const csv = toCsv(columns, rows)
  const filename = `${safeFilename(fileBase)}_${period.startDate}_${period.endDate}`
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}.csv"`,
  })
})

export default analyticsRoutes
