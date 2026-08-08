<script setup lang="ts">
import type { ImportJob, StartResult } from '@/types/imports'
import { IMPORT_TYPE_LABELS } from '@/types/imports'

defineProps<{
  result: StartResult
  job: ImportJob
}>()

const emit = defineEmits<{ (e: 'viewErrors'): void }>()
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <FaIcon name="i-ri:checkbox-circle-fill" class="text-green-500 text-xl" />
      <span class="text-lg font-semibold">导入执行完成</span>
      <FaTag variant="default">
        已完成
      </FaTag>
    </div>

    <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
      <FaCard class="p-4">
        <div class="text-2xl font-bold text-green-600">{{ result.successRows }}</div>
        <div class="mt-1 text-sm text-gray-500">成功</div>
      </FaCard>
      <FaCard class="p-4">
        <div class="text-2xl font-bold text-amber-500">{{ result.skippedRows }}</div>
        <div class="mt-1 text-sm text-gray-500">跳过(重复)</div>
      </FaCard>
      <FaCard class="p-4">
        <div class="text-2xl font-bold text-red-500">{{ result.failedRows }}</div>
        <div class="mt-1 text-sm text-gray-500">失败</div>
      </FaCard>
      <FaCard class="p-4">
        <div class="text-2xl font-bold">{{ result.totalRows }}</div>
        <div class="mt-1 text-sm text-gray-500">总行数</div>
      </FaCard>
    </div>

    <div>
      <div class="mb-1 flex items-center justify-between text-sm">
        <span class="text-gray-500">成功率</span>
        <span class="font-medium">{{ result.totalRows ? Math.round((result.successRows / result.totalRows) * 100) : 0 }}%</span>
      </div>
      <FaProgress
        :model-value="result.totalRows ? Math.round((result.successRows / result.totalRows) * 100) : 0"
        :max="100"
      />
    </div>

    <div class="flex flex-wrap gap-2">
      <FaTag
        v-if="result.pendingOpeningCommands > 0"
        variant="secondary"
        class="text-blue-600"
      >
        库存期初命令 {{ result.pendingOpeningCommands }} 条待接入
      </FaTag>
      <FaTag
        v-if="result.pendingEmployeeInvites > 0"
        variant="secondary"
        class="text-blue-600"
      >
        员工待邀请 {{ result.pendingEmployeeInvites }} 条待接入
      </FaTag>
    </div>

    <div
      v-if="result.pendingOpeningCommands > 0 || result.pendingEmployeeInvites > 0"
      class="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700"
    >
      <div class="font-medium">跨域动作待集成</div>
      <div class="mt-1 text-blue-600/90">库存期初命令与员工邀请将在 S3.2 集成阶段由对应领域 Command 正式执行（见 S32-A-HANDOFF）。</div>
    </div>

    <div
      v-if="result.failedRows > 0"
      class="rounded-lg border border-red-200 bg-red-50 p-3"
    >
      <div class="mb-2 flex items-center justify-between">
        <span class="font-medium text-red-700">失败明细（前 {{ Math.min(result.failedSamples.length, 10) }} 条）</span>
        <FaButton variant="link" @click="emit('viewErrors')">
          查看全部
        </FaButton>
      </div>
      <div class="max-h-48 space-y-1 overflow-auto">
        <div
          v-for="(e, i) in result.failedSamples.slice(0, 10)"
          :key="i"
          class="rounded bg-white px-2 py-1 text-xs text-red-600"
        >
          第 {{ e.row_number }} 行：{{ e.message }}
        </div>
      </div>
    </div>

    <div class="mt-4 flex items-center justify-end gap-2 border-t pt-4">
      <span class="mr-auto text-sm text-gray-400">
        {{ IMPORT_TYPE_LABELS[job.type] }} · {{ job.total_rows }} 行
      </span>
    </div>
  </div>
</template>
