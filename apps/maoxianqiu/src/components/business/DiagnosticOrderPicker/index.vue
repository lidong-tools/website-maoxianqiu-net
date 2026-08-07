<script setup lang="ts">
/**
 * DiagnosticOrderPicker — 检验/疫苗申请搜索选择器
 * 替代手动输入诊断申请 UUID
 */
import type { AcceptableValue } from 'reka-ui'
import { supabase } from '@/lib/supabase'

defineOptions({
  name: 'BusinessDiagnosticOrderPicker',
})

const props = withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
  /** 类型过滤: lab / vaccination */
  orderType?: 'lab' | 'vaccination'
}>(), {
  placeholder: '搜索选择检验/疫苗申请',
  disabled: false,
  orderType: undefined,
})

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

interface OrderOption {
  label: string
  value: string
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<OrderOption[]>([])
const searchKeyword = ref('')

/**
 * 搜索检验/疫苗申请
 */
async function searchOrders(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    // 检验申请
    const labResults: OrderOption[] = []
    if (!props.orderType || props.orderType === 'lab') {
      const { data: labData, error: labError } = await supabase
        .from('lab_orders')
        .select('id, order_no, status')
        .neq('status', 'cancelled')
        .or(`order_no.ilike.%${keyword.trim()}%`)
        .order('created_at', { ascending: false })
        .limit(10)
      if (!labError) {
        for (const o of (labData ?? [])) {
          labResults.push({
            label: `[检验] ${o.order_no ?? o.id.slice(0, 8)} (${o.status ?? ''})`,
            value: o.id,
          } as OrderOption)
        }
      }
    }

    // 疫苗申请
    const vaccResults: OrderOption[] = []
    if (!props.orderType || props.orderType === 'vaccination') {
      const { data: vaccData, error: vaccError } = await supabase
        .from('vaccinations')
        .select('id, status')
        .neq('status', 'cancelled')
        .order('scheduled_date', { ascending: false })
        .limit(10)
      if (!vaccError) {
        for (const v of (vaccData ?? [])) {
          vaccResults.push({
            label: `[疫苗] ${v.id.slice(0, 8)} (${v.status ?? ''})`,
            value: v.id,
          } as OrderOption)
        }
      }
    }

    options.value = [...labResults, ...vaccResults]
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
  timer = setTimeout(searchOrders, 300, val)
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
