<script setup lang="ts">
/**
 * AdmissionPicker — 住院记录搜索选择器
 * 按关联宠物名模糊搜索;可选按住院状态过滤(如仅 admitted)
 */
import type { AcceptableValue } from 'reka-ui'
import { supabase } from '@/lib/supabase'
import { ADMISSION_STATUS_LABELS } from '@/types/inpatient'

defineOptions({
  name: 'BusinessAdmissionPicker',
})

const props = withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
  /** 仅列出指定状态的住院记录(如 admitted),为空则不限状态 */
  status?: string
}>(), {
  placeholder: '搜索选择住院记录',
  disabled: false,
  status: '',
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
 * 搜索住院记录(按关联宠物名模糊匹配)
 * 注意:admissions 表无 admission_no 列,只能按宠物名/宠物 ID 匹配
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

    // 无匹配宠物则直接返回空列表(避免对不存在的列构造 OR 条件导致 400)
    if (petIds.length === 0) {
      options.value = []
      return
    }

    let query = supabase
      .from('admissions')
      .select('id, admitted_at, status, pet:pets(name)')
      .in('pet_id', petIds)
    // 指定状态时才过滤(为空不限状态,避免空值 eq 导致无结果)
    if (props.status) {
      query = query.eq('status', props.status)
    }
    const { data, error } = await query.limit(20)

    if (error) {
      throw new Error(error.message)
    }
    options.value = (data ?? []).map((adm: any) => ({
      label: `${(adm.pet as any)?.name ?? ''} · ${adm.admitted_at ? new Date(adm.admitted_at).toLocaleDateString('zh-CN') : ''} (${ADMISSION_STATUS_LABELS[adm.status as keyof typeof ADMISSION_STATUS_LABELS] ?? adm.status})`,
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
