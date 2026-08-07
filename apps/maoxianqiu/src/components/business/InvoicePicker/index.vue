<script setup lang="ts">
/**
 * InvoicePicker — 发票搜索选择器
 * 替代手动输入发票 UUID,支持按发票号搜索
 */
import type { AcceptableValue } from 'reka-ui'
import apiBilling from '@/api/modules/billing'

defineOptions({
  name: 'BusinessInvoicePicker',
})

withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
}>(), {
  placeholder: '搜索选择发票',
  disabled: false,
})

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

interface InvoiceOption {
  label: string
  value: string
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<InvoiceOption[]>([])
const searchKeyword = ref('')

/**
 * 搜索发票(按发票号模糊匹配)
 */
async function searchInvoices(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    const res: any = await apiBilling.listInvoices({
      keyword: keyword.trim(),
      limit: 20,
    })
    const list = res?.data?.list ?? []
    options.value = list.map((inv: any) => ({
      label: `${inv.invoice_no ?? inv.id} — ¥${Number(inv.total_amount ?? 0).toFixed(2)} (${inv.status ?? ''})`,
      value: inv.id,
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
  timer = setTimeout(searchInvoices, 300, val)
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
