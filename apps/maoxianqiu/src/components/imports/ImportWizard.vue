<script setup lang="ts">
import type { FileItem } from '@fantastic-admin/components'
import type {
  DuplicateStrategy,
  ImportErrorRow,
  ImportJob,
  ImportJobType,
  ImportRowPreview,
  StartResult,
  ValidateResult,
} from '@/types/imports'
import {
  DUPLICATE_STRATEGY_LABELS,
  IMPORT_TYPE_LABELS,
  IMPORT_TYPE_META,
  IMPORT_TYPES_ENABLED,
} from '@/types/imports'
import apiImports from '@/api/modules/imports'
import ImportResultSummary from './ImportResultSummary.vue'

const props = defineProps<{
  tenantId: string
  storeId?: string
  storeOptions: Array<{ label: string, value: string }>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'completed'): void
}>()

const steps = [
  { title: '选择类型', desc: '选择数据与文件' },
  { title: '字段映射', desc: '配置映射与去重' },
  { title: '预览校验', desc: '预览与校验' },
  { title: '确认执行', desc: '执行导入' },
  { title: '查看结果', desc: '结果汇总' },
]
const step = ref(1)

const type = ref<ImportJobType>('customer')
const storeId = ref(props.storeId || '')
const fileList = ref<FileItem[]>([])
const uploadedFileId = ref('')

const jobId = ref('')
const job = ref<ImportJob | null>(null)
const headers = ref<string[]>([])
const mapping = ref<Record<string, string>>({})
const duplicateStrategy = ref<DuplicateStrategy>('skip')
const preview = ref<ImportRowPreview[]>([])
const totalRows = ref(0)
const validateResult = ref<ValidateResult | null>(null)
const startResult = ref<StartResult | null>(null)

const loading = ref(false)
const submitting = ref(false)

// 错误抽屉
const errorsVisible = ref(false)
const errorList = ref<ImportErrorRow[]>([])
const errorTotal = ref(0)
const errorPage = ref(0)
const ERROR_PAGE_SIZE = 20

const meta = computed(() => IMPORT_TYPE_META[type.value])
const headerOptions = computed(() => [
  { label: '（不导入）', value: '' },
  ...headers.value.map(h => ({ label: h, value: h })),
])
const strategyOptions = computed(() => meta.value.duplicateStrategies.map(s => ({
  label: DUPLICATE_STRATEGY_LABELS[s],
  value: s,
})))
const previewColumns = computed(() => meta.value.fields.filter(f => mapping.value[f.key]))

/** 归一化默认映射：未匹配字段置空，保证编辑框能显示 */
function normalizeMapping(defaultMapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of meta.value.fields) {
    out[f.key] = defaultMapping[f.key] ?? ''
  }
  return out
}

async function downloadTemplate() {
  try {
    await apiImports.downloadTemplate(type.value, props.tenantId, 'xlsx')
  }
  catch {
    useFaToast().error('模板下载失败')
  }
}

async function doUpload() {
  if (!uploadedFileId.value) {
    useFaToast().warning('请先上传数据文件')
    return
  }
  loading.value = true
  try {
    const res = await apiImports.upload({
      tenantId: props.tenantId,
      storeId: storeId.value || undefined,
      type: type.value,
      fileId: uploadedFileId.value,
    })
    jobId.value = res.job.id
    job.value = res.job
    headers.value = res.headers
    mapping.value = normalizeMapping(res.mapping)
    duplicateStrategy.value = res.duplicateStrategies.includes('skip') ? 'skip' : res.duplicateStrategies[0]
    preview.value = res.preview
    totalRows.value = res.totalRows
    step.value = 2
  }
  catch {
    // 错误提示由 axios 拦截器统一处理
  }
  finally {
    loading.value = false
  }
}

async function saveMapping() {
  submitting.value = true
  try {
    const res = await apiImports.saveMapping(jobId.value, {
      mapping: mapping.value,
      duplicateStrategy: duplicateStrategy.value,
    })
    job.value = res.job
    headers.value = res.headers
    preview.value = res.preview
    step.value = 3
    if (!res.requiredMapped) {
      useFaToast().warning('存在必填字段未映射，校验时将报错')
    }
  }
  catch {
    // toast handled
  }
  finally {
    submitting.value = false
  }
}

async function doValidate() {
  loading.value = true
  try {
    validateResult.value = await apiImports.runValidate(jobId.value)
    job.value = validateResult.value.job
    step.value = 4
  }
  catch {
    // toast handled
  }
  finally {
    loading.value = false
  }
}

async function doStart() {
  submitting.value = true
  try {
    startResult.value = await apiImports.runStart(jobId.value)
    job.value = startResult.value.job
    step.value = 5
    emit('completed')
  }
  catch {
    // toast handled
  }
  finally {
    submitting.value = false
  }
}

