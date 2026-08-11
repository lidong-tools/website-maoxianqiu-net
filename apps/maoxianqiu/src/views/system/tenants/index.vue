<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiTenant from '@/api/modules/tenant'

defineOptions({
  name: 'SystemTenants',
})

interface TenantItem {
  id: string
  slug: string
  name: string
  shortName: string | null
  status: string
  trialEndsAt: string | null
  timezone: string
  currency: string
  locale: string
  createdAt: string
  updatedAt: string
  storeCount: number
  activeEmployeeCount: number
  employeeCount: number
}

const loading = ref(false)
const dataList = ref<TenantItem[]>([])
const search = ref({
  keyword: '',
  status: '',
  trial: '',
})

const STATUS_LABEL: Record<string, string> = {
  active: '启用',
  trial: '试用',
  suspended: '已停用',
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  active: 'default',
  trial: 'secondary',
  suspended: 'destructive',
}

const tableColumns = computed<TableColumn<TenantItem>[]>(() => [
  { accessorKey: 'name', header: '医院名称', minSize: 200 },
  { accessorKey: 'slug', header: '简称', minSize: 120 },
  {
    accessorKey: 'status',
    header: '状态',
    minSize: 90,
  },
  { accessorKey: 'storeCount', header: '门店数', minSize: 80, align: 'center' },
  {
    accessorKey: 'employeeCount',
    header: '员工数',
    minSize: 90,
    align: 'center',
  },
  { accessorKey: 'trialEndsAt', header: '试用截止', minSize: 160 },
  { accessorKey: 'createdAt', header: '创建时间', minSize: 160 },
  {
    id: 'operation',
    header: '操作',
    width: 160,
    align: 'center',
    fixed: 'right',
  },
])

