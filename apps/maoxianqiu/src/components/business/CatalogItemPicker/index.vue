<script setup lang="ts">
/**
 * CatalogItemPicker — 目录项目搜索选择器
 * 替代手动输入 catalog_item UUID
 */
import type { AcceptableValue } from 'reka-ui'

defineOptions({
  name: 'BusinessCatalogItemPicker',
})

const props = withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
  /** 按 billing_type 过滤(如 medicine/consultation) */
  billingType?: string
}>(), {
  placeholder: '搜索选择服务/药品',
  disabled: false,
  billingType: undefined,
})

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

interface ItemOption {
  label: string
  value: string
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<ItemOption[]>([])
const searchKeyword = ref('')

/**
 * 搜索目录项目
 */
async function searchItems(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    const { supabase } = await import('@/lib/supabase')
    let query = supabase
      .from('catalog_items')
      .select('id, name, default_price, billing_type, unit')
      .eq('is_active', true)
      .or(`name.ilike.%${keyword.trim()}%,code.ilike.%${keyword.trim()}%`)

    if (props.billingType) {
      query = query.eq('billing_type', props.billingType)
    }
    query = query.limit(20)

    const { data, error } = await query
    if (error) {
      throw new Error(error.message)
    }
    options.value = (data ?? []).map((item: any) => ({
      label: `${item.name} (¥${Number(item.default_price ?? 0).toFixed(2)}/${item.unit ?? '-'})`,
      value: item.id,
    }))
  }
  finally {
    loading.value = false
  }
}

function onChange(value: AcceptableValue | undefined) {
  emit('change', value)
}

// 防抖搜索
let timer: ReturnType<typeof setTimeout> | null = null
watch(searchKeyword, (val) => {
  if (timer) {
    clearTimeout(timer)
  }
  timer = setTimeout(searchItems, 300, val)
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
