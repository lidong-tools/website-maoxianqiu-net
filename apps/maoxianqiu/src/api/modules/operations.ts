import type {
  AdjustPointsInput,
  AdjustPointsResult,
  CreateImportTaskInput,
  CreatePrintJobInput,
  GenerateReportSnapshotInput,
  ImportTask,
  MessageTemplate,
  PrintData,
  PrintJob,
  ReportDataPayload,
  ReportDefinition,
  ReportSnapshot,
  ScanRemindersResult,
  SecurityEvent,
} from '@/types/operations'
import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * Operations 领域 API 模块(MXQ-12001~12009)
 *
 * 设计原则:
 *   - 跨表事务操作(积分增减、提醒扫描、发送、导入、打印、报表生成)走 Hono Command + RPC
 *   - 简单 CRUD(模板、报表定义等)直连 Supabase,RLS 兜底
 *   - 安全事件仅超管可读,通过 Hono 路由代理(service_role 写入)
 *   - 幂等:积分调整支持 idempotency-key 头部
 *
 * 消息发送(MXQ-12005)说明:
 *   - sendDelivery 通过 Hono Command + send_delivery RPC 触发
 *   - RPC 内部当前使用 Mock Provider(开发/测试阶段)
 *   - 正式上线前需替换为真实消息供应商(阿里云短信/SendGrid 邮件/微信模板消息等)
 *   - 通过 isMockProvider() 可运行时判断当前是否为 Mock 模式
 */

/**
 * 检查当前消息服务是否使用 Mock Provider
 * Mock 模式下消息不会真正发送到终端用户，仅标记为 sent
 * 正式上线配置真实供应商后返回 false
 */
export function isMockProvider(): boolean {
  /** 通过 VITE_MESSAGE_PROVIDER 环境变量显式指定消息供应商；未配置或为 mock 时回退到 mock 模式 */
  const provider = import.meta.env.VITE_MESSAGE_PROVIDER as string | undefined
  if (provider === 'real') {
    return false
  }
  if (provider === 'mock') {
    return true
  }
  /**
   * 未配置真实供应商时，所有环境均回退 mock 模式；
   *  生产环境中此行为会导致 sendDelivery 拒绝执行
   */
  return true
}