async function openErrors() {
  errorsVisible.value = true
  errorPage.value = 0
  await loadErrors()
}

async function loadErrors() {
  const res = await apiImports.listErrors(jobId.value, {
    from: errorPage.value * ERROR_PAGE_SIZE,
    limit: ERROR_PAGE_SIZE,
  })
  errorList.value = res.list
  errorTotal.value = res.total
}

function prevStep() {
  if (step.value > 1) {
    step.value--
  }
}

function resetAndClose() {
  emit('close')
}
</script>

<template>
  <div class="space-y-5">
    <!-- 步骤条 -->
    <div class="flex items-center">
      <template v-for="(s, i) in steps" :key="s.title">
        <div class="flex items-center gap-2">
          <div
            class="flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-colors"
            :class="i + 1 < step
              ? 'bg-green-500 text-white'
              : i + 1 === step
                ? 'bg-primary text-primary-foreground'
                : 'bg-gray-100 text-gray-400'"
          >
            <FaIcon v-if="i + 1 < step" name="i-ri:check-line" />
            <span v-else>{{ i + 1 }}</span>
          </div>
          <div class="hidden sm:block">
            <div class="text-sm font-medium" :class="i + 1 === step ? 'text-foreground' : 'text-gray-500'">
              {{ s.title }}
            </div>
            <div class="text-xs text-gray-400">{{ s.desc }}</div>
          </div>
        </div>
        <div v-if="i < steps.length - 1" class="mx-3 h-px flex-1 bg-gray-200" />
      </template>
    </div>

    <div class="rounded-xl border bg-card p-5">
      <!-- Step 1: 选择类型与文件 -->
      <div v-if="step === 1" class="space-y-5">
        <div>
          <h3 class="mb-2 font-medium">1. 选择数据类型</h3>
          <div class="grid grid-cols-2 gap-3 md:grid-cols-5">
            <button
              v-for="t in IMPORT_TYPES_ENABLED"
              :key="t"
              type="button"
              class="rounded-lg border p-3 text-left transition-colors"
              :class="type === t ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-gray-200 hover:border-gray-300'"
              @click="type = t"
            >
              <div class="font-medium">{{ IMPORT_TYPE_LABELS[t] }}</div>
              <div class="mt-1 text-xs text-gray-400">{{ IMPORT_TYPE_META[t].description }}</div>
            </button>
          </div>
        </div>

        <div class="flex flex-wrap items-end gap-4">
          <div class="w-56">
            <FaLabel label="门店" />
            <FaSelect v-model="storeId" :options="storeOptions" class="w-full" />
          </div>
          <FaButton variant="outline" @click="downloadTemplate">
            <FaIcon name="i-ri:download-2-line" />
            下载模板
          </FaButton>
        </div>

        <div>
          <FaLabel label="数据文件（CSV / XLSX）" />
          <BusinessFileUploader
            v-model="fileList"
            category="import"
            purpose="attachment"
            :max="1"
            :tenant-id="tenantId"
            :store-id="storeId || undefined"
            description="上传前请先下载模板，按模板列整理数据"
            @uploaded="uploadedFileId = $event.fileId"
          />
        </div>
      </div>

      <!-- Step 2: 字段映射 -->
      <div v-if="step === 2" class="space-y-5">
        <div class="flex items-center justify-between">
          <h3 class="font-medium">2. 字段映射与去重策略</h3>
          <FaTag variant="secondary">
            共 {{ totalRows }} 行
          </FaTag>
        </div>
        <div class="space-y-2">
          <div
            v-for="field in meta.fields"
            :key="field.key"
            class="grid grid-cols-[220px_1fr] items-center gap-3"
          >
            <FaLabel :label="`${field.label}${field.required ? '*' : ''}`" :title="field.description" />
            <FaSelect v-model="mapping[field.key]" :options="headerOptions" class="w-full" clearable />
          </div>
        </div>
        <div class="rounded-lg bg-gray-50 p-3">
          <div class="mb-2 text-sm font-medium">重复数据策略（{{ meta.duplicateHints.join('；') }}）</div>
          <div class="w-64">
            <FaSelect v-model="duplicateStrategy" :options="strategyOptions" class="w-full" />
          </div>
        </div>
      </div>

      <!-- Step 3: 预览校验 -->
      <div v-if="step === 3" class="space-y-4">
        <div class="flex items-center justify-between">
          <h3 class="font-medium">3. 数据预览与校验</h3>
          <div class="flex items-center gap-2">
            <FaTag variant="secondary">
              预览前 {{ preview.length }} / {{ totalRows }} 行
            </FaTag>
            <FaButton type="primary" :loading="loading" @click="doValidate">
              <FaIcon name="i-ri:shield-check-line" />
              开始校验
            </FaButton>
          </div>
        </div>
        <div class="overflow-auto rounded-lg border">
          <table class="min-w-full text-sm">
            <thead class="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th class="px-3 py-2">行号</th>
                <th v-for="col in previewColumns" :key="col.key" class="px-3 py-2">
                  {{ col.label }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in preview" :key="r.rowNumber" class="border-t">
                <td class="px-3 py-1.5 text-gray-400">{{ r.rowNumber }}</td>
                <td v-for="col in previewColumns" :key="col.key" class="px-3 py-1.5">
                  {{ r.values[col.key] ?? '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Step 4: 确认执行 -->
      <div v-if="step === 4" class="space-y-4">
        <h3 class="font-medium">4. 确认执行</h3>
        <div v-if="validateResult" class="grid grid-cols-3 gap-4">
          <FaCard class="p-4">
            <div class="text-2xl font-bold text-green-600">{{ validateResult.validRows }}</div>
            <div class="mt-1 text-sm text-gray-500">有效行</div>
          </FaCard>
          <FaCard class="p-4">
            <div class="text-2xl font-bold text-red-500">{{ validateResult.invalidRows }}</div>
            <div class="mt-1 text-sm text-gray-500">无效行</div>
          </FaCard>
          <FaCard class="p-4">
            <div class="text-2xl font-bold text-amber-500">{{ validateResult.errorCount }}</div>
            <div class="mt-1 text-sm text-gray-500">错误数</div>
          </FaCard>
        </div>

        <div
          v-if="validateResult && validateResult.errorGroups.length > 0"
          class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"
        >
          <div class="mb-1 font-medium text-amber-700">错误分组</div>
          <div class="flex flex-wrap gap-2">
            <FaTag
              v-for="g in validateResult.errorGroups"
              :key="g.code"
              variant="outline"
              class="text-amber-700"
            >
              {{ g.code }} × {{ g.count }}
            </FaTag>
          </div>
        </div>

        <div
          v-if="validateResult && validateResult.invalidRows > 0"
          class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          存在 {{ validateResult.invalidRows }} 行校验失败，执行时将跳过这些行并计入失败。
        </div>

        <div class="rounded-lg bg-gray-50 px-4 py-3 text-sm">
          <span class="mr-3 text-gray-500">重复策略：</span>
          <span class="font-medium">{{ DUPLICATE_STRATEGY_LABELS[duplicateStrategy] }}</span>
        </div>
      </div>

      <!-- Step 5: 结果 -->
      <div v-if="step === 5 && startResult && job">
        <ImportResultSummary :result="startResult" :job="job" @view-errors="openErrors" />
      </div>
    </div>

    <!-- 底部操作 -->
    <div class="flex items-center justify-end gap-2 border-t pt-4">
      <FaButton variant="outline" @click="resetAndClose">
        关闭
      </FaButton>
      <FaButton v-if="step > 1 && step < 5" variant="outline" @click="prevStep">
        上一步
      </FaButton>
      <FaButton
        v-if="step === 1"
        type="primary"
        :disabled="!uploadedFileId"
        :loading="loading"
        @click="doUpload"
      >
        解析并继续
      </FaButton>
      <FaButton
        v-if="step === 2"
        type="primary"
        :loading="submitting"
        @click="saveMapping"
      >
        保存映射并预览
      </FaButton>
      <FaButton
        v-if="step === 3"
        type="primary"
        :disabled="!validateResult"
        @click="step = 4"
      >
        下一步
      </FaButton>
      <FaButton
        v-if="step === 4"
        type="primary"
        :loading="submitting"
        @click="doStart"
      >
        <FaIcon name="i-ri:play-circle-line" />
        确认执行
      </FaButton>
    </div>

    <!-- 错误明细抽屉 -->
    <FaDrawer v-model="errorsVisible" title="错误明细" :width="640">
      <div class="space-y-2">
        <div class="flex items-center justify-between text-sm text-gray-500">
          <span>共 {{ errorTotal }} 条</span>
          <FaTag variant="outline">
            行号
          </FaTag>
        </div>
        <div
          v-for="e in errorList"
          :key="e.id"
          class="rounded-lg border p-2 text-sm"
        >
          <div class="flex items-center gap-2">
            <FaTag variant="destructive">
              第 {{ e.row_number }} 行
            </FaTag>
            <span class="font-medium text-red-600">{{ e.message }}</span>
          </div>
          <div v-if="e.raw_data" class="mt-1 truncate text-xs text-gray-400">
            {{ JSON.stringify(e.raw_data) }}
          </div>
        </div>
        <div v-if="errorList.length === 0" class="py-8 text-center text-gray-400">
          暂无错误
        </div>
      </div>
    </FaDrawer>
  </div>
</template>