function formatTime(value: string | null | undefined): string {
  if (!value) {
    return '-'
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    return '-'
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function getDataList() {
  loading.value = true
  try {
    const res: any = await apiTenant.listPlatform()
    const list: TenantItem[] = res?.data?.list ?? []
    const k = search.value.keyword.trim().toLowerCase()
    dataList.value = list.filter((item) => {
      if (search.value.status && item.status !== search.value.status) {
        return false
      }
      if (search.value.trial === 'active' && !item.trialEndsAt) {
        return false
      }
      if (search.value.trial === 'expired' && item.trialEndsAt && new Date(item.trialEndsAt).getTime() > Date.now()) {
        return false
      }
      if (k && !`${item.name} ${item.shortName ?? ''} ${item.slug} ${item.id}`.toLowerCase().includes(k)) {
        return false
      }
      return true
    })
  }
  finally {
    loading.value = false
  }
}

onMounted(getDataList)

// ===== 停用/恢复 =====
const statusModal = ref(false)
const statusAction = ref<'suspend' | 'resume'>('suspend')
const statusItem = ref<TenantItem | null>(null)
const statusReason = ref('')
const statusLoading = ref(false)

function openSuspend(row: TenantItem) {
  statusItem.value = row
  statusAction.value = 'suspend'
  statusReason.value = ''
  statusModal.value = true
}

function openResume(row: TenantItem) {
  statusItem.value = row
  statusAction.value = 'resume'
  statusReason.value = ''
  statusModal.value = true
}

async function submitStatus() {
  const item = statusItem.value
  if (!item) {
    return
  }
  if (!statusReason.value.trim()) {
    useFaToast().warning('请填写操作原因')
    return
  }
  statusLoading.value = true
  try {
    if (statusAction.value === 'suspend') {
      await apiTenant.suspend(item.id, statusReason.value.trim())
      useFaToast().success('租户已停用')
    }
    else {
      await apiTenant.resume(item.id, statusReason.value.trim())
      useFaToast().success('租户已恢复')
    }
    statusModal.value = false
    getDataList()
  }
  finally {
    statusLoading.value = false
  }
}

const router = useRouter()
function openDetail(row: TenantItem) {
  router.push({ name: 'systemTenantDetail', params: { id: row.id } })
}
</script>

<template>
  <!-- 标准布局:外层固定高度 + 白底卡片,FaSearchBar 展开为卡片内联布局(左筛选右按钮) -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告 #8) -->
    <!--
    <EntityPageHeader compact title="平台租户" description="平台管理员管理全部医院租户;停用后该租户新业务将无法继续,历史数据保留" />
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 筛选区:左筛选控件,右功能按钮 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 flex flex-wrap gap-3 items-center">
            <FaInput
              v-model="search.keyword"
              placeholder="医院名称/简称/ID"
              class="w-56"
              clearable
              @keydown.enter="getDataList"
              @clear="getDataList"
            />
            <div class="flex gap-2 items-center">
              <span class="text-sm text-muted-foreground">状态</span>
              <FaSelect
                v-model="search.status" :options="[
                  { label: '全部', value: '' },
                  { label: '启用', value: 'active' },
                  { label: '试用', value: 'trial' },
                  { label: '已停用', value: 'suspended' },
                ]" class="w-32" @change="getDataList"
              />
            </div>
            <div class="flex gap-2 items-center">
              <span class="text-sm text-muted-foreground">试用状态</span>
              <FaSelect
                v-model="search.trial" :options="[
                  { label: '全部', value: '' },
                  { label: '试用中', value: 'active' },
                  { label: '已过期', value: 'expired' },
                ]" class="w-32" @change="getDataList"
              />
            </div>
            <div class="ml-auto flex gap-2 items-center">
              <FaButton size="sm" variant="outline" @click="search.keyword = ''; search.status = ''; search.trial = ''; getDataList()">
                重置
              </FaButton>
              <FaButton size="sm" @click="getDataList">
                <FaIcon name="i-ri:search-line" />
                筛选
              </FaButton>
            </div>
          </div>
        </div>
        <!-- 表格区(flex-1 撑满,内部滚动) -->
        <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="tableColumns"
            :data="dataList"
          >
            <template #cell-name="{ row }">
              <div class="flex flex-col gap-0.5">
                <span class="font-medium">{{ row.original.name }}</span>
                <span v-if="row.original.shortName" class="text-xs text-muted-foreground">
                  {{ row.original.shortName }}
                </span>
              </div>
            </template>
            <template #cell-status="{ row }">
              <FaTag :variant="STATUS_VARIANT[row.original.status] ?? 'secondary'">
                {{ STATUS_LABEL[row.original.status] ?? row.original.status }}
              </FaTag>
            </template>
            <template #cell-employeeCount="{ row }">
              {{ row.original.activeEmployeeCount }} / {{ row.original.employeeCount }}
            </template>
            <template #cell-trialEndsAt="{ row }">
              {{ formatTime(row.original.trialEndsAt) }}
            </template>
            <template #cell-createdAt="{ row }">
              {{ formatTime(row.original.createdAt) }}
            </template>
            <template #cell-operation="{ row }">
              <div class="flex-center gap-2">
                <FaButton variant="outline" size="sm" @click="openDetail(row.original)">
                  <FaIcon name="i-ri:eye-line" />
                  查看
                </FaButton>
                <FaDropdown
                  :items="[[
                    row.original.status === 'suspended'
                      ? { label: '恢复', handle: () => openResume(row.original) }
                      : { label: '停用', variant: 'destructive', handle: () => openSuspend(row.original) },
                  ]]"
                >
                  <FaButton variant="outline" size="icon-sm">
                    <FaIcon name="i-ri:more-line" />
                  </FaButton>
                </FaDropdown>
              </div>
            </template>
          </FaTable>
        </div>
      </div>
    </div>

    <!-- 停用/恢复确认 -->
    <FaModal v-model="statusModal" :title="statusAction === 'suspend' ? '停用租户' : '恢复租户'" :footer="false" :close-on-click-overlay="false">
      <div class="py-2 space-y-4">
        <div class="text-sm">
          <span class="text-muted-foreground">对象：</span>
          <span class="font-medium">{{ statusItem?.name }}</span>
        </div>
        <div v-if="statusAction === 'suspend'" class="text-xs text-muted-foreground">
          停用后该租户内新业务(开单/入库/住院等)将无法继续,历史数据保留;可随时恢复。
        </div>
        <FaLabel label="操作原因(必填)" class="block">
          <FaTextarea v-model="statusReason" :placeholder="statusAction === 'suspend' ? '请说明停用原因' : '请说明恢复原因'" class="w-full" :rows="3" />
        </FaLabel>
        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="statusModal = false">
            取消
          </FaButton>
          <FaButton :variant="statusAction === 'suspend' ? 'destructive' : 'default'" :loading="statusLoading" @click="submitStatus">
            {{ statusAction === 'suspend' ? '确认停用' : '确认恢复' }}
          </FaButton>
        </div>
      </div>
    </FaModal>
  </div>
</template>
