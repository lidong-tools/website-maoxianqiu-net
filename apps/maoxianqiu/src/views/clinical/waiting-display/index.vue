<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- 大屏轮询无门店时单行返回 */
import type { WorkbenchRow } from '@/types/patient-journey'
import apiJourney from '@/api/modules/patient-journey'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({ name: 'ClinicalWaitingDisplay' })

const tenantStore = useAppTenantStore()
const rows = ref<WorkbenchRow[]>([])
let timer: ReturnType<typeof setInterval> | undefined
let latestSequence = 0

const called = computed(() => rows.value.filter(row => row.status === 'called'))
const waiting = computed(() => rows.value.filter(row => row.status === 'waiting'))

/** 大屏只消费受限聚合接口，不暴露主人手机号、病历或费用信息。 */
async function load() {
  if (!tenantStore.currentStoreId) { return }
  try {
    rows.value = await apiJourney.getQueueDisplay(tenantStore.currentStoreId)
    const newest = called.value.reduce((result, row) => Number(row.call_sequence ?? 0) > Number(result.call_sequence ?? 0) ? row : result, {} as WorkbenchRow)
    const sequence = Number(newest.call_sequence ?? 0)
    if (sequence > latestSequence && latestSequence > 0 && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(`请 ${newest.queue_no ?? newest.queue_number ?? ''} 号，${newest.pet?.name ?? '宠物'}，到 ${newest.room_name ?? '诊室'} 就诊`))
    }
    latestSequence = Math.max(latestSequence, sequence)
  }
  catch {
    // 大屏短时断线时保留最后一次队列，下一轮自动恢复。
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, 5000)
})
onBeforeUnmount(() => timer && clearInterval(timer))
</script>

<template>
  <div class="text-white p-8 bg-slate-950 min-h-screen">
    <header class="pb-6 border-b border-white/20 flex items-end justify-between">
      <div>
        <h1 class="text-4xl font-bold">
          候诊叫号
        </h1><p class="text-slate-400 mt-2">
          请留意屏幕与语音提示
        </p>
      </div>
      <div class="text-2xl">
        {{ new Date().toLocaleDateString('zh-CN') }}
      </div>
    </header>
    <section class="mt-8 gap-6 grid grid-cols-1 lg:grid-cols-2">
      <div class="p-6 border border-emerald-400/30 rounded-2xl bg-emerald-500/15">
        <h2 class="text-2xl text-emerald-300">
          正在叫号
        </h2>
        <div v-for="row in called" :key="row.id" class="text-slate-950 mt-4 p-6 rounded-xl bg-emerald-400 flex items-center justify-between">
          <div>
            <div class="text-5xl font-black">
              {{ row.queue_no ?? row.queue_number }}
            </div><div class="text-2xl font-semibold mt-2">
              {{ row.pet?.name }}
            </div>
          </div>
          <div class="text-right">
            <div class="text-3xl font-bold">
              {{ row.room_name ?? '诊室' }}
            </div><div class="text-lg mt-2">
              {{ row.doctor_display_name ?? '' }}
            </div>
          </div>
        </div>
        <div v-if="!called.length" class="text-slate-400 py-16 text-center">
          请耐心候诊
        </div>
      </div>
      <div class="p-6 border border-white/10 rounded-2xl bg-white/5">
        <h2 class="text-2xl">
          候诊队列
        </h2>
        <div class="mt-4 gap-3 grid grid-cols-2">
          <div v-for="row in waiting" :key="row.id" class="p-4 rounded-lg bg-white/10 flex items-center justify-between">
            <span class="text-2xl font-bold">{{ row.queue_no ?? row.queue_number }}</span><span class="text-xl">{{ row.pet?.name }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
