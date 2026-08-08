<script setup lang="ts">
defineOptions({
  name: 'BusinessFilterBar',
})

const emit = defineEmits<{
  search: []
  reset: []
}>()

const advanced = ref(false)
</script>

<template>
  <div class="px-4 py-3 border-b bg-card">
    <div class="flex flex-wrap gap-3 items-center">
      <div class="flex flex-1 flex-wrap gap-3 min-w-0 items-center">
        <slot />
      </div>
      <div class="flex gap-2 items-center">
        <slot name="actions" />
        <FaButton size="sm" @click="emit('search')">
          <FaIcon name="i-lucide:search" />
          查询
        </FaButton>
        <FaButton size="sm" variant="outline" @click="emit('reset')">
          重置
        </FaButton>
        <FaButton v-if="$slots.advanced" size="sm" variant="ghost" @click="advanced = !advanced">
          高级
          <FaIcon :name="advanced ? 'i-ep:caret-top' : 'i-ep:caret-bottom'" />
        </FaButton>
      </div>
    </div>
    <div v-if="$slots.advanced" v-show="advanced" class="mt-3 pt-3 border-t">
      <slot name="advanced" />
    </div>
  </div>
</template>
