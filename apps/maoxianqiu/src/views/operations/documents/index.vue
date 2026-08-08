<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiDocuments from '@/api/modules/documents'
import apiStore from '@/api/modules/store'
import DocumentEntityPicker from '@/components/documents/DocumentEntityPicker/index.vue'
import DocumentPreviewPanel from '@/components/documents/DocumentPreviewPanel/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import type {
  DocumentHistoryItem,
  DocumentRenderResult,
  DocumentTemplate,
  DocumentType,
  PaperSize,
} from '@/types/documents'
import { DOCUMENT_TYPE_OPTIONS, getDocumentTypeLabel, PAPER_SIZE_OPTIONS } from '@/types/documents'

defineOptions({
  name: 'OperationsDocuments',
})

const tenantStore = useAppTenantStore()

// ===== 门店过滤 =====
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({ storeId: '' })

async function loadStoreOptions() {
  try {
    const res: any = await apiStore.list()
    const stores = res.data.list ?? []
    storeOptions.value = [
      { label: '全部门店', value: '' },
      ...stores.map((s: any) => ({ label: s.name, value: s.id })),
    ]
  }
  catch {
    storeOptions.value = [{ label: '全部门店', value: '' }]
  }
}

// ===== 文档配置 =====
const documentType = ref<DocumentType>('invoice')
const entityId = ref('')
const templateId = ref('') // '' = 自动(门店/租户/系统优先级)
const paperSize = ref<PaperSize>('A4')

const templateOptions = ref<DocumentTemplate[]>([])

const filteredTemplates = computed(() => {
  return templateOptions.value.filter(t => t.document_type === documentType.value)
})

const TEMPLATE_LEVEL_LABELS: Record<string, string> = {
  store: '门店',
  tenant: '租户',
  system: '系统',
}

function templateLevelLabel(tpl: DocumentTemplate): string {
  return TEMPLATE_LEVEL_LABELS[tpl.level ?? 'system'] ?? '系统'
}

// ===== 模板/历史加载 =====
async function loadTemplates() {
  if (!tenantStore.currentTenantId) {
    templateOptions.value = []
    return
  }
  try {
    const res: any = await apiDocuments.listTemplates({
      tenantId: tenantStore.currentTenantId,
      storeId: search.value.storeId || undefined,
    })
    templateOptions.value = res.data.list ?? []
  }
  catch {
    templateOptions.value = []
  }
}

const historyList = ref<DocumentHistoryItem[]>([])
const historyLoading = ref(false)
const historyTotal = ref(0)

async function loadHistory() {
  if (!tenantStore.currentTenantId) {
    historyList.value = []
    return
  }
  historyLoading.value = true
  try {
    const res: any = await apiDocuments.listHistory({
      tenantId: tenantStore.currentTenantId,
      storeId: search.value.storeId || undefined,
      limit: 20,
    })
    historyList.value = res.data.list ?? []
    historyTotal.value = res.data.total ?? 0
  }
  catch {
    historyList.value = []
  }
  finally {
    historyLoading.value = false
  }
}

// ===== 预览/渲染/打印 =====
const previewHtml = ref('')
const previewLoading = ref(false)
const lastRender = ref<DocumentRenderResult | null>(null)

async function doRender(mode: 'preview' | 'render' | 'print') {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  if (!entityId.value.trim()) {
    useFaToast().warning('请先选择业务单据')
    return
  }
  previewLoading.value = true
  try {
    const payload = {
      documentType: documentType.value,
      entityId: entityId.value.trim(),
      templateId: templateId.value || undefined,
      paperSize: paperSize.value,
    }
    let res: any
    if (mode === 'preview') {
      res = await apiDocuments.previewDocument(payload)
    }
    else if (mode === 'render') {
      res = await apiDocuments.renderDocument(payload)
      loadHistory()
    }
    else {
      res = await apiDocuments.printDocument(payload)
      loadHistory()
    }
    const data = res.data as DocumentRenderResult
    lastRender.value = data
    previewHtml.value = data.html
    // 服务端返回生效纸型,同步预览面板宽度
    paperSize.value = data.paperSize
    if (mode === 'print') {
      openPrintWindow(data.html)
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '文档处理失败')
  }
  finally {
    previewLoading.value = false
  }
}

