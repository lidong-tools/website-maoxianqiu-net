<script setup lang="ts">
defineOptions({
  name: 'BusinessAuditTimeline',
})

defineProps<{
  items: { actor: string, at: string, action: string, before?: string, after?: string }[]
}>()
</script>

<template>
  <div>
    <div
      v-for="(it, i) in items"
      :key="i"
      class="pb-5 pl-5 border-l border-border relative last:pb-0 last:border-0"
    >
      <span
        class="border-2 border-background rounded-full bg-muted-foreground size-2 left-0 top-1 absolute -translate-x-1/2"
      />
      <div class="flex gap-3 items-baseline justify-between">
        <span class="text-sm font-medium">{{ it.action }}</span>
        <span class="text-xs text-muted-foreground shrink-0">{{ it.actor }} · {{ it.at }}</span>
      </div>
      <div v-if="it.before || it.after" class="text-xs text-muted-foreground mt-1">
        <template v-if="it.before">
          旧值：{{ it.before }}
        </template>
        <template v-if="it.before && it.after">
          →
        </template>
        <template v-if="it.after">
          新值：{{ it.after }}
        </template>
      </div>
    </div>
    <EmptyState v-if="!items.length" compact title="暂无审计记录" />
  </div>
</template>
