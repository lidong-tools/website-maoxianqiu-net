<script setup lang="ts">
import type { AttachmentWithFile } from '@/types/file'
import apiFile from '@/api/modules/file'
import { FILE_CATEGORY_LABELS, FILE_STATUS_LABELS } from '@/types/file'

defineOptions({
  name: 'BusinessFilePreview',
})

/**
 * 文件预览列表组件(MXQ-4005)
 *
 * 功能:
 *   - 展示实体关联的附件列表
 *   - 图片类直接预览缩略图(私有文件需先取 downloadUrl)
 *   - 非图片类显示文件名 + 下载按钮
 *   - 下载走 getDownloadUrl RPC,记录审计
 */
const _props = withDefaults(defineProps<{
  /** 附件列表(含 file 详情) */
  attachments: AttachmentWithFile[]
  /** 是否只读(隐藏移除按钮) */
  readonly?: boolean
}>(), {
  readonly: false,
})

const emits = defineEmits<{
  removed: [attachmentId: string]
}>()

const loading = ref<string>('')

/**
 * 下载文件:调 getDownloadUrl 获取短期预签名 URL,然后打开
 */
async function onDownload(fileId: string, filename?: string) {
  loading.value = fileId
  try {
    const res: any = await apiFile.getDownloadUrl({ fileId, filename })
    const { downloadUrl } = res.data
    // 使用 a 标签触发下载(避免浏览器直接打开 PDF)
    const a = document.createElement('a')
    a.href = downloadUrl
    a.download = filename ?? ''
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
  catch (e: any) {
    useFaToast().error('下载失败', { description: e?.message })
  }
  finally {
    loading.value = ''
  }
}

/**
 * 判断是否为图片
 */
function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

/**
 * 移除附件
 */
async function onRemove(attachment: AttachmentWithFile) {
  if (!attachment.id) {
    return
  }
  useFaModal().confirm({
    title: '确认移除',
    content: `确认移除附件「${attachment.file?.original_name ?? ''}」吗？`,
    onConfirm: async () => {
      try {
        await apiFile.removeAttachment(attachment.id)
        emits('removed', attachment.id)
        useFaToast().success('已移除')
      }
      catch (e: any) {
        useFaToast().error('移除失败', { description: e?.message })
      }
    },
  })
}

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
</script>

<template>
  <div class="business-file-preview">
    <FaEmptyState v-if="attachments.length === 0" description="暂无附件" />
    <div v-else class="flex flex-col gap-2">
      <div
        v-for="attachment in attachments"
        :key="attachment.id"
        class="p-3 border rounded-lg flex gap-3 transition-colors items-center hover:bg-muted/50"
      >
        <!-- 图片缩略图 -->
        <div v-if="attachment.file && isImage(attachment.file.mime_type)" class="rounded bg-muted shrink-0 h-12 w-12 overflow-hidden">
          <img
            :src="`/api/files/${attachment.file.id}/thumbnail`"
            :alt="attachment.file.original_name"
            class="h-full w-full object-cover"
            @error="(e: any) => e.target.style.display = 'none'"
          >
        </div>
        <!-- 文件图标 -->
        <div v-else class="rounded bg-muted flex shrink-0 h-12 w-12 items-center justify-center">
          <FaIcon name="i-ri:file-3-line" class="text-xl text-muted-foreground" />
        </div>

        <!-- 文件信息 -->
        <div class="flex-1 min-w-0">
          <div class="font-medium truncate">
            {{ attachment.file?.original_name ?? '未知文件' }}
          </div>
          <div class="text-xs text-muted-foreground mt-0.5 flex gap-2 items-center">
            <span>{{ attachment.file ? formatSize(attachment.file.size_bytes) : '-' }}</span>
            <span v-if="attachment.file">·</span>
            <span v-if="attachment.file">{{ FILE_CATEGORY_LABELS[attachment.file.category] }}</span>
            <span v-if="attachment.file">·</span>
            <span v-if="attachment.file">{{ FILE_STATUS_LABELS[attachment.file.status] }}</span>
          </div>
        </div>

        <!-- 操作 -->
        <div class="flex shrink-0 gap-1 items-center">
          <FaButton
            variant="outline"
            size="icon-sm"
            :loading="loading === attachment.file?.id"
            :disabled="attachment.file?.status !== 'uploaded'"
            @click="onDownload(attachment.file!.id, attachment.file?.original_name)"
          >
            <FaIcon name="i-ri:download-line" />
          </FaButton>
          <FaButton
            v-if="!readonly"
            variant="outline"
            size="icon-sm"
            @click="onRemove(attachment)"
          >
            <FaIcon name="i-ri:delete-bin-line" />
          </FaButton>
        </div>
      </div>
    </div>
  </div>
</template>
