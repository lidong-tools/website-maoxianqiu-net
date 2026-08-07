import type {
  AppointmentListParams,
  AppointmentRecord,
  AppointmentStatus,
  CancelMedicalOrderResult,
  CreateAppointmentInput,
  CreateEncounterInput,
  CreateMedicalOrderInput,
  CreateNurseTaskInput,
  EncounterListParams,
  EncounterRecord,
  EncounterRevisionRecord,
  EncounterStatus,
  MedicalLabRef,
  MedicalOrderDetailResult,
  MedicalOrderListParams,
  MedicalOrderRecord,
  NurseTaskListParams,
  NurseTaskRecord,
  NurseTaskStatus,
  PrescriptionDetailResult,
  PrescriptionRecord,
  SavePrescriptionInput,
  ScanNurseTaskOverdueResult,
  UpdateAppointmentInput,
  UpdateEncounterInput,
  UpdateNurseTaskInput,
} from '@/types/clinical'
import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * Clinical 诊疗核心 API 模块(MXQ-7001~7011)
 *
 * 分层策略:
 *   - Query(list/detail):浏览器直连 Supabase,RLS 兜底
 *   - Command(create/update/transition/sign/revise/save_prescription/dispense/cancel):
 *     走 Hono Command(api/routes/clinical.ts),服务端做权限/租户归属/状态机校验,
 *     禁止前端直连写
 *
 * 状态机:
 *   预约:pending→confirmed→checked_in→in_progress→completed;任意非终态→cancelled/no_show
 *   就诊:in_progress→completed→signed(终态,需修订)
 *   处方:draft→dispensed;draft→cancelled
 */
