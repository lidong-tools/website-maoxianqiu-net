<script setup lang="ts">
defineOptions({
  name: 'BusinessPetSafetyBanner',
})

const props = defineProps<{
  allergies?: (string | null)[] | null
  riskTags?: (string | null)[] | null
  conditions?: (string | null)[] | null
  temperament?: string | null
  medicalNotes?: string | null
}>()

const items = computed(() => {
  const list: { text: string, tone: 'danger' | 'warning' | 'info' }[] = []
  ;(props.allergies ?? []).filter(Boolean).forEach(a => list.push({ text: `过敏：${a}`, tone: 'danger' }))
  ;(props.conditions ?? []).filter(Boolean).forEach(c => list.push({ text: `慢病：${c}`, tone: 'warning' }))
  ;(props.riskTags ?? []).filter(Boolean).forEach(r => list.push({ text: r as string, tone: 'warning' }))
  if (props.temperament) { list.push({ text: `性格：${props.temperament}`, tone: 'info' }) }
  if (props.medicalNotes) { list.push({ text: `备注：${props.medicalNotes}`, tone: 'info' }) }
  return list
})
</script>

<template>
  <div
    v-if="items.length"
    class="px-3 py-2 border border-amber-200 rounded-md bg-amber-50 flex flex-wrap gap-x-3 gap-y-1 items-center"
  >
    <FaIcon name="i-lucide:triangle-alert" class="text-amber-600 shrink-0 size-4" />
    <span
      v-for="(it, i) in items"
      :key="i"
      class="text-xs font-medium inline-flex gap-1 items-center"
      :class="{
        'text-red-600': it.tone === 'danger',
        'text-amber-700': it.tone === 'warning',
        'text-muted-foreground': it.tone === 'info',
      }"
    >
      <FaIcon
        :name="it.tone === 'danger' ? 'i-lucide:alert-circle' : it.tone === 'warning' ? 'i-lucide:alert-triangle' : 'i-lucide:info'"
        class="size-3.5"
      />
      {{ it.text }}
    </span>
  </div>
  <div v-else class="text-xs text-muted-foreground px-1 py-0.5">
    无已知风险
  </div>
</template>
