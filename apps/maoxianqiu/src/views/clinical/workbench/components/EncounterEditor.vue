<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- 复诊间隔快捷值与字段守卫使用单行表达式 */
/**
 * EncounterEditor — 高密度病历编辑区
 * 按医生书写顺序双列布局:主诉+现病史 / 体格检查+诊断 / 治疗方案+复诊。
 * 多行内容统一 FaTextarea;低频字段放入 FaCollapsible;支持 Ctrl/Cmd+S 保存。
 *
 * 快捷项数据源(R-C1/R-C2):
 *   - 主诉快捷项 ← 问诊问题库(GET /catalog/intake-questions,is_active=true,按 sort_order)
 *   - 诊断快捷项 ← 诊断字典(GET /catalog/diagnosis-dict,is_active=true,取前 N 条)
 *   - 组件级内存缓存(按 tenantId 分 key),加载失败/空数据优雅降级为隐藏快捷区
 *
 * 插入检验结果(R-G2):
 *   - 按就诊宠物列出已发布(completed)检验单及结果项,勾选后引用到病历目标字段
 *   - 引用命令服务端落库 encounter_lab_result_refs,前端仅追加快照文本到表单
 */
import type { EncounterFormState } from '../composables/useEncounterDraft'
import type { AvailableLabResult, EncounterLabResultTargetField } from '@/types/clinical'
import type { DiagnosisDict, IntakeQuestion } from '@/types/catalog'
import apiCatalog from '@/api/modules/catalog'
import apiClinical from '@/api/modules/clinical'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'WorkbenchEncounterEditor',
})

const props = defineProps<{
  form: EncounterFormState
  readonly: boolean
  saving: boolean
}>()

const emit = defineEmits<{
  update: [field: keyof EncounterFormState, value: string]
  save: []
}>()

const tenantStore = useAppTenantStore()

/** 主诉快捷项(来自问诊问题库,仅问题文案) */
const intakeQuestions = ref<string[]>([])
/** 诊断快捷项(来自诊断字典,仅诊断名称) */
const quickDiagnoses = ref<string[]>([])
/** 快捷项组件级缓存:key = tenantId,避免同一租户下跨组件/重复挂载反复请求 */
const quickCache = new Map<string, { questions: string[], diagnoses: string[] }>()

/**
 * 加载问诊问题库与诊断字典快捷项(组件级缓存,失败/空数据优雅降级)
 * 挂载时与租户切换时调用;同一租户仅请求一次。
 */
async function loadQuickItems() {
  const tenantId = tenantStore.currentTenantId
  if (!tenantId) {
    intakeQuestions.value = []
    quickDiagnoses.value = []
    return
  }
  const cached = quickCache.get(tenantId)
  if (cached) {
    intakeQuestions.value = cached.questions
    quickDiagnoses.value = cached.diagnoses
    return
  }
  try {
    const [qRes, dRes] = await Promise.all([
      apiCatalog.listIntakeQuestions({ tenantId, isActive: true, pageSize: 50 }),
      apiCatalog.listDiagnosisDict({ tenantId, isActive: true, pageSize: 20 }),
    ])
    const questions = ((qRes.data?.list ?? []) as IntakeQuestion[])
      .map(it => it.question.trim())
      .filter(Boolean)
    const diagnoses = ((dRes.data?.list ?? []) as DiagnosisDict[])
      .map(it => it.name.trim())
      .filter(Boolean)
    quickCache.set(tenantId, { questions, diagnoses })
    intakeQuestions.value = questions
    quickDiagnoses.value = diagnoses
  }
  catch {
    // 加载失败:保留空数组,模板 v-if 隐藏快捷区(优雅降级,不影响病历编辑)
    intakeQuestions.value = []
    quickDiagnoses.value = []
  }
}

/** 复诊常用间隔 */
const QUICK_FOLLOWUPS = [
  { label: '3天', value: (() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 10) })() },
  { label: '7天', value: (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10) })() },
  { label: '14天', value: (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10) })() },
  { label: '30天', value: (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10) })() },
]

