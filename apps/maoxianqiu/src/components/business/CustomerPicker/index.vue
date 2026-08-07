<script setup lang="ts">
/**
 * CustomerPicker — 客户搜索选择器
 * 替代手动输入顾客 UUID,支持按姓名/手机号/编号搜索
 */
import type { AcceptableValue } from 'reka-ui'
import apiCustomer from '@/api/modules/customer'

defineOptions({
  name: 'BusinessCustomerPicker',
})

withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
}>(), {
  placeholder: '搜索选择客户',
  disabled: false,
})

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

interface CustomerOption {
  label: string
  value: string
  detail?: string
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<CustomerOption[]>([])
const searchKeyword = ref('')

const displayOptions = computed(() => options.value)

/**
 * 搜索客户(按姓名/手机/编号模糊匹配)
 */
async function searchCustomers(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    const res: any = await apiCustomer.list({
      keyword: keyword.trim(),
      page: 1,
      pageSize: 20,
    })
    const list = res?.data?.list ?? []
    options.value = list.map((c: any) => ({
      label: `${c.name} (${c.phone ?? '无手机号'})`,
      value: c.id,
      detail: c.customer_no,
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
  timer = setTimeout(searchCustomers, 300, val)
})
</script>

<template>
  <FaSelect
    v-model="model"
    :options="displayOptions"
    :placeholder="placeholder"
    :disabled="disabled"
    :class="loading ? 'opacity-60' : ''"
    filterable
    remote
    :remote-method="searchKeyword = $event"
    @change="onChange"
  />
</template>
