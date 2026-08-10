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
    <div class="flex gap-2 items-center">
      <FaIcon name="i-ri:checkbox-circle-fill" class="text-xl text-green-500" />
      <span class="text-lg font-semibold">导入执行完成</span>
      <FaTag variant="default">
        已完成
      </FaTag>
    </div>

    <div class="gap-4 grid grid-cols-2 md:grid-cols-4">
      <FaCard class="p-4">
        <div class="text-2xl text-green-600 font-bold">
          {{ result.successRows }}
        </div>
        <div class="text-sm text-gray-500 mt-1">
          成功
        </div>
      </FaCard>
      <FaCard class="p-4">
        <div class="text-2xl text-amber-500 font-bold">
          {{ result.skippedRows }}
        </div>
        <div class="text-sm text-gray-500 mt-1">
          跳过(重复)
        </div>
      </FaCard>
      <FaCard class="p-4">
        <div class="text-2xl text-red-500 font-bold">
          {{ result.failedRows }}
        </div>
        <div class="text-sm text-gray-500 mt-1">
          失败
        </div>
      </FaCard>
      <FaCard class="p-4">
        <div class="text-2xl font-bold">
          {{ result.totalRows }}
        </div>
        <div class="text-sm text-gray-500 mt-1">
          总行数
        </div>
      </FaCard>
    </div>

    <div>
      <div class="text-sm mb-1 flex items-center justify-between">
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
      class="text-sm text-blue-700 px-4 py-3 border border-blue-200 rounded-lg bg-blue-50"
    >
      <div class="font-medium">
        跨域动作待集成
      </div>
      <div class="text-blue-600/90 mt-1">
        库存期初命令与员工邀请将在 S3.2 集成阶段由对应领域 Command 正式执行（见 S32-A-HANDOFF）。
      </div>
    </div>

    <div
      v-if="result.failedRows > 0"
      class="p-3 border border-red-200 rounded-lg bg-red-50"
    >
      <div class="mb-2 flex items-center justify-between">
        <span class="text-red-700 font-medium">失败明细（前 {{ Math.min(result.failedSamples.length, 10) }} 条）</span>
        <FaButton variant="link" @click="emit('viewErrors')">
          查看全部
        </FaButton>
      </div>
      <div class="max-h-48 overflow-auto space-y-1">
        <div
          v-for="(e, i) in result.failedSamples.slice(0, 10)"
          :key="i"
          class="text-xs text-red-600 px-2 py-1 rounded bg-white"
        >
          第 {{ e.row_number }} 行：{{ e.message }}
        </div>
      </div>
    </div>

    <div class="mt-4 pt-4 border-t flex gap-2 items-center justify-end">
      <span class="text-sm text-gray-400 mr-auto">
        {{ IMPORT_TYPE_LABELS[job.type] }} · {{ job.total_rows }} 行
      </span>
    </div>
  </div>
</template>
