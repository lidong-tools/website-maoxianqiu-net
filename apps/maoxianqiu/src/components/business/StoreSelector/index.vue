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
  /**
   * 门店数据范围(P0-07):
   * - context(默认):当前用户真实工作上下文授权的门店(员工被分配/tenant-wide 角色可见)
   * - all:租户全部门店(平台/门店管理场景,浏览器直连)
   */
  scope?: 'context' | 'all'
}>(), {
  includeAll: false,
  allLabel: '全部门店',
  placeholder: '请选择门店',
  disabled: false,
  clearable: false,
  scope: 'context',
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
    // P0-07:默认只展示当前用户授权工作上下文的门店,避免员工选到未授权门店
    if (props.scope === 'context') {
      const appTenantStore = useAppTenantStore()
      const currentTenant = appTenantStore.context?.tenants.find(
        t => t.id === appTenantStore.currentTenantId,
      )
      const stores = currentTenant?.stores
        ?? appTenantStore.context?.tenants.flatMap(t => t.stores)
        ?? []
      options.value = stores.map(s => ({
        label: s.name ?? s.code ?? s.id,
        value: s.id,
      }))
      return
    }
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
