<script setup lang="ts">
/**
 * EmployeePicker — 员工搜索选择器
 * 替代手动输入员工 UUID,支持按姓名模糊搜索
 *
 * S30-R04:valueKey 控制返回值语义,杜绝 employees.id / auth.users.id 混用:
 *   - 'id'     (默认):返回 employees.id(员工档案 id)—— 用于 admissions.doctor_id 等存 employees.id 的字段
 *   - 'user_id':返回 employees.user_id(auth.users.id 登录用户 id)—— 用于 nurse_tasks.assigned_to、
 *     shift_handovers.outgoing_user/incoming_user、encounters.doctor_id 等存 auth.users.id 的字段
 */
import type { AcceptableValue } from 'reka-ui'
import { supabase } from '@/lib/supabase'

defineOptions({
  name: 'BusinessEmployeePicker',
})

const props = withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
  /** 返回值语义:'id'=employees.id(默认);'user_id'=employees.user_id(auth.users.id) */
  valueKey?: 'id' | 'user_id'
}>(), {
  placeholder: '搜索选择员工',
  disabled: false,
  valueKey: 'id',
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
 * 按 valueKey 返回 employees.id 或 employees.user_id(auth.users.id)
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
      .select('id, user_id, name, role')
      .ilike('name', `%${keyword.trim()}%`)
      .limit(20)

    if (error) {
      throw new Error(error.message)
    }
    options.value = (data ?? []).map((emp: any) => ({
      label: `${emp.name}${emp.role ? ` (${emp.role})` : ''}`,
      value: props.valueKey === 'user_id' ? emp.user_id : emp.id,
    }))
  }
  finally {
    loading.value = false
  }
}

function onChange(value: AcceptableValue | undefined) {
  emit('change', value)
}

/**
 * 远程搜索回调(接收 FaSelect 输入的搜索关键字)
 */
function onRemoteMethod(keyword: string) {
  searchKeyword.value = keyword
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
    :remote-method="onRemoteMethod"
    @change="onChange"
  />
</template>
