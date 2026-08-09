import type {
  CreateInsurancePackInput,
  GeneratePackResult,
  InsurancePack,
  InsurancePackItem,
  InsurancePackWithItems,
  SignatureRequest,
} from '@/types/insurance'
import api from '../index'

/**
 * Stage-04 Agent-06 — 保险理赔包 API 模块
 * 全部 Command 走 Hono 路由(service_role + scoped 授权 + 审计 + 幂等)
 */

export default {
  /**
   * 创建理赔包(draft,服务端按白名单自动聚合合格材料)
   */
  createPack(input: CreateInsurancePackInput, idempotencyKey?: string) {
    return api.post<InsurancePackWithItems>('insurance/claim-packs', input, {
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    })
  },

  /**
   * 理赔包详情(含材料清单)
   */
  getPack(id: string) {
    return api.get<InsurancePackWithItems>(`insurance/claim-packs/${id}`)
  },

  /**
   * 更新材料清单(仅 draft 可编辑)
   */
  updatePackItems(id: string, items: InsurancePackItem[]) {
    return api.post<InsurancePackWithItems>(`insurance/claim-packs/${id}/items`, { items })
  },

  /**
   * 生成理赔材料 PDF(幂等 + 乐观并发)
   */
  generatePack(id: string, idempotencyKey?: string) {
    return api.post<GeneratePackResult>(`insurance/claim-packs/${id}/generate`, {}, {
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    })
  },

  /**
   * 导出历史(含归档 hash/version)
   */
  listExports(id: string) {
    return api.get<{ pack: InsurancePack, exports: Array<Record<string, unknown>> }>(
      `insurance/claim-packs/${id}/exports`,
    )
  },

  /**
   * 状态转换(draft/generated → archived/cancelled;generated → draft)
   */
  transitionPack(id: string, status: 'archived' | 'cancelled' | 'draft') {
    return api.post<InsurancePack>(`insurance/claim-packs/${id}/transition`, { status })
  },
}

export type { SignatureRequest }
