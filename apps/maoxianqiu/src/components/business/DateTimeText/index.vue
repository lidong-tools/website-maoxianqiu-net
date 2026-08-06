<script setup lang="ts">
import { formatDate, formatDateTime } from '@/utils/format'

defineOptions({
  name: 'BusinessDateTimeText',
})

withDefaults(defineProps<{
  value?: string | number | Date | null
  withTime?: boolean
}>(), {
  withTime: true,
})
</script>

<template>
  <span :class="!value ? 'text-muted-foreground' : ''">
    {{ withTime ? formatDateTime(value) : formatDate(value) }}
  </span>
</template>
