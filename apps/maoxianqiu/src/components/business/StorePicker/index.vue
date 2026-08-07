<script setup lang="ts">
/**
 * StorePicker — 门店搜索选择器
 * 面向搜索选择场景,专注按门店名搜索返回 UUID
 * 注意:与 StoreSelector 不同,StorePicker 专注远程搜索选择,不预加载全部列表
 */
import type { AcceptableValue } from 'reka-ui'
import { supabase } from '@/lib/supabase'

defineOptions({
  name: 'BusinessStorePicker',
})

withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
}>(), {
  placeholder: '搜索选择门店',
  disabled: false,
})

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

interface StoreOption {
  label: string
  value: string
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<StoreOption[]>([])
const searchKeyword = ref('')

/**
 * 搜索门店(按名称模糊匹配)
 */
async function searchStores(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    const { data, error } = await supabase
      .from('stores')
      .select('id, name')
      .is('archived_at', null)
      .ilike('name', `%${keyword.trim()}%`)
      .limit(20)

    if (error) {
      throw new Error(error.message)
    }
    options.value = (data ?? []).map((store: any) => ({
      label: `${store.name} (门店)`,
      value: store.id,
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
  timer = setTimeout(searchStores, 300, val)
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
