<script setup lang="ts">
/**
 * EmployeePicker — 员工搜索选择器
 * 替代手动输入员工 UUID,支持按姓名模糊搜索
 */
import type { AcceptableValue } from 'reka-ui'
import { supabase } from '@/lib/supabase'

defineOptions({
  name: 'BusinessEmployeePicker',
})

withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
}>(), {
  placeholder: '搜索选择员工',
  disabled: false,
})

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

interface EmployeeOption {
  label: string
  value: string
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<EmployeeOption[]>([])
const searchKeyword = ref('')

/**
 * 搜索员工(按姓名模糊匹配)
 */
async function searchEmployees(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('id, name, role')
      .ilike('name', `%${keyword.trim()}%`)
      .limit(20)

    if (error) {
      throw new Error(error.message)
    }
    options.value = (data ?? []).map((emp: any) => ({
      label: `${emp.name}${emp.role ? ` (${emp.role})` : ''}`,
      value: emp.id,
    }))
  }
  finally {
    loading.value = false
  }
}

function onChange(value: AcceptableValue | undefined) {
  emit('change', value)
}

// 防抖搜索(300ms)
let timer: ReturnType<typeof setTimeout> | null = null
watch(searchKeyword, (val) => {
  if (timer) {
    clearTimeout(timer)
  }
  timer = setTimeout(searchEmployees, 300, val)
})
</script>

<template>
  <FaSelect
    v-model="model"
    :options="options"
    :placeholder="placeholder"
    :disabled="disabled"
    :class="loading ? 'opacity-60' : ''"
    filterable
    remote
    :remote-method="searchKeyword = $event"
    @change="onChange"
  />
</template>
