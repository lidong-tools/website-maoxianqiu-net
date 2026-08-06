<script setup lang="ts">
import type { AcceptableValue } from 'reka-ui'
import apiStore from '@/api/modules/store'

defineOptions({
  name: 'BusinessStoreSelector',
})

const props = withDefaults(defineProps<{
  includeAll?: boolean
  allLabel?: string
  placeholder?: string
  disabled?: boolean
  clearable?: boolean
}>(), {
  includeAll: false,
  allLabel: '全部门店',
  placeholder: '请选择门店',
  disabled: false,
  clearable: false,
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

const displayOptions = computed(() => {
  if (!props.includeAll) {
    return options.value
  }
  return [{ label: props.allLabel, value: '' }, ...options.value]
})

async function load() {
  loading.value = true
  try {
    const res: any = await apiStore.list()
    const list = res?.data?.list ?? []
    options.value = list.map((store: any) => ({
      label: store.name ?? store.code ?? store.id,
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

onMounted(() => {
  load()
})
</script>

<template>
  <FaSelect
    v-model="model"
    :options="displayOptions"
    :placeholder="placeholder"
    :disabled="disabled"
    :class="loading ? 'opacity-60' : ''"
    @change="onChange"
  />
</template>