function onUpdate(field: keyof EncounterFormState, value: string | number | undefined) {
  emit('update', field, String(value ?? ''))
}

/** 快捷插入:在目标字段末尾追加内容(保留既有内容) */
function quickInsert(field: keyof EncounterFormState, text: string) {
  const current = props.form[field]
  const separator = current ? '；' : ''
  emit('update', field, `${current}${separator}${text}`)
}

// ===== 插入检验结果(R-G2) =====

/** 引用目标字段选项(默认现病史) */
const REF_TARGET_FIELD_OPTIONS: { label: string, value: EncounterLabResultTargetField }[] = [
  { label: '主诉', value: 'chiefComplaint' },
  { label: '现病史', value: 'historyPresent' },
  { label: '检查发现', value: 'examFindings' },
  { label: '诊断', value: 'diagnosisText' },
  { label: '治疗方案', value: 'treatmentPlan' },
]

/** 插入检验结果弹窗可见性 */
const refModalVisible = ref(false)
/** 可引用检验单加载中 */
const refLoading = ref(false)
/** 引用提交中 */
const refSubmitting = ref(false)
/** 可引用检验单列表(已发布,由服务端按就诊宠物收敛) */
const availableOrders = ref<AvailableLabResult[]>([])
/** 当前选中的检验单 id(同一时刻仅允许勾选一个检验单的结果项) */
const selectedOrderId = ref('')
/** 当前选中的结果项 id 列表(lab_order_analytes.id,即快照 sourceId) */
const selectedAnalyteIds = ref<string[]>([])
/** 引用目标字段 */
const refTargetField = ref<EncounterLabResultTargetField>('historyPresent')

/** 判断结果项是否已勾选 */
function isAnalyteSelected(sourceId: string) {
  return selectedAnalyteIds.value.includes(sourceId)
}

/**
 * 勾选/取消结果项(切换检验单时自动清空上一检验单的勾选)
 * @param orderId 检验单 id
 * @param sourceId 结果项 id(lab_order_analytes.id)
 * @param checked 是否勾选
 */
function toggleAnalyte(orderId: string, sourceId: string, checked: boolean) {
  if (checked) {
    if (selectedOrderId.value !== orderId) {
      selectedOrderId.value = orderId
      selectedAnalyteIds.value = []
    }
    if (!selectedAnalyteIds.value.includes(sourceId)) {
      selectedAnalyteIds.value.push(sourceId)
    }
  }
  else {
    selectedAnalyteIds.value = selectedAnalyteIds.value.filter(id => id !== sourceId)
    if (selectedAnalyteIds.value.length === 0) {
      selectedOrderId.value = ''
    }
  }
}

/**
 * 打开插入检验结果弹窗:按就诊宠物加载已发布检验单
 * 需要已有就诊(encounterId);加载失败提示但不阻断病历编辑。
 */
async function openLabResultRefModal() {
  if (!props.form.encounterId) {
    useFaToast().warning('请先选择患者开始接诊')
    return
  }
  refModalVisible.value = true
  refLoading.value = true
  availableOrders.value = []
  selectedOrderId.value = ''
  selectedAnalyteIds.value = []
  try {
    const res: any = await apiClinical.listAvailableLabResults(props.form.encounterId)
    availableOrders.value = res.data?.list ?? []
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载检验结果失败')
  }
  finally {
    refLoading.value = false
  }
}

/**
 * 确认引用:调用引用命令落库引用记录,并把返回的快照文本追加到目标字段
 * 成功后将引用记录同步到本地 form.labResultRefs 供展示(持久化已由命令完成)。
 */
