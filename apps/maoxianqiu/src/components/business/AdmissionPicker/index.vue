<script setup lang="ts">
/**
 * AdmissionPicker — 住院记录搜索选择器
 * 支持按 admission_no 或关联宠物名模糊搜索
 */
import type { AcceptableValue } from 'reka-ui'
import { supabase } from '@/lib/supabase'
import { ADMISSION_STATUS_LABELS } from '@/types/inpatient'

defineOptions({
  name: 'BusinessAdmissionPicker',
})

withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
}>(), {
  placeholder: '搜索选择住院记录',
  disabled: false,
})

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

interface AdmissionOption {
  label: string
  value: string
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<AdmissionOption[]>([])
const searchKeyword = ref('')

/**
 * 搜索住院记录(按 admission_no 或关联宠物名模糊匹配)
 */
async function searchAdmissions(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    const trimmed = keyword.trim()

    // 先搜索匹配的宠物,获取宠物 ID 列表
    const { data: matchedPets } = await supabase
      .from('pets')
      .select('id')
      .ilike('name', `%${trimmed}%`)

    const petIds = (matchedPets ?? []).map((p: any) => p.id)

    // 构建 OR 条件:admission_no 模糊匹配 OR pet_id 在匹配列表中
    const orConditions: string[] = []
    orConditions.push(`admission_no.ilike.%${trimmed}%`)
    if (petIds.length > 0) {
      orConditions.push(`pet_id.in.(${petIds.join(',')})`)
    }

    const { data, error } = await supabase
      .from('admissions')
      .select('id, admission_no, status, pet:pets(name)')
      .or(orConditions.join(','))
      .limit(20)

    if (error) {
      throw new Error(error.message)
    }
    options.value = (data ?? []).map((adm: any) => ({
      label: `${adm.admission_no ?? adm.id.slice(0, 8)} ${(adm.pet as any)?.name ?? ''} (${ADMISSION_STATUS_LABELS[adm.status as keyof typeof ADMISSION_STATUS_LABELS] ?? adm.status})`,
      value: adm.id,
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
  timer = setTimeout(searchAdmissions, 300, val)
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
