<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { MessageChannel } from '@/types/operations'
import apiOperations, { isMockProvider } from '@/api/modules/operations'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  MEMBERSHIP_CHANNEL_LABELS,
} from '@/types/operations'

defineOptions({
  name: 'OperationsMessageTemplates',
})

interface TemplateRow {
  id: string
  tenant_id: string
  code: string
  name: string
  channel: MessageChannel
  subject: string | null
  body: string
  variables: Record<string, unknown>
  is_active: boolean
  version: number
  created_at: string
  updated_at: string
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<TemplateRow[]>([])
/** 是否为 Mock 模式 */
const isMock = ref(false)
/** 是否为生产环境 Mock 模式 */
const isProdMock = computed(() => isMock.value && import.meta.env.PROD)

/** 渠道筛选选项 */
const channelOptions = [
  { label: '全部渠道', value: '' },
  { label: '短信', value: 'sms' },
  { label: '邮件', value: 'email' },
  { label: '微信', value: 'wechat' },
  { label: '企业微信', value: 'work_wechat' },
]

const search = ref({
  channel: '' as '' | MessageChannel,
})

/** 新建/编辑弹窗状态 */
const editVisible = ref(false)
const editSubmitting = ref(false)
const isEditing = ref(false)
const editForm = ref({
  id: '' as string,
  code: '',
  name: '',
  channel: 'sms' as MessageChannel,
  subject: '',
  body: '',
  variables: '' as string,
  is_active: true,
})

/**
 * 拉取消息模板列表
 */
function getDataList() {
  if (!tenantStore.currentTenantId) {
    dataList.value = []
    return
  }
  loading.value = true
  apiOperations.listMessageTemplates({
    tenantId: tenantStore.currentTenantId,
    channel: search.value.channel || undefined,
  }).then((res: any) => {
    loading.value = false
    dataList.value = (res.data.list ?? []) as TemplateRow[]
  }).catch(() => {
    loading.value = false
  })
}

onMounted(() => {
  isMock.value = isMockProvider()
  getDataList()
})

function onSearch() {
  getDataList()
}

function onReset() {
  search.value.channel = ''
  getDataList()
}

const tableColumns = computed<TableColumn<TemplateRow>[]>(() => [
  {
    accessorKey: 'code',
    header: '模板编码',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'name',
    header: '模板名称',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'channel',
    header: '渠道',
    cell: (info: any) => MEMBERSHIP_CHANNEL_LABELS[info.getValue() as MessageChannel] ?? info.getValue(),
  },
  {
    accessorKey: 'subject',
    header: '标题',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'is_active',
    header: '状态',
    cell: (info: any) => info.getValue() ? '启用' : '停用',
  },
  {
    accessorKey: 'updated_at',
    header: '更新时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 120,
    align: 'center',
    fixed: 'right',
  },
])

/**
 * 打开新建模板弹窗
 */
function openCreate() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  isEditing.value = false
  editForm.value = {
    id: '',
    code: '',
    name: '',
    channel: 'sms',
    subject: '',
    body: '',
    variables: '',
    is_active: true,
  }
  editVisible.value = true
}

/**
 * 打开编辑模板弹窗
 */
function openEdit(row: TemplateRow) {
  isEditing.value = true
  editForm.value = {
    id: row.id,
    code: row.code,
    name: row.name,
    channel: row.channel,
    subject: row.subject ?? '',
    body: row.body,
    variables: row.variables ? JSON.stringify(row.variables, null, 2) : '',
    is_active: row.is_active,
  }
  editVisible.value = true
}

/**
 * 提交保存消息模板(直连 Supabase,RLS 兜底)
 */
function onSubmitEdit() {
  if (!tenantStore.currentTenantId) {
    return
  }
  if (!editForm.value.code.trim() || !editForm.value.name.trim() || !editForm.value.body.trim()) {
    useFaToast().warning('模板编码、名称和内容不能为空')
    return
  }
  /** 解析变量 JSON */
  let variablesObj: Record<string, unknown> = {}
  if (editForm.value.variables.trim()) {
    try {
      variablesObj = JSON.parse(editForm.value.variables)
    }
    catch {
      useFaToast().warning('变量占位符格式不正确，请输入有效的 JSON')
      return
    }
  }
  editSubmitting.value = true
  apiOperations.saveMessageTemplate({
    id: editForm.value.id || undefined,
    tenant_id: tenantStore.currentTenantId,
    code: editForm.value.code.trim(),
    name: editForm.value.name.trim(),
    channel: editForm.value.channel,
    subject: editForm.value.subject.trim() || null,
    body: editForm.value.body.trim(),
    variables: variablesObj,
    is_active: editForm.value.is_active,
    version: isEditing.value ? undefined : 1,
  } as any).then(() => {
    useFaToast().success(isEditing.value ? '模板已更新' : '模板已创建')
    editVisible.value = false
    getDataList()
  }).catch(() => {
    // 错误已在拦截器中处理
  }).finally(() => {
    editSubmitting.value = false
  })
}

