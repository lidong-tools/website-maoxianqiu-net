import type { Context } from 'hono'
import type { AppEnv } from '../../lib/types.js'
import process from 'node:process'

/**
 * Stage-04 Agent-06 — 电子签名 Provider 抽象(api/providers/signature)
 *
 * 重要合规边界:
 *   Stage03 P2 的"reliable e-signature provider"与内部签名不同。
 *   首版 provider=internal/manual,status 只能表达内部流程;
 *   UI/文案禁止宣称"已完成合法可靠电子签名",除非接入合规 Provider。
 *
 * Provider 接口:createRequest / getStatus / verifyWebhook / downloadArtifact。
 * 当前实现 internalProvider(人工/内部流程);合规 Provider 接入时在
 * 本目录新增实现,并在 getSignatureProvider() 中按 SIGNATURE_PROVIDER 选择。
 */

export interface SignatureCreateInput {
  tenantId: string
  storeId?: string | null
  archiveId: string
  signerName?: string
  signerEmail?: string
}

export interface SignatureProvider {
  readonly name: string
  /** 创建签名请求,返回 Provider 侧 request id */
  createRequest: (c: Context<AppEnv>, input: SignatureCreateInput) => Promise<{ providerRequestId: string }>
  /** 查询 Provider 侧状态(内部 Provider 直接返回本地状态) */
  getStatus: (c: Context<AppEnv>, providerRequestId: string) => Promise<{ status: string }>
  /** 校验 Provider webhook 签名(内部 Provider 无 webhook) */
  verifyWebhook: (c: Context<AppEnv>, rawBody: unknown) => Promise<{ valid: boolean }>
  /** 下载已签产物(内部 Provider 无独立产物,返回 null) */
  downloadArtifact: (c: Context<AppEnv>, providerRequestId: string) => Promise<{ bytes: Uint8Array, mimeType: string } | null>
}

/**
 * 内部/人工签名 Provider
 * 仅表达门店内部流程(如客户到店确认),不具备法律效力。
 */
const internalProvider: SignatureProvider = {
  name: 'internal',

  async createRequest(_c, input) {
    // 内部流程无外部请求,以本地 UUID 占位(由路由层生成后回写)
    return { providerRequestId: input.archiveId }
  },

  async getStatus() {
    return { status: 'created' }
  },

  async verifyWebhook() {
    return { valid: false }
  },

  async downloadArtifact() {
    return null
  },
}

/** 单一 Provider 实例缓存 */
let cachedProvider: SignatureProvider | null = null

export function getSignatureProvider(): SignatureProvider {
  if (cachedProvider) {
    return cachedProvider
  }
  const kind = (process.env.SIGNATURE_PROVIDER ?? 'internal').trim().toLowerCase()
  if (kind === 'internal') {
    cachedProvider = internalProvider
  }
  else {
    // 未接入合规 Provider 前一律使用 internal,并告警
    console.warn(`[signature] 未接入合规 Provider(SIGNATURE_PROVIDER=${kind}),使用 internal`)
    cachedProvider = internalProvider
  }
  return cachedProvider
}
