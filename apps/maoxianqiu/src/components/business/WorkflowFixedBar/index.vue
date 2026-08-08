<script setup lang="ts">
defineOptions({
  name: 'BusinessWorkflowFixedBar',
})
</script>

<template>
  <FaFixedBar position="bottom" class="border-t">
    <div class="mx-auto flex flex-wrap gap-3 max-w-[1400px] w-full items-center justify-between">
      <div class="flex flex-wrap gap-4 items-center">
        <slot name="left" />
      </div>
      <div class="flex gap-2 items-center">
        <slot name="right" />
      </div>
    </div>
  </FaFixedBar>
</template>
