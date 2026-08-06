<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

defineOptions({
  name: 'BusinessPermissionButton',
})

const props = withDefaults(defineProps<{
  /** 权限码或权限码集合,为空视为有权限 */
  permission?: string | string[]
  /** hide=无权限不渲染; disable=无权限禁用 */
  mode?: Mode
  /** 业务条件禁用(与权限叠加) */
  disabled?: boolean
  /** 禁用原因,鼠标悬浮提示 */
  disabledReason?: string
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
  size?: 'lg' | 'sm' | 'default' | 'icon' | 'icon-sm' | 'icon-lg'
  loading?: boolean
  type?: 'button' | 'submit' | 'reset'
  class?: HTMLAttributes['class']
}>(), {
  mode: 'hide',
  disabled: false,
  variant: 'default',
  type: 'button',
})

type Mode = 'hide' | 'disable'

const { auth } = useAppAuth()
const hasPermission = computed(() => auth(props.permission ?? ''))
const realDisabled = computed(() => !hasPermission.value || props.disabled)
const reason = computed(() => props.disabledReason || (!hasPermission.value ? '暂无操作权限' : ''))
</script>

<template>
  <FaTooltip v-if="mode === 'disable'" :text="realDisabled ? reason : ''" :disabled="!realDisabled">
    <FaButton
      :variant
      :size
      :loading
      :type
      :disabled="realDisabled"
      :class="props.class"
    >
      <slot />
    </FaButton>
  </FaTooltip>
  <FaButton
    v-else-if="hasPermission"
    :variant
    :size
    :loading
    :type
    :disabled="props.disabled"
    :class="props.class"
  >
    <slot />
  </FaButton>
</template>