function onPreview() {
  doRender('preview')
}

function onRender() {
  doRender('render')
}

function onPrint() {
  doRender('print')
}

/** HTML 属性值转义(用于 srcdoc 属性注入) */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 浏览器打印:新窗口内用 sandbox iframe 承载服务端已净化 HTML。
 * 不直接 document.write 文档内容,避免脚本执行环境;打印调用 iframe 自身的打印流程。
 */
function openPrintWindow(html: string) {
  const win = window.open('', '_blank', 'width=900,height=700')
  if (!win) {
    useFaToast().warning('请允许弹出窗口以进行打印')
    return
  }
  // 外层仅写入静态打印壳;文档放入 sandbox="" iframe,阻断脚本与同源访问
  win.document.write(
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>打印</title>'
    + '<style>html,body{margin:0;padding:0}iframe{width:100%;height:100%;border:0;display:block}</style>'
    + '</head><body>'
    + `<iframe sandbox="" srcdoc="${escapeAttr(html)}"></iframe>`
    + '</body></html>',
  )
  win.document.close()
  win.focus()
  setTimeout(() => {
    const frame = win.document.querySelector('iframe')
    if (frame?.contentWindow) {
      frame.contentWindow.print()
    }
    else {
      win.print()
    }
  }, 400)
}

// ===== 模板管理(create / edit)=====
const manageVisible = ref(false)
const manageMode = ref<'create' | 'edit'>('create')
const manageEditingId = ref('')
const manageSubmitting = ref(false)
const manageForm = ref({
  storeScope: 'tenant' as 'tenant' | 'store',
  name: '',
  paperSize: 'A4' as PaperSize,
  isDefault: false,
  isActive: true,
  templateHtml: '',
})

/** 当前文档类型的系统默认模板 HTML(作为新建模板起点) */
function systemTemplateHtml(): string {
  const sys = templateOptions.value.find(t => t.document_type === documentType.value && t.level === 'system')
  return sys?.template_html ?? ''
}

function openCreateTemplate() {
  manageMode.value = 'create'
  manageEditingId.value = ''
  manageForm.value = {
    storeScope: search.value.storeId || tenantStore.currentStoreId ? 'store' : 'tenant',
    name: `${getDocumentTypeLabel(documentType.value)}模板`,
    paperSize: 'A4',
    isDefault: false,
    isActive: true,
    templateHtml: systemTemplateHtml(),
  }
  manageVisible.value = true
}

function openEditTemplate(tpl: DocumentTemplate) {
  if (tpl.level === 'system') {
    useFaToast().warning('系统默认模板不可修改,请新建租户级模板覆盖')
    return
  }
  manageMode.value = 'edit'
  manageEditingId.value = tpl.id
  manageForm.value = {
    storeScope: tpl.store_id ? 'store' : 'tenant',
    name: tpl.name,
    paperSize: tpl.paper_size,
    isDefault: tpl.is_default,
    isActive: tpl.is_active,
    templateHtml: tpl.template_html,
  }
  manageVisible.value = true
}

async function saveTemplate() {
  if (!tenantStore.currentTenantId) {
    return
  }
  if (!manageForm.value.name.trim()) {
    useFaToast().warning('请填写模板名称')
    return
  }
  if (!manageForm.value.templateHtml.trim()) {
    useFaToast().warning('请填写模板内容')
    return
  }
  manageSubmitting.value = true
  try {
    if (manageMode.value === 'create') {
      const storeId = manageForm.value.storeScope === 'store'
        ? (search.value.storeId || tenantStore.currentStoreId || null)
        : null
      await apiDocuments.createTemplate({
        tenantId: tenantStore.currentTenantId,
        storeId,
        documentType: documentType.value,
        name: manageForm.value.name.trim(),
        templateHtml: manageForm.value.templateHtml,
        paperSize: manageForm.value.paperSize,
        isDefault: manageForm.value.isDefault,
        isActive: manageForm.value.isActive,
      })
      useFaToast().success('模板已创建')
    }
    else {
      await apiDocuments.updateTemplate(manageEditingId.value, {
        name: manageForm.value.name.trim(),
        templateHtml: manageForm.value.templateHtml,
        paperSize: manageForm.value.paperSize,
        isDefault: manageForm.value.isDefault,
        isActive: manageForm.value.isActive,
      })
      useFaToast().success('模板已更新')
    }
    manageVisible.value = false
    await loadTemplates()
    // 自动选中刚编辑的模板
    if (manageMode.value === 'edit') {
      templateId.value = manageEditingId.value
    }
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '保存模板失败')
  }
  finally {
    manageSubmitting.value = false
  }
}