/**
 * 切换模板启用状态
 */
function toggleActive(row: TemplateRow) {
  if (!tenantStore.currentTenantId) {
    return
  }
  apiOperations.saveMessageTemplate({
    id: row.id,
    tenant_id: tenantStore.currentTenantId,
    code: row.code,
    name: row.name,
    channel: row.channel,
    body: row.body,
    is_active: !row.is_active,
  } as any).then(() => {
    useFaToast().success(row.is_active ? '已停用' : '已启用')
    getDataList()
  }).catch(() => {
    // 错误已在拦截器中处理
  })
}
</script>

<template>
  <div>
    <EntityPageHeader compact title="消息模板管理" description="管理短信/邮件/微信/企业微信的消息模板；支持变量占位符(如 {'{{ '}customer_name{' }}'})" />
    <FaPageMain>
      <!-- 生产环境 Mock 模式：红色警告横幅 -->
      <div v-if="isProdMock" class="mock-banner">
        <FaIcon name="i-ri:error-warning-line" class="mock-banner-icon" />
        <span>
          <strong>未配置消息供应商 — 消息功能已禁用。</strong>
          请在环境变量中设置 VITE_MESSAGE_PROVIDER=real 并配置后端供应商后启用。
        </span>
      </div>

      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="渠道" class="col-span-1">
              <FaSelect v-model="search.channel" :options="channelOptions" class="w-full" @change="onSearch" />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton variant="outline" @click="onReset">
                重置
              </FaButton>
              <FaButton type="primary" @click="onSearch">
                <FaIcon name="i-ri:search-line" />
                筛选
              </FaButton>
            </div>
          </div>
        </template>
      </FaSearchBar>
      <div class="mx--4 my-3 border-t border-t-dashed" />
      <FaTable
        v-loading="loading"
        table-root-class="rounded-lg overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="tableColumns"
        :data="dataList"
      >
        <template #toolbar>
          <FaButton @click="openCreate">
            <FaIcon name="i-ri:add-line" />
            新建模板
          </FaButton>
        </template>
        <template #cell-operation="{ row }">
          <div class="flex-center gap-2">
            <FaButton variant="outline" size="icon-sm" @click="openEdit(row.original)">
              <FaIcon name="i-ri:edit-line" />
            </FaButton>
            <FaButton
              variant="outline"
              size="icon-sm"
              @click="toggleActive(row.original)"
            >
              <FaIcon :name="row.original.is_active ? 'i-ri:toggle-fill' : 'i-ri:toggle-line'" />
            </FaButton>
          </div>
        </template>
      </FaTable>

      <!-- 新建/编辑模板弹窗 -->
      <FaModal
        v-model="editVisible"
        :title="isEditing ? '编辑模板' : '新建模板'"
        :confirm-text="isEditing ? '保存' : '创建'"
        :loading="editSubmitting"
        @confirm="onSubmitEdit"
      >
        <div class="space-y-4">
          <FaLabel label="模板编码">
            <FaInput v-model="editForm.code" :disabled="isEditing" placeholder="例如: vaccine_reminder" class="w-full" />
          </FaLabel>
          <FaLabel label="模板名称">
            <FaInput v-model="editForm.name" placeholder="例如: 疫苗提醒模板" class="w-full" />
          </FaLabel>
          <FaLabel label="渠道">
            <FaSelect
              v-model="editForm.channel"
              :options="channelOptions.filter(o => o.value !== '')"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="标题(可选)">
            <FaInput v-model="editForm.subject" placeholder="消息标题(邮件必填)" class="w-full" />
          </FaLabel>
          <FaLabel label="内容">
            <FaInput
              v-model="editForm.body"
              type="textarea"
              placeholder="消息内容，支持 {'{{'}variable_name{'}}'} 占位"
              :rows="5"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="变量占位符(JSON)">
            <FaInput
              v-model="editForm.variables"
              type="textarea"
              placeholder="例如: { &quot;customer_name&quot;: &quot;客户姓名&quot; }"
              :rows="3"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="启用">
            <FaSwitch v-model="editForm.is_active" />
          </FaLabel>
        </div>
      </FaModal>
    </FaPageMain>
  </div>
</template>

<style scoped>
.mock-banner {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
  margin-bottom: 16px;
  font-size: 14px;
  color: #991b1b;
  background: #fee2e2;
  border: 1px solid #ef4444;
  border-radius: 8px;
}

.mock-banner-icon {
  flex-shrink: 0;
  font-size: 18px;
}
</style>
