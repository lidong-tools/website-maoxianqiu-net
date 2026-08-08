import type { AppEnv } from './lib/types'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { fail, failError, ok } from './lib/result'
import { requestIdMiddleware } from './middlewares/request-id'
import approvalsRoutes from './routes/approvals'
import analyticsRoutes from './routes/analytics'
import auditRoutes from './routes/audit'
import billingRoutes from './routes/billing'
import catalogRoutes from './routes/catalog'
import clinicalRoutes from './routes/clinical'
import closingRoutes from './routes/closing'
import complianceRoutes from './routes/compliance'
import customersRoutes from './routes/customers'
import diagnosticsRoutes from './routes/diagnostics'
import documentsRoutes from './routes/documents'
import employeeRoutes from './routes/employees'
import fileCommandRoutes from './routes/files-v2'
import importsRoutes from './routes/imports'
import inpatientRoutes from './routes/inpatient'
import inventoryRoutes from './routes/inventory'
import meRoutes from './routes/me'
import messagingRoutes from './routes/messaging'
import operationsRoutes from './routes/operations'
import petsRoutes from './routes/pets'
import regulatoryRoutes from './routes/regulatory'
import reportDataRoutes from './routes/report-data'
import roleRoutes from './routes/roles'
import searchRoutes from './routes/search'
import settingsRoutes from './routes/settings'
import storeRoutes from './routes/stores'
import tenantRoutes from './routes/tenants'
import userRoutes from './routes/user'

export const runtime = 'nodejs'

// 部署元数据：模块加载时一次性计算
const buildTime = new Date().toISOString()

const appVersion: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync('apps/maoxianqiu/package.json', 'utf-8'))
    return pkg.version ?? '0.0.0'
  }
  catch {
    return '0.0.0'
  }
})()

const commitSha: string = (() => {
  // Vercel 部署环境中自动注入此变量
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA
  if (vercelSha) {
    return vercelSha
  }
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
  }
  catch {
    return 'unknown'
  }
})()

const env: string = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development'

export const app = new Hono<AppEnv>().basePath('/api')

// API Foundation 全局中间件
app.use('*', requestIdMiddleware())

app.get('/health', (c) => {
  return ok(c, {
    ok: true,
    uptime: process.uptime(),
    commitSha,
    buildTime,
    environment: env,
    appVersion,
  })
})

// 仅保留无法浏览器直连的服务端操作
// P0-03:旧 /api/upload(Vercel 中转)与旧 /api/files/delete(r2_files) 已下线,统一走新私有 files 模型
// CORE-04:审计日志查询(仅 service role 可写,查询走 Hono 权限收敛)
app.route('/audit', auditRoutes)
// CORE-05:审批中心聚合查询(决定动作仍走各业务域)
app.route('/approvals', approvalsRoutes)
// CORE-06:系统设置(配置继承:门店覆盖 → 租户默认 → 系统默认)
app.route('/settings', settingsRoutes)
app.route('/user', userRoutes)
// P0-01..P0-05:当前用户工作上下文(浏览器不再维护第二套权限/上下文算法)
app.route('/me', meRoutes)
// P0-29:全局业务搜索(服务端聚合 + 作用域过滤)
app.route('/search', searchRoutes)
// MXQ-4003~4006:文件上传意图/完成/下载 URL/归档/物理删除(Hono Command + RPC)
app.route('/files', fileCommandRoutes)
// MXQ-3008/3009/3010:门店归档/恢复、员工邀请/启停/分配/改角色、角色权限替换
app.route('/stores', storeRoutes)
// S3.1-A:租户初始化闭环(首店/owner/仓库/支付/字典/打印)
app.route('/tenants', tenantRoutes)
app.route('/employees', employeeRoutes)
app.route('/roles', roleRoutes)
// MXQ-5001~5010:CRM 客户/宠物(合并 RPC + 导入)
app.route('/customers', customersRoutes)
app.route('/pets', petsRoutes)
// MXQ-6001~6010:Catalog 类目/目录/批量迁移/字典
app.route('/catalog', catalogRoutes)
// MXQ-9001~9008:Inventory 仓库/批次/发药/盘点/调拨(不可变流水 + 幂等)
app.route('/inventory', inventoryRoutes)
// P0-06:统一报表真源(实时明细,服务端聚合,前端只渲染)
// 注意:必须挂在 /operations 之前,否则会被 operationsRoutes 拦截
app.route('/operations/report-data', reportDataRoutes)
// MXQ-12001~12009:Operations 会员/积分/消息/导入/打印/报表/安全事件
app.route('/operations', operationsRoutes)
// S32-A:导入中心 V2(模板/上传/映射/校验/执行/取消;跨域 Hook 见 S32-A-HANDOFF)
app.route('/imports', importsRoutes)
// S32-B:经营报表与驾驶舱(只读聚合,权限 analytics.view.store/tenant/export)
app.route('/analytics', analyticsRoutes)
// S32-C:业务文档与打印中心 V2(模板/预览/渲染/打印/历史;医疗文档按业务权限门二次校验)
app.route('/documents', documentsRoutes)
// S32-D:消息通知真实 Provider(模板/发送/投递/重试;webhook 本轮未实现,见 S32-D-HANDOFF)
app.route('/messaging', messagingRoutes)
// MXQ-7001~7011:Clinical 预约/候诊/就诊/病历签署/修订/处方/护士任务
app.route('/clinical', clinicalRoutes)
// MXQ-8001~8007:Billing 发票/折扣/支付/退款 RPC(幂等防重复)
app.route('/billing', billingRoutes)
// MXQ-11001~11009:Inpatient 房间/笼位/入院房位锁/护理/交接班/换房/自动计费/出院
app.route('/inpatient', inpatientRoutes)
// MXQ-10001~10011:Diagnostics 疫苗方案/接种/证明/驱虫/检验申请/标本/结果发布/审核/危急值/提醒
app.route('/diagnostics', diagnosticsRoutes)
// S3.1-1:Compliance 病历归档/修订/兽医备案/处方开具合规
app.route('/compliance', complianceRoutes)
// S3.1-PARALLEL-01:Regulatory 监管运营(许可证/年度报告/疫情台账/医疗废弃物)
app.route('/regulatory', regulatoryRoutes)
// S31-PARALLEL-B:日结与对账(日结/调整/渠道汇总/对账录入/差异确认)
app.route('/closing', closingRoutes)

// 统一错误处理(MXQ-2001):业务错误带明确 HTTP 状态与错误码
app.notFound((c) => {
  return fail(c, 404, { code: 'NOT_FOUND', message: '接口不存在' })
})
app.onError((e, c) => {
  return failError(c, e)
})

export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const PATCH = handle(app)
export const DELETE = handle(app)
export const OPTIONS = handle(app)
