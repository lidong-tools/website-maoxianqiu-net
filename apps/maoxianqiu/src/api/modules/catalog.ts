import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * Catalog API 模块(MXQ-6001~6010)
 *
 * 设计原则:
 *   - 类目维护:走 Hono Command + PostgreSQL RPC(三级树约束与原子排序)
 *   - 统一目录/门店价格/药品疫苗扩展:浏览器直连,RLS 兜底
 *   - 批量迁移(MXQ-6005):走 Hono Command + migrate_catalog_to_store RPC(跨表事务)
 *   - 问诊问题/诊断字典/检验 panel:走后端 Hono 聚合(统一鉴权 + 审计)
 *   - 状态机:catalog_items.is_active / store_catalog_items.is_active 双向切换
 */
export default {
  // ==================== 类目(MXQ-6001) ====================

  /** 类目列表(走 Hono scoped authorization,返回扁平列表) */
  listCategories: (params: { tenantId: string }) => api.get('catalog/categories', { params }),

  /** 新增类目(Hono + RPC,最多三级) */
  createCategory: (data: {
    tenantId: string
    code: string
    name: string
    parentId?: string | null
    idempotencyKey: string
  }) => api.post('catalog/categories', data, {
    headers: { 'idempotency-key': data.idempotencyKey },
  }),

  /** 编辑类目名称/状态(Hono + RPC) */
  updateCategory: (data: {
    id: string
    tenantId: string
    name?: string
    isActive?: boolean
    idempotencyKey: string
  }) => api.patch(`catalog/categories/${data.id}`, data, {
    headers: { 'idempotency-key': data.idempotencyKey },
  }),

  /** 删除空类目(Hono + RPC;有子类目或目录项时拒绝) */
  deleteCategory: (data: { id: string, tenantId: string, idempotencyKey: string }) => api.delete(`catalog/categories/${data.id}`, {
    data: { tenantId: data.tenantId, idempotencyKey: data.idempotencyKey },
    headers: { 'idempotency-key': data.idempotencyKey },
  }),

  /** 拖拽移动类目并原子重排新旧同级列表 */
  moveCategory: (data: {
    tenantId: string
    categoryId: string
    parentId: string | null
    position: number
    idempotencyKey: string
  }) => api.post('catalog/categories/move', data, {
    headers: { 'idempotency-key': data.idempotencyKey },
  }),

  // ==================== 统一目录(MXQ-6002 / MXQ-6010) ====================

  /**
   * 目录项列表(直连,RLS 兜底)
   * 支持按类目、关键词、收费类型、状态筛选
   */
  async listItems(params: {
    tenantId: string
    categoryId?: string
    keyword?: string
    billingType?: string
    isActive?: boolean
    from?: number
    limit?: number
  }) {
    let query = supabase
      .from('catalog_items')
      .select(`
        *,
        category:catalog_categories(id, code, name),
        drug_extension:catalog_drug_extensions(id, drug_form, strength, manufacturer, barcode, is_controlled, storage_condition, shelf_life_days),
        vaccine_extension:catalog_vaccine_extensions(id, vaccine_type, manufacturer, protocol_course, interval_days, is_required)
      `, { count: 'exact' })
      .eq('tenant_id', params.tenantId)

    if (params.categoryId) {
      query = query.eq('category_id', params.categoryId)
    }
    if (params.billingType) {
      query = query.eq('billing_type', params.billingType)
    }
    if (params.isActive !== undefined) {
      query = query.eq('is_active', params.isActive)
    }
    if (params.keyword) {
      query = query.or(`name.ilike.%${params.keyword}%,code.ilike.%${params.keyword}%`)
    }
    if (params.from !== undefined && params.limit !== undefined) {
      query = query.range(params.from, params.from + params.limit - 1)
    }
    const { data, error, count } = await query.order('created_at', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: data ?? [], total: count ?? 0 } }
  },

  /**
   * 新增目录项(直连,需 catalog.manage)
   */
  async createItem(data: {
    tenantId: string
    categoryId?: string | null
    code: string
    name: string
    description?: string
    unit?: string
    defaultPrice?: number
    costPrice?: number
    tags?: string[]
    billingType?: string
  }) {
    const { data: row, error } = await supabase
      .from('catalog_items')
      .insert({
        tenant_id: data.tenantId,
        category_id: data.categoryId ?? null,
        code: data.code,
        name: data.name,
        description: data.description ?? null,
        unit: data.unit ?? null,
        default_price: data.defaultPrice ?? 0,
        cost_price: data.costPrice ?? 0,
        tags: data.tags ?? [],
        billing_type: data.billingType ?? 'service',
      })
      .select()
      .single()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: row }
  },

  /**
   * 编辑目录项(直连)
   */
  async updateItem(data: {
    id: string
    categoryId?: string | null
    name?: string
    description?: string
    unit?: string
    defaultPrice?: number
    costPrice?: number
    tags?: string[]
    billingType?: string
    isActive?: boolean
  }) {
    const patch: Record<string, string | number | boolean | string[] | null> = {}
    if (data.categoryId !== undefined) {
      patch.category_id = data.categoryId
    }
    if (data.name !== undefined) {
      patch.name = data.name
    }
    if (data.description !== undefined) {
      patch.description = data.description
    }
    if (data.unit !== undefined) {
      patch.unit = data.unit
    }
    if (data.defaultPrice !== undefined) {
      patch.default_price = data.defaultPrice
    }
    if (data.costPrice !== undefined) {
      patch.cost_price = data.costPrice
    }
    if (data.tags !== undefined) {
      patch.tags = data.tags
    }
    if (data.billingType !== undefined) {
      patch.billing_type = data.billingType
    }
    if (data.isActive !== undefined) {
      patch.is_active = data.isActive
    }
    const { error } = await supabase.from('catalog_items').update(patch).eq('id', data.id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 切换目录项启停状态(状态机:active ↔ inactive)
   */
  async toggleItemActive(id: string, isActive: boolean) {
    const { error } = await supabase
      .from('catalog_items')
      .update({ is_active: isActive })
      .eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 删除目录项(直连)
   */
  async deleteItem(id: string) {
    const { error } = await supabase.from('catalog_items').delete().eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  // ==================== 门店项目/价格覆盖(MXQ-6003) ====================

  /**
   * 门店目录项列表(直连,RLS 兜底,can_access_store 校验)
   */
  async listStoreItems(params: {
    storeId: string
    keyword?: string
    isActive?: boolean
    from?: number
    limit?: number
  }) {
    let query = supabase
      .from('store_catalog_items')
      .select(`
        *,
        catalog_item:catalog_items(id, code, name, unit, default_price, billing_type, category_id)
      `, { count: 'exact' })
      .eq('store_id', params.storeId)

    if (params.isActive !== undefined) {
      query = query.eq('is_active', params.isActive)
    }
    if (params.keyword) {
      query = query.or(`custom_name.ilike.%${params.keyword}%,catalog_item.name.ilike.%${params.keyword}%`)
    }
    if (params.from !== undefined && params.limit !== undefined) {
      query = query.range(params.from, params.from + params.limit - 1)
    }
    const { data, error, count } = await query.order('sort_order', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: data ?? [], total: count ?? 0 } }
  },

  /**
   * 新增/更新门店目录项(upsert,需 catalog.storePrice.manage)
   */
  async upsertStoreItem(data: {
    tenantId: string
    storeId: string
    catalogItemId: string
    customName?: string | null
    customPrice?: number | null
    isActive?: boolean
    sortOrder?: number
  }) {
    const { data: row, error } = await supabase
      .from('store_catalog_items')
      .upsert({
        tenant_id: data.tenantId,
        store_id: data.storeId,
        catalog_item_id: data.catalogItemId,
        custom_name: data.customName ?? null,
        custom_price: data.customPrice ?? null,
        is_active: data.isActive ?? true,
        sort_order: data.sortOrder ?? 0,
      })
      .select()
      .single()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: row }
  },

  /**
   * 切换门店目录项启停状态(状态机:active ↔ inactive)
   */
  async toggleStoreItemActive(id: string, isActive: boolean) {
    const { error } = await supabase
      .from('store_catalog_items')
      .update({ is_active: isActive })
      .eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  /**
   * 删除门店目录项(直连)
   */
  async deleteStoreItem(id: string) {
    const { error } = await supabase.from('store_catalog_items').delete().eq('id', id)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },

  // ==================== 药品扩展(MXQ-6004) ====================

  /**
   * 药品扩展(upsert,需 catalog.drug.manage)
   */
  async upsertDrugExtension(data: {
    catalogItemId: string
    drugForm?: string
    strength?: string | null
    manufacturer?: string | null
    barcode?: string | null
    isControlled?: boolean
    storageCondition?: string | null
    shelfLifeDays?: number | null
  }) {
    const { data: row, error } = await supabase
      .from('catalog_drug_extensions')
      .upsert({
        catalog_item_id: data.catalogItemId,
        drug_form: data.drugForm ?? 'other',
        strength: data.strength ?? null,
        manufacturer: data.manufacturer ?? null,
        barcode: data.barcode ?? null,
        is_controlled: data.isControlled ?? false,
        storage_condition: data.storageCondition ?? null,
        shelf_life_days: data.shelfLifeDays ?? null,
      })
      .select()
      .single()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: row }
  },

  // ==================== 疫苗扩展(MXQ-6004) ====================

  /**
   * 疫苗扩展(upsert,需 catalog.vaccine.manage)
   */
  async upsertVaccineExtension(data: {
    catalogItemId: string
    vaccineType?: string
    manufacturer?: string | null
    protocolCourse?: number
    intervalDays?: number | null
    isRequired?: boolean
  }) {
    const { data: row, error } = await supabase
      .from('catalog_vaccine_extensions')
      .upsert({
        catalog_item_id: data.catalogItemId,
        vaccine_type: data.vaccineType ?? 'other',
        manufacturer: data.manufacturer ?? null,
        protocol_course: data.protocolCourse ?? 1,
        interval_days: data.intervalDays ?? null,
        is_required: data.isRequired ?? false,
      })
      .select()
      .single()
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: row }
  },

  // ==================== 批量迁移(MXQ-6005,走后端 RPC) ====================

  /**
   * 批量迁移租户目录到门店(走 Hono Command + migrate_catalog_to_store RPC)
   * 跨表事务,禁止前端直连写 store_catalog_items 批量
   */
  migrateToStore: (data: {
    tenantId: string
    storeId: string
    categoryCode?: string
  }) => api.post('catalog/migrate-to-store', data),

  // ==================== 问诊问题库(MXQ-6007,走后端) ====================

  listIntakeQuestions: (params: {
    tenantId: string
    category?: string
    isActive?: boolean
    page?: number
    pageSize?: number
  }) => api.get('catalog/intake-questions', { params }),

  createIntakeQuestion: (data: {
    tenantId: string
    category: string
    question: string
    sortOrder?: number
  }) => api.post('catalog/intake-questions', data),

  updateIntakeQuestion: (id: string, data: {
    category?: string
    question?: string
    sortOrder?: number
    isActive?: boolean
  }) => api.patch(`catalog/intake-questions/${id}`, data),

  deleteIntakeQuestion: (id: string) => api.delete(`catalog/intake-questions/${id}`),

  // ==================== 诊断字典(MXQ-6008,走后端) ====================

  listDiagnosisDict: (params: {
    tenantId: string
    keyword?: string
    category?: string
    isActive?: boolean
    page?: number
    pageSize?: number
  }) => api.get('catalog/diagnosis-dict', { params }),

  createDiagnosis: (data: {
    tenantId: string
    code: string
    name: string
    category?: string
    description?: string
  }) => api.post('catalog/diagnosis-dict', data),

  updateDiagnosis: (id: string, data: {
    name?: string
    category?: string
    description?: string
    isActive?: boolean
  }) => api.patch(`catalog/diagnosis-dict/${id}`, data),

  deleteDiagnosis: (id: string) => api.delete(`catalog/diagnosis-dict/${id}`),

  // ==================== 检验 panel/analyte(MXQ-6009,走后端) ====================

  listLabPanels: (params: {
    tenantId: string
    category?: string
    isActive?: boolean
    page?: number
    pageSize?: number
  }) => api.get('catalog/lab-panels', { params }),

  createLabPanel: (data: {
    tenantId: string
    code: string
    name: string
    category?: string
    sampleType?: string
  }) => api.post('catalog/lab-panels', data),

  updateLabPanel: (id: string, data: {
    name?: string
    category?: string
    sampleType?: string
    isActive?: boolean
  }) => api.patch(`catalog/lab-panels/${id}`, data),

  deleteLabPanel: (id: string) => api.delete(`catalog/lab-panels/${id}`),

  listLabAnalytes: (params: { panelId: string }) => api.get('catalog/lab-analytes', { params }),

  createLabAnalyte: (data: {
    panelId: string
    code: string
    name: string
    unit?: string
    refRangeLow?: number
    refRangeHigh?: number
    refRangeText?: string
    isCritical?: boolean
    sortOrder?: number
  }) => api.post('catalog/lab-analytes', data),

  updateLabAnalyte: (id: string, data: {
    name?: string
    unit?: string
    refRangeLow?: number
    refRangeHigh?: number
    refRangeText?: string
    isCritical?: boolean
    sortOrder?: number
  }) => api.patch(`catalog/lab-analytes/${id}`, data),

  deleteLabAnalyte: (id: string) => api.delete(`catalog/lab-analytes/${id}`),
}
