import type { PrescriptionRecord } from '@/types/clinical'
import type {
  AmendmentApplyInput,
  AmendmentRequestInput,
  AmendmentReviewInput,
  ComplianceArchiveInput,
  MedicalRecordAmendmentRecord,
  MedicalRecordType,
  PrescriptionExtendValidityInput,
  PrescriptionIssueInput,
  VeterinarianRegistrationListItem,
  VeterinarianRegistrationRecord,
  VeterinarianRegistrationUpsertInput,
} from '@/types/compliance'
import { supabase } from '@/lib/supabase'
import api from '../index'

/** 模块级缓存:当前登录用户对应的 employees.id */
let currentEmployeeIdCache: string | null = null

/**
 * 获取当前登录用户的员工档案 id(employees.id)
 * 通过 supabase 查询 employees(user_id = 当前 user.id),带模块级缓存,避免重复查询
 * @returns 员工档案 id
 */
export async function getCurrentEmployeeId(): Promise<string> {
  if (currentEmployeeIdCache) {
    return currentEmployeeIdCache
  }
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) {
    throw new Error('未登录')
  }
  const { data, error } = await supabase
    .from('employees')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()
  if (error) {
    throw new Error(error.message)
  }
  if (!data) {
    throw new Error('当前账号未关联员工档案,无法执行操作')
  }
  currentEmployeeIdCache = data.id
  return data.id
}

/**
 * Compliance 合规域 API 模块(S3.1-1)
 *
 * 分层策略:
 *   - Query(list):浏览器直连 Supabase,RLS 兜底
 *   - Command(archive/amend/upsert/issue/extend):走 Hono Command(api/routes/compliance.ts),
 *     服务端做权限/租户归属/状态机校验,禁止前端直连写
 */
export default {
  // ============================================================
  // 病历归档与修订
  // ============================================================

  /**
   * 病历归档(走 Hono Command,权限 medical_record.archive)
   */
  archiveRecord(input: ComplianceArchiveInput) {
    return api.post('compliance/records/archive', input) as Promise<{ data: Record<string, unknown> }>
  },

  /**
   * 修订申请(走 Hono Command,权限 medical_record.amend.request)
   */
  requestAmendment(input: AmendmentRequestInput) {
    return api.post('compliance/records/amendments/request', input) as Promise<{ data: MedicalRecordAmendmentRecord }>
  },

  /**
   * 修订审批(走 Hono Command,权限 medical_record.amend.approve)
   */
  reviewAmendment(id: string, input: AmendmentReviewInput) {
    return api.post(`compliance/records/amendments/${id}/review`, input) as Promise<{ data: MedicalRecordAmendmentRecord }>
  },

  /**
   * 修订应用(走 Hono Command,权限 medical_record.amend.request)
   */
  applyAmendment(id: string, input: AmendmentApplyInput) {
    return api.post(`compliance/records/amendments/${id}/apply`, input) as Promise<{ data: MedicalRecordAmendmentRecord }>
  },

  /**
   * 病历修订申请列表(浏览器直连,RLS 兜底)
   * @param recordType 病历类型 encounter|admission
   * @param recordId 病历记录 id
   */
  async listAmendments(recordType: MedicalRecordType, recordId: string) {
    const { data, error } = await supabase
      .from('medical_record_amendments')
      .select('*')
      .eq('medical_record_type', recordType)
      .eq('medical_record_id', recordId)
      .order('requested_at', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }

    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as MedicalRecordAmendmentRecord[] },
    }
  },

  // ============================================================
  // 执业兽医备案
  // ============================================================

  /**
   * 兽医备案 upsert(走 Hono Command,权限 veterinarian_registration.manage)
   */
  upsertVeterinarianRegistration(input: VeterinarianRegistrationUpsertInput) {
    return api.post('compliance/veterinarian-registrations/upsert', input) as Promise<{ data: VeterinarianRegistrationRecord }>
  },

  /**
   * 兽医备案列表(浏览器直连,RLS 兜底,关联员工姓名/工号/职称)
   * @param tenantId 租户 id
   */
  async listVeterinarianRegistrations(tenantId: string) {
    const { data, error } = await supabase
      .from('veterinarian_registrations')
      .select('*, employees(name, employee_no, title)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }

    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as VeterinarianRegistrationListItem[] },
    }
  },

  // ============================================================
  // 处方合规
  // ============================================================

  /**
   * 开具处方(走 Hono Command,权限 prescription.issue;受控药另需 prescription.controlled_issue)
   */
  issuePrescription(id: string, input: PrescriptionIssueInput) {
    return api.post(`compliance/prescriptions/${id}/issue`, input) as Promise<{ data: PrescriptionRecord }>
  },

  /**
   * 延长处方有效期(走 Hono Command,权限 prescription.extend_validity)
   */
  extendPrescriptionValidity(id: string, input: PrescriptionExtendValidityInput) {
    return api.post(`compliance/prescriptions/${id}/extend-validity`, input) as Promise<{ data: PrescriptionRecord }>
  },
}
