import type {
  CreatePetInput,
  PetDetailResult,
  PetListParams,
  PetRecord,
  PetWeightRecord,
  UpdatePetInput,
} from '@/types/customer'
import { supabase } from '@/lib/supabase'

/**
 * 宠物 API 模块(MXQ-5006~5008)
 *
 * 分层策略:
 *   - Query(list/detail/weights):浏览器直连 Supabase,RLS 兜底
 *   - Command(create/update/archive):浏览器直连 Supabase RPC,RLS 兜底
 *
 * 状态机:
 *   active → deceased(去世) / lost(走失) / archived(归档)
 *   deceased/lost → archived
 *   archived 不可再变更
 *
 * 体重记录(pet_weights):
 *   - create_pet / update_pet 体重变化时自动落记录
 *   - 也提供独立的 listWeights 接口供体检/就诊录入
 */
export default {
  /**
   * 宠物列表(按客户)(浏览器直连,RLS 兜底)
   */
  async list(params: PetListParams) {
    let query = supabase
      .from('pets')
      .select('*')
      .eq('customer_id', params.customerId)

    if (params.status) {
      query = query.eq('status', params.status)
    }
    else {
      // 默认不展示已归档
      query = query.neq('status', 'archived')
    }

    const { data, error } = await query.order('created_at', { ascending: true })

    if (error) {
      throw new Error(error.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        list: (data ?? []) as PetRecord[],
      },
    }
  },

  /**
   * 宠物详情(浏览器直连,RLS 兜底)
   * 返回宠物基本信息 + 最近 30 条体重记录
   */
  async detail(id: string): Promise<{ status: number, error: string, data: PetDetailResult }> {
    const { data: pet, error } = await supabase
      .from('pets')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      throw new Error(error.message)
    }
    if (!pet) {
      throw new Error('宠物不存在')
    }

    // 查询最近 30 条体重记录(按时间倒序)
    const { data: weights, error: weightsError } = await supabase
      .from('pet_weights')
      .select('*')
      .eq('pet_id', id)
      .order('recorded_at', { ascending: false })
      .limit(30)

    if (weightsError) {
      throw new Error(weightsError.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        pet: pet as PetRecord,
        weights: (weights ?? []) as PetWeightRecord[],
      },
    }
  },

  /**
   * 创建宠物(浏览器直连 RPC,RLS 兜底)
   * 调用 create_pet RPC,若提供初始体重会同步落体重记录
   */
  async create(input: CreatePetInput) {
    const { data, error } = await supabase.rpc('create_pet', {
      p_tenant_id: input.tenantId,
      p_customer_id: input.customerId,
      p_name: input.name,
      p_species: input.species ?? null,
      p_breed: input.breed ?? null,
      p_gender: input.gender ?? null,
      p_birth_date: input.birthDate ?? null,
      p_weight: input.weight ?? null,
      p_is_neutered: input.isNeutered ?? false,
      p_microchip: input.microchip ?? null,
      p_color: input.color ?? null,
      p_photo_file_id: input.photoFileId ?? null,
      p_risk_tags: input.riskTags ?? [],
      p_temperament: input.temperament ?? null,
      p_medical_notes: input.medicalNotes ?? null,
    })

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as PetRecord }
  },

  /**
   * 更新宠物(浏览器直连 RPC,RLS 兜底)
   * 调用 update_pet RPC,体重变化时自动落体重记录
   */
  async update(id: string, input: UpdatePetInput) {
    const { data, error } = await supabase.rpc('update_pet', {
      p_pet_id: id,
      p_name: input.name ?? null,
      p_species: input.species ?? null,
      p_breed: input.breed ?? null,
      p_gender: input.gender ?? null,
      p_birth_date: input.birthDate ?? null,
      p_weight: input.weight ?? null,
      p_is_neutered: input.isNeutered ?? null,
      p_microchip: input.microchip ?? null,
      p_color: input.color ?? null,
      p_photo_file_id: input.photoFileId ?? null,
      p_risk_tags: input.riskTags ?? null,
      p_temperament: input.temperament ?? null,
      p_medical_notes: input.medicalNotes ?? null,
      p_status: input.status ?? null,
    })

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as PetRecord }
  },

  /**
   * 归档宠物(浏览器直连 RPC,RLS 兜底)
   * 调用 archive_pet RPC,active/deceased/lost → archived
   */
  async archive(id: string, reason?: string) {
    const { data, error } = await supabase.rpc('archive_pet', {
      p_pet_id: id,
      p_archived_by: null,
      p_reason: reason ?? null,
    })

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as PetRecord }
  },

  /**
   * 体重记录列表(浏览器直连,RLS 兜底)
   * 返回指定宠物的全部体重记录(按时间倒序)
   */
  async listWeights(petId: string, limit = 100) {
    const { data, error } = await supabase
      .from('pet_weights')
      .select('*')
      .eq('pet_id', petId)
      .order('recorded_at', { ascending: false })
      .limit(limit)

    if (error) {
      throw new Error(error.message)
    }

    return {
      status: 1,
      error: '',
      data: {
        list: (data ?? []) as PetWeightRecord[],
      },
    }
  },

  /**
   * 添加体重记录(浏览器直连,RLS 兜底)
   * 供体检/就诊时手动录入体重
   */
  async addWeight(petId: string, tenantId: string, weight: number, note?: string) {
    const { data, error } = await supabase
      .from('pet_weights')
      .insert({
        pet_id: petId,
        tenant_id: tenantId,
        weight,
        note: note ?? null,
      })
      .select('*')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return { status: 1, error: '', data: data as PetWeightRecord }
  },
}
