<script setup lang="ts">
/**
 * DoctorQueuePanel — 左侧候诊队列 + 当前宠物历史
 * 候诊列表直接消费 GET /workbenches/doctor 聚合 DTO,
 * 按状态分段:待叫号 / 已叫号 / 诊疗中,主动作由服务端推导。
 */
import type { DoctorQueueRow } from '@/types/patient-journey'
import { QUEUE_STATUS_LABELS, QUEUE_STATUS_VARIANTS, useDoctorQueue } from '../composables/useDoctorQueue'

defineOptions({
  name: 'WorkbenchDoctorQueuePanel',
})

const props = defineProps<{
  rows: DoctorQueueRow[]
  loading: boolean
  /** 当前选中患者对应队列 id,用于高亮 */
  activeQueueId?: string
  /** 最近就诊摘要(当前宠物历史) */
  recentEncounters?: Record<string, any>[]
  /** 横向模式:卡片横向排列,用于顶部候诊列表 */
  horizontal?: boolean
}>()

const emit = defineEmits<{
  select: [row: DoctorQueueRow]
  call: [row: DoctorQueueRow]
  start: [row: DoctorQueueRow]
  openHistory: [id: string]
}>()

const { waitingText } = useDoctorQueue()

/** 分诊分级中文名(与 PatientContextBar 保持一致) */
const ACUITY_LABELS: Record<string, string> = {
  routine: '常规',
  priority: '优先',
  urgent: '紧急',
  emergency: '危重',
}

/** 队列是否为空 */
const empty = computed(() => !props.loading && props.rows.length === 0)

/** 点击行:诊疗中继续 / 其他打开工作区 */
function onRowClick(row: DoctorQueueRow) {
  emit('select', row)
}

/** 时间显示:候诊记录用等待时长,预约用预约时间 */
function timeText(row: DoctorQueueRow) {
  if (row.checked_in_at || row.waiting_at) {
    return waitingText(row.waiting_at ?? row.checked_in_at)
  }
  if (row.appointment?.scheduled_start) {
    return new Date(row.appointment.scheduled_start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return ''
}
</script>

<template>
  <FaScrollArea :horizontal="horizontal" class="flex-1 min-h-0">
    <div class="p-2" :class="horizontal ? 'flex gap-1.5 items-start' : 'space-y-2'">
      <!-- 候诊卡片:所有状态患者混合展示,横向同一行 / 纵向列表 -->
      <div
        v-for="row in rows"
        :key="row.id"
        class="p-2 text-left border rounded-md cursor-pointer transition hover:bg-muted/40 flex gap-2"
        :class="[activeQueueId === row.id ? 'border-primary bg-primary-50' : 'bg-card', horizontal ? 'w-56 shrink-0' : 'w-full']"
        @click="onRowClick(row)"
      >
        <!-- 左列:患者信息 -->
        <div class="flex-1 min-w-0 flex flex-col justify-center">
          <!-- 行1:排队号 · 宠物名 -->
          <div class="text-sm font-medium truncate">
            <template v-if="row.queue_no">
              <span class="text-muted-foreground">{{ row.queue_no }}</span>
              ·
            </template>
            {{ row.pet?.name ?? '未知宠物' }}
          </div>
          <!-- 行2:主人 · 电话 -->
          <div class="text-xs text-muted-foreground truncate">
            {{ row.customer?.name ?? '未知主人' }}
            <template v-if="row.customer?.phone">
              · {{ row.customer.phone }}
            </template>
          </div>
          <!-- 行3:原因 -->
          <div class="text-xs text-muted-foreground truncate">
            {{ row.appointment?.reason ?? '未填写原因' }}
            <template v-if="row.triage?.acuity && row.triage.acuity !== 'routine'">
              <span class="text-amber-600 ml-0.5">[{{ ACUITY_LABELS[row.triage.acuity] ?? row.triage.acuity }}]</span>
            </template>
          </div>
          <!-- 行4:已等待时间(单独一行) -->
          <div class="text-xs text-muted-foreground">{{ timeText(row) }}</div>
        </div>
        <!-- 右列:就诊状态 tag + 操作按钮(同一列竖排) -->
        <div class="flex shrink-0 flex-col gap-1.5 items-stretch">
          <EntityStatusTag
            :label="QUEUE_STATUS_LABELS[row.status] ?? row.status"
            :variant="QUEUE_STATUS_VARIANTS[row.status] ?? 'neutral'"
            :dot="false"
            class="shrink-0 self-center"
          />
          <div v-if="row.primaryAction" class="flex flex-1 items-stretch">
            <FaButton v-if="row.primaryAction === 'call'" size="sm" variant="outline" class="h-auto w-16 px-0 text-xs flex-1" @click.stop="emit('call', row)">
              叫号
            </FaButton>
            <FaButton v-if="row.primaryAction === 'start'" size="sm" class="h-auto w-16 px-0 text-xs flex-1" @click.stop="emit('start', row)">
              开始接诊
            </FaButton>
            <FaButton v-if="row.primaryAction === 'continue'" size="sm" variant="outline" class="h-auto w-16 px-0 text-xs flex-1" @click.stop="emit('start', row)">
              继续问诊
            </FaButton>
          </div>
        </div>
      </div>
      <EmptyState v-if="empty" compact title="当前队列无待诊患者" class="shrink-0" />
      <div v-if="loading" class="text-xs text-muted-foreground py-4 text-center shrink-0">
        加载队列中…
      </div>
    </div>
  </FaScrollArea>
</template>
