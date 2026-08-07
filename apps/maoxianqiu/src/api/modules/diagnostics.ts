import type {
  CreateDewormingInput,
  CreateLabOrderInput,
  CreateLabSampleInput,
  CreateLabSpecimenInput,
  CreateVaccinationInput,
  CreateVaccineProtocolInput,
  CreateVaccineProtocolItemInput,
  CriticalAlertListParams,
  CriticalValueAlert,
  DewormingRecord,
  DiagReminder,
  DiagReminderListParams,
  IssueCertificateInput,
  LabOrderAnalyte,
  LabOrderListParams,
  LabOrderRecord,
  LabResultReview,
  LabSampleListParams,
  LabSampleRecord,
  LabSpecimen,
  NotifyChannel,
  PublishLabResultsInput,
  ReviewLabResultsInput,
  ScanRemindersResult,
  TransitionLabSampleInput,
  UpdateDewormingInput,
  UpdateLabSpecimenInput,
  UpdateVaccinationInput,
  VaccinationListParams,
  VaccinationRecord,
  VaccineCertificate,
  VaccineProtocol,
  VaccineProtocolItem,
  VaccineProtocolWithItems,
} from '@/types/diagnostics'
import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * Diagnostics 疫苗与检验领域 API 模块(MXQ-10001~10011)
 *
 * 分层策略:
 *   - Query(list/detail):浏览器直连 Supabase,RLS 兜底
 *   - Command(create/update):浏览器直连 Supabase,RLS 兜底
 *   - 跨表事务(证书签发 / 结果发布 / 结果审核 / 提醒扫描):走 Hono Command
 *     (api/routes/diagnostics.ts),由 Hono 以 service role 调用 RPC,
 *     浏览器(anon/authenticated)无权限直连 RPC(S30-R03)
 *
 * 状态机:
 *   疫苗接种:scheduled→administered; scheduled→overdue; scheduled→skipped
 *   检验申请:requested→collected→completed; requested→cancelled
 *   标本:collected→in_transit→received→discarded
 *   危急值告警:pending→acknowledged→resolved
 *   疫苗证明:issued→revoked
 */
