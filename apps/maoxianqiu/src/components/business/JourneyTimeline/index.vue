<script setup lang="ts">
import type { JourneyEvent } from '@/types/patient-journey'
import apiJourney from '@/api/modules/patient-journey'

const props = defineProps<{ encounterId: string }>()
const events = ref<JourneyEvent[]>([])
const loading = ref(false)

/** 显示专用患者旅程事件，不以通用审计日志替代业务时间线。 */
async function load() {
  loading.value = true
  try {
    events.value = await apiJourney.getTimeline(props.encounterId)
  }
  finally {
    loading.value = false
  }
}

watch(() => props.encounterId, load, { immediate: true })
</script>

<template>
  <div v-loading="loading" class="space-y-3">
    <div v-for="event in events" :key="event.id" class="pl-3 border-l-2 border-primary/30 relative">
      <span class="rounded-full bg-primary h-2 w-2 top-1.5 absolute -left-[5px]" />
      <div class="text-sm font-medium">
        {{ event.event_type }}
      </div>
      <div class="text-xs text-muted-foreground mt-1">
        {{ event.actor_name }} · {{ event.actor_role }} · {{ new Date(event.occurred_at).toLocaleString('zh-CN') }}
      </div>
      <div v-if="event.from_status || event.to_status" class="text-xs mt-1">
        {{ event.from_status ?? '开始' }} → {{ event.to_status ?? '完成' }}
      </div>
      <div v-if="event.reason" class="text-xs text-amber-700 mt-1">
        原因：{{ event.reason }}
      </div>
    </div>
    <div v-if="!loading && !events.length" class="text-xs text-muted-foreground py-4 text-center">
      暂无旅程事件
    </div>
  </div>
</template>
