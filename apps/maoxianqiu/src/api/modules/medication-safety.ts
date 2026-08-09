import type {
  DrugInteractionInput,
  DrugInteractionRecord,
  DrugProfileInput,
  DrugProfileRecord,
  MedicationSafetyCheckRecord,
  MedicationSafetyEvaluateInput,
  MedicationSafetyEvaluateResult,
  MedicationSafetyOverrideInput,
  MedicationSafetyRuleInput,
  MedicationSafetyRuleRecord,
} from '@/types/medication-safety'
import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * Medication Safety 用药安全域 API 模块(Stage-04 Agent-04)
 *
 * 分层策略:
 *   - Query(list):浏览器直连 Supabase,RLS 兜底(authenticated 仅 SELECT)
 *   - Command(create/update/toggle/upsert/evaluate/override):走 Hono Command
 *     (api/routes/medication-safety.ts),服务端做作用域权限校验,
 *     高危写操作全部通过 service-role-only RPC
 *   - 处方开具/发药的安全门禁由 DB RPC(issue/dispense)强制,不依赖前端先调用 evaluate
 */
export default {
  // ============================================================
  // 规则管理
  // ============================================================

  /**
   * 规则列表(浏览器直连,RLS 兜底;含版本历史)
   * @param tenantId 租户 id
   */
  async listRules(tenantId: string) {
    const { data, error } = await supabase
      .from('medication_safety_rules')
      .select('*, rule_versions:medication_safety_rule_versions(*)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as MedicationSafetyRuleRecord[] },
    }
  },

  /**
   * 创建规则(走 Hono Command,权限 medication_safety.manage)
   */
  createRule(input: MedicationSafetyRuleInput) {
    return api.post('medication-safety/rules', input) as Promise<{ data: { rule: MedicationSafetyRuleRecord } }>
  },

  /**
   * 更新规则(走 Hono Command,权限 medication_safety.manage;版本 +1)
   */
  updateRule(id: string, input: MedicationSafetyRuleInput) {
    return api.patch(`medication-safety/rules/${id}`, input) as Promise<{ data: { rule: MedicationSafetyRuleRecord } }>
  },

  /**
   * 启停规则(走 Hono Command,权限 medication_safety.manage)
   */
  toggleRule(id: string, active: boolean) {
    return api.post(`medication-safety/rules/${id}/toggle`, { active }) as Promise<{ data: { rule: MedicationSafetyRuleRecord } }>
  },

  // ============================================================
  // 药品安全档案
  // ============================================================

  /**
   * 药品安全档案列表(浏览器直连,RLS 兜底;关联目录商品)
   * @param tenantId 租户 id
   */
  async listDrugProfiles(tenantId: string) {
    const { data, error } = await supabase
      .from('drug_profiles')
      .select('*, catalog_item:catalog_items(id, code, name, unit, billing_type)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })

    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as DrugProfileRecord[] },
    }
  },

  /**
   * upsert 药品安全档案(走 Hono Command,权限 medication_safety.manage)
   */
  upsertDrugProfile(input: DrugProfileInput) {
    return api.post('medication-safety/drug-profiles', input) as Promise<{ data: { profile: DrugProfileRecord } }>
  },

  // ============================================================
  // 药物相互作用禁忌
  // ============================================================

  /**
   * 相互作用禁忌列表(浏览器直连,RLS 兜底)
   * @param tenantId 租户 id
   */
  async listInteractions(tenantId: string) {
    const { data, error } = await supabase
      .from('medication_drug_interactions')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('ingredient_a', { ascending: true })

    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as DrugInteractionRecord[] },
    }
  },

  /**
   * upsert 相互作用禁忌(走 Hono Command,权限 medication_safety.manage)
   */
  upsertInteraction(input: DrugInteractionInput) {
    return api.post('medication-safety/interactions', input) as Promise<{ data: { interaction: DrugInteractionRecord } }>
  },

  // ============================================================
  // 检查与豁免
  // ============================================================

  /**
   * 对处方执行安全检查(走 Hono Command,权限 medication_safety.view)
   * 注:仅用于展示/预检;issue/dispense 门禁由 DB RPC 强制,不依赖本端点
   */
  evaluate(input: MedicationSafetyEvaluateInput) {
    return api.post('medication-safety/evaluate', input) as Promise<{ data: { result: MedicationSafetyEvaluateResult } }>
  },

  /**
   * 处方检查结果列表(浏览器直连,RLS 兜底;关联豁免记录)
   * @param prescriptionId 处方 id
   * @param stage 可选阶段过滤
   */
  async listChecks(prescriptionId: string, stage?: MedicationSafetyEvaluateInput['stage']) {
    let query = supabase
      .from('medication_safety_checks')
      .select('*, overrides:medication_safety_overrides(*)')
      .eq('prescription_id', prescriptionId)
      .order('item_index', { ascending: true })
      .order('created_at', { ascending: false })
    if (stage) {
      query = query.eq('check_stage', stage)
    }
    const { data, error } = await query

    if (error) {
      throw new Error(error.message)
    }
    return {
      status: 1,
      error: '',
      data: { list: (data ?? []) as MedicationSafetyCheckRecord[] },
    }
  },

  /**
   * 阻断豁免(走 Hono Command,权限 medication_safety.override;reason 必填)
   */
  overrideCheck(id: string, input: MedicationSafetyOverrideInput) {
    return api.post(`medication-safety/checks/${id}/override`, input) as Promise<{ data: { check: MedicationSafetyCheckRecord } }>
  },
}
