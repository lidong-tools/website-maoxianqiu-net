<script setup lang="ts">
/**
 * DocumentPreviewPanel — 文档实时预览面板
 * 用 iframe srcdoc 隔离样式,按纸型设置宽度(右:实时文档预览)。
 */
import type { PaperSize } from '@/types/documents'

defineOptions({
  name: 'DocumentPreviewPanel',
})

defineProps<{
  html: string
  paperSize: PaperSize
  loading?: boolean
}>()

const PAPER_WIDTH: Record<PaperSize, string> = {
  A4: '210mm',
  '80mm': '80mm',
  '58mm': '58mm',
}
</script>

<template>
  <div
    class="mx-auto border border-gray-300 bg-white shadow overflow-auto"
    :style="{ width: PAPER_WIDTH[paperSize], maxHeight: '60vh' }"
  >
    <div v-if="loading" class="flex-center py-20 text-sm text-muted-foreground">
      正在渲染文档…
    </div>
    <iframe
      v-else-if="html"
      :srcdoc="html"
      class="w-full"
      sandbox=""
      style="height: 60vh; border: 0; background: #fff;"
    />
    <div v-else class="flex-center py-20 text-sm text-muted-foreground">
      请选择业务单据后预览文档
    </div>
  </div>
</template>
