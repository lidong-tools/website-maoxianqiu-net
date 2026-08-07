import type {
  AnnualRegulatoryReportRecord,
  ChangeLicenseStatusInput,
  EpidemicEventRecord,
  GenerateReportInput,
  HandoverWasteInput,
  InstitutionLicenseRecord,
  InstitutionLicenseVersionRecord,
  MedicalWasteRecord,
  SaveEpidemicEventInput,
  SaveLicenseInput,
  SaveWasteRecordInput,
} from '@/types/regulatory'
import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * Regulatory 监管运营域 API 模块(S3.1-PARALLEL-01)
 *
 * 分层策略:
 *   - Query(list/detail):浏览器直连 Supabase,RLS 兜底(tenant + store 收敛);
 *   - Command(save/status/generate/submit/isolate/resolve/handover):
 *     走 Hono Command(api/routes/regulatory.ts),服务端做权限/归属/状态机校验,
 *     禁止前端直连写;
 *   - 操作人:一律由服务端根据登录用户反查在职员工档案推导,客户端不传 employee id;
 *   - storeId 由 StorePicker 提供,tenantId 由服务端按门店归属推导,用户不输入 UUID。
 */
export default {
  // ============================================================
  // 动物诊疗许可证
  // ============================================================

  /**
   * 许可证列表(浏览器直连,RLS 兜底,按租户 + 门店筛选)
   * @param tenantId 租户 id
   * @param storeId 门店 id(可为空=全部授权门店)
   * @param status 状态筛选(可选)
   */
  async listLicenses(tenantId: string, storeId?: string, status?: string) {
    let query = supabase
      .from('institution_licenses')
      .select('*, stores(name, code)')
      .eq('tenant_id', tenantId)
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    if (status) {
      query = query.eq('status', status)
    }
    const { data, error } = await query.order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as InstitutionLicenseRecord[] },
    }
  },

  /**
   * 许可证历史版本(浏览器直连,RLS 兜底)
   * @param licenseId 许可证 id
   */
  async listLicenseVersions(licenseId: string) {
    const { data, error } = await supabase
      .from('institution_license_versions')
      .select('*')
      .eq('license_id', licenseId)
      .order('version_no', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as InstitutionLicenseVersionRecord[] },
    }
  },

  /**
   * 许可证新增/编辑(走 Hono Command,权限 license.manage)
   */
  saveLicense(input: SaveLicenseInput) {
    return api.post('regulatory/licenses/save', input) as Promise<{ data: InstitutionLicenseRecord }>
  },

  /**
   * 许可证状态变更(走 Hono Command,权限 license.manage)
   */
  changeLicenseStatus(id: string, input: ChangeLicenseStatusInput) {
    return api.post(`regulatory/licenses/${id}/status`, input) as Promise<{ data: InstitutionLicenseRecord }>
  },

  // ============================================================
  // 年度动物诊疗活动报告
  // ============================================================

  /**
   * 年度报告列表(浏览器直连,RLS 兜底,按租户 + 门店筛选)
   * @param tenantId 租户 id
   * @param storeId 门店 id(可为空=全部授权门店)
   */
  async listAnnualReports(tenantId: string, storeId?: string) {
    let query = supabase
      .from('annual_regulatory_reports')
      .select('*, stores(name, code)')
      .eq('tenant_id', tenantId)
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    const { data, error } = await query.order('report_year', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as AnnualRegulatoryReportRecord[] },
    }
  },

  /**
   * 生成年度报告(走 Hono Command,权限 regulatory_report.generate)
   * 生成时保存 report_snapshot,查看/导出一律读快照,历史内容固定
   */
  generateReport(input: GenerateReportInput) {
    return api.post('regulatory/annual-reports/generate', input) as Promise<{ data: AnnualRegulatoryReportRecord }>
  },

  /**
   * 提交年度报告(走 Hono Command,权限 regulatory_report.submit)
   */
  submitReport(id: string) {
    return api.post(`regulatory/annual-reports/${id}/submit`, {}) as Promise<{ data: AnnualRegulatoryReportRecord }>
  },

  // ============================================================
  // 疫情事件台账
  // ============================================================

  /**
   * 疫情事件列表(浏览器直连,RLS 兜底,按租户 + 门店筛选)
   * @param tenantId 租户 id
   * @param storeId 门店 id(可为空=全部授权门店)
   * @param status 状态筛选(可选)
   */
  async listEpidemicEvents(tenantId: string, storeId?: string, status?: string) {
    let query = supabase
      .from('epidemic_events')
      .select('*, pets(name), customers(name)')
      .eq('tenant_id', tenantId)
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    if (status) {
      query = query.eq('status', status)
    }
    const { data, error } = await query.order('detected_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as EpidemicEventRecord[] },
    }
  },

  /**
   * 疫情事件上报/维护(走 Hono Command,权限 epidemic.report)
   */
  saveEpidemicEvent(input: SaveEpidemicEventInput) {
    return api.post('regulatory/epidemic-events/save', input) as Promise<{ data: EpidemicEventRecord }>
  },

  /**
   * 疫情事件隔离(走 Hono Command,权限 epidemic.report)
   */
  isolateEpidemicEvent(id: string) {
    return api.post(`regulatory/epidemic-events/${id}/isolate`, {}) as Promise<{ data: EpidemicEventRecord }>
  },

  /**
   * 疫情事件解除(走 Hono Command,权限 epidemic.resolve)
   */
  resolveEpidemicEvent(id: string) {
    return api.post(`regulatory/epidemic-events/${id}/resolve`, {}) as Promise<{ data: EpidemicEventRecord }>
  },

  // ============================================================
  // 医疗废弃物台账
  // ============================================================

  /**
   * 废弃物列表(浏览器直连,RLS 兜底,按租户 + 门店筛选)
   * @param tenantId 租户 id
   * @param storeId 门店 id(可为空=全部授权门店)
   * @param status 状态筛选(可选)
   */
  async listWasteRecords(tenantId: string, storeId?: string, status?: string) {
    let query = supabase
      .from('medical_waste_records')
      .select('*, employees(name)')
      .eq('tenant_id', tenantId)
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    if (status) {
      query = query.eq('status', status)
    }
    const { data, error } = await query.order('generated_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as MedicalWasteRecord[] },
    }
  },

  /**
   * 废弃物新增/维护(走 Hono Command,权限 waste.manage)
   */
  saveWasteRecord(input: SaveWasteRecordInput) {
    return api.post('regulatory/waste/save', input) as Promise<{ data: MedicalWasteRecord }>
  },

  /**
   * 废弃物交接(走 Hono Command,权限 waste.manage)
   */
  handoverWaste(id: string, input: HandoverWasteInput) {
    return api.post(`regulatory/waste/${id}/handover`, input) as Promise<{ data: MedicalWasteRecord }>
  },
}
