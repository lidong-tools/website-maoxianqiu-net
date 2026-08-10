<script setup lang="ts">
/**
 * CatalogItemPicker — 目录项目搜索选择器
 * 替代手动输入 catalog_item UUID;change 事件返回受控业务 DTO
 * (id/name/unit/billingType/defaultPrice/effectivePrice/active),
 * 避免页面为回填名称/单位/价格再次直查 Supabase。
 * effectivePrice = 门店自定义价(custom_price)优先,无则回退 default_price。
 */
import type { AcceptableValue } from 'reka-ui'
import { useAppTenantStore } from '@/store/modules/app/tenant'

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
  change: [value: CatalogItemPicked | undefined]
}>()

/** 选择的目录项目业务 DTO */
export interface CatalogItemPicked {
  id: string
  name: string
  unit: string | null
  billingType: string
  defaultPrice: number
  effectivePrice: number
  active: boolean
}

interface ItemOption {
  label: string
  value: string
  /** 携带完整业务字段,change 时回传 */
  picked: CatalogItemPicked
}

const model = defineModel<string>({ default: '' })
const loading = ref(false)
const options = ref<ItemOption[]>([])
const searchKeyword = ref('')
const tenantStore = useAppTenantStore()

/**
 * 搜索目录项目(含门店自定义价格,effectivePrice = custom_price ?? default_price)。
 * 目录项目采用左连接:没有门店覆盖行的有效项目仍可选用,价格回退 default_price,
 * 避免内连接漏掉"门店未单独覆盖价格"的目录项。
 */
async function searchItems(keyword: string) {
  if (!keyword.trim()) {
    options.value = []
    return
  }
  loading.value = true
  try {
    const { supabase } = await import('@/lib/supabase')
    const storeId = tenantStore.currentStoreId
    let query = supabase
      .from('catalog_items')
      .select('id, name, default_price, billing_type, unit, is_active, store_items:store_catalog_items(custom_price, is_active, store_id)')
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
    // 命中当前门店覆盖行则取门店价,否则回退目录默认价(门店级下架仅对该门店生效)
    options.value = (data ?? []).map((item: any) => {
      const storeRow = storeId
        ? (item.store_items ?? []).find((row: any) => row.store_id === storeId)
        : undefined
      const effectivePrice = Number(storeRow?.custom_price ?? item.default_price ?? 0)
      const picked: CatalogItemPicked = {
        id: item.id,
        name: item.name,
        unit: item.unit ?? null,
        billingType: item.billing_type,
        defaultPrice: Number(item.default_price ?? 0),
        effectivePrice,
        active: storeRow ? storeRow.is_active !== false : item.is_active !== false,
      }
      return {
        label: `${item.name} (¥${effectivePrice.toFixed(2)}/${item.unit ?? '-'})`,
        value: item.id,
        picked,
      }
    })
  }
  catch {
    options.value = []
  }
  finally {
    loading.value = false
  }
}

function onChange(value: AcceptableValue | undefined) {
  const picked = options.value.find(opt => opt.value === value)?.picked
  emit('change', picked)
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
    :remote-method="onRemoteMethod"
    @change="onChange"
  />
</template>