async function onConfirmInsertRef() {
  if (!props.form.encounterId) {
    return
  }
  if (!selectedOrderId.value || selectedAnalyteIds.value.length === 0) {
    useFaToast().warning('请至少勾选一条检验结果')
    return
  }
  refSubmitting.value = true
  try {
    const res: any = await apiClinical.createEncounterLabResultRefs(props.form.encounterId, {
      labOrderId: selectedOrderId.value,
      sourceLabResultIds: selectedAnalyteIds.value,
      targetField: refTargetField.value,
    })
    const text = res.data?.text as string
    const refs = res.data?.refs ?? []
    // 快照文本追加到目标字段(与快捷插入同语义,触发父级草稿同步与自动保存)
    const current = props.form[refTargetField.value] ?? ''
    const separator = current ? '；' : ''
    emit('update', refTargetField.value, `${current}${separator}${text}`)
    // 本地引用关联展示(顶部插入最新引用;持久化已由引用命令落库)
    props.form.labResultRefs = [...refs, ...props.form.labResultRefs]
    refModalVisible.value = false
    useFaToast().success('已引用到病历')
  }
  catch (e: any) {
    useFaToast().error(e?.message || '引用检验结果失败')
  }
  finally {
    refSubmitting.value = false
  }
}

/** 全局 Ctrl/Cmd+S 保存(不侵入输入框内联行为) */
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    emit('save')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  loadQuickItems()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
// 租户切换后重新加载快捷项(组件级缓存保证同租户只请求一次)
watch(() => tenantStore.currentTenantId, loadQuickItems)
</script>

