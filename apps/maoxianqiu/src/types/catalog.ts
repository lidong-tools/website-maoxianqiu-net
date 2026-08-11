/**
 * Catalog 领域类型定义(MXQ-6001~6010)
 * 与 supabase/migrations/20260806000016_catalog.sql 对齐
 */

/** 顶级类目编码(MXQ-6001) */
export type CatalogCategoryCode
  = | 'service'
    | 'product'
    | 'drug'
    | 'vaccine'
    | 'exam'
    | 'consumable'

/** 收费类型(MXQ-6010):收费时按目录项引用的分类 */
export type BillingType = 'service' | 'product' | 'drug' | 'vaccine' | 'exam' | 'hospitalization' | 'boarding'

/** 药品剂型(MXQ-6004) */
export type DrugForm = 'tablet' | 'capsule' | 'liquid' | 'injection' | 'other'

/** 疫苗类型(MXQ-6004) */
export type VaccineType = 'rabies' | 'distemper' | 'parvo' | 'other'

/** 检验 panel 分类(MXQ-6009) */
export type LabPanelCategory = 'blood' | 'urine' | 'biochem' | 'endocrine' | 'other'

/** 目录项状态机:is_active true/false 切换 */
export type CatalogItemStatus = 'active' | 'inactive'

/** catalog_categories 表记录(MXQ-6001) */
export interface CatalogCategory {
  id: string
  tenant_id: string
  code: string
  name: string
  parent_id: string | null
  sort_order: number
  is_active: boolean
  created_at: string
  updated_at: string
}

/** 类目树节点(含子类目,UI 渲染用) */
export interface CatalogCategoryNode extends CatalogCategory {
  children?: CatalogCategoryNode[]
}

/** catalog_items 表记录(MXQ-6002 / MXQ-6010) */
export interface CatalogItem {
  id: string
  tenant_id: string
  category_id: string | null
  code: string
  name: string
  description: string | null
  unit: string | null
  default_price: number
  cost_price: number
  is_active: boolean
  tags: string[]
  billing_type: BillingType
  /** 通用条码(商品/服务均可维护,B-R-6) */
  barcode: string | null
  /** 通用厂商(商品/服务均可维护,B-R-6) */
  manufacturer: string | null
  /** 名称全拼(拼音码检索,D-R-4) */
  pinyin: string | null
  /** 名称拼音首字母(拼音码检索,D-R-4) */
  pinyin_short: string | null
  created_at: string
  updated_at: string
}

/** 目录项含类目与扩展信息(联表查询结果) */
export interface CatalogItemWithRelations extends CatalogItem {
  category?: Pick<CatalogCategory, 'id' | 'code' | 'name'> | null
  drug_extension?: CatalogDrugExtension | null
  vaccine_extension?: CatalogVaccineExtension | null
}

