/**
 * Medication Safety 用药安全域类型定义(Stage-04 Agent-04)
 * 与 supabase/migrations/20260810000210~211 数据模型一一对应。
 */

/** 规则类型枚举(与 DB check 约束一致) */
export type MedicationSafetyRuleType =
  | 'duplicate_ingredient'
  | 'duplicate_drug'
  | 'dose_range'
  | 'duration_limit'
  | 'frequency_limit'
  | 'species_contraindication'
  | 'age_constraint'
  | 'weight_constraint'
  | 'antimicrobial_notice'
  | 'drug_interaction'

/** 严重度 */
export type MedicationSafetySeverity = 'info' | 'warning' | 'error'

/** 检查阶段 */
export type MedicationSafetyCheckStage = 'draft' | 'issue' | 'dispense'

/** 检查状态 */
export type MedicationSafetyCheckStatus = 'triggered' | 'overridden' | 'resolved'

/** 用药安全规则记录 */
export interface MedicationSafetyRuleRecord {
  id: string
  tenant_id: string
  code: string
  name: string
  rule_type: MedicationSafetyRuleType
  severity: MedicationSafetySeverity
  is_blocking: boolean
  species: string[]
  active: boolean
  current_version: number
  created_by: string | null
  created_at: string
  updated_at: string
  rule_versions?: MedicationSafetyRuleVersionRecord[]
}

/** 规则版本记录(append-only,历史处方可追溯) */
export interface MedicationSafetyRuleVersionRecord {
  id: string
  rule_id: string
  version: number
  condition: Record<string, unknown>
  message: string | null
  recommendation: string | null
  effective_from: string
  effective_to: string | null
  created_by: string | null
  created_at: string
}

/** 规则创建/更新入参 */
export interface MedicationSafetyRuleInput {
  tenantId: string
  ruleId?: string
  code?: string
  name?: string
  ruleType: MedicationSafetyRuleType
  severity: MedicationSafetySeverity
  isBlocking: boolean
  species?: string[]
  active?: boolean
  condition?: Record<string, unknown>
  message?: string
  recommendation?: string
}

/** 药品安全档案记录 */
export interface DrugProfileRecord {
  id: string
  tenant_id: string
  catalog_item_id: string
  active_ingredient: string | null
  strength: string | null
  strength_unit: string | null
  route: 'oral' | 'injection' | 'topical' | 'other' | null
  antimicrobial_class: string | null
  min_dose_mg_kg: number | null
  max_dose_mg_kg: number | null
  min_age_months: number | null
  max_age_months: number | null
  min_weight_kg: number | null
  max_weight_kg: number | null
  max_duration_days: number | null
  species_contraindications: string[]
  created_at: string
  updated_at: string
  catalog_item?: {
    id: string
    code: string
    name: string
    unit: string | null
    billing_type: string
  }
}

/** 药品安全档案 upsert 入参 */
export interface DrugProfileInput {
  tenantId: string
  catalogItemId: string
  activeIngredient?: string
  strength?: string
  strengthUnit?: string
  route?: 'oral' | 'injection' | 'topical' | 'other'
  antimicrobialClass?: string
  minDoseMgKg?: number
  maxDoseMgKg?: number
  minAgeMonths?: number
  maxAgeMonths?: number
  minWeightKg?: number
  maxWeightKg?: number
  maxDurationDays?: number
  speciesContraindications?: string[]
}

/** 药物相互作用禁忌记录 */
export interface DrugInteractionRecord {
  id: string
  tenant_id: string
  ingredient_a: string
  ingredient_b: string
  severity: MedicationSafetySeverity
  description: string | null
  active: boolean
  created_at: string
  updated_at: string
}

/** 相互作用禁忌 upsert 入参 */
export interface DrugInteractionInput {
  tenantId: string
  ingredientA: string
  ingredientB: string
  severity: MedicationSafetySeverity
  description?: string
  active?: boolean
}

/** 检查结果记录 */
export interface MedicationSafetyCheckRecord {
  id: string
  tenant_id: string
  store_id: string | null
  prescription_id: string
  encounter_id: string | null
  pet_id: string
  check_stage: MedicationSafetyCheckStage
  rule_id: string | null
  rule_version: number | null
  rule_code: string
  rule_type: MedicationSafetyRuleType
  severity: MedicationSafetySeverity
  blocking: boolean
  status: MedicationSafetyCheckStatus
  item_index: number
  message_snapshot: string
  recommendation_snapshot: string | null
  context_snapshot: Record<string, unknown>
  created_at: string
  updated_at: string
  overrides?: MedicationSafetyOverrideRecord[]
}

/** 豁免记录 */
export interface MedicationSafetyOverrideRecord {
  id: string
  tenant_id: string
  check_id: string
  override_by: string | null
  override_by_employee_id: string | null
  reason: string
  created_at: string
}

/** evaluate 结果 */
export interface MedicationSafetyEvaluateResult {
  prescription_id: string
  stage: MedicationSafetyCheckStage
  total: number
  blocking_unresolved: number
  unable_to_evaluate: number
  checks: MedicationSafetyCheckRecord[]
}

/** evaluate 入参 */
export interface MedicationSafetyEvaluateInput {
  prescriptionId: string
  stage: MedicationSafetyCheckStage
}

/** 豁免入参 */
export interface MedicationSafetyOverrideInput {
  reason: string
}
