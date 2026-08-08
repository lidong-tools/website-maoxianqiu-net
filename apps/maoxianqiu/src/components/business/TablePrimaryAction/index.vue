<script setup lang="ts">
defineOptions({
  name: 'BusinessTablePrimaryAction',
})

const props = withDefaults(defineProps<{
  primaryLabel?: string
  primaryIcon?: string
  primaryDisabled?: boolean
  primaryLoading?: boolean
  more?: MoreItem[]
}>(), {
  more: () => [],
})

const emit = defineEmits<{
  primary: []
}>()

interface MoreItem {
  label: string
  icon?: string
  destructive?: boolean
  disabled?: boolean
  onClick?: () => void
}

const groups = computed(() => [
  props.more.map(it => ({
    label: it.label,
    icon: it.icon,
    variant: it.destructive ? ('destructive' as const) : undefined,
    disabled: it.disabled,
    handle: it.onClick,
  })),
])
</script>

<template>
  <div class="flex gap-1 items-center justify-end">
    <FaButton size="sm" :disabled="primaryDisabled" :loading="primaryLoading" @click="emit('primary')">
      <FaIcon v-if="primaryIcon" :name="primaryIcon" />
      {{ primaryLabel }}
    </FaButton>
    <FaDropdown v-if="more.length" :items="groups">
      <FaButton size="icon-sm" variant="ghost" aria-label="更多操作">
        <FaIcon name="i-lucide:ellipsis" />
      </FaButton>
    </FaDropdown>
  </div>
</template>
