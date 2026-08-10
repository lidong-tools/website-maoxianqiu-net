<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- 复诊间隔快捷值与字段守卫使用单行表达式 */
/**
 * EncounterEditor — 高密度病历编辑区
 * 按医生书写顺序双列布局:主诉+现病史 / 体格检查+诊断 / 治疗方案+复诊。
 * 多行内容统一 FaTextarea;低频字段放入 FaCollapsible;支持 Ctrl/Cmd+S 保存。
 */
import type { EncounterFormState } from '../composables/useEncounterDraft'

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

/** 常见诊断快捷项,点击插入当前诊断输入框 */
const QUICK_DIAGNOSES = ['胃炎', '皮肤病', '耳炎', '猫瘟(FPV)', '犬细小(CPV)', '尿结石', '牙周病']

/** 问诊问题库,点击插入主诉输入框 */
const QUICK_COMPLAINTS = ['精神食欲', '呕吐腹泻', '咳嗽喷嚏', '皮肤瘙痒', '排尿异常', '跛行']

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

/** 全局 Ctrl/Cmd+S 保存(不侵入输入框内联行为) */
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    emit('save')
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="p-3 space-y-3">
    <div class="flex items-center justify-between">
      <div class="text-sm font-medium">
        就诊病历
        <span v-if="saving" class="text-xs text-muted-foreground ml-2">保存中…</span>
      </div>
      <div class="text-xs text-muted-foreground">
        快捷键 <span class="px-1 py-0.5 border rounded bg-muted">Ctrl+S</span> 保存
      </div>
    </div>

    <div class="gap-3 grid grid-cols-2 items-start">
      <!-- 主诉 -->
      <FaLabel label="主诉" class="col-span-1">
        <div class="mb-1 flex flex-wrap gap-1.5">
          <FaButton
            v-for="item in QUICK_COMPLAINTS"
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
        <div class="mb-1 flex flex-wrap gap-1.5">
          <FaButton
            v-for="item in QUICK_DIAGNOSES"
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
  </div>
</template>
