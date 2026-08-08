import { err } from './errors.js'
import { createServiceClient } from './supabase.js'

/**
 * 跨域自动回访 Command(S3.1 Agent-07 集成)
 *
 * 由 clinical(病历随访日期) / inpatient(出院) 在业务完成后调用,
 * 自动生成 followup_tasks。调用方已完成作用域收敛与权限校验,本函数不再鉴权。
 *
 * 设计原则(AGENT-04-HANDOFF §7):
 * - 不让 clinical / inpatient 直接散写 followup 表,统一走本内部 Command;
 * - 去重:同 (tenant_id, source_type, source_id, task_type) 存在未完成回访时跳过,
 *   避免编辑病历日期 / 重试出院时产生重复任务;
 * - 创建失败抛错,由调用方决定是否吞掉(回访为二级动作,不阻塞医疗主流程)。
 */

export type FollowupSourceType = 'manual' | 'encounter' | 'discharge' | 'reminder' | 'complaint'
export type FollowupTaskType = 'post_visit' | 'post_discharge' | 'medication' | 'recheck' | 'customer_care' | 'other'
export type FollowupChannel = 'phone' | 'wechat' | 'sms' | 'in_person' | 'other'

export interface FollowupAutoCreateInput {
  tenantId: string
  storeId?: string | null
  customerId: string
  petId?: string | null
  sourceType: FollowupSourceType
  sourceId: string
  taskType: FollowupTaskType
  scheduledAt?: string | null
  assigneeEmployeeId?: string | null
  channel?: FollowupChannel | null
  createdBy?: string | null
}

/**
 * 自动创建回访任务(去重)
 * @returns { id } | null —— 命中去重(已有未完成回访)返回 null
 */
export async function autoCreateFollowup(
  input: FollowupAutoCreateInput,
): Promise<{ id: string } | null> {
  if (!input.customerId) {
    return null
  }
  const service = createServiceClient()
  // followup_tasks 尚未进入生成的 supabase types,沿用 customers.ts followupTable 的 any 处理
  const table = service.from('followup_tasks') as any

  const { data: existing } = await table
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('source_type', input.sourceType)
    .eq('source_id', input.sourceId)
    .eq('task_type', input.taskType)
    .in('status', ['pending', 'in_progress'])
    .limit(1)
  if ((existing ?? []).length > 0) {
    return null
  }

  const { data, error } = await table
    .insert({
      tenant_id: input.tenantId,
      store_id: input.storeId ?? null,
      customer_id: input.customerId,
      pet_id: input.petId ?? null,
      source_type: input.sourceType,
      source_id: input.sourceId,
      task_type: input.taskType,
      scheduled_at: input.scheduledAt
        ? new Date(input.scheduledAt).toISOString()
        : new Date().toISOString(),
      assignee_employee_id: input.assigneeEmployeeId ?? null,
      channel: input.channel ?? null,
      status: 'pending',
      created_by: input.createdBy ?? null,
    })
    .select('id')
    .single()

  if (error) {
    throw err.internal(`创建回访任务失败: ${error.message}`)
  }
  return data
}
