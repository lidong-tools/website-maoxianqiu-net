<script setup lang="ts">
import type { AcceptableValue, SelectContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { useTextDirection } from '@vueuse/core'
import { computed, watch } from 'vue'
import { cn } from '#utils'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from './select'

interface Option {
  label: string
  value: AcceptableValue
  disabled?: boolean
}
interface GroupOption {
  label: string
  options: Option[]
}

// reka-ui SelectItem 不允许空字符串 value(会抛 "must have a value prop that is not an empty string")。
// 各业务页面用 value:'' 表示"全部/不限",渲染时映射为哨兵值,回写 v-model 时再还原为 ''。
const EMPTY_VALUE_SENTINEL = '\u0000__empty__\u0000'

/**
 * 渲染层值转换:空字符串 → 哨兵值(避免 SelectItem setup 抛错)。
 * @param v 原始值(可为数组,mulitple 模式)
 * @returns 转换后的值
 */
function toRenderValue(v: AcceptableValue | AcceptableValue[] | undefined): AcceptableValue | AcceptableValue[] | undefined {
  if (Array.isArray(v)) {
    return v.map(x => (x === '' ? EMPTY_VALUE_SENTINEL : x))
  }
  return v === '' ? EMPTY_VALUE_SENTINEL : v
}

/**
 * 模型层值还原:哨兵值 → 空字符串(保持对外 v-model 语义不变)。
 * @param v 渲染层值(可为数组)
 * @returns 还原后的值
 */
function toModelValue(v: AcceptableValue | AcceptableValue[] | undefined): AcceptableValue | AcceptableValue[] | undefined {
  if (Array.isArray(v)) {
    return v.map(x => (x === EMPTY_VALUE_SENTINEL ? '' : x))
  }
  return v === EMPTY_VALUE_SENTINEL ? '' : v
}

defineOptions({
  name: 'BuiltInSelect',
})

const props = defineProps<{
  multiple?: boolean
  disabled?: boolean
  position?: SelectContentProps['position']
  options: (Option | GroupOption)[]
  placeholder?: string
  class?: HTMLAttributes['class']
}>()

const emits = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

const value = defineModel<AcceptableValue>()

// 渲染层与模型层的桥接:SelectItem 的 value 使用哨兵值(非空),回写 v-model 时还原为原始值
const modelProxy = computed<AcceptableValue | AcceptableValue[] | undefined>({
  get() {
    return toRenderValue(value.value)
  },
  set(v) {
    value.value = toModelValue(v)
  },
})

const dir = useTextDirection({
  observe: true,
})

watch(value, (newValue) => {
  emits('change', newValue)
})

const selectedOption = computed({
  get() {
    // 处理普通选项和分组选项
    if (!props.options || props.options.length === 0) {
      return null
    }
    for (const option of props.options) {
      if (Object.hasOwn(option, 'options')) {
        // 分组选项
        const group = option as GroupOption
        const found = group.options.find(opt => opt.value === value.value)
        if (found) {
          return found
        }
      }
      else {
        // 普通选项
        const single = option as Option
        if (single.value === value.value) {
          return single
        }
      }
    }
    // 如果没有找到匹配项，返回第一个有效选项
    if (props.options.length > 0) {
      const firstOption = props.options[0]

      if (Object.hasOwn(firstOption, 'options')) {
        const group = firstOption as GroupOption
        return group.options && group.options.length > 0 ? group.options[0] : null
      }
      else {
        return firstOption as Option
      }
    }
    return null
  },
  set(val) {
    value.value = val?.value || null
  },
})
</script>

<template>
  <Select v-model="modelProxy" :multiple :disabled :dir="dir === 'ltr' ? 'ltr' : 'rtl'">
    <SelectTrigger :class="cn('w-[200px]', props.class)">
      <SelectValue :placeholder="props.placeholder" :selected-option="selectedOption?.label" />
    </SelectTrigger>
    <SelectContent :position class="z-2000">
      <template v-for="option in props.options" :key="option.label">
        <SelectGroup v-if="option.hasOwnProperty('options')">
          <SelectLabel>{{ option.label }}</SelectLabel>
          <SelectItem
            v-for="(item, index) in (option as GroupOption).options"
            :key="index"
            :value="toRenderValue(item.value) ?? EMPTY_VALUE_SENTINEL"
            :disabled="item.disabled"
          >
            {{ item.label }}
          </SelectItem>
        </SelectGroup>
        <SelectItem
          v-else
          :value="toRenderValue((option as Option).value) ?? EMPTY_VALUE_SENTINEL"
          :disabled="(option as Option).disabled"
        >
          {{ option.label }}
        </SelectItem>
      </template>
    </SelectContent>
  </Select>
</template>
