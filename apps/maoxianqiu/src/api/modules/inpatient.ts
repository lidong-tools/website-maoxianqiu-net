import type {
  Admission,
  AdmitPatientInput,
  Cage,
  CageStatusView,
  CageTransfer,
  CageUpsertInput,
  CreateHandoverInput,
  CreateProgressNoteInput,
  DischargePatientInput,
  FinalizeSettlementResult,
  InpatientCharge,
  NursingPlan,
  NursingPlanInput,
  NursingTask,
  NursingTaskInput,
  PaymentMethod,
  PrepareSettlementResult,
  ProgressNoteListParams,
  ProgressNoteRecord,
  Room,
  RoomUpsertInput,
  SettleSettlementResult,
  ShiftHandover,
  TransferCageInput,
  WaiveSettlementResult,
} from '@/types/inpatient'
import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * Inpatient 住院管理领域 API 模块(MXQ-11001~11009)
 *
 * 设计原则:
 *   - 入院/换房/出院走 Hono Command + PostgreSQL RPC,SELECT FOR UPDATE 防房位冲突
 *   - 查询类(房间/笼位/住院记录/护理任务)浏览器直连 supabase,RLS 兜底
 *   - 幂等:过房位类命令须带 idempotency-key(Header),同一 key 重复请求返回原结果
 *   - 房态看板查询 inpatient_cage_status 视图
 */
