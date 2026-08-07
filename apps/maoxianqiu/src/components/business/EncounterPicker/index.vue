<script setup lang="ts">
/**
 * EncounterPicker — 就诊记录搜索选择器
 * 替代手动输入病历 UUID
 */
import type { AcceptableValue } from 'reka-ui'
import { supabase } from '@/lib/supabase'

defineOptions({
  name: 'BusinessEncounterPicker',
})

const props = withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
  /** 按 pet_id 过滤 */
  petId?: string
}>(), {
  placeholder: '搜索选择就诊记录',
  disabled: false,
  petId: undefined,
})

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

interface EncounterOption {
  label: string
  value: string
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<EncounterOption[]>([])
const searchKeyword = ref('')

/**
 * 搜索就诊记录(按客户名/宠物名/就诊编号模糊匹配)
 */
async function searchEncounters(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    let query = supabase
      .from('encounters')
      .select('id, encounter_no, encounter_date, status')
      .neq('status', 'cancelled')

    if (props.petId) {
      query = query.eq('pet_id', props.petId)
    }

    query = query
      .or(`encounter_no.ilike.%${keyword.trim()}%`)
      .order('encounter_date', { ascending: false })
      .limit(20)

    const { data, error } = await query
    if (error) {
      throw new Error(error.message)
    }
    options.value = (data ?? []).map((enc: any) => ({
      label: `${enc.encounter_no ?? enc.id.slice(0, 8)} — ${enc.encounter_date ?? ''} (${enc.status ?? ''})`,
      value: enc.id,
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

// 防抖搜索
let timer: ReturnType<typeof setTimeout> | null = null
watch(searchKeyword, (val) => {
  if (timer) {
    clearTimeout(timer)
  }
  timer = setTimeout(searchEncounters, 300, val)
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
