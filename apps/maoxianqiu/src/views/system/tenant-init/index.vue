<script setup lang="ts">
import type { FormExpose } from '@fantastic-admin/components'
import apiTenant from '@/api/modules/tenant'
import { supabase } from '@/lib/supabase'

defineOptions({
  name: 'SystemTenantInit',
})

/**
 * 租户初始化页面(S3.1 并发任务 A)
 * 新建医院后一键初始化:首店 / tenant_owner / 默认仓库 / 支付上下文 / 基础字典 / 打印设置。
 * - 选择目标租户(平台管理员可新建租户)
 * - 查看初始化状态;pending/running 自动轮询(3s);failed 可重试
 */
interface TenantOption {
  id: string
  slug: string
  name: string
  status?: string
}

const loading = ref(false)
const submitting = ref(false)
const tenantList = ref<TenantOption[]>([])
const selectedTenantId = ref('')
const initState = ref<{
  status: string
  storeName?: string | null
  storeCode?: string | null
  ownerName?: string | null
  attempts?: number
  lastError?: string | null
  completedAt?: string | null
  failedAt?: string | null
}>({ status: 'not_started' })

const formRef = useTemplateRef<FormExpose>('formRef')
const model = ref({
  tenantSlug: '',
  tenantName: '',
  storeName: '',
  storeCode: '',
  ownerUserId: '',
  ownerName: '',
  ownerPhone: '',
  timezone: 'Asia/Shanghai',
})

const validationSchema = {
  storeName(value: string) {
    return value ? true : '请输入门店名称'
  },
  storeCode(value: string) {
    return value ? true : '请输入门店编码'
  },
  ownerUserId(value: string) {
    return value ? true : '所有者用户不能为空'
  },
  ownerName(value: string) {
    return value ? true : '请输入所有者姓名'
  },
}

const statusMap: Record<string, { label: string, type: 'success' | 'warning' | 'error' | 'info' }> = {
  not_started: { label: '未初始化', type: 'info' },
  pending: { label: '等待执行', type: 'warning' },
  running: { label: '初始化中', type: 'warning' },
  completed: { label: '已完成', type: 'success' },
  failed: { label: '失败', type: 'error' },
}

let pollTimer: ReturnType<typeof setInterval> | null = null

/**
 * 加载租户列表与当前登录用户(作为默认 owner)
 */
async function loadTenants() {
  loading.value = true
  try {
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id ?? ''
    const email = userData.user?.email ?? ''
    model.value.ownerUserId = userId
    model.value.ownerName = email
    const res = await apiTenant.listMyTenants()
    tenantList.value = res.data.list ?? []
    if (tenantList.value.length > 0 && !selectedTenantId.value) {
      selectedTenantId.value = tenantList.value[0].id
      loadStatus()
    }
  }
  finally {
    loading.value = false
  }
}

/**
 * 查询初始化状态(选择租户或轮询时调用)
 */
async function loadStatus() {
  if (!selectedTenantId.value) {
    return
  }
  const res = await apiTenant.getInitialization(selectedTenantId.value)
  initState.value = res.data
  stopPoll()
  if (res.data.status === 'pending' || res.data.status === 'running') {
    startPoll()
  }
}

/**
 * 3s 轮询 running/pending 状态,完成或失败后停止
 */
