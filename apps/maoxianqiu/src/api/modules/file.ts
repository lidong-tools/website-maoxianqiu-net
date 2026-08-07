import api from '../index'

/**
 * 文件 API 模块(MXQ-4001~4007)
 *
 * 设计原则:
 *   - 所有文件操作走 Hono Command + PostgreSQL RPC,禁止前端直连写 files/attachments
 *   - 上传流程: createUploadIntent → 前端直传 R2 → completeUpload
 *   - 下载流程: getDownloadUrl → 短期预签名 URL
 *   - 删除流程: archiveFile(软删除,延迟清理 R2 对象)
 *   - 私有医疗文件默认不公开,必须通过 getDownloadUrl 访问
 *
 * P0-03 说明:旧的 /upload + /files/delete (r2_files) 服务端接口已下线,本模块是新文件模型唯一入口。
 */
export default {
  /**
   * 创建上传意图(MXQ-4003)
   * 返回预签名上传 URL + 文件 id,前端直传 R2 后调用 completeUpload。
   */
  createUploadIntent(data: {
    tenantId: string
    storeId?: string
    category: string
    filename: string
    contentType: string
    sizeBytes: number
    entityType?: string
    entityId?: string
    purpose?: string
  }) {
    return api.post('files/upload-intents', data)
  },

  /**
   * 完成上传(MXQ-4004)
   * 服务端 HEAD 校验对象存在后标记 uploaded。
   */
  completeUpload(data: {
    fileId: string
    checksum?: string
    sizeBytes?: number
  }) {
    return api.post(`files/${data.fileId}/complete`, {
      checksum: data.checksum,
      sizeBytes: data.sizeBytes,
    })
  },

  /**
   * 获取下载 URL(MXQ-4005)
   * 权限校验并记录审计,返回短期预签名 URL。
   */
  getDownloadUrl(data: { fileId: string, filename?: string }) {
    return api.post(`files/${data.fileId}/download-url`, {
      filename: data.filename,
    })
  },

  /**
   * 归档文件(MXQ-4006)
   * 软删除,标记 archived_at,不立即删 R2 对象。
   */
  archiveFile(data: { fileId: string, reason?: string }) {
    return api.post(`files/${data.fileId}/archive`, {
      reason: data.reason,
    })
  },

  /**
   * 附件列表(浏览器直连,RLS 兜底)
   * 按实体查询关联文件。
   */
  async listAttachments(params: {
    tenantId?: string
    entityType: string
    entityId: string
    purpose?: string
  }) {
    // attachments 查询走 supabase 直连(RLS 兜底),详见 lib/supabase
    const { supabase } = await import('@/lib/supabase')
    let query = supabase
      .from('attachments')
      .select(`
        *,
        file:files(*)
      `)
      .eq('entity_type', params.entityType)
      .eq('entity_id', params.entityId)
    if (params.tenantId) {
      query = query.eq('tenant_id', params.tenantId)
    }
    if (params.purpose) {
      query = query.eq('purpose', params.purpose)
    }
    const { data, error } = await query.order('sort_order', { ascending: true })
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { list: data ?? [] } }
  },

  /**
   * 附件解绑(浏览器直连 delete,RLS 兜底)
   * 仅删除关联关系,不归档文件本身。
   */
  async removeAttachment(attachmentId: string) {
    const { supabase } = await import('@/lib/supabase')
    const { error } = await supabase
      .from('attachments')
      .delete()
      .eq('id', attachmentId)
    if (error) {
      throw new Error(error.message)
    }
    return { status: 1, error: '', data: { isSuccess: true } }
  },
}
