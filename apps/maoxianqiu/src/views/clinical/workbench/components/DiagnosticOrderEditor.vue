<script setup lang="ts">
/**
 * DiagnosticOrderEditor — 检验/影像快速申请编辑器
 * 检验:目录项目 + 样本/备注 + 临床问题;影像:目录项目 + 影像类型 + 临床问题。
 * 提交走 createLabOrder / createImagingOrder(服务端同步收费与下游岗位任务)。
 */
import type { ImagingDraft, LabDraft } from '../composables/useClinicalPlanDraft'
import type { CatalogItemPicked } from '@/components/business/CatalogItemPicker/index.vue'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'

defineOptions({
  name: 'WorkbenchDiagnosticOrderEditor',
})

defineProps<{
  mode: 'lab' | 'imaging'
  draft: LabDraft | ImagingDraft
  submitting: boolean
  readonly: boolean
}>()

const emit = defineEmits<{
  update: [field: string, value: unknown]
  submit: []
}>()

/** 影像类型选项 */
const IMAGING_TYPE_OPTIONS = [
  { label: '超声', value: 'ultrasound' },
  { label: 'X线', value: 'xray' },
  { label: 'CR', value: 'cr' },
  { label: 'CT', value: 'ct' },
  { label: 'MRI', value: 'mri' },
  { label: '其他', value: 'other' },
]

/** 选中目录项目后回填 id(名称/单位由服务端按目录解析) */
function onPickItem(picked?: CatalogItemPicked) {
  emit('update', 'catalogItemId', picked?.id ?? '')
}
</script>

<template>
  <div class="p-2 border rounded-md space-y-2">
    <FaLabel label="检查项目">
      <BusinessCatalogItemPicker
        :model-value="draft.catalogItemId"
        billing-type="exam"
        :placeholder="mode === 'lab' ? '搜索检验项目' : '搜索影像检查'"
        :disabled="readonly"
        class="w-full"
        @update:model-value="(v) => emit('update', 'catalogItemId', v)"
        @change="onPickItem"
      />
    </FaLabel>

    <template v-if="mode === 'imaging'">
      <FaLabel label="影像类型">
        <FaSelect
          :model-value="(draft as ImagingDraft).imagingType"
          :options="IMAGING_TYPE_OPTIONS"
          :disabled="readonly"
          class="w-full"
          @update:model-value="(v) => emit('update', 'imagingType', v)"
        />
      </FaLabel>
      <FaLabel label="临床问题">
        <FaTextarea :model-value="(draft as ImagingDraft).clinicalQuestion" :disabled="readonly" :rows="2" placeholder="请描述检查目的/临床问题" class="w-full" @update:model-value="(v) => emit('update', 'clinicalQuestion', v)" />
      </FaLabel>
    </template>
    <template v-else>
      <FaLabel label="临床问题">
        <FaTextarea :model-value="(draft as LabDraft).clinicalQuestion" :disabled="readonly" :rows="2" placeholder="请描述检验目的/临床问题" class="w-full" @update:model-value="(v) => emit('update', 'clinicalQuestion', v)" />
      </FaLabel>
      <FaLabel label="样本/备注">
        <FaTextarea :model-value="(draft as LabDraft).remark" :disabled="readonly" :rows="2" placeholder="样本要求或备注(可选)" class="w-full" @update:model-value="(v) => emit('update', 'remark', v)" />
      </FaLabel>
    </template>

    <div class="flex justify-end">
      <FaButton size="sm" :disabled="readonly" :loading="submitting" @click="emit('submit')">
        <FaIcon name="i-lucide:send" />
        {{ mode === 'lab' ? '创建检验申请' : '创建影像申请' }}
      </FaButton>
    </div>
  </div>
</template>