function startPoll() {
  stopPoll()
  pollTimer = setInterval(async () => {
    if (!selectedTenantId.value) {
      return
    }
    const res = await apiTenant.getInitialization(selectedTenantId.value)
    initState.value = res.data
    if (res.data.status === 'completed' || res.data.status === 'failed') {
      stopPoll()
    }
  }, 3000)
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * 执行初始化:已存在租户直接初始化;平台管理员可新建租户(需填 slug/name)
 */
async function submit() {
  const result = await formRef.value?.validate()
  if (!result?.valid) {
    return
  }
  submitting.value = true
  try {
    const payload = {
      tenantId: selectedTenantId.value || undefined,
      tenantSlug: model.value.tenantSlug || undefined,
      tenantName: model.value.tenantName || undefined,
      storeName: model.value.storeName,
      storeCode: model.value.storeCode,
      ownerUserId: model.value.ownerUserId,
      ownerName: model.value.ownerName,
      ownerPhone: model.value.ownerPhone || undefined,
      timezone: model.value.timezone,
      idempotencyKey: `tenant-init-${selectedTenantId.value || model.value.tenantSlug}-${Date.now()}`,
    }
    await apiTenant.initialize(payload)
    useFaToast().success('初始化已触发')
    await loadStatus()
  }
  catch {
    // 失败提示已由 axios 拦截器统一处理;若为 running 进入轮询
    if (selectedTenantId.value) {
      await loadStatus()
    }
  }
  finally {
    submitting.value = false
  }
}

onMounted(loadTenants)
onBeforeUnmount(stopPoll)
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="租户初始化" class="mb-0">
      <template #description>
        新建医院后一键初始化:首店 / 租户所有者 / 默认仓库 / 支付上下文 / 基础字典 / 打印设置
      </template>
    </FaPageHeader>
    <FaPageMain>
      <div class="gap-4 grid grid-cols-1 lg:grid-cols-2">
        <!-- 左:租户选择 + 状态 -->
        <FaCard>
          <FaCardHeader title="目标租户" />
          <FaFormItem name="selectedTenantId" label="选择租户">
            <FaSelect
              v-model="selectedTenantId"
              :options="tenantList.map(t => ({ label: `${t.name}(${t.slug})`, value: t.id }))"
              placeholder="请选择租户"
              class="w-full"
              clearable
              @update:model-value="loadStatus"
            />
          </FaFormItem>
          <div class="flex gap-2 items-center">
            <span class="text-sm text-slate-500">初始化状态:</span>
            <FaTag
              v-if="statusMap[initState.status]"
              :type="statusMap[initState.status].type"
            >
              {{ statusMap[initState.status].label }}
            </FaTag>
          </div>
          <FaAlert
            v-if="initState.status === 'failed'"
            variant="destructive"
            :title="`初始化失败${initState.attempts ? `(第 ${initState.attempts} 次)` : ''}`"
            :description="initState.lastError || '未知错误,可点击右侧重新初始化'"
            class="mt-3"
          />
          <FaAlert
            v-if="initState.status === 'completed'"
            title="初始化已完成"
            :description="`首店:${initState.storeName}(${initState.storeCode})`"
            class="mt-3"
          />
          <FaAlert
            v-if="initState.status === 'running' || initState.status === 'pending'"
            title="初始化进行中,将自动轮询状态…"
            class="mt-3"
          />
        </FaCard>

        <!-- 右:初始化表单 -->
        <FaCard>
          <FaCardHeader title="初始化参数" />
          <FaForm
            ref="formRef"
            :model="model"
            :validation-schema="validationSchema"
            label-placement="right"
            :label-width="110"
          >
            <FaFormItem name="tenantSlug" label="新建租户 slug(平台管理员)">
              <FaInput v-model="model.tenantSlug" placeholder="留空表示初始化已选租户" class="w-full" />
            </FaFormItem>
            <FaFormItem name="tenantName" label="新建租户名称">
              <FaInput v-model="model.tenantName" placeholder="留空表示初始化已选租户" class="w-full" />
            </FaFormItem>
            <FaFormItem name="storeName" label="门店名称" required>
              <FaInput v-model="model.storeName" placeholder="如 爱心宠物医院·总店" class="w-full" />
            </FaFormItem>
            <FaFormItem name="storeCode" label="门店编码" required>
              <FaInput v-model="model.storeCode" placeholder="唯一编码,如 ST001" class="w-full" />
            </FaFormItem>
            <FaFormItem name="ownerUserId" label="所有者用户" required>
              <FaInput v-model="model.ownerUserId" placeholder="登录用户 id,可修改" class="w-full" />
            </FaFormItem>
            <FaFormItem name="ownerName" label="所有者姓名" required>
              <FaInput v-model="model.ownerName" placeholder="所有者姓名/邮箱" class="w-full" />
            </FaFormItem>
            <FaFormItem name="ownerPhone" label="所有者电话">
              <FaInput v-model="model.ownerPhone" placeholder="联系电话(可选)" class="w-full" />
            </FaFormItem>
            <FaFormItem name="timezone" label="时区">
              <FaSelect
                v-model="model.timezone"
                :options="[{ label: 'Asia/Shanghai(中国大陆)', value: 'Asia/Shanghai' }]"
                class="w-full"
              />
            </FaFormItem>
            <div class="pt-2 flex gap-2 justify-end">
              <FaButton type="primary" :loading="submitting" @click="submit">
                {{ initState.status === 'failed' ? '重新初始化' : '执行初始化' }}
              </FaButton>
            </div>
          </FaForm>
        </FaCard>
      </div>
    </FaPageMain>
  </div>
</template>