export default {
  // ============================================================
  // 疫苗方案 MXQ-10001
  // ============================================================

  /**
   * 疫苗方案列表(浏览器直连,RLS 兜底,租户成员可读)
   * @param onlyActive 仅返回启用的方案
   */
  async listVaccineProtocols(onlyActive = false) {
    let query = supabase.from('vaccine_protocols').select('*')
    if (onlyActive) {
      query = query.eq('is_active', true)
    }
    const { data, error } = await query.order('name', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as VaccineProtocol[] } }
  },

  /**
   * 疫苗方案详情(含明细)(浏览器直连,RLS 兜底)
   */
  async getVaccineProtocol(id: string) {
    const { data: protocol, error } = await supabase
      .from('vaccine_protocols')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw new Error(error.message)
    }
    if (!protocol) {
      throw new Error('疫苗方案不存在')
    }
    const { data: items, error: itemsError } = await supabase
      .from('vaccine_protocol_items')
      .select('*')
      .eq('protocol_id', id)
      .order('dose_no', { ascending: true })
    if (itemsError) {
      throw new Error(itemsError.message)
    }
    const result = { ...(protocol as VaccineProtocol), items: (items ?? []) as VaccineProtocolItem[] }
    return { status: 1, error: '', data: result as VaccineProtocolWithItems }
  },

  /**
   * 创建疫苗方案(浏览器直连,RLS 须 vaccine.manage 权限)
   */
  async createVaccineProtocol(input: CreateVaccineProtocolInput) {
    const { data, error } = await supabase
      .from('vaccine_protocols')
      .insert({
        tenant_id: input.tenantId,
        code: input.code,
        name: input.name,
        species: input.species ?? 'other',
        description: input.description ?? null,
        is_active: input.isActive ?? true,
      })
      .select('*')
      .single()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: data as VaccineProtocol }
  },

  /**
   * 创建疫苗方案明细(浏览器直连,RLS 须 vaccine.manage 权限)
   */
  async createVaccineProtocolItem(input: CreateVaccineProtocolItemInput) {
    const { data, error } = await supabase
      .from('vaccine_protocol_items')
      .insert({
        protocol_id: input.protocolId,
        vaccine_catalog_item_id: input.vaccineCatalogItemId ?? null,
        dose_no: input.doseNo,
        min_age_weeks: input.minAgeWeeks ?? null,
        max_age_weeks: input.maxAgeWeeks ?? null,
        interval_days: input.intervalDays ?? null,
        is_required: input.isRequired ?? true,
        remark: input.remark ?? null,
      })
      .select('*')
      .single()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: data as VaccineProtocolItem }
  },

  // ============================================================
  // 疫苗接种 MXQ-10002
  // ============================================================

  /**
   * 疫苗接种列表(浏览器直连,RLS 兜底)
   * 支持 storeId/petId/customerId/status/encounterId 筛选 + 分页
   */
  async listVaccinations(params?: VaccinationListParams) {
    let query = supabase
      .from('vaccinations')
      .select('*', { count: 'exact' })

    if (params?.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params?.petId) {
      query = query.eq('pet_id', params.petId)
    }
    if (params?.customerId) {
      query = query.eq('customer_id', params.customerId)
    }
    if (params?.status) {
      query = query.eq('status', params.status)
    }
    if (params?.encounterId) {
      query = query.eq('encounter_id', params.encounterId)
    }

    const page = params?.page ?? 1
    const pageSize = params?.pageSize ?? 20
    const from = (page - 1) * pageSize
    query = query.range(from, from + pageSize - 1)

    const { data, error, count } = await query.order('created_at', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        list: (data ?? []) as VaccinationRecord[],
        total: count ?? 0,
        page,
        pageSize,
      },
    }
  },

  /**
   * 创建疫苗接种(浏览器直连,RLS 须 vaccine.manage 权限)
   */
  async createVaccination(input: CreateVaccinationInput) {
    const { data, error } = await supabase
      .from('vaccinations')
      .insert({
        tenant_id: input.tenantId,
        store_id: input.storeId ?? null,
        customer_id: input.customerId,
        pet_id: input.petId,
        encounter_id: input.encounterId ?? null,
        vaccine_catalog_item_id: input.vaccineCatalogItemId ?? null,
        protocol_item_id: input.protocolItemId ?? null,
        dose_no: input.doseNo ?? 1,
        scheduled_date: input.scheduledDate ?? null,
        batch_no: input.batchNo ?? null,
        manufacturer: input.manufacturer ?? null,
        status: 'scheduled',
        remark: input.remark ?? null,
      })
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as VaccinationRecord }
  },

  /**
   * 更新疫苗接种(浏览器直连,RLS 须 vaccine.manage 权限)
   * 状态转换校验由前端状态机 + 后端 CHECK 约束双重兜底
   */
  async updateVaccination(id: string, input: UpdateVaccinationInput) {
    const patch: Record<string, unknown> = {}
    if (input.scheduledDate !== undefined) {
      patch.scheduled_date = input.scheduledDate
    }
    if (input.administeredDate !== undefined) {
      patch.administered_date = input.administeredDate
    }
    if (input.batchNo !== undefined) {
      patch.batch_no = input.batchNo
    }
    if (input.manufacturer !== undefined) {
      patch.manufacturer = input.manufacturer
    }
    if (input.status !== undefined) {
      patch.status = input.status
    }
    if (input.nextDueDate !== undefined) {
      patch.next_due_date = input.nextDueDate
    }
    if (input.remark !== undefined) {
      patch.remark = input.remark
    }

    // 接种完成时,自动填充 administered_date
    if (input.status === 'administered' && !input.administeredDate) {
      patch.administered_date = new Date().toISOString()
    }

    const { data, error } = await supabase
      .from('vaccinations')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as VaccinationRecord }
  },

  // ============================================================
  // 驱虫记录 MXQ-10003
  // ============================================================

  /**
   * 驱虫记录列表(浏览器直连,RLS 兜底)
   */
  async listDeworming(params?: { storeId?: string, petId?: string, customerId?: string, status?: string }) {
    let query = supabase.from('deworming_records').select('*')

    if (params?.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params?.petId) {
      query = query.eq('pet_id', params.petId)
    }
    if (params?.customerId) {
      query = query.eq('customer_id', params.customerId)
    }
    if (params?.status) {
      query = query.eq('status', params.status)
    }

    const { data, error } = await query.order('administered_date', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: { list: (data ?? []) as DewormingRecord[] } }
  },

  /**
   * 创建驱虫记录(浏览器直连,RLS 须 deworming.manage 权限)
   */
  async createDeworming(input: CreateDewormingInput) {
    const { data, error } = await supabase
      .from('deworming_records')
      .insert({
        tenant_id: input.tenantId,
        store_id: input.storeId ?? null,
        customer_id: input.customerId,
        pet_id: input.petId,
        encounter_id: input.encounterId ?? null,
        drug_catalog_item_id: input.drugCatalogItemId ?? null,
        drug_name: input.drugName,
        dose: input.dose ?? null,
        administered_date: input.administeredDate ?? new Date().toISOString(),
        next_due_date: input.nextDueDate ?? null,
        parasite_type: input.parasiteType ?? 'internal',
        status: input.status ?? 'done',
        remark: input.remark ?? null,
      })
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as DewormingRecord }
  },

  /**
   * 更新驱虫记录(浏览器直连,RLS 须 deworming.manage 权限)
   */
  async updateDeworming(id: string, input: UpdateDewormingInput) {
    const patch: Record<string, unknown> = {}
    if (input.drugName !== undefined) {
      patch.drug_name = input.drugName
    }
    if (input.dose !== undefined) {
      patch.dose = input.dose
    }
    if (input.administeredDate !== undefined) {
      patch.administered_date = input.administeredDate
    }
    if (input.nextDueDate !== undefined) {
      patch.next_due_date = input.nextDueDate
    }
    if (input.parasiteType !== undefined) {
      patch.parasite_type = input.parasiteType
    }
    if (input.status !== undefined) {
      patch.status = input.status
    }
    if (input.remark !== undefined) {
      patch.remark = input.remark
    }

    const { data, error } = await supabase
      .from('deworming_records')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as DewormingRecord }
  },

  // ============================================================
  // 提醒 MXQ-10004(扫描走 RPC)
  // ============================================================

  /**
   * 提醒列表(浏览器直连,RLS 兜底)
   */
  async listReminders(params?: DiagReminderListParams) {
    let query = supabase
      .from('diag_reminders')
      .select('*', { count: 'exact' })

    if (params?.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params?.petId) {
      query = query.eq('pet_id', params.petId)
    }
    if (params?.reminderType) {
      query = query.eq('reminder_type', params.reminderType)
    }
    if (params?.status) {
      query = query.eq('status', params.status)
    }

    const page = params?.page ?? 1
    const pageSize = params?.pageSize ?? 20
    const from = (page - 1) * pageSize
    query = query.range(from, from + pageSize - 1)

    const { data, error, count } = await query.order('due_date', { ascending: true })

    if (error) {
      throw new Error(error.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        list: (data ?? []) as DiagReminder[],
        total: count ?? 0,
        page,
        pageSize,
      },
    }
  },

  /**
   * 扫描到期提醒(MXQ-10004,跨表事务 RPC)
   * 走 Hono Command(api/routes/diagnostics.ts#/reminders/scan):
   * Hono 以 service role 调 scan_diag_reminders RPC,扫描到期疫苗/驱虫记录,生成提醒(幂等)
   * @param tenantId 租户 id
   * @param storeId 门店 id(可选,为空则扫描全租户)
   * @param lookaheadDays 提前多少天扫描(默认 7)
   */
  async scanReminders(tenantId: string, storeId?: string, lookaheadDays = 7) {
    const res = await api.post('diagnostics/reminders/scan', {
      tenantId,
      storeId: storeId ?? undefined,
      lookaheadDays,
    })

    return { status: 1, error: '', data: (res as any).data as ScanRemindersResult }
  },

  /**
   * 取消提醒(浏览器直连,RLS 须 diag_reminder.view 权限)
   */
  async cancelReminder(id: string) {
    const { data, error } = await supabase
      .from('diag_reminders')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'pending')
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as DiagReminder }
  },

  // ============================================================
  // 疫苗证明 MXQ-10005(签发走 RPC)
  // ============================================================

  /**
   * 疫苗证明列表(浏览器直连,RLS 兜底)
   */
  async listCertificates(params?: { storeId?: string, petId?: string, customerId?: string, status?: string }) {
    let query = supabase.from('vaccine_certificates').select('*')

    if (params?.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params?.petId) {
      query = query.eq('pet_id', params.petId)
    }
    if (params?.customerId) {
      query = query.eq('customer_id', params.customerId)
    }
    if (params?.status) {
      query = query.eq('status', params.status)
    }

    const { data, error } = await query.order('issued_date', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: { list: (data ?? []) as VaccineCertificate[] } }
  },

  /**
   * 签发疫苗证明(MXQ-10005,跨表事务 RPC)
   * 走 Hono Command(api/routes/diagnostics.ts#/certificates/issue):
   * Hono 以 service role 调 issue_vaccine_certificate RPC:校验已接种 + 生成唯一证书编号 + 落库 + 审计
   */
  async issueCertificate(input: IssueCertificateInput) {
    const res = await api.post('diagnostics/certificates/issue', {
      vaccinationId: input.vaccinationId,
      pdfFileId: input.pdfFileId ?? undefined,
    })

    return { status: 1, error: '', data: (res as any).data as VaccineCertificate }
  },

  /**
   * 撤销疫苗证明(浏览器直连,RLS 须 vaccine.certificate.issue 权限)
   */
  async revokeCertificate(id: string) {
    const { data, error } = await supabase
      .from('vaccine_certificates')
      .update({ status: 'revoked' })
      .eq('id', id)
      .eq('status', 'issued')
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as VaccineCertificate }
  },

  // ============================================================
  // 检验申请 MXQ-10006
  // ============================================================

  /**
   * 检验申请列表(浏览器直连,RLS 兜底)
   */
  async listLabOrders(params?: LabOrderListParams) {
    let query = supabase
      .from('lab_orders')
      .select('*', { count: 'exact' })

    if (params?.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params?.petId) {
      query = query.eq('pet_id', params.petId)
    }
    if (params?.customerId) {
      query = query.eq('customer_id', params.customerId)
    }
    if (params?.encounterId) {
      query = query.eq('encounter_id', params.encounterId)
    }
    if (params?.status) {
      query = query.eq('status', params.status)
    }

    const page = params?.page ?? 1
    const pageSize = params?.pageSize ?? 20
    const from = (page - 1) * pageSize
    query = query.range(from, from + pageSize - 1)

    const { data, error, count } = await query.order('requested_at', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        list: (data ?? []) as LabOrderRecord[],
        total: count ?? 0,
        page,
        pageSize,
      },
    }
  },

  /**
   * 创建检验申请(浏览器直连,RLS 须 lab.request 权限)
   * 自动生成申请单号:LAB-yyyymmdd-随机后缀
   */
  async createLabOrder(input: CreateLabOrderInput) {
    const orderNo = `LAB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    const { data, error } = await supabase
      .from('lab_orders')
      .insert({
        tenant_id: input.tenantId,
        store_id: input.storeId ?? null,
        customer_id: input.customerId,
        pet_id: input.petId,
        encounter_id: input.encounterId ?? null,
        panel_id: input.panelId ?? null,
        order_no: orderNo,
        status: 'requested',
        remark: input.remark ?? null,
      })
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as LabOrderRecord }
  },

  /**
   * 取消检验申请(浏览器直连,RLS 须 lab.request 权限)
   * 仅 requested 状态可取消
   */
  async cancelLabOrder(id: string) {
    const { data, error } = await supabase
      .from('lab_orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'requested')
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as LabOrderRecord }
  },

  /**
   * 标记已采集(requested→collected)(浏览器直连,RLS 须 lab.collect 权限)
   */
  async markLabOrderCollected(id: string) {
    const { data, error } = await supabase
      .from('lab_orders')
      .update({
        status: 'collected',
        collected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'requested')
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as LabOrderRecord }
  },

  // ============================================================
  // 检验结果项 MXQ-10006/10008
  // ============================================================

  /**
   * 检验结果项列表(浏览器直联,RLS 跟随 lab_orders)
   */
  async listLabOrderAnalytes(labOrderId: string) {
    const { data, error } = await supabase
      .from('lab_order_analytes')
      .select('*')
      .eq('lab_order_id', labOrderId)
      .order('created_at', { ascending: true })

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: { list: (data ?? []) as LabOrderAnalyte[] } }
  },

  /**
   * 批量创建检验结果项(浏览器直连,RLS 须 lab.result.input 权限)
   * 用于申请后预生成 analyte 占位行(可选)
   */
  async batchCreateAnalytes(labOrderId: string, analyteIds: string[]) {
    const rows = analyteIds.map(aid => ({
      lab_order_id: labOrderId,
      analyte_id: aid,
      is_abnormal: false,
      is_critical: false,
    }))
    const { data, error } = await supabase
      .from('lab_order_analytes')
      .insert(rows)
      .select('*')
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as LabOrderAnalyte[] } }
  },

  /**
   * 发布检验结果(MXQ-10008,跨表事务 RPC)
   * 走 Hono Command(api/routes/diagnostics.ts#/lab-orders/publish):
   * Hono 以 service role 调 publish_lab_results RPC:批量更新结果 + 自动危急值告警 + 状态推进 + 审计
   * @param input 发布入参(含 labOrderId 与结果项数组)
   */
  async publishLabResults(input: PublishLabResultsInput) {
    // Hono 端 publishResultsSchema 直接接收 snake_case 结果项(LabResultInput 字段即 snake_case)
    const res = await api.post('diagnostics/lab-orders/publish', {
      labOrderId: input.labOrderId,
      results: input.results,
    })

    return { status: 1, error: '', data: (res as any).data as LabOrderRecord }
  },

  // ============================================================
  // 标本 MXQ-10007
  // ============================================================

  /**
   * 标本列表(浏览器直连,RLS 跟随 lab_orders)
   */
  async listSpecimens(labOrderId: string) {
    const { data, error } = await supabase
      .from('lab_specimens')
      .select('*')
      .eq('lab_order_id', labOrderId)
      .order('collected_at', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: { list: (data ?? []) as LabSpecimen[] } }
  },

  /**
   * 创建标本(浏览器直连,RLS 须 lab.collect 权限)
   */
  async createSpecimen(input: CreateLabSpecimenInput) {
    const { data, error } = await supabase
      .from('lab_specimens')
      .insert({
        tenant_id: input.tenantId,
        lab_order_id: input.labOrderId,
        specimen_type: input.specimenType ?? 'blood',
        collection_method: input.collectionMethod ?? null,
        collected_at: new Date().toISOString(),
        container_id: input.containerId ?? null,
        storage_condition: input.storageCondition ?? null,
        status: 'collected',
        remark: input.remark ?? null,
      })
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as LabSpecimen }
  },

  /**
   * 更新标本(浏览器直连,RLS 须 lab.collect 权限)
   * 支持状态流转:collected→in_transit→received→discarded
   */
  async updateSpecimen(id: string, input: UpdateLabSpecimenInput) {
    const patch: Record<string, unknown> = {}
    if (input.specimenType !== undefined) {
      patch.specimen_type = input.specimenType
    }
    if (input.collectionMethod !== undefined) {
      patch.collection_method = input.collectionMethod
    }
    if (input.containerId !== undefined) {
      patch.container_id = input.containerId
    }
    if (input.storageCondition !== undefined) {
      patch.storage_condition = input.storageCondition
    }
    if (input.status !== undefined) {
      patch.status = input.status
      if (input.status === 'received') {
        patch.received_at = new Date().toISOString()
      }
    }
    if (input.remark !== undefined) {
      patch.remark = input.remark
    }

    const { data, error } = await supabase
      .from('lab_specimens')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as LabSpecimen }
  },

  // ============================================================
  // 结果审核 MXQ-10008(双签走 RPC)
  // ============================================================

  /**
   * 审核记录列表(浏览器直连,RLS 跟随 lab_orders)
   */
  async listReviews(labOrderId: string) {
    const { data, error } = await supabase
      .from('lab_result_reviews')
      .select('*')
      .eq('lab_order_id', labOrderId)
      .order('reviewed_at', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: { list: (data ?? []) as LabResultReview[] } }
  },

  /**
   * 审核检验结果(MXQ-10008,跨表事务 RPC,双签)
   * 走 Hono Command(api/routes/diagnostics.ts#/lab-orders/review):
   * Hono 以 service role 调 review_lab_results RPC:校验已录入 + 双签(审核人≠录入人)+ 写审核记录 + 状态推进 + 审计
   */
  async reviewLabResults(input: ReviewLabResultsInput) {
    const res = await api.post('diagnostics/lab-orders/review', {
      labOrderId: input.labOrderId,
      decision: input.decision,
      comment: input.comment ?? undefined,
    })

    return { status: 1, error: '', data: (res as any).data as LabResultReview }
  },

  // ============================================================
  // 标本流转闭环 lab_samples S3.1-C(migration 45,走 Hono Command + RPC)
  // ============================================================

  /**
   * 标本列表(走 Hono Command,权限:lab_sample.read)
   * 支持 storeId/labOrderId/status 筛选 + 分页
   */
  async listLabSamples(params?: LabSampleListParams) {
    const query: Record<string, unknown> = {}
    if (params?.storeId) query.storeId = params.storeId
    if (params?.labOrderId) query.labOrderId = params.labOrderId
    if (params?.status) query.status = params.status
    query.page = params?.page ?? 1
    query.pageSize = params?.pageSize ?? 20
    const res = await api.get('diagnostics/lab-samples', { params: query })
    const data = (res as any).data
    return { status: 1, error: '', data }
  },

  /**
   * 创建标本(S3.1-C,走 Hono Command + create_lab_sample RPC)
   * 校验检验申请状态(requested/collected)+ 生成标本编号 + 审计
   */
  async createLabSample(input: CreateLabSampleInput) {
    const res = await api.post('diagnostics/lab-samples', {
      labOrderId: input.labOrderId,
      sampleType: input.sampleType ?? 'blood',
      container: input.container ?? undefined,
      storageCondition: input.storageCondition ?? undefined,
      remark: input.remark ?? undefined,
    })
    return { status: 1, error: '', data: (res as any).data as LabSampleRecord }
  },

  /**
   * 标本状态流转(S3.1-C,走 Hono Command + transition_lab_sample RPC)
   * 状态机:planned→collected→received→testing→completed;任意非终态→rejected(须 reason)
   */
  async transitionLabSample(id: string, input: TransitionLabSampleInput) {
    const res = await api.post(`diagnostics/lab-samples/${id}/transition`, {
      toStatus: input.toStatus,
      reason: input.reason ?? undefined,
    })
    return { status: 1, error: '', data: (res as any).data as LabSampleRecord }
  },

  // ============================================================
  // 危急值告警 MXQ-10009
  // ============================================================

  /**
   * 危急值告警列表(S3.1-C,走 Hono Command,权限:lab_critical.read)
   * 支持 storeId/petId/labOrderId/status 筛选 + 分页
   */
  async listCriticalAlerts(params?: CriticalAlertListParams) {
    const query: Record<string, unknown> = {}
    if (params?.storeId) query.storeId = params.storeId
    if (params?.petId) query.petId = params.petId
    if (params?.labOrderId) query.labOrderId = params.labOrderId
    if (params?.status) query.status = params.status
    query.page = params?.page ?? 1
    query.pageSize = params?.pageSize ?? 20
    const res = await api.get('diagnostics/critical-values', { params: query })
    const data = (res as any).data
    return { status: 1, error: '', data }
  },

  /**
   * 通知危急值(S3.1-C,走 Hono Command + notify_critical_value RPC)
   * 仅 pending/acknowledged 可通知,不改变状态;确认前必须已通知(闭环强制)
   */
  async notifyCriticalAlert(id: string, channel: NotifyChannel = 'phone') {
    const res = await api.post(`diagnostics/critical-values/${id}/notify`, { channel })
    return { status: 1, error: '', data: (res as any).data as CriticalValueAlert }
  },

  /**
   * 确认危急值(S3.1-C,走 Hono Command + ack_critical_value RPC)
   * pending→acknowledged(须已通知,否则后端 CRITICAL_NOT_NOTIFIED 拦截)
   */
  async acknowledgeCriticalAlert(id: string, note?: string) {
    const res = await api.post(`diagnostics/critical-values/${id}/ack`, {
      toStatus: 'acknowledged',
      note: note ?? undefined,
    })
    return { status: 1, error: '', data: (res as any).data as CriticalValueAlert }
  },

  /**
   * 解决危急值(S3.1-C,走 Hono Command + ack_critical_value RPC)
   * acknowledged→resolved(禁止跳级)
   */
  async resolveCriticalAlert(id: string, note?: string) {
    const res = await api.post(`diagnostics/critical-values/${id}/ack`, {
      toStatus: 'resolved',
      note: note ?? undefined,
    })
    return { status: 1, error: '', data: (res as any).data as CriticalValueAlert }
  },
}
