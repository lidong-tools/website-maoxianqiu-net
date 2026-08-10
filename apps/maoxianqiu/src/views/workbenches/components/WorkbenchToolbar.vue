<script setup lang="ts">
/**
 * 工作台顶部工具栏:岗位选择 + 搜索(300ms 防抖由 useRoleWorkbench 处理)
 * + 状态数量筛选(FaTabs,数量来自服务端全量聚合)+ 总数与刷新。
 */
import type { WorkbenchRole } from '@/types/patient-journey'
import { WORKBENCH_ROLE_LABELS } from '@/types/patient-journey'
import { roleStatusLabel, WORKBENCH_STATUS_TABS } from '../composables/useRoleWorkbench'

const props = withDefaults(defineProps<{
  role: WorkbenchRole
  roleOptions: Array<{ value: WorkbenchRole, label: string }>
  roleDisabled?: boolean
  loading?: boolean
  counts?: Record<string, number>
  allCount?: number
  /** 当前筛选条件下的总条数(与分页 total 一致,用于"共 X 条"文案) */
  total?: number
  /** 当前状态筛选:'' 表示全部 */
  status?: string
  searchKeyword?: string
}>(), {
  roleDisabled: false,
  loading: false,
  counts: () => ({}),
  allCount: 0,
  total: 0,
  status: '',
  searchKeyword: '',
})

const emit = defineEmits<{
  'update:role': [value: WorkbenchRole]
  'update:status': [value: string]
  'update:searchKeyword': [value: string]
  'refresh': []
}>()

/** 岗位工作流固定的状态筛选 tab(全部 + 各状态数量) */
const statusTabs = computed(() => [
  { label: `全部 ${props.allCount}`, value: 'all' },
  ...WORKBENCH_STATUS_TABS[props.role].map(statusKey => ({
    label: `${roleStatusLabel(props.role, statusKey)} ${props.counts[statusKey] ?? 0}`,
    value: statusKey,
  })),
])

/** 将内部 '' 状态与 FaTabs 的 'all' 互转 */
const activeStatus = computed({
  get: () => props.status || 'all',
  set: (value: string) => emit('update:status', value === 'all' ? '' : value),
})

/** 当前岗位中文名(用于页头语义) */
const roleLabel = computed(() => WORKBENCH_ROLE_LABELS[props.role] ?? '岗位')
</script>

<template>
  <!-- 工具栏区:位于主工作区卡片内,与表格共用同一背景,底部用分隔线隔开 -->
  <div class="px-4 pt-3 border-b shrink-0">
    <div class="pb-3 flex flex-wrap gap-2 items-center">
      <FaSelect
        :model-value="props.role"
        :options="props.roleOptions"
        :disabled="props.roleDisabled"
        placeholder="暂无可用岗位"
        class="w-36"
        @update:model-value="emit('update:role', $event as WorkbenchRole)"
      />
      <FaInput
        :model-value="props.searchKeyword"
        placeholder="搜索宠物/主人/电话/队列号/单号"
        clearable
        class="w-64"
        @update:model-value="emit('update:searchKeyword', String($event ?? ''))"
      >
        <template #start>
          <FaIcon name="i-lucide:search" class="text-muted-foreground" />
        </template>
      </FaInput>
      <span class="text-sm text-muted-foreground shrink-0">
        {{ roleLabel }}工作台 · 共 {{ props.loading ? '…' : props.total }} 条待办
      </span>
      <FaButton variant="outline" size="sm" class="ml-auto" :loading="props.loading" @click="emit('refresh')">
        <FaIcon name="i-lucide:refresh-cw" />
        刷新
      </FaButton>
    </div>
    <div class="py-3 border-t">
      <FaTabs
        :model-value="activeStatus"
        :list="statusTabs"
        list-class="justify-start gap-1 w-fit"
        class="shrink-0"
        @update:model-value="activeStatus = String($event)"
      />
    </div>
  </div>
</template>