export default {
  // ===== MXQ-12001 会员等级 =====

  /**
   * 查询会员等级列表(浏览器直连,RLS 兜底)
   * @param params 查询参数
   * @param params.tenantId 租户 id
   * @param params.onlyActive 仅返回启用的等级
   */
  async listMembershipTiers(params: { tenantId: string, onlyActive?: boolean }) {
    let query = supabase
      .from('membership_tiers')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
    if (params.onlyActive) {
      query = query.eq('is_active', true)
    }
    const { data, error, count } = await query.order('sort_order', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: data ?? [], total: count ?? 0 } }
  },

  /**
   * 查询客户会员关系
   * @param params 查询参数
   * @param params.tenantId 租户 id
   * @param params.customerId 客户 id
   */
  async getCustomerMembership(params: { tenantId: string, customerId: string }) {
    const { data, error } = await supabase
      .from('customer_memberships')
      .select('*, tier:membership_tiers(*)')
      .eq('tenant_id', params.tenantId)
      .eq('customer_id', params.customerId)
      .maybeSingle()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data }
  },

  // ===== MXQ-12002 积分 =====

  /**
   * 查询客户积分流水(浏览器直连,RLS 兜底)
   * @param params 查询参数
   * @param params.tenantId 租户 id
   * @param params.customerId 客户 id
   * @param params.from 起始行
   * @param params.limit 行数
   */
  async listPointTransactions(params: {
    tenantId: string
    customerId: string
    from?: number
    limit?: number
  }) {
    let query = supabase
      .from('point_transactions')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
      .eq('customer_id', params.customerId)
    if (params.from !== undefined && params.limit !== undefined) {
      query = query.range(params.from, params.from + params.limit - 1)
    }
    const { data, error, count } = await query.order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: data ?? [], total: count ?? 0 } }
  },

  /**
   * 调整积分(MXQ-12002)
   * 走 Hono Command + adjust_points RPC,事务化增减积分 + 写流水
   * 幂等键通过 header 传递
   */
  adjustPoints(data: AdjustPointsInput & { idempotencyKey?: string }) {
    const headers: Record<string, string> = {}
    if (data.idempotencyKey) {
      headers['idempotency-key'] = data.idempotencyKey
    }
    return api.post<AdjustPointsResult>('operations/points/adjust', {
      tenantId: data.tenantId,
      customerId: data.customerId,
      delta: data.delta,
      reason: data.reason,
      referenceId: data.referenceId,
      referenceType: data.referenceType,
    }, { headers })
  },

  // ===== MXQ-12003 消息模板 =====

  /**
   * 查询消息模板列表(浏览器直连,RLS 兜底)
   */
  async listMessageTemplates(params: {
    tenantId: string
    channel?: string
    onlyActive?: boolean
  }) {
    let query = supabase
      .from('message_templates')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
    if (params.channel) {
      query = query.eq('channel', params.channel)
    }
    if (params.onlyActive) {
      query = query.eq('is_active', true)
    }
    const { data, error, count } = await query.order('updated_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as MessageTemplate[], total: count ?? 0 } }
  },

  /**
   * 新建/编辑消息模板(直连,RLS 兜底)
   */
  async saveMessageTemplate(payload: Partial<MessageTemplate> & {
    tenant_id: string
    code: string
    name: string
    channel: MessageTemplate['channel']
    body: string
  }) {
    if (payload.id) {
      const { id, ...patch } = payload
      const { data, error } = await supabase
        .from('message_templates')
        .update(patch)
        .eq('id', id)
        .select()
        .single()
      if (error) {
        throw new Error(error.message)
      }
      return { status: 1, error: '', data }
    }
    const { data, error } = await supabase
      .from('message_templates')
      .insert(payload)
      .select()
      .single()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data }
  },

  // ===== MXQ-12004 提醒 =====

  /**
   * 查询提醒列表(浏览器直连,RLS 兜底)
   */
  async listReminders(params: {
    tenantId: string
    storeId?: string
    status?: string
    from?: number
    limit?: number
  }) {
    let query = supabase
      .from('reminders')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
    if (params.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params.status) {
      query = query.eq('status', params.status)
    }
    if (params.from !== undefined && params.limit !== undefined) {
      query = query.range(params.from, params.from + params.limit - 1)
    }
    const { data, error, count } = await query.order('scheduled_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: data ?? [], total: count ?? 0 } }
  },

  /**
   * 扫描到期提醒(MXQ-12004)
   * 走 Hono Command + scan_reminders RPC,生成发送任务
   */
  scanReminders(data: { tenantId: string, storeId?: string }) {
    return api.post<ScanRemindersResult>('operations/reminders/scan', data)
  },

  // ===== MXQ-12005 发送适配器 =====

  /**
   * 查询发送任务列表(浏览器直连,RLS 兜底)
   * 支持按状态和渠道筛选
   */
  async listDeliveries(params: {
    tenantId: string
    status?: string
    channel?: string
    from?: number
    limit?: number
  }) {
    let query = supabase
      .from('message_deliveries')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
    if (params.status) {
      query = query.eq('status', params.status)
    }
    if (params.channel) {
      query = query.eq('channel', params.channel)
    }
    if (params.from !== undefined && params.limit !== undefined) {
      query = query.range(params.from, params.from + params.limit - 1)
    }
    const { data, error, count } = await query.order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: data ?? [], total: count ?? 0 } }
  },

  /**
   * 触发发送(MXQ-12005)
   *
   * ⚠️ 当前使用 Mock Provider:
   *   - 开发环境: 走 Hono Command + send_delivery RPC，仅标记 sent
   *   - 生产环境: 拒绝执行，直接抛错
   *   - 正式上线前需在后端配置真实消息供应商
   *   - 前端可调用 isMockProvider() 获取当前是否为 Mock 模式
   *
   * @param deliveryId 投递记录 id
   * @returns 发送结果(状态标记，mock 模式下附带 mock: true)
   */
  sendDelivery(deliveryId: string) {
    /** 检查 provider 配置 */
    if (isMockProvider()) {
      /** 生产环境 mock 模式：拒绝执行，不调用 RPC */
      if (import.meta.env.PROD) {
        return Promise.reject(new Error('生产环境未配置消息供应商，无法发送消息'))
      }
      /** 开发环境 mock 模式：允许执行但输出警告 */
      console.warn(`[operations] sendDelivery(${deliveryId}): 当前使用 Mock Provider，消息不会实际发送`)
      return api.post(`operations/deliveries/${deliveryId}/send`, {}).then((res) => {
        return { ...(res as any), mock: true }
      })
    }
    /** 真实供应商模式：正常发送 */
    return api.post(`operations/deliveries/${deliveryId}/send`, {})
  },

  // ===== MXQ-12006 导入任务 =====

  /**
   * 创建导入任务(MXQ-12006)
   * 走 Hono Command + create_import_task RPC,事务化建任务 + 入队
   */
  createImportTask(data: CreateImportTaskInput) {
    return api.post<ImportTask>('operations/imports', data)
  },

  /**
   * 查询导入任务详情(浏览器直连,RLS 兜底)
   */
  async getImportTask(id: string) {
    const { data, error } = await supabase
      .from('import_tasks')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: data as ImportTask | null }
  },

  /**
   * 查询导入任务列表(浏览器直连)
   */
  async listImportTasks(params: {
    tenantId: string
    storeId?: string
    status?: string
    type?: string
    from?: number
    limit?: number
  }) {
    let query = supabase
      .from('import_tasks')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
    if (params.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params.status) {
      query = query.eq('status', params.status)
    }
    if (params.type) {
      query = query.eq('type', params.type)
    }
    if (params.from !== undefined && params.limit !== undefined) {
      query = query.range(params.from, params.from + params.limit - 1)
    }
    const { data, error, count } = await query.order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as ImportTask[], total: count ?? 0 } }
  },

  // ===== MXQ-12007 打印 =====

  /**
   * 创建打印任务(MXQ-12007)
   * 走 Hono Command + create_print_job RPC
   */
  createPrintJob(data: CreatePrintJobInput) {
    return api.post<PrintJob>('operations/print', data)
  },

  /**
   * 查询打印任务详情(浏览器直连)
   */
  async getPrintJob(id: string) {
    const { data, error } = await supabase
      .from('print_jobs')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: data as PrintJob | null }
  },

  /**
   * 获取打印真实业务数据(P0-05)
   * GET /api/operations/print-data/:entityType/:entityId
   * 服务端聚合真实业务数据并返回标准 DTO,前端模板只负责渲染。
   * @param entityType 实体类型(invoice/medical_record/prescription/lab_report/vaccine_certificate)
   * @param entityId 业务实体 id
   */
  getPrintData(entityType: string, entityId: string) {
    return api.get<PrintData>(`operations/print-data/${entityType}/${entityId}`)
  },

  /**
   * 查询打印模板列表(浏览器直连)
   */
  async listPrintTemplates(params: { tenantId: string, onlyActive?: boolean }) {
    let query = supabase
      .from('print_templates')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
    if (params.onlyActive) {
      query = query.eq('is_active', true)
    }
    const { data, error, count } = await query.order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: data ?? [], total: count ?? 0 } }
  },

  /**
   * 查询打印任务列表(浏览器直连)
   */
  async listPrintJobs(params: {
    tenantId: string
    storeId?: string
    status?: string
    from?: number
    limit?: number
  }) {
    let query = supabase
      .from('print_jobs')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
    if (params.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params.status) {
      query = query.eq('status', params.status)
    }
    if (params.from !== undefined && params.limit !== undefined) {
      query = query.range(params.from, params.from + params.limit - 1)
    }
    const { data, error, count } = await query.order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as PrintJob[], total: count ?? 0 } }
  },

  // ===== MXQ-12008 报表 =====

  /**
   * 生成报表快照(MXQ-12008)
   * 走 Hono Command + generate_report_snapshot RPC
   */
  generateReport(data: GenerateReportSnapshotInput) {
    return api.post<ReportSnapshot>(`operations/reports/${data.reportCode}/generate`, {
      tenantId: data.tenantId,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
    })
  },

  /**
   * 查询报表定义列表(浏览器直连)
   */
  async listReports(params: { tenantId: string, category?: string, onlyActive?: boolean }) {
    let query = supabase
      .from('report_definitions')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
    if (params.category) {
      query = query.eq('category', params.category)
    }
    if (params.onlyActive) {
      query = query.eq('is_active', true)
    }
    const { data, error, count } = await query.order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as ReportDefinition[], total: count ?? 0 } }
  },

  /**
   * 查询报表快照列表(浏览器直连)
   */
  async listReportSnapshots(params: {
    tenantId: string
    reportId?: string
    from?: number
    limit?: number
  }) {
    let query = supabase
      .from('report_snapshots')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
    if (params.reportId) {
      query = query.eq('report_id', params.reportId)
    }
    if (params.from !== undefined && params.limit !== undefined) {
      query = query.range(params.from, params.from + params.limit - 1)
    }
    const { data, error, count } = await query.order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as ReportSnapshot[], total: count ?? 0 } }
  },

  /**
   * 获取报表实时数据(P0-06 统一报表真源)
   * GET /api/operations/report-data/:reportCode
   * 由 Hono 服务端聚合业务表返回标准 DTO,前端只负责渲染 rows。
   * @param reportCode 报表编码(与 report_definitions.code 一致)
   * @param params 查询参数
   * @param params.tenantId 租户 id(可选,缺省时按调用者成员关系解析)
   * @param params.periodStart 起始日期 YYYY-MM-DD(可选,默认本月首日)
   * @param params.periodEnd 结束日期 YYYY-MM-DD(可选,默认本月末日)
   */
  getReportData(reportCode: string, params: { tenantId?: string, periodStart?: string, periodEnd?: string }) {
    return api.get<ReportDataPayload>(`operations/report-data/${reportCode}`, { params })
  },

  // ===== MXQ-12009 安全事件 =====

  /**
   * 查询安全事件列表(MXQ-12009)
   * 走 Hono Command(仅超管可读)
   */
  async listSecurityEvents(params: {
    tenantId?: string
    eventType?: string
    severity?: string
    from?: number
    limit?: number
  }) {
    return api.get<{ list: SecurityEvent[], total: number }>('operations/security-events', {
      params,
    })
  },
}
