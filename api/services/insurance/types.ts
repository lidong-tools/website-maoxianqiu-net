import type { createServiceClient } from '../../lib/supabase.js'

/**
 * Stage-04 Agent-06 — 保险理赔包服务共享类型
 */

export type Service = ReturnType<typeof createServiceClient>

/** 理赔包材料来源类型(与 migration 235 约束一致) */
export const INSURANCE_SOURCE_TYPES = [
  'encounter',
  'prescription',
  'invoice',
  'lab_report',
  'imaging_report',
  'discharge_summary',
  'medical_record_summary',
  'vaccination_certificate',
] as const

export type InsuranceSourceType = (typeof INSURANCE_SOURCE_TYPES)[number]

/** 理赔包状态 */
export const INSURANCE_PACK_STATUSES = ['draft', 'generated', 'archived', 'cancelled'] as const
export type InsurancePackStatus = (typeof INSURANCE_PACK_STATUSES)[number]

/**
 * 合规可输出状态白名单(INSURANCE_INCLUDED_STATUSES)
 * 未发布/草稿/未完成的数据一律不得进入正式理赔包:
 *   - 未发布 Lab / 未发布 Imaging → 排除
 *   - Draft Prescription → 排除
 */
export const INSURANCE_INCLUDED_STATUSES: Record<InsuranceSourceType, string[]> = {
  encounter: ['completed', 'signed'],
  prescription: ['dispensed'],
  invoice: ['paid', 'partially_paid', 'confirmed'],
  lab_report: ['completed'],
  imaging_report: ['published'],
  discharge_summary: ['discharged'],
  medical_record_summary: ['signed'],
  vaccination_certificate: ['issued'],
}

/** 理赔包材料清单项(前端传入/服务端返回) */
export interface InsurancePackItem {
  id?: string
  source_type: InsuranceSourceType
  source_id: string
  display_order: number
  required: boolean
  included: boolean
  /** 来源摘要(服务端补充,前端展示) */
  summary?: string
}

/** 理赔包头 */
export interface InsurancePack {
  id: string
  tenant_id: string
  store_id: string | null
  customer_id: string
  pet_id: string
  encounter_id: string | null
  admission_id: string | null
  pack_no: string
  status: InsurancePackStatus
  version: number
  remark: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** 理赔包 + 材料清单 */
export interface InsurancePackWithItems {
  pack: InsurancePack
  items: InsurancePackItem[]
}

/** 导出快照(存必要字段,不存无边界医疗全文) */
export interface InsuranceSnapshot {
  pack: {
    id: string
    packNo: string
    version: number
    generatedAt: string
  }
  hospital: { name: string }
  store: { name: string, code?: string, address?: string, phone?: string } | null
  customer: { id: string, name: string, phone?: string } | null
  pet: { id: string, name: string, species?: string, breed?: string, gender?: string } | null
  encounter: {
    id: string
    startedAt?: string
    endedAt?: string
    status: string
    chiefComplaint?: string
    diagnosisText?: string
    doctorName?: string
  } | null
  documents: Array<{
    sourceType: InsuranceSourceType
    sourceId: string
    title: string
    status: string
    issuedAt?: string
    content: Record<string, unknown>
  }>
}

/** 理赔包创建输入(路由层解析) */
export interface CreateInsurancePackInput {
  tenantId: string
  storeId?: string | null
  customerId: string
  petId: string
  encounterId?: string | null
  admissionId?: string | null
  idempotencyKey?: string
}
