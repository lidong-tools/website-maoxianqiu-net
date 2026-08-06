<script setup lang="ts">
import { formatMoney } from '@/utils/format'

defineOptions({
  name: 'BusinessMoneyText',
})

withDefaults(defineProps<{
  value?: number | string | null
  currency?: string
  showSymbol?: boolean
}>(), {
  currency: '¥',
  showSymbol: true,
})
</script>

<template>
  <span :class="value === null || value === undefined || value === '' ? 'text-muted-foreground' : ''">
    {{ showSymbol ? formatMoney(value, currency) : formatMoney(value, '') }}
  </span>
</template>
