<script setup lang="ts">
/**
 * PetPicker — 宠物搜索选择器
 * 替代手动输入宠物 UUID,支持按宠物名字搜索,可按客户过滤
 */
import type { AcceptableValue } from 'reka-ui'

defineOptions({
  name: 'BusinessPetPicker',
})

const props = withDefaults(defineProps<{
  customerId?: string
  placeholder?: string
  disabled?: boolean
}>(), {
  customerId: undefined,
  placeholder: '搜索选择宠物',
  disabled: false,
})

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

interface PetOption {
  label: string
  value: string
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<PetOption[]>([])
const searchKeyword = ref('')

watch(() => props.customerId, () => {
  // 客户变更时重新搜索
  if (searchKeyword.value) {
    searchPets(searchKeyword.value)
  }
})

/**
 * 搜索宠物(按名字模糊匹配,可按客户过滤)
 */
async function searchPets(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    const { supabase } = await import('@/lib/supabase')
    let query = supabase
      .from('pets')
      .select('id, name, species, breed, customer_id')
      .neq('status', 'archived')

    if (props.customerId) {
      query = query.eq('customer_id', props.customerId)
    }
    query = query.or(`name.ilike.%${keyword.trim()}%`).limit(20)

    const { data, error } = await query
    if (error) {
      throw new Error(error.message)
    }
    options.value = (data ?? []).map((p: any) => ({
      label: `${p.name} (${p.species ?? '未知物种'}${p.breed ? `·${p.breed}` : ''})`,
      value: p.id,
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
  timer = setTimeout(searchPets, 300, val)
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