export default {
  // ============================================================
  // 预约 MXQ-7001 / MXQ-7002
  // ============================================================

  /**
   * 预约列表(浏览器直连,RLS 兜底)
   * 支持 storeId/doctorId/petId/customerId/status/日期范围筛选
   */
  async listAppointments(params?: AppointmentListParams) {
    let query = supabase
      .from('appointments')
      .select('*', { count: 'exact' })

    if (params?.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params?.doctorId) {
      query = query.eq('doctor_id', params.doctorId)
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
    if (params?.dateFrom) {
      query = query.gte('scheduled_start', params.dateFrom)
    }
    if (params?.dateTo) {
      query = query.lte('scheduled_start', params.dateTo)
    }

    const page = params?.page ?? 1
    const pageSize = params?.pageSize ?? 20
    const from = (page - 1) * pageSize
    query = query.range(from, from + pageSize - 1)

    const { data, error, count } = await query.order('scheduled_start', { ascending: true })

    if (error) {
      throw new Error(error.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        list: (data ?? []) as AppointmentRecord[],
        total: count ?? 0,
        page,
        pageSize,
      },
    }
  },

  /**
   * 候诊队列(MXQ-7002,浏览器直连,RLS 兜底)
   * 返回 status=checked_in 的预约,按 scheduled_start 排序
   */
  async listWaiting(storeId?: string) {
    let query = supabase
      .from('appointments')
      .select('*')
      .eq('status', 'checked_in')
      .order('scheduled_start', { ascending: true })

    if (storeId) {
      query = query.eq('store_id', storeId)
    }

    const { data, error } = await query

    if (error) {
      throw new Error(error.message)
    }

    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as AppointmentRecord[] },
    }
  },

  /**
   * 预约详情(浏览器直连,RLS 兜底)
   */
  async getAppointment(id: string) {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      throw new Error(error.message)
    }
    if (!data) {
      throw new Error('预约不存在')
    }

    return { status: 1, error: '', data: data as AppointmentRecord }
  },

  /**
   * 创建预约(走 Hono Command,服务端校验租户归属 + 医生时段冲突)
   */
  createAppointment(input: CreateAppointmentInput) {
    return api.post('clinical/appointments', input) as Promise<{ data: AppointmentRecord }>
  },

  /**
   * 更新预约(走 Hono Command)
   * 仅非终态可编辑
   */
  updateAppointment(id: string, input: UpdateAppointmentInput) {
    return api.patch(`clinical/appointments/${id}`, input) as Promise<{ data: AppointmentRecord }>
  },

  /**
   * 预约状态转换(走 Hono Command,服务端调 transition_appointment RPC 校验状态机)
   */
  transitionAppointment(id: string, targetStatus: AppointmentStatus) {
    return api.post(`clinical/appointments/${id}/transition`, { targetStatus }) as Promise<{ data: AppointmentRecord }>
  },

  // ============================================================
  // 就诊/病历 MXQ-7003 / MXQ-7005
  // ============================================================

  /**
   * 就诊列表(浏览器直连,RLS 兜底)
   */
  async listEncounters(params?: EncounterListParams) {
    let query = supabase
      .from('encounters')
      .select('*', { count: 'exact' })

    if (params?.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params?.doctorId) {
      query = query.eq('doctor_id', params.doctorId)
    }
    if (params?.petId) {
      query = query.eq('pet_id', params.petId)
    }
    if (params?.status) {
      query = query.eq('status', params.status)
    }

    const page = params?.page ?? 1
    const pageSize = params?.pageSize ?? 20
    const from = (page - 1) * pageSize
    query = query.range(from, from + pageSize - 1)

    const { data, error, count } = await query.order('started_at', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        list: (data ?? []) as EncounterRecord[],
        total: count ?? 0,
        page,
        pageSize,
      },
    }
  },

  /**
   * 就诊详情(含修订历史)(浏览器直连,RLS 兜底)
   */
  async getEncounter(id: string) {
    const { data: encounter, error } = await supabase
      .from('encounters')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      throw new Error(error.message)
    }
    if (!encounter) {
      throw new Error('病历不存在')
    }

    const { data: revisions, error: revError } = await supabase
      .from('encounter_revisions')
      .select('*')
      .eq('encounter_id', id)
      .order('revision_no', { ascending: true })

    if (revError) {
      throw new Error(revError.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        encounter: encounter as EncounterRecord,
        revisions: (revisions ?? []) as EncounterRevisionRecord[],
      },
    }
  },

  /**
   * 创建就诊(走 Hono Command,服务端校验租户归属)
   * 创建时 status=in_progress
   */
  createEncounter(input: CreateEncounterInput) {
    return api.post('clinical/encounters', input) as Promise<{ data: EncounterRecord }>
  },

  /**
   * 更新病历(走 Hono Command,服务端校验状态机)
   * 已签署(signed)病历不可直接修改,需走修订功能
   */
  updateEncounter(id: string, input: UpdateEncounterInput) {
    return api.patch(`clinical/encounters/${id}`, input) as Promise<{ data: EncounterRecord }>
  },

  /**
   * 签署病历(走 Hono Command,服务端调 sign_encounter RPC 校验主治医生 + 状态)
   * S30-R04:签署人强制为当前登录用户(Hono 侧 doctorId ?? user.id 且拒绝代签),
   * 前端不再传 doctorId,禁止 EmployeePicker 手选非本人签署。
   */
  signEncounter(encounterId: string) {
    return api.post(`clinical/encounters/${encounterId}/sign`, {}) as Promise<{ data: EncounterRecord }>
  },

  /**
   * 修订病历(走 Hono Command,服务端调 revise_encounter RPC 创建修订版本)
   */
  reviseEncounter(encounterId: string, content: Record<string, unknown>, reason: string) {
    return api.post(`clinical/encounters/${encounterId}/revise`, { content, reason }) as Promise<{ data: EncounterRevisionRecord }>
  },

  // ============================================================
  // 处方 MXQ-7006
  // ============================================================

  /**
   * 处方列表(浏览器直连,RLS 兜底)
   */
  async listPrescriptions(params?: { encounterId?: string, storeId?: string, petId?: string, status?: string }) {
    let query = supabase
      .from('prescriptions')
      .select('*')

    if (params?.encounterId) {
      query = query.eq('encounter_id', params.encounterId)
    }
    if (params?.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params?.petId) {
      query = query.eq('pet_id', params.petId)
    }
    if (params?.status) {
      query = query.eq('status', params.status)
    }

    const { data, error } = await query.order('created_at', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: { list: (data ?? []) as PrescriptionRecord[] } }
  },

  /**
   * 处方详情(含明细)(浏览器直连,RLS 兜底)
   */
  async getPrescription(id: string) {
    const { data: prescription, error } = await supabase
      .from('prescriptions')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      throw new Error(error.message)
    }
    if (!prescription) {
      throw new Error('处方不存在')
    }

    const { data: items, error: itemsError } = await supabase
      .from('prescription_items')
      .select('*')
      .eq('prescription_id', id)
      .order('sort_order', { ascending: true })

    if (itemsError) {
      throw new Error(itemsError.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        prescription: prescription as PrescriptionRecord,
        items: (items ?? []) as PrescriptionDetailResult['items'],
      },
    }
  },

  /**
   * 保存处方(走 Hono Command,服务端调 save_prescription RPC 事务化写入)
   */
  savePrescription(input: SavePrescriptionInput) {
    return api.post('clinical/prescriptions/save', input) as Promise<{ data: PrescriptionRecord }>
  },

  /**
   * 发药(走 Hono Command,服务端调 dispense_prescription RPC 单事务:
   * 处方校验 + 库存扣减 + 状态 issued→dispensed + 审计,R04 禁止 draft 直发)
   */
  dispensePrescription(id: string) {
    return api.post(`clinical/prescriptions/${id}/dispense`, {}) as Promise<{ data: PrescriptionRecord }>
  },

  /**
   * 取消处方(走 Hono Command,服务端校验状态后 draft→cancelled)
   */
  cancelPrescription(id: string) {
    return api.post(`clinical/prescriptions/${id}/cancel`, {}) as Promise<{ data: PrescriptionRecord }>
  },

  // ============================================================
  // 护士任务 MXQ-7007
  // ============================================================

  /**
   * 护士任务列表(浏览器直连,RLS 兜底)
   */
  async listNurseTasks(params?: NurseTaskListParams) {
    let query = supabase
      .from('nurse_tasks')
      .select('*', { count: 'exact' })

    if (params?.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params?.assigneeId) {
      query = query.eq('assigned_to', params.assigneeId)
    }
    if (params?.petId) {
      query = query.eq('pet_id', params.petId)
    }
    if (params?.encounterId) {
      query = query.eq('encounter_id', params.encounterId)
    }
    if (params?.status) {
      query = query.eq('status', params.status)
    }
    if (params?.taskType) {
      query = query.eq('task_type', params.taskType)
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
        list: (data ?? []) as NurseTaskRecord[],
        total: count ?? 0,
        page,
        pageSize,
      },
    }
  },

  /**
   * 创建护士任务(走 Hono Command,服务端校验租户归属)
   */
  createNurseTask(input: CreateNurseTaskInput) {
    return api.post('clinical/nurse-tasks', input) as Promise<{ data: NurseTaskRecord }>
  },

  /**
   * 更新护士任务(走 Hono Command,服务端填充 completed_at/completed_by)
   */
  updateNurseTask(id: string, input: UpdateNurseTaskInput) {
    return api.patch(`clinical/nurse-tasks/${id}`, input) as Promise<{ data: NurseTaskRecord }>
  },

  /**
   * 删除护士任务(走 Hono Command)
   */
  deleteNurseTask(id: string) {
    return api.delete(`clinical/nurse-tasks/${id}`) as Promise<{ data: { isSuccess: boolean } }>
  },

  // ============================================================
  // 医嘱 S3.1-C(medical_orders,走 Hono Command + RPC)
  // ============================================================

  /**
   * 医嘱列表(走 Hono Command,权限:nurse_task.view)
   * 支持 storeId/petId/encounterId/admissionId/status/orderType 筛选 + 分页
   */
  async listMedicalOrders(params?: MedicalOrderListParams) {
    const query: Record<string, unknown> = {}
    if (params?.storeId) query.storeId = params.storeId
    if (params?.petId) query.petId = params.petId
    if (params?.encounterId) query.encounterId = params.encounterId
    if (params?.admissionId) query.admissionId = params.admissionId
    if (params?.status) query.status = params.status
    if (params?.orderType) query.orderType = params.orderType
    query.page = params?.page ?? 1
    query.pageSize = params?.pageSize ?? 20
    const res = await api.get('clinical/medical-orders', { params: query })
    const data = (res as any).data
    return { status: 1, error: '', data }
  },

  /**
   * 医嘱详情(含关联护士任务与检验申请,走 Hono Command)
   */
  async getMedicalOrder(id: string) {
    const res = await api.get(`clinical/medical-orders/${id}`)
    return { status: 1, error: '', data: (res as any).data as MedicalOrderDetailResult }
  },

  /**
   * 开立医嘱(S3.1-C,自动生成护士任务)
   * 走 Hono Command + create_medical_order RPC:单事务创建医嘱+任务+幂等+审计
   * @param input 医嘱入参(含幂等键,同一 key 重复请求返回原结果)
   */
  async createMedicalOrder(input: CreateMedicalOrderInput) {
    const res = await api.post('clinical/medical-orders', {
      ...input,
      idempotencyKey: input.idempotencyKey ?? undefined,
    })
    return { status: 1, error: '', data: (res as any).data }
  },

  /**
   * 取消医嘱(S3.1-C,未执行任务→cancelled,已执行任务永久保留)
   */
  async cancelMedicalOrder(id: string, reason?: string) {
    const res = await api.post(`clinical/medical-orders/${id}/cancel`, { reason: reason ?? undefined })
    return { status: 1, error: '', data: (res as any).data as CancelMedicalOrderResult }
  },

  /**
   * 医嘱关联检验申请(S3.1-C,校验同租户 + 幂等)
   */
  async linkMedicalLabRef(medicalOrderId: string, labOrderId: string, linkType: 'order_request' | 'result_followup' = 'order_request') {
    const res = await api.post(`clinical/medical-orders/${medicalOrderId}/link-lab`, { labOrderId, linkType })
    return { status: 1, error: '', data: (res as any).data as MedicalLabRef }
  },

  // ============================================================
  // 护士任务命令增强 S3.1-C(complete/cancel/fail/scan 走 RPC)
  // ============================================================

  /**
   * 完成任务(S3.1-C)
   * 走 Hono Command + complete_nurse_task RPC:校验状态 + 联动医嘱 completed + 审计
   * 旧 done 状态任务同样可经 RPC 转 completed(状态机兼容)
   */
  async completeNurseTask(id: string, note?: string) {
    const res = await api.post(`clinical/nurse-tasks/${id}/complete`, { note: note ?? undefined })
    return { status: 1, error: '', data: (res as any).data as NurseTaskRecord }
  },

  /**
   * 取消任务(S3.1-C)
   * 走 Hono Command + cancel_nurse_task RPC:仅未执行任务可取消,已执行任务永久保留
   */
  async cancelNurseTask(id: string, reason?: string) {
    const res = await api.post(`clinical/nurse-tasks/${id}/cancel`, { reason: reason ?? undefined })
    return { status: 1, error: '', data: (res as any).data as NurseTaskRecord }
  },

  /**
   * 标记任务失败(S3.1-C)
   * 走 Hono Command + fail_nurse_task RPC:仅未执行任务可标记失败,须填写原因
   */
  async failNurseTask(id: string, reason: string) {
    const res = await api.post(`clinical/nurse-tasks/${id}/fail`, { reason })
    return { status: 1, error: '', data: (res as any).data as NurseTaskRecord }
  },

  /**
   * 护士任务超时/即将到期扫描(S3.1-C)
   * 走 Hono Command + scan_nurse_task_overdue RPC:批量标记 overdue/due_soon(幂等)
   * @param tenantId 租户 id
   * @param storeId 门店 id(可选,为空扫全租户)
   * @param dueSoonMinutes 即将到期提前分钟数(默认 120)
   */
  async scanNurseTaskOverdue(tenantId: string, storeId?: string, dueSoonMinutes = 120) {
    const res = await api.post('clinical/nurse-tasks/scan-overdue', {
      tenantId,
      storeId: storeId ?? undefined,
      dueSoonMinutes,
    })
    return { status: 1, error: '', data: (res as any).data as ScanNurseTaskOverdueResult }
  },

  // ============================================================
  // 便捷状态转换方法
  // ============================================================

  /**
   * 确认预约(pending→confirmed)
   */
  confirmAppointment(id: string) {
    return this.transitionAppointment(id, 'confirmed' as AppointmentStatus)
  },

  /**
   * 候诊报到(confirmed→checked_in)
   */
  checkInAppointment(id: string) {
    return this.transitionAppointment(id, 'checked_in' as AppointmentStatus)
  },

  /**
   * 开始就诊(checked_in→in_progress)
   */
  startAppointment(id: string) {
    return this.transitionAppointment(id, 'in_progress' as AppointmentStatus)
  },

  /**
   * 完成预约(in_progress→completed)
   */
  completeAppointment(id: string) {
    return this.transitionAppointment(id, 'completed' as AppointmentStatus)
  },

  /**
   * 取消预约(任意非终态→cancelled)
   */
  cancelAppointment(id: string) {
    return this.transitionAppointment(id, 'cancelled' as AppointmentStatus)
  },

  /**
   * 标记爽约(任意非终态→no_show)
   */
  noShowAppointment(id: string) {
    return this.transitionAppointment(id, 'no_show' as AppointmentStatus)
  },

  /**
   * 完成就诊(in_progress→completed)
   */
  completeEncounter(id: string) {
    return this.updateEncounter(id, { status: 'completed' as EncounterStatus })
  },

  /**
   * 跳过护士任务(pending/in_progress→skipped)
   */
  skipNurseTask(id: string) {
    return this.updateNurseTask(id, { status: 'skipped' as NurseTaskStatus })
  },
}
