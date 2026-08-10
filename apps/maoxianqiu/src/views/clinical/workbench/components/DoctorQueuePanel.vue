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
}>()

const emit = defineEmits<{
  select: [row: DoctorQueueRow]
  call: [row: DoctorQueueRow]
  start: [row: DoctorQueueRow]
  openHistory: [id: string]
}>()

const { waitingText } = useDoctorQueue()

/** 队列是否为空 */
const empty = computed(() => !props.loading && props.rows.length === 0)

/** 按状态分段展示 */
const segments = computed(() => {
  const waiting = props.rows.filter(row => row.status === 'waiting' || row.status === 'checked_in' || row.status === 'triage')
  const called = props.rows.filter(row => row.status === 'called')
  const consulting = props.rows.filter(row => row.status === 'in_consultation')
  return [
    { key: 'waiting', title: '待叫号', rows: waiting },
    { key: 'called', title: '已叫号', rows: called },
    { key: 'consulting', title: '诊疗中', rows: consulting },
  ].filter(segment => segment.rows.length > 0 || props.rows.length === 0)
})

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
  <FaScrollArea class="flex-1 min-h-0">
    <div class="p-2 space-y-3">
      <!-- 候诊分段 -->
      <section v-for="segment in segments" :key="segment.key">
        <div class="text-xs text-muted-foreground font-medium px-1 py-1">
          {{ segment.title }}({{ segment.rows.length }})
        </div>
        <div class="space-y-1.5">
          <div
            v-for="row in segment.rows"
            :key="row.id"
            class="p-2.5 text-left border rounded-md w-full cursor-pointer transition hover:bg-muted/40"
            :class="activeQueueId === row.id ? 'border-primary bg-primary-50' : 'bg-card'"
            @click="onRowClick(row)"
          >
            <div class="flex gap-2 items-center justify-between">
              <span class="text-sm font-medium truncate">{{ row.pet?.name ?? '未知宠物' }}</span>
              <div class="flex shrink-0 gap-1 items-center">
                <span v-if="row.queue_no" class="text-xs text-muted-foreground">{{ row.queue_no }}</span>
                <EntityStatusTag
                  :label="QUEUE_STATUS_LABELS[row.status] ?? row.status"
                  :variant="QUEUE_STATUS_VARIANTS[row.status] ?? 'neutral'"
                  :dot="false"
                />
              </div>
            </div>
            <div class="text-xs text-muted-foreground mt-0.5 truncate">
              {{ row.customer?.name ?? '未知主人' }}
              <template v-if="row.customer?.phone">
                · {{ row.customer.phone }}
              </template>
            </div>
            <div class="text-xs text-muted-foreground mt-0.5 truncate">
              {{ row.appointment?.reason ?? '未填写原因' }}
              <template v-if="row.triage?.acuity && row.triage.acuity !== 'routine'">
                <span class="text-amber-600 ml-1">[{{ row.triage.acuity }}]</span>
              </template>
            </div>
            <div class="mt-1.5 flex gap-1.5 items-center justify-between">
              <span class="text-xs text-muted-foreground">{{ timeText(row) }}</span>
              <div class="flex gap-1.5">
                <FaButton v-if="row.primaryAction === 'call'" size="sm" variant="outline" @click.stop="emit('call', row)">
                  <FaIcon name="i-lucide:volume-2" />
                  叫号
                </FaButton>
                <FaButton v-if="row.primaryAction === 'start'" size="sm" @click.stop="emit('start', row)">
                  开始接诊
                </FaButton>
                <FaButton v-if="row.primaryAction === 'continue'" size="sm" variant="outline" @click.stop="emit('start', row)">
                  继续问诊
                </FaButton>
              </div>
            </div>
          </div>
        </div>
      </section>
      <EmptyState v-if="empty" compact title="当前队列无待诊患者" />
      <div v-if="loading" class="text-xs text-muted-foreground py-4 text-center">
        加载队列中…
      </div>
    </div>
  </FaScrollArea>
</template>
