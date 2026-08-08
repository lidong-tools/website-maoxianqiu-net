<script setup lang="ts">
/**
 * DocumentEntityPicker — 业务文档单据选择器
 * 按 documentType 选择业务单据,复用既有业务选择器;影像/出院/寄养走远程搜索。
 * S30-R06:禁止手填 UUID,一律通过选择器选取。
 */
import type { AcceptableValue } from 'reka-ui'
import { supabase } from '@/lib/supabase'
import type { DocumentType } from '@/types/documents'
import BusinessDiagnosticOrderPicker from '@/components/business/DiagnosticOrderPicker/index.vue'
import BusinessEncounterPicker from '@/components/business/EncounterPicker/index.vue'
import BusinessInvoicePicker from '@/components/business/InvoicePicker/index.vue'

defineOptions({
  name: 'DocumentEntityPicker',
})

const props = defineProps<{
  documentType: DocumentType
  placeholder?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  change: [value: AcceptableValue | undefined]
}>()

const model = defineModel<string>({ default: '' })

/** 需要远程搜索的类型 */
const REMOTE_PICKABLE: DocumentType[] = ['imaging_report', 'discharge_summary', 'boarding_handover']

const loading = ref(false)
const options = ref<Array<{ label: string, value: string }>>([])
const searchKeyword = ref('')

/**
 * 远程搜索:影像单/已出院住院记录/寄养单
 */
async function searchRemote(keyword: string) {
  loading.value = true
  options.value = []
  try {
    const kw = keyword.trim()
    if (props.documentType === 'imaging_report') {
      let q = supabase
        .from('imaging_orders')
        .select('id, order_no, imaging_type, status, pets(name)')
        .neq('status', 'cancelled')
      if (kw) {
        q = q.or(`order_no.ilike.%${kw}%`)
      }
      const { data } = await q.order('created_at', { ascending: false }).limit(10)
      options.value = (data ?? []).map((o: any) => ({
        label: `[影像] ${o.order_no ?? o.id.slice(0, 8)}${o.pets?.name ? ` · ${o.pets.name}` : ''} (${o.status ?? ''})`,
        value: o.id,
      }))
    }
    else if (props.documentType === 'discharge_summary') {
      let q = supabase
        .from('admissions')
        .select('id, status, admitted_at, pets(name)')
        .eq('status', 'discharged')
      if (kw) {
        q = q.or(`admission_reason.ilike.%${kw}%`)
      }
      const { data } = await q.order('admitted_at', { ascending: false }).limit(10)
      options.value = (data ?? []).map((a: any) => ({
        label: `[住院] ${a.pets?.name ?? a.id.slice(0, 8)} · 入院 ${a.admitted_at?.slice(0, 10) ?? ''} (${a.status ?? ''})`,
        value: a.id,
      }))
    }
    else if (props.documentType === 'boarding_handover') {
      let q = supabase
        .from('boarding_stays')
        .select('id, boarding_no, status, check_in_at, pets(name)')
      if (kw) {
        q = q.or(`boarding_no.ilike.%${kw}%`)
      }
      const { data } = await q.order('check_in_at', { ascending: false }).limit(10)
      options.value = (data ?? []).map((b: any) => ({
        label: `[寄养] ${b.boarding_no ?? b.id.slice(0, 8)}${b.pets?.name ? ` · ${b.pets.name}` : ''} (${b.status ?? ''})`,
        value: b.id,
      }))
    }
  }
  finally {
    loading.value = false
  }
}

function onChange(value: AcceptableValue | undefined) {
  emit('change', value)
}

function onRemoteMethod(keyword: string) {
  searchKeyword.value = keyword
}

let timer: ReturnType<typeof setTimeout> | null = null
watch(searchKeyword, (val) => {
  if (timer) {
    clearTimeout(timer)
  }
  timer = setTimeout(searchRemote, 300, val)
})

// 挂载后默认加载最近记录,便于快速选择
onMounted(() => {
  if (REMOTE_PICKABLE.includes(props.documentType)) {
    searchRemote('')
  }
})

watch(() => props.documentType, (val) => {
  model.value = ''
  options.value = []
  if (REMOTE_PICKABLE.includes(val)) {
    searchRemote('')
  }
})
</script>

<template>
  <!-- 既有选择器(收费单/就诊记录/检验/疫苗) -->
  <BusinessInvoicePicker
    v-if="documentType === 'invoice'"
    v-model="model"
    :placeholder="placeholder ?? '搜索选择收费单'"
    :disabled="disabled"
    @change="onChange"
  />
  <BusinessEncounterPicker
    v-else-if="documentType === 'prescription' || documentType === 'medical_record_summary'"
    v-model="model"
    :placeholder="placeholder ?? '搜索选择就诊记录'"
    :disabled="disabled"
    @change="onChange"
  />
  <BusinessDiagnosticOrderPicker
    v-else-if="documentType === 'lab_report'"
    v-model="model"
    order-type="lab"
    :placeholder="placeholder ?? '搜索选择检验申请'"
    :disabled="disabled"
    @change="onChange"
  />
  <BusinessDiagnosticOrderPicker
    v-else-if="documentType === 'vaccination_certificate'"
    v-model="model"
    order-type="vaccination"
    :placeholder="placeholder ?? '搜索选择疫苗记录'"
    :disabled="disabled"
    @change="onChange"
  />
  <!-- 远程搜索类型(影像/出院/寄养) -->
  <FaSelect
    v-else-if="REMOTE_PICKABLE.includes(documentType)"
    v-model="model"
    :options="options"
    :placeholder="placeholder ?? '搜索选择业务单据'"
    :disabled="disabled"
    :class="loading ? 'opacity-60' : ''"
    filterable
    remote
    :remote-method="onRemoteMethod"
    @change="onChange"
  />
  <FaInput
    v-else
    v-model="model"
    placeholder="该类型暂不支持选择业务单据"
    disabled
  />
</template>