<template>
  <div class="p-3 space-y-3">
    <div class="flex items-center justify-between">
      <div class="text-sm font-medium">
        就诊病历
        <span v-if="saving" class="text-xs text-muted-foreground ml-2">保存中…</span>
      </div>
      <div class="flex gap-2 items-center">
        <FaButton size="sm" variant="outline" :disabled="readonly" @click="openLabResultRefModal">
          <FaIcon name="i-lucide:test-tubes" />
          插入检验结果
        </FaButton>
        <div class="text-xs text-muted-foreground">
          快捷键 <span class="px-1 py-0.5 border rounded bg-muted">Ctrl+S</span> 保存
        </div>
      </div>
    </div>

    <div class="gap-3 grid grid-cols-2 items-start">
      <!-- 主诉 -->
      <FaLabel label="主诉" class="col-span-1">
        <div v-if="intakeQuestions.length" class="mb-1 flex flex-wrap gap-1.5">
          <FaButton
            v-for="item in intakeQuestions"
            :key="item"
            size="sm"
            variant="ghost"
            :disabled="readonly"
            class="text-xs px-1.5 h-6"
            @click="quickInsert('chiefComplaint', item)"
          >
            {{ item }}
          </FaButton>
        </div>
        <FaInput :model-value="form.chiefComplaint" :disabled="readonly" placeholder="宠物主诉" class="w-full" @update:model-value="(v) => onUpdate('chiefComplaint', v)" />
      </FaLabel>

      <!-- 现病史 -->
      <FaLabel label="现病史" class="col-span-1">
        <FaTextarea :model-value="form.historyPresent" :disabled="readonly" :rows="3" placeholder="病史描述" class="w-full" @update:model-value="(v) => onUpdate('historyPresent', v)" />
      </FaLabel>

      <!-- 体格检查 -->
      <FaLabel label="体格检查" class="col-span-1">
        <FaTextarea :model-value="form.examFindings" :disabled="readonly" :rows="3" placeholder="体检发现" class="w-full" @update:model-value="(v) => onUpdate('examFindings', v)" />
      </FaLabel>

      <!-- 诊断 -->
      <FaLabel label="诊断" class="col-span-1">
        <div v-if="quickDiagnoses.length" class="mb-1 flex flex-wrap gap-1.5">
          <FaButton
            v-for="item in quickDiagnoses"
            :key="item"
            size="sm"
            variant="ghost"
            :disabled="readonly"
            class="text-xs px-1.5 h-6"
            @click="quickInsert('diagnosisText', item)"
          >
            {{ item }}
          </FaButton>
        </div>
        <FaInput :model-value="form.diagnosisText" :disabled="readonly" placeholder="诊断结论" class="w-full" @update:model-value="(v) => onUpdate('diagnosisText', v)" />
      </FaLabel>

      <!-- 治疗方案 -->
      <FaLabel label="治疗方案" class="col-span-2">
        <FaTextarea :model-value="form.treatmentPlan" :disabled="readonly" :rows="3" placeholder="治疗方案" class="w-full" @update:model-value="(v) => onUpdate('treatmentPlan', v)" />
      </FaLabel>

      <!-- 复诊日期 -->
      <FaLabel label="复诊日期" class="col-span-1">
        <div class="mb-1 flex flex-wrap gap-1.5">
          <FaButton
            v-for="item in QUICK_FOLLOWUPS"
            :key="item.label"
            size="sm"
            variant="ghost"
            :disabled="readonly"
            class="text-xs px-1.5 h-6"
            @click="onUpdate('followUpDate', item.value)"
          >
            {{ item.label }}
          </FaButton>
        </div>
        <FaInput :model-value="form.followUpDate" :disabled="readonly" type="date" class="w-full" @update:model-value="(v) => onUpdate('followUpDate', v)" />
      </FaLabel>
    </div>

    <!-- 低频字段折叠区 -->
    <FaCollapsible>
      <FaCollapsibleTrigger>
        <div class="text-xs text-muted-foreground flex gap-1 items-center">
          <FaIcon name="i-lucide:chevrons-up-down" class="size-3" />
          更多病历信息(诊断编码/护士等)
        </div>
      </FaCollapsibleTrigger>
      <FaCollapsibleContent class="mt-2">
        <div class="text-xs text-muted-foreground p-2 border rounded-md">
          诊断编码与责任护士字段在病历详情页维护,本页聚焦书写效率。
        </div>
      </FaCollapsibleContent>
    </FaCollapsible>

    <!-- 插入检验结果弹窗(R-G2:发布后医生可一键引用检验结果到病历) -->
    <FaModal
      v-model:visible="refModalVisible"
      title="插入检验结果"
      confirm-button-text="引用到病历"
      cancel-button-text="取消"
      :confirm-button-loading="refSubmitting"
      @confirm="onConfirmInsertRef"
    >
      <div v-loading="refLoading" class="space-y-3">
        <FaLabel label="目标字段">
          <FaSelect v-model="refTargetField" :options="REF_TARGET_FIELD_OPTIONS" class="w-full" />
        </FaLabel>
        <div class="text-xs text-muted-foreground">
          仅展示该宠物已发布(completed)的检验单,勾选结果项后点击引用。
        </div>
        <template v-if="availableOrders.length">
          <div v-for="order in availableOrders" :key="order.labOrder.id" class="border rounded-md p-2.5">
            <div class="flex gap-2 items-center justify-between">
              <span class="text-sm font-medium">{{ order.labOrder.order_no }}</span>
              <span v-if="order.labOrder.completed_at" class="text-xs text-muted-foreground">
                发布于 {{ new Date(order.labOrder.completed_at).toLocaleString('zh-CN') }}
              </span>
            </div>
            <div class="mt-1.5 space-y-1">
              <label
                v-for="a in order.analytes"
                :key="a.sourceId"
                class="flex gap-2 items-center text-xs cursor-pointer"
              >
                <FaCheckbox
                  :model-value="isAnalyteSelected(a.sourceId)"
                  :disabled="readonly"
                  @update:model-value="(v) => toggleAnalyte(order.labOrder.id, a.sourceId, v === true)"
                />
                <span>
                  {{ a.name }}: {{ a.resultValue }} {{ a.unit ?? '' }}
                  <span v-if="a.refRange">(参考 {{ a.refRange }})</span>
                  <span v-if="a.flag" class="text-amber-600">[{{ a.flag }}]</span>
                  <span v-if="a.isCritical" class="text-red-600">⚠</span>
                  <span v-else-if="a.isAbnormal" class="text-red-600">*</span>
                </span>
              </label>
            </div>
          </div>
        </template>
        <EmptyState v-else-if="!refLoading" compact title="暂无已发布的检验结果" description="该宠物尚未有已发布(completed)的检验结果" />
      </div>
    </FaModal>
  </div>
</template>
