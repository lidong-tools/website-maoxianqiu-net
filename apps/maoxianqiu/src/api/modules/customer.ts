import type {
  BatchImportCustomersInput,
  CreateCustomerInput,
  CustomerListParams,
  CustomerRecord,
  MergeCustomersInput,
  PetRecord,
  UpdateCustomerInput,
} from '@/types/customer'
import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * 客户 API 模块(MXQ-5002~5010)
 *
 * 分层策略:
 *   - Query(list/detail):浏览器直连 Supabase,RLS 兜底
 *   - Command(create/update/archive):浏览器直连 Supabase RPC,RLS 兜底
 *   - 跨表事务(merge/batch-import):走 Hono Command + PostgreSQL RPC,禁止前端直连
 *
 * 状态机:
 *   active → archived(归档)
 *   active → merged(合并,终态)
 *   archived/merged 不可再变更
 */
export default {
  /**
   * 客户列表(浏览器直连,RLS 兜底)
   * 支持 keyword(姓名/手机/编号)、storeId、memberLevel、status 筛选
   */
  async list(params?: CustomerListParams) {
    let query = supabase
      .from('customers')
      .select('*', { count: 'exact' })

    // 默认不展示已归档
    if (params?.status) {
      query = query.eq('status', params.status)
    }
    else {
      query = query.neq('status', 'archived')
    }

    if (params?.storeId) {
      query = query.eq('store_id', params.storeId)
    }
    if (params?.memberLevel) {
      query = query.eq('member_level', params.memberLevel)
    }
    if (params?.keyword) {
      query = query.or(`name.ilike.%${params.keyword}%,phone.ilike.%${params.keyword}%,customer_no.ilike.%${params.keyword}%`)
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
        list: (data ?? []) as CustomerRecord[],
        total: count ?? 0,
        page,
        pageSize,
      },
    }
  },

  /**
   * 客户详情(浏览器直连,RLS 兜底)
   * 返回客户基本信息 + 宠物列表
   */
  async detail(id: string) {
    const { data: customer, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      throw new Error(error.message)
    }
    if (!customer) {
      throw new Error('客户不存在')
    }

    // 查询宠物列表
    const { data: pets, error: petsError } = await supabase
      .from('pets')
      .select('*')
      .eq('customer_id', id)
      .order('created_at', { ascending: true })

    if (petsError) {
      throw new Error(petsError.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        customer: customer as CustomerRecord,
        pets: (pets ?? []) as PetRecord[],
      },
    }
  },

  /**
   * 创建客户(走 Hono Command:POST /customers)
   * Hono 以 service role 调 create_customer RPC,自动生成 customer_no
   */
  async create(input: CreateCustomerInput) {
    const res = await api.post('customers', {
      tenantId: input.tenantId,
      storeId: input.storeId ?? undefined,
      name: input.name,
      gender: input.gender ?? undefined,
      phone: input.phone ?? undefined,
      email: input.email || undefined,
      address: input.address ?? undefined,
      birthday: input.birthday ?? undefined,
      source: input.source ?? undefined,
      memberLevel: input.memberLevel ?? undefined,
      remark: input.remark ?? undefined,
      customerNo: input.customerNo ?? undefined,
    })

    return { status: 1, error: '', data: (res as any).data as CustomerRecord }
  },

  /**
   * 更新客户(走 Hono Command:PATCH /customers/:id)
   * Hono 以 service role 调 update_customer RPC,仅 active 客户可改
   */
  async update(id: string, input: UpdateCustomerInput) {
    const res = await api.patch(`customers/${id}`, {
      name: input.name ?? undefined,
      gender: input.gender ?? undefined,
      phone: input.phone ?? undefined,
      email: input.email || undefined,
      address: input.address ?? undefined,
      birthday: input.birthday ?? undefined,
      source: input.source ?? undefined,
      memberLevel: input.memberLevel ?? undefined,
      memberPoints: input.memberPoints ?? undefined,
      balance: input.balance ?? undefined,
      remark: input.remark ?? undefined,
    })

    return { status: 1, error: '', data: (res as any).data as CustomerRecord }
  },

  /**
   * 归档客户(走 Hono Command:POST /customers/:id/archive)
   * Hono 以 service role 调 archive_customer RPC,active → archived
   */
  async archive(id: string, reason?: string) {
    const res = await api.post(`customers/${id}/archive`, {
      reason: reason ?? undefined,
    })

    return { status: 1, error: '', data: (res as any).data as CustomerRecord }
  },

  /**
   * 合并客户(MXQ-5009,跨表事务)
   * 走 Hono Command + merge_customers RPC,禁止前端直连
   */
  merge(input: MergeCustomersInput) {
    return api.post('customers/merge', {
      sourceId: input.sourceId,
      targetId: input.targetId,
    })
  },

  /**
   * 批量导入客户(MXQ-5010)
   * 走 Hono Command,逐行调 create_customer RPC
   */
  batchImport(input: BatchImportCustomersInput) {
    return api.post('customers/batch-import', input)
  },

  /**
   * 创建导入任务(MXQ-5010)
   * 走 Hono Command,创建 pending 状态的导入任务
   * 文件上传走 files 模块(前端先上传再传 fileId)
   */
  createImportJob(input: {
    tenantId: string
    storeId?: string
    fileId?: string
    totalRows?: number
  }) {
    return api.post('customers/import', input)
  },

  /**
   * 查询导入任务状态(MXQ-5010)
   * 走 Hono Command,返回导入任务详情(含进度)
   */
  getImportJob(id: string) {
    return api.get(`customers/import/${id}`)
  },
}
