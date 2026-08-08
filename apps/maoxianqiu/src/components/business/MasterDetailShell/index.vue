<script setup lang="ts">
defineOptions({
  name: 'BusinessMasterDetailShell',
})

withDefaults(defineProps<{
  masterWidth?: number
}>(), {
  masterWidth: 300,
})
</script>

<template>
  <div class="flex gap-4 h-full">
    <div class="border rounded-lg bg-card shrink-0 overflow-auto" :style="{ width: `${masterWidth}px` }">
      <slot name="master" />
    </div>
    <div class="flex-1 min-w-0 overflow-auto">
      <slot name="detail" />
    </div>
  </div>
</template>
