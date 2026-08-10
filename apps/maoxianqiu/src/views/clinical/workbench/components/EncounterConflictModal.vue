<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- 冲突动作分发使用单行提前返回 */
/**
 * EncounterConflictModal — 标准化 409 乐观锁冲突处理
 * 三个动作:查看最新版本(丢弃本地)/复制我的未保存内容(载入最新+保留本地)/稍后处理。
 * 由页面编排层负责实际的数据加载与回填,组件仅承担交互展示。
 */
import type { EncounterRecord } from '@/types/clinical'

defineOptions({
  name: 'WorkbenchEncounterConflictModal',
})

defineProps<{
  visible: boolean
  /** 本地未保存内容摘要(供用户核对) */
  localDraft?: EncounterRecord | null
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'viewLatest': []
  'keepMine': []
  'later': []
}>()

/** 冲突处理动作 */
const ACTIONS = [
  { key: 'viewLatest', label: '查看最新版本', icon: 'i-lucide:refresh-cw', desc: '丢弃本地未保存内容,载入服务器最新版本' },
  { key: 'keepMine', label: '复制我的未保存内容', icon: 'i-lucide:clipboard-copy', desc: '载入最新版本并保留本地编辑,由你核对后重新保存' },
  { key: 'later', label: '稍后处理', icon: 'i-lucide:clock', desc: '暂不处理,保持当前编辑状态' },
] as const

function onAction(key: string) {
  if (key === 'viewLatest') { emit('viewLatest') }
  else if (key === 'keepMine') { emit('keepMine') }
  else { emit('later') }
}
</script>

<template>
  <FaModal
    :model-value="visible"
    title="病历已被其他人更新"
    :show-confirm-button="false"
    @update:model-value="emit('update:visible', $event)"
  >
    <p class="text-sm text-muted-foreground">
      该病历在其他窗口已被修改,直接保存将覆盖对方内容。请选择处理方式:
    </p>
    <div class="mt-4 space-y-2">
      <FaButton
        v-for="action in ACTIONS"
        :key="action.key"
        class="w-full justify-start"
        :variant="action.key === 'later' ? 'default' : 'outline'"
        @click="onAction(action.key)"
      >
        <FaIcon :name="action.icon" />
        {{ action.label }}
      </FaButton>
      <p v-if="localDraft" class="text-xs text-muted-foreground px-1 pt-1">
        你的本地草稿仍保留在编辑区,选择「复制我的未保存内容」后需要重新保存。
      </p>
    </div>
  </FaModal>
</template>