export default {
  // ==================== 查询:浏览器直连 ====================

  /**
   * 房间列表(浏览器直连,RLS 按门店过滤)
   * @param storeId 门店 id
   * @param onlyActive 仅返回启用的房间
   */
  async listRooms(storeId?: string, onlyActive = false) {
    let query = supabase.from('rooms').select('*')
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    if (onlyActive) {
      query = query.eq('is_active', true)
    }
    const { data, error } = await query.order('name', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as Room[] } }
  },

  /**
   * 新增房间(直连,RLS 须 inpatient.admit 权限)
   */
  async createRoom(data: RoomUpsertInput) {
    const { error } = await supabase.from('rooms').insert({
      tenant_id: data.tenantId,
      store_id: data.storeId,
      name: data.name,
      code: data.code,
      floor: data.floor ?? null,
      room_type: data.roomType ?? 'standard',
      capacity: data.capacity ?? 0,
      is_active: data.isActive ?? true,
    })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 编辑房间(直连)
   */
  async updateRoom(id: string, patch: Partial<RoomUpsertInput>) {
    const update: Record<string, unknown> = {}
    if (patch.name !== undefined) {
      update.name = patch.name
    }
    if (patch.code !== undefined) {
      update.code = patch.code
    }
    if (patch.floor !== undefined) {
      update.floor = patch.floor
    }
    if (patch.roomType !== undefined) {
      update.room_type = patch.roomType
    }
    if (patch.capacity !== undefined) {
      update.capacity = patch.capacity
    }
    if (patch.isActive !== undefined) {
      update.is_active = patch.isActive
    }

    const { error } = await supabase.from('rooms').update(update).eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 笼位列表(浏览器直连,RLS 按门店过滤)
   * @param storeId 门店 id
   * @param roomId 房间 id(可选)
   * @param status 笼位状态(可选)
   */
  async listCages(storeId?: string, roomId?: string, status?: string) {
    let query = supabase.from('cages').select('*')
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    if (roomId) {
      query = query.eq('room_id', roomId)
    }
    if (status) {
      query = query.eq('status', status)
    }
    const { data, error } = await query.order('name', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as Cage[] } }
  },

  /**
   * 新增笼位(直连,RLS 须 inpatient.admit 权限)
   */
  async createCage(data: CageUpsertInput) {
    const { error } = await supabase.from('cages').insert({
      tenant_id: data.tenantId,
      store_id: data.storeId,
      room_id: data.roomId,
      name: data.name,
      code: data.code,
      cage_type: data.cageType ?? 'cage',
      daily_rate: data.dailyRate ?? 0,
      status: data.status ?? 'available',
    })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 编辑笼位(直连)
   */
  async updateCage(id: string, patch: Partial<CageUpsertInput>) {
    const update: Record<string, unknown> = {}
    if (patch.name !== undefined) {
      update.name = patch.name
    }
    if (patch.code !== undefined) {
      update.code = patch.code
    }
    if (patch.cageType !== undefined) {
      update.cage_type = patch.cageType
    }
    if (patch.dailyRate !== undefined) {
      update.daily_rate = patch.dailyRate
    }
    if (patch.status !== undefined) {
      update.status = patch.status
    }
    if (patch.roomId !== undefined) {
      update.room_id = patch.roomId
    }

    const { error } = await supabase.from('cages').update(update).eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 房态看板(直连 inpatient_cage_status 视图,RLS 按门店过滤)
   * 关联 cages + rooms + current_admission,展示房态
   * @param storeId 门店 id
   */
  async listCageStatus(storeId?: string): Promise<CageStatusView[]> {
    let query = supabase.from('inpatient_cage_status').select('*')
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    const { data, error } = await query.order('room_name', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return (data ?? []) as CageStatusView[]
  },

  /**
   * 住院记录列表(浏览器直连,RLS 兜底)
   * @param storeId 门店 id
   * @param status 入院状态(可选)
   */
  async listAdmissions(storeId?: string, status?: string) {
    let query = supabase.from('admissions').select('*')
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    if (status) {
      query = query.eq('status', status)
    }
    const { data, error } = await query.order('admitted_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as Admission[] } }
  },

  /**
   * 护理计划列表(浏览器直连)
   * @param admissionId 住院 id
   */
  async listNursingPlans(admissionId: string) {
    const { data, error } = await supabase
      .from('nursing_plans')
      .select('*')
      .eq('admission_id', admissionId)
      .order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as NursingPlan[] } }
  },

  /**
   * 新建护理计划(直连,RLS 须 nursing.manage 权限)
   */
  async createNursingPlan(data: NursingPlanInput) {
    const { error } = await supabase.from('nursing_plans').insert({
      tenant_id: data.tenantId,
      store_id: data.storeId,
      admission_id: data.admissionId,
      pet_id: data.petId,
      plan_name: data.planName,
      frequency: data.frequency,
      start_date: data.startDate ?? null,
      end_date: data.endDate ?? null,
    })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 护理任务列表(浏览器直连)
   * @param admissionId 住院 id
   * @param date 任务日期(可选,默认今日)
   */
  async listNursingTasks(admissionId: string, date?: string) {
    const targetDate = date ?? new Date().toISOString().slice(0, 10)
    const { data, error } = await supabase
      .from('nursing_tasks')
      .select('*')
      .eq('admission_id', admissionId)
      .gte('scheduled_at', `${targetDate}T00:00:00`)
      .lt('scheduled_at', `${targetDate}T23:59:59`)
      .order('scheduled_at', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as NursingTask[] } }
  },

  /**
   * 新建护理任务(直连,RLS 须 nursing.manage 权限)
   */
  async createNursingTask(data: NursingTaskInput) {
    const { error } = await supabase.from('nursing_tasks').insert({
      tenant_id: data.tenantId,
      store_id: data.storeId,
      admission_id: data.admissionId,
      pet_id: data.petId,
      plan_id: data.planId ?? null,
      task_type: data.taskType,
      description: data.description ?? null,
      scheduled_at: data.scheduledAt,
      assigned_to: data.assignedTo ?? null,
    })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 更新护理任务状态(开始执行 / 完成 / 跳过)
   * @param id 任务 id
   * @param status 目标状态
   * @param note 备注(可选)
   */
  async updateNursingTaskStatus(id: string, status: NursingTask['status'], note?: string) {
    const patch: Record<string, unknown> = { status }
    if (status === 'done') {
      patch.completed_at = new Date().toISOString()
    }
    if (note !== undefined) {
      patch.note = note
    }
    const { error } = await supabase.from('nursing_tasks').update(patch).eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 交接班列表(浏览器直连)
   * @param storeId 门店 id
   * @param shiftDate 班次日期(可选)
   */
  async listHandovers(storeId?: string, shiftDate?: string) {
    let query = supabase.from('shift_handovers').select('*')
    if (storeId) {
      query = query.eq('store_id', storeId)
    }
    if (shiftDate) {
      query = query.eq('shift_date', shiftDate)
    }
    const { data, error } = await query.order('shift_date', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as ShiftHandover[] } }
  },

  /**
   * 换房历史列表(浏览器直连)
   * @param admissionId 住院 id
   */
  async listCageTransfers(admissionId: string) {
    const { data, error } = await supabase
      .from('cage_transfers')
      .select('*')
      .eq('admission_id', admissionId)
      .order('created_at', { ascending: false })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as CageTransfer[] } }
  },

  /**
   * 住院费用列表(浏览器直连)
   * @param admissionId 住院 id
   */
  async listCharges(admissionId: string) {
    const { data, error } = await supabase
      .from('inpatient_charges')
      .select('*')
      .eq('admission_id', admissionId)
      .order('charge_date', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: (data ?? []) as InpatientCharge[] } }
  },

  // ==================== 命令:Hono + RPC ====================

  /**
   * 办理入院(MXQ-11003)
   * 走 Hono Command + admit_patient RPC,事务化创建 admission + 锁笼位
   * @param data 入院参数
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  admitPatient(data: AdmitPatientInput, idempotencyKey: string) {
    return api.post('inpatient/admit', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },

  /**
   * 换房(MXQ-11006)
   * 走 Hono Command + transfer_cage RPC,事务化释放旧笼位 + 占用新笼位
   * @param data 换房参数
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  transferCage(data: TransferCageInput, idempotencyKey: string) {
    return api.post('inpatient/transfer', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },

  /**
   * 办理出院(MXQ-11008)
   * 走 Hono Command + discharge_patient RPC,事务化汇总费用 + 释放笼位
   * @param data 出院参数
   * @param idempotencyKey 幂等键(同一 key 重复请求返回原结果)
   */
  dischargePatient(data: DischargePatientInput, idempotencyKey: string) {
    return api.post('inpatient/discharge', data, {
      headers: { 'idempotency-key': idempotencyKey },
    })
  },

  /**
   * 创建交接班(MXQ-11005)
   * 走 Hono Command + create_handover RPC,同班次已存在则更新 summary
   */
  createHandover(data: CreateHandoverInput) {
    return api.post('inpatient/handover', data)
  },

  /**
   * 自动计费(MXQ-11007)
   * 走 Hono Command + generate_daily_charges RPC,扫描所有 admitted admission 生成当日笼位费
   * @param targetDate 目标计费日期(可选,默认今日)
   */
  generateDailyCharges(targetDate?: string) {
    return api.post('inpatient/charges/generate', { targetDate: targetDate ?? null })
  },

  // ============================================================
  // 住院病程记录 S3.1-C(migration 47,走 Hono Command + RPC)
  // ============================================================

  /**
   * 病程记录列表(走 Hono Command,权限:progress.view)
   * 支持 storeId/admissionId/petId/status/noteType 筛选 + 分页
   */
  async listProgressNotes(params?: ProgressNoteListParams) {
    const query: Record<string, unknown> = {}
    if (params?.storeId) query.storeId = params.storeId
    if (params?.admissionId) query.admissionId = params.admissionId
    if (params?.petId) query.petId = params.petId
    if (params?.status) query.status = params.status
    if (params?.noteType) query.noteType = params.noteType
    query.page = params?.page ?? 1
    query.pageSize = params?.pageSize ?? 20
    const res = await api.get('inpatient/progress-notes', { params: query })
    const data = (res as any).data
    return { status: 1, error: '', data }
  },

  /**
   * 记录病程(S3.1-C,走 Hono Command + create_progress_note RPC)
   * 校验住院中(admitted)+ 生成编号 + 审计;记录后 status=draft
   */
  async createProgressNote(input: CreateProgressNoteInput) {
    const res = await api.post('inpatient/progress-notes', {
      admissionId: input.admissionId,
      content: input.content,
      noteType: input.noteType ?? 'daily',
      recordedAt: input.recordedAt ?? undefined,
    })
    return { status: 1, error: '', data: (res as any).data as ProgressNoteRecord }
  },

  /**
   * 签署病程(S3.1-C,走 Hono Command + sign_progress_note RPC)
   * draft→signed(终态,签署后内容不可再改)
   */
  async signProgressNote(id: string) {
    const res = await api.post(`inpatient/progress-notes/${id}/sign`, {})
    return { status: 1, error: '', data: (res as any).data as ProgressNoteRecord }
  },

  // ============================================================
  // 出院结算 S3.1-C(migration 48,走 Hono Command + RPC)
  // ============================================================

  /**
   * 生成结算单(S3.1-C,走 Hono Command + prepare_settlement RPC)
   * 汇总 inpatient_charges 生成应收 + 结算单号(幂等:已准备重复调用返回原结算信息)
   */
  async prepareSettlement(admissionId: string) {
    const res = await api.post(`inpatient/admissions/${admissionId}/settlement/prepare`, {})
    return { status: 1, error: '', data: (res as any).data as PrepareSettlementResult }
  },

  /**
   * 收款结算(S3.1-C,走 Hono Command + settle_admission RPC)
   * 校验 prepared;实收不可超过应付(应收-押金-减免);状态 prepared→settled
   */
  async settleAdmission(admissionId: string, paidAmount: number, paymentMethod: PaymentMethod = 'cash') {
    const res = await api.post(`inpatient/admissions/${admissionId}/settlement/settle`, {
      paidAmount,
      paymentMethod,
    })
    return { status: 1, error: '', data: (res as any).data as SettleSettlementResult }
  },

  /**
   * 减免/挂账(S3.1-C,走 Hono Command + waive_admission_charge RPC)
   * 校验 prepared/settled;减免金额须在可减免上限内;状态 → waived
   */
  async waiveAdmissionCharge(admissionId: string, amount: number, reason?: string) {
    const res = await api.post(`inpatient/admissions/${admissionId}/settlement/waive`, {
      amount,
      reason: reason ?? undefined,
    })
    return { status: 1, error: '', data: (res as any).data as WaiveSettlementResult }
  },

  /**
   * 完成结算并出院(S3.1-C,走 Hono Command + finalize_settlement RPC)
   * 校验 settled/waived;联动出院(释放笼位 + total_charge 同步);状态 → finalized
   */
  async finalizeSettlement(admissionId: string) {
    const res = await api.post(`inpatient/admissions/${admissionId}/settlement/finalize`, {})
    return { status: 1, error: '', data: (res as any).data as FinalizeSettlementResult }
  },
}

/**
 * 生成幂等键(浏览器原生 crypto.randomUUID)
 * 用于入院/换房/出院等命令,同一 key 重复请求返回原结果,防止重复扣房位
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID()
}
