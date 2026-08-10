import type { AppEnv } from './lib/types.js'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { fail, failError, ok } from './lib/result.js'
import { requestIdMiddleware } from './middlewares/request-id.js'
import analyticsRoutes from './routes/analytics.js'
import approvalsRoutes from './routes/approvals.js'
import auditRoutes from './routes/audit.js'
import billingRoutes from './routes/billing.js'
import catalogRoutes from './routes/catalog.js'
import clinicalRoutes from './routes/clinical.js'
import closingRoutes from './routes/closing.js'
import complianceRoutes from './routes/compliance.js'
import crmGrowthRoutes from './routes/crm-growth.js'
import customersRoutes from './routes/customers.js'
import diagnosticsRoutes from './routes/diagnostics.js'
import documentArtifactRoutes from './routes/document-artifacts.js'
import documentsRoutes from './routes/documents.js'
import employeeRoutes from './routes/employees.js'
import fileCommandRoutes from './routes/files-v2.js'
import importConsumerRoutes from './routes/import-consumers.js'
import importsRoutes from './routes/imports.js'
import inpatientRoutes from './routes/inpatient.js'
import insuranceRoutes from './routes/insurance.js'
import inventoryRoutes from './routes/inventory.js'
import marketingRoutes from './routes/marketing.js'
import meRoutes from './routes/me.js'
import medicationSafetyRoutes from './routes/medication-safety.js'
import messagingWebhookRoutes from './routes/messaging-webhook.js'
import messagingRoutes from './routes/messaging.js'
import operationsRoutes from './routes/operations.js'
import patientJourneyRoutes from './routes/patient-journey.js'
import petsRoutes from './routes/pets.js'
import portalRoutes from './routes/portal.js'
import purchaseRequestRoutes from './routes/purchase-requests.js'
import purchaseReturnRoutes from './routes/purchase-returns.js'
import regulatoryRoutes from './routes/regulatory.js'
import reportDataRoutes from './routes/report-data.js'
import roleRoutes from './routes/roles.js'
import searchRoutes from './routes/search.js'
import settingsRoutes from './routes/settings.js'
import storeRoutes from './routes/stores.js'
import tenantRoutes from './routes/tenants.js'
import userRoutes from './routes/user.js'
import walletRoutes from './routes/wallet.js'

/**
 * Vercel 函数路由唯一入口。vercel.json 将 /api/* 重写到此固定入口，
 * Hono 仍使用原始请求路径完成业务路由匹配。
 *
 * 使用固定入口避免 Vercel 在非 Next.js 项目中将 catch-all 文件误判为普通动态段，
 * 导致 /api/me/context 等多段路径在平台层直接返回 404。
 */
export const runtime = 'nodejs'

// 部署元数据:模块加载时一次性计算
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
// Stage04-07:采购申请 / 采购退货(挂载在 /inventory 之后,
// inventoryRoutes 无动态段吞路径,保持与既有 /inventory/purchase-orders 同级约定)
app.route('/inventory/purchase-requests', purchaseRequestRoutes)
app.route('/inventory/purchase-returns', purchaseReturnRoutes)
// Stage04-07:Import Consumer 命令收口(员工邀请/期初库存消费 Job)
app.route('/import-consumers', importConsumerRoutes)
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
// 注意:webhook 回调入口必须挂在 /messaging 之前,避免被 messaging 前缀路由吞掉
app.route('/messaging/webhook', messagingWebhookRoutes)
app.route('/messaging', messagingRoutes)
// Stage04-08:C 端门户(身份/预约/报告/会员权益)
app.route('/portal', portalRoutes)
// MXQ-7001~7011:Clinical 预约/候诊/就诊/病历签署/修订/处方/护士任务
app.route('/clinical', clinicalRoutes)
app.route('/', patientJourneyRoutes)
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
// Stage04-03:储值钱包(账户/充值/调整/冻结/流水;收银 stored_value 原子扣款在 Billing RPC)
app.route('/wallet', walletRoutes)
// Stage04-04:用药安全(规则/药品档案/相互作用/评估/豁免;issue/dispense 服务端强制门禁)
app.route('/medication-safety', medicationSafetyRoutes)
// Stage04-05:CRM 增长(分层/流失/洞察)与营销(优惠券/套餐/活动/推荐)
app.route('/crm-growth', crmGrowthRoutes)
app.route('/marketing', marketingRoutes)
// Stage04-06:保险理赔 + 通用 PDF 归档/电子签名
app.route('/insurance', insuranceRoutes)
app.route('/document-artifacts', documentArtifactRoutes)

// 统一错误处理(MXQ-2001):业务错误带明确 HTTP 状态与错误码
app.notFound((c) => {
  return fail(c, 404, { code: 'NOT_FOUND', message: '接口不存在' })
})
app.onError((e, c) => {
  return failError(c, e)
})

const honoHandler = handle(app)

/**
 * 还原 vercel.json 重写前的 API 路径，使固定函数入口能够分发任意层级的 Hono 路由。
 */
function handleRewrittenRequest(request: Request) {
  const url = new URL(request.url)
  const path = url.searchParams.get('path')
  if (!path) {
    return honoHandler(request)
  }

  url.pathname = `/api/${path.replace(/^\/+/, '')}`
  url.searchParams.delete('path')
  return honoHandler(new Request(url, request))
}

export const GET = handleRewrittenRequest
export const POST = handleRewrittenRequest
export const PUT = handleRewrittenRequest
export const PATCH = handleRewrittenRequest
export const DELETE = handleRewrittenRequest
export const OPTIONS = handleRewrittenRequest
