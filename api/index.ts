import type { AppEnv } from './lib/types'
import process from 'node:process'
import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { fail, failError, ok } from './lib/result'
import { requestIdMiddleware } from './middlewares/request-id'
import billingRoutes from './routes/billing'
import catalogRoutes from './routes/catalog'
import clinicalRoutes from './routes/clinical'
import customersRoutes from './routes/customers'
import diagnosticsRoutes from './routes/diagnostics'
import employeeRoutes from './routes/employees'
import fileRoutes from './routes/files'
import fileCommandRoutes from './routes/files-v2'
import inpatientRoutes from './routes/inpatient'
import inventoryRoutes from './routes/inventory'
import operationsRoutes from './routes/operations'
import petsRoutes from './routes/pets'
import roleRoutes from './routes/roles'
import storeRoutes from './routes/stores'
import uploadRoutes from './routes/upload'
import userRoutes from './routes/user'

export const runtime = 'nodejs'

export const app = new Hono<AppEnv>().basePath('/api')

// API Foundation 全局中间件
app.use('*', requestIdMiddleware())

app.get('/health', (c) => {
  return ok(c, { ok: true, uptime: process.uptime() })
})

// 仅保留无法浏览器直连的服务端操作
app.route('/upload', uploadRoutes)
app.route('/files', fileRoutes)
app.route('/user', userRoutes)
// MXQ-4003~4006:文件上传意图/完成/下载 URL/归档/物理删除(Hono Command + RPC)
app.route('/files', fileCommandRoutes)
// MXQ-3008/3009/3010:门店归档/恢复、员工邀请/启停/分配/改角色、角色权限替换
app.route('/stores', storeRoutes)
app.route('/employees', employeeRoutes)
app.route('/roles', roleRoutes)
// MXQ-5001~5010:CRM 客户/宠物(合并 RPC + 导入)
app.route('/customers', customersRoutes)
app.route('/pets', petsRoutes)
// MXQ-6001~6010:Catalog 类目/目录/批量迁移/字典
app.route('/catalog', catalogRoutes)
// MXQ-9001~9008:Inventory 仓库/批次/发药/盘点/调拨(不可变流水 + 幂等)
app.route('/inventory', inventoryRoutes)
// MXQ-12001~12009:Operations 会员/积分/消息/导入/打印/报表/安全事件
app.route('/operations', operationsRoutes)
// MXQ-7001~7011:Clinical 预约/候诊/就诊/病历签署/修订/处方/护士任务
app.route('/clinical', clinicalRoutes)
// MXQ-8001~8007:Billing 发票/折扣/支付/退款 RPC(幂等防重复)
app.route('/billing', billingRoutes)
// MXQ-11001~11009:Inpatient 房间/笼位/入院房位锁/护理/交接班/换房/自动计费/出院
app.route('/inpatient', inpatientRoutes)
// MXQ-10001~10011:Diagnostics 疫苗方案/接种/证明/驱虫/检验申请/标本/结果发布/审核/危急值/提醒
app.route('/diagnostics', diagnosticsRoutes)

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