/** store_catalog_items 表记录(MXQ-6003) */
export interface StoreCatalogItem {
  id: string
  tenant_id: string
  store_id: string
  catalog_item_id: string
  custom_name: string | null
  custom_price: number | null
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

/** 门店目录项含目录信息(联表查询结果) */
export interface StoreCatalogItemWithCatalog extends StoreCatalogItem {
  catalog_item?: Pick<CatalogItem, 'id' | 'code' | 'name' | 'unit' | 'default_price' | 'billing_type'> | null
}

/** catalog_drug_extensions 表记录(MXQ-6004) */
export interface CatalogDrugExtension {
  id: string
  catalog_item_id: string
  drug_form: DrugForm
  strength: string | null
  manufacturer: string | null
  barcode: string | null
  is_controlled: boolean
  storage_condition: string | null
  shelf_life_days: number | null
  /** 批准文号(国药准字等,B-R-4) */
  approval_number: string | null
  /** 通用名/成分(B-R-4) */
  generic_name: string | null
  /** 用药单位(如 mg/ml/粒,B-R-4) */
  dosage_unit: string | null
  /** 库存单位(如 盒/瓶/支,B-R-4) */
  stock_unit: string | null
  /** 换算率(用药单位 与 库存单位 换算,B-R-4) */
  conversion_rate: number | null
  /** 是否处方药(B-R-4) */
  is_rx: boolean
  created_at: string
  updated_at: string
}

/** catalog_vaccine_extensions 表记录(MXQ-6004) */
export interface CatalogVaccineExtension {
  id: string
  catalog_item_id: string
  vaccine_type: VaccineType
  manufacturer: string | null
  protocol_course: number
  interval_days: number | null
  is_required: boolean
  /** 推荐物种(犬/猫/其他,B-R-9) */
  recommended_species: string | null
  /** 推荐年龄(如 8周龄以上,B-R-9) */
  recommended_age: string | null
  /** 接种禁忌(B-R-9) */
  contraindications: string | null
  /** 提醒规则(如 每年加强一针,B-R-9) */
  reminder_rules: string | null
  created_at: string
  updated_at: string
}

/** intake_questions 表记录(MXQ-6007) */
export interface IntakeQuestion {
  id: string
  tenant_id: string
  category: string
  question: string
  sort_order: number
  is_active: boolean
  created_at: string
  updated_at: string
}

/** diagnosis_dict 表记录(MXQ-6008) */
export interface DiagnosisDict {
  id: string
  tenant_id: string
  code: string
  name: string
  category: string | null
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/** lab_panels 表记录(MXQ-6009) */
export interface LabPanel {
  id: string
  tenant_id: string
  code: string
  name: string
  category: LabPanelCategory
  sample_type: string | null
  /** 关联收费目录项(billing_type=exam),panel 组合的收费入口(B-R-5) */
  catalog_item_id: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/** lab_analytes 表记录(MXQ-6009) */
export interface LabAnalyte {
  id: string
  panel_id: string
  code: string
  name: string
  unit: string | null
  ref_range_low: number | null
  ref_range_high: number | null
  ref_range_text: string | null
  is_critical: boolean
  /** 报告模板(G-R-4) */
  report_template: string | null
  /** 是否外送检测(G-R-4) */
  is_outsourced: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

/** 检验 panel 含 analyte 列表与关联收费项(联表查询结果) */
export interface LabPanelWithAnalytes extends LabPanel {
  analytes?: LabAnalyte[]
  catalog_item?: Pick<CatalogItem, 'id' | 'code' | 'name'> | null
}

/** 批量迁移请求(MXQ-6005,走 Hono Command + RPC) */
export interface MigrateCatalogToStoreInput {
  tenantId: string
  storeId: string
  /** 按类目码过滤;为空时迁移全部 active 目录项 */
  categoryCode?: string
}

/** 批量迁移响应 */
export interface MigrateCatalogToStoreResult {
  insertedCount: number
  skippedCount: number
  totalCount: number
}

/** 目录项跨类目批量迁移请求(B-R-1,走 Hono Command + catalog_items_bulk_migrate RPC) */
export interface BulkMigrateItemsInput {
  tenantId: string
  /** 来源类目 id(项目当前所属类目) */
  sourceCategoryId: string
  /** 待迁移项目 id 列表 */
  itemIds: string[]
  /** 目标类目 id */
  targetCategoryId: string
}

/** 目录项跨类目批量迁移响应(B-R-1) */
export interface BulkMigrateItemsResult {
  migratedCount: number
  skippedCount: number
  totalCount: number
}

/** 目录项状态机转换矩阵:active ↔ inactive */
export const CATALOG_ITEM_STATUS_TRANSITIONS: Record<CatalogItemStatus, CatalogItemStatus[]> = {
  active: ['inactive'],
  inactive: ['active'],
}

/**
 * 校验目录项状态转换是否合法
 * @param from 当前状态
 * @param to 目标状态
 * @returns 是否允许转换
 */
export function canTransitionCatalogItemStatus(from: CatalogItemStatus, to: CatalogItemStatus): boolean {
  return CATALOG_ITEM_STATUS_TRANSITIONS[from].includes(to)
}

/** 顶级类目标签映射(UI 显示用) */
export const CATALOG_CATEGORY_LABELS: Record<CatalogCategoryCode, string> = {
  service: '服务',
  product: '商品',
  drug: '药品',
  vaccine: '疫苗',
  exam: '检验',
  consumable: '耗材',
}

/** 收费类型标签映射(UI 显示用) */
export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
  service: '服务',
  product: '商品',
  drug: '药品',
  vaccine: '疫苗',
  exam: '检验',
  hospitalization: '住院费',
  boarding: '寄养费',
}

/** 药品剂型标签映射(UI 显示用) */
export const DRUG_FORM_LABELS: Record<DrugForm, string> = {
  tablet: '片剂',
  capsule: '胶囊',
  liquid: '液体',
  injection: '注射剂',
  other: '其他',
}

/** 疫苗类型标签映射(UI 显示用) */
export const VACCINE_TYPE_LABELS: Record<VaccineType, string> = {
  rabies: '狂犬',
  distemper: '犬瘟',
  parvo: '细小',
  other: '其他',
}

/** 检验 panel 分类标签映射(UI 显示用) */
export const LAB_PANEL_CATEGORY_LABELS: Record<LabPanelCategory, string> = {
  blood: '血液',
  urine: '尿液',
  biochem: '生化',
  endocrine: '内分泌',
  other: '其他',
}
