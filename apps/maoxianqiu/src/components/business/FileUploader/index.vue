<script setup lang="ts">
import type { FileItem } from '@fantastic-admin/components'
import type { AttachmentEntityType, AttachmentPurpose, FileCategory } from '@/types/file'
import apiFile from '@/api/modules/file'
import { ALLOWED_MIME_BY_CATEGORY, MAX_FILE_SIZE } from '@/types/file'

defineOptions({
  name: 'BusinessFileUploader',
})

/**
 * 业务文件上传组件(MXQ-4001~4007)
 *
 * 流程:
 *   1. 前端选择文件 → 校验 MIME/size
 *   2. 调 createUploadIntent 获取预签名 URL + fileId
 *   3. 前端直传 R2(PUT 预签名 URL)
 *   4. 调 completeUpload 让服务端 HEAD 校验并标记 uploaded
 *   5. 上传完成后通过 v-model 返回 attachment/file id 列表
 *
 * 安全:
 *   - 私有医疗文件默认走私有桶,仅通过 getDownloadUrl 访问
 *   - 禁止前端持有 R2 密钥,所有 URL 由后端预签名
 */
const props = withDefaults(defineProps<{
  /** 文件分类(决定桶、MIME、大小限制) */
  category: FileCategory
  /** 关联实体类型 */
  entityType?: AttachmentEntityType
  /** 关联实体 id */
  entityId?: string
  /** 附件用途 */
  purpose?: AttachmentPurpose
  /** 租户 id(默认从 tenant store 取) */
  tenantId?: string
  /** 门店 id(可选,门店级文件必填) */
  storeId?: string
  /** 最大文件数,0 表示不限 */
  max?: number
  /** 是否禁用 */
  disabled?: boolean
  /** 描述文案 */
  description?: string
}>(), {
  max: 0,
  disabled: false,
  description: '拖放或点击上传',
  purpose: 'attachment',
})

const emits = defineEmits<{
  /** 上传完成,返回 file id 与 attachment id(若绑定实体) */
  uploaded: [payload: { fileId: string, attachmentId?: string, fileItem: FileItem }]
  /** 上传失败 */
  error: [payload: { file: File, message: string }]
  /** 附件被移除 */
  removed: [attachmentId: string]
}>()

const appTenant = useAppTenantStore()
const tenantId = computed(() => props.tenantId ?? appTenant.currentTenantId)

const fileList = defineModel<FileItem[]>({
  default: () => [],
})

/**
 * 校验文件 MIME 与大小
 * @returns 错误信息,null 表示通过
 */
function validateFile(file: File): string | null {
  const mimeRegex = ALLOWED_MIME_BY_CATEGORY[props.category]
  if (!mimeRegex.test(file.type)) {
    return `文件类型 ${file.type || '未知'} 不允许`
  }
  const maxSize = MAX_FILE_SIZE[props.category]
  if (file.size > maxSize) {
    const maxMB = Math.round(maxSize / 1024 / 1024)
    return `文件大小超过 ${maxMB}MB 限制`
  }
  return null
}

/**
 * 自定义上传请求:走 createUploadIntent → PUT R2 → completeUpload
 */
async function httpRequest({ file, onProgress }: { file: File, onProgress: (pct: number) => void }) {
  // 1) 校验
  const validateError = validateFile(file)
  if (validateError) {
    emits('error', { file, message: validateError })
    throw new Error(validateError)
  }

  if (!tenantId.value) {
    const msg = '缺少租户上下文'
    emits('error', { file, message: msg })
    throw new Error(msg)
  }

  try {
    // 2) 创建上传意图
    onProgress(5)
    const intentRes: any = await apiFile.createUploadIntent({
      tenantId: tenantId.value,
      storeId: props.storeId,
      category: props.category,
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      entityType: props.entityType,
      entityId: props.entityId,
      purpose: props.purpose,
    })

    const { fileId, objectKey, uploadUrl, attachmentId } = intentRes.data
    onProgress(15)

    // 3) 前端直传 R2(PUT 预签名 URL)
    await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': file.type,
      },
    })
    onProgress(80)

    // 4) 完成上传(服务端 HEAD 校验)
    await apiFile.completeUpload({
      fileId,
      sizeBytes: file.size,
    })
    onProgress(100)

    // 5) 返回上传结果(供 afterUpload 取 url)
    emits('uploaded', { fileId, attachmentId, fileItem: { name: file.name, size: file.size, url: '' } })

    return {
      url: '', // 私有文件不返回直链,下载时走 getDownloadUrl
      name: file.name,
      fileId,
      attachmentId,
      objectKey,
    }
  }
  catch (e: any) {
    const message = e?.message ?? '上传失败'
    emits('error', { file, message })
    throw e
  }
}

/**
 * 移除附件
 */
async function onRemove(fileItem: FileItem, index: number) {
  const attachmentId = (fileItem as any).attachmentId
  if (attachmentId) {
    try {
      await apiFile.removeAttachment(attachmentId)
      emits('removed', attachmentId)
    }
    catch (e: any) {
      useFaToast().error('移除附件失败', { description: e?.message })
    }
  }
  fileList.value.splice(index, 1)
}

defineExpose({
  httpRequest,
  validateFile,
  onRemove,
})
</script>

<template>
  <div class="business-file-uploader">
    <FaFileUpload
      v-model="fileList"
      :http-request="httpRequest"
      :max="max"
      :disabled="disabled"
      :description="description"
      :show-file-list="true"
    >
      <template #tip>
        <div class="text-xs text-muted-foreground mt-1">
          允许类型:{{ category }};单文件最大 {{ Math.round(MAX_FILE_SIZE[category] / 1024 / 1024) }}MB
        </div>
      </template>
    </FaFileUpload>
  </div>
</template>
