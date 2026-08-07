<script setup lang="ts">
/**
 * DoctorPicker — 医生搜索选择器
 * 与 EmployeePicker 类似但仅筛选 role = 'doctor' 的员工
 */
import type { AcceptableValue } from 'reka-ui'
import { supabase } from '@/lib/supabase'

defineOptions({
  name: 'BusinessDoctorPicker',
})

withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
}>(), {
  placeholder: '搜索选择医生',
  disabled: false,
})

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

interface DoctorOption {
  label: string
  value: string
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<DoctorOption[]>([])
const searchKeyword = ref('')

/**
 * 搜索医生(按姓名模糊匹配,仅 role = 'doctor')
 */
async function searchDoctors(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('id, name, specialty')
      .eq('role', 'doctor')
      .ilike('name', `%${keyword.trim()}%`)
      .limit(20)

    if (error) {
      throw new Error(error.message)
    }
    options.value = (data ?? []).map((doc: any) => ({
      label: `${doc.name}${doc.specialty ? ` (${doc.specialty})` : ''}`,
      value: doc.id,
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
  timer = setTimeout(searchDoctors, 300, val)
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