// ===== 切换文档类型/门店 =====
function onDocumentTypeChange() {
  entityId.value = ''
  previewHtml.value = ''
  lastRender.value = null
  templateId.value = ''
}

function onStoreChange() {
  loadTemplates()
  loadHistory()
}

const historyColumns = computed<TableColumn<DocumentHistoryItem>[]>(() => [
  {
    accessorKey: 'document_type',
    header: '文档类型',
    cell: info => getDocumentTypeLabel(info.getValue() as string),
  },
  {
    accessorKey: 'action',
    header: '动作',
    cell: info => (info.getValue() === 'print' ? '打印' : '渲染'),
  },
  {
    accessorKey: 'entity_id',
    header: '业务单据',
    cell: info => (info.getValue() as string | undefined)?.slice(0, 8) ?? '-',
  },
  {
    accessorKey: 'template_version',
    header: '模板版本',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'paper_size',
    header: '纸型',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'created_at',
    header: '时间',
    cell: info => (info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-'),
  },
])

onMounted(async () => {
  await Promise.all([loadStoreOptions()])
  if (tenantStore.currentStoreId) {
    search.value.storeId = tenantStore.currentStoreId
  }
  await Promise.all([loadTemplates(), loadHistory()])
})
</script>

<template>
  <div>
    <EntityPageHeader compact title="业务文档中心" description="处方/收费单/病历摘要/检验/影像/出院/疫苗/寄养交接;服务端安全模板渲染,审计可追溯" />

    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="门店" class="col-span-1">
              <FaSelect
                v-model="search.storeId"
                :options="storeOptions"
                class="w-full"
                @change="onStoreChange"
              />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton @click="openCreateTemplate">
                <FaIcon name="i-ri:file-add-line" />
                新建模板
              </FaButton>
            </div>
          </div>
        </template>
      </FaSearchBar>

      <!-- 左:文档配置 / 右:实时预览 -->
      <div class="gap-6 grid grid-cols-1 mt-4 lg:grid-cols-[380px_1fr]">
        <!-- 左列配置 -->
        <div class="space-y-4">
          <div class="border border-gray-200 rounded-lg p-4 space-y-4 dark:border-gray-700">
            <p class="font-medium text-sm">文档配置</p>

            <FaLabel label="文档类型">
              <FaSelect
                v-model="documentType"
                :options="DOCUMENT_TYPE_OPTIONS"
                class="w-full"
                @change="onDocumentTypeChange"
              />
            </FaLabel>

            <FaLabel label="业务单据">
              <DocumentEntityPicker
                v-model="entityId"
                :document-type="documentType"
                class="w-full"
              />
            </FaLabel>

            <FaLabel label="模板">
              <FaSelect
                v-model="templateId"
                :options="[
                  { label: '自动(门店/租户/系统)', value: '' },
                  ...filteredTemplates.map(t => ({
                    label: `${t.name} [${templateLevelLabel(t)} v${t.version}]`,
                    value: t.id,
                  })),
                ]"
                class="w-full"
              />
            </FaLabel>

            <FaLabel label="纸型">
              <FaSelect
                v-model="paperSize"
                :options="PAPER_SIZE_OPTIONS"
                class="w-full"
              />
            </FaLabel>

            <div class="flex gap-2">
              <FaButton type="primary" :loading="previewLoading" @click="onPreview">
                <FaIcon name="i-ri:eye-line" />
                预览
              </FaButton>
              <FaButton :loading="previewLoading" @click="onRender">
                <FaIcon name="i-ri:file-line" />
                渲染
              </FaButton>
              <FaButton variant="outline" :loading="previewLoading" @click="onPrint">
                <FaIcon name="i-ri:printer-line" />
                打印
              </FaButton>
            </div>
            <p class="text-xs text-muted-foreground">
              切换纸型仅改变预览宽度;打印时请确保打印机纸张匹配。
            </p>
          </div>

          <!-- 模板列表 -->
          <div class="border border-gray-200 rounded-lg p-4 dark:border-gray-700">
            <p class="font-medium text-sm mb-3">可用模板({{ filteredTemplates.length }})</p>
            <div class="space-y-2 max-h-72 overflow-auto">
              <div
                v-for="tpl in filteredTemplates"
                :key="tpl.id"
                class="flex items-center justify-between gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                :class="templateId === tpl.id ? 'border-primary' : ''"
                @click="templateId = tpl.id"
              >
                <div class="min-w-0">
                  <div class="truncate">{{ tpl.name }}</div>
                  <div class="text-xs text-muted-foreground">
                    {{ templateLevelLabel(tpl) }} · v{{ tpl.version }} · {{ tpl.paper_size }}{{ tpl.is_default ? ' · 默认' : '' }}
                  </div>
                </div>
                <FaButton v-if="tpl.level !== 'system'" variant="outline" size="sm" @click.stop="openEditTemplate(tpl)">
                  编辑
                </FaButton>
              </div>
              <p v-if="filteredTemplates.length === 0" class="text-xs text-muted-foreground py-2">
                当前类型暂无可用模板
              </p>
            </div>
          </div>
        </div>

        <!-- 右列预览 -->
        <div class="min-w-0">
          <DocumentPreviewPanel
            :html="previewHtml"
            :paper-size="paperSize"
            :loading="previewLoading"
          />
          <div v-if="lastRender" class="mt-3 text-xs text-muted-foreground">
            生效模板: {{ lastRender.templateName }} ({{ TEMPLATE_LEVEL_LABELS[lastRender.templateLevel] ?? lastRender.templateLevel }} v{{ lastRender.templateVersion }}) · 纸型 {{ lastRender.paperSize }}
          </div>
        </div>
      </div>

      <!-- 历史 -->
      <div class="mx--4 my-4 border-t border-t-dashed" />
      <div class="flex items-center justify-between mb-2">
        <p class="font-medium text-sm">文档历史(近 {{ historyTotal }} 条)</p>
      </div>
      <FaTable
        v-loading="historyLoading"
        table-root-class="rounded-lg overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="historyColumns"
        :data="historyList"
      />

      <!-- 模板管理弹窗 -->
      <FaModal
        v-model="manageVisible"
        :title="manageMode === 'create' ? '新建文档模板' : '编辑文档模板'"
        confirm-text="保存"
        :loading="manageSubmitting"
        width="720px"
        @confirm="saveTemplate"
      >
        <div class="space-y-4">
          <div class="gap-3 grid grid-cols-2">
            <FaLabel label="模板名称">
              <FaInput v-model="manageForm.name" placeholder="模板名称" class="w-full" />
            </FaLabel>
            <FaLabel label="纸型">
              <FaSelect v-model="manageForm.paperSize" :options="PAPER_SIZE_OPTIONS" class="w-full" />
            </FaLabel>
            <FaLabel v-if="manageMode === 'create'" label="生效范围">
              <FaSelect
                v-model="manageForm.storeScope"
                :options="[
                  { label: '租户默认', value: 'tenant' },
                  { label: '门店覆盖', value: 'store' },
                ]"
                class="w-full"
              />
            </FaLabel>
            <div class="flex items-end gap-4 pb-1">
              <FaCheckbox v-model="manageForm.isDefault">设为默认</FaCheckbox>
              <FaCheckbox v-model="manageForm.isActive">启用</FaCheckbox>
            </div>
          </div>
          <FaLabel label="模板内容(HTML)">
            <textarea
              v-model="manageForm.templateHtml"
              rows="12"
              class="w-full rounded-md border border-gray-300 p-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
              placeholder="仅支持安全变量 {{path}} 与 {{#each path}}...{{/each}},禁止脚本"
            />
          </FaLabel>
          <p class="text-xs text-muted-foreground">
            安全变量示例: &#123;&#123;hospital.name&#125;&#125; / &#123;&#123;pet.name&#125;&#125; / &#123;&#123;invoice.total&#125;&#125;;列表用 &#123;&#123;#each invoice.items&#125;&#125;...&#123;&#123;/each&#125;&#125;。禁止 &lt;script&gt;、onclick、javascript:、&#123;&#123;&#123; 等。
          </p>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>
