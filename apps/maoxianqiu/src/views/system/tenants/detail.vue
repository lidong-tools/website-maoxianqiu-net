<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiTenant from '@/api/modules/tenant'

defineOptions({
  name: 'SystemTenantDetail',
})

interface TenantOverview {
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
  totalEmployeeCount: number
  activeEmployeeCount: number
}

interface TenantStore {
  id: string
  name: string
  code: string | null
  status: string
  address: string
  phone: string
  archived_at: string | null
  created_at: string
}

interface TenantEmployee {
  id: string
  employeeNo: string
  name: string
  phone: string | null
  email: string | null
  title: string | null
  status: string
  createdAt: string
  roles: string[]
  stores: Array<{ id: string, name: string, isPrimary: boolean }>
}

const route = useRoute()
const router = useRouter()
const tenantId = route.params.id as string

const loading = ref(false)
const activeTab = ref('overview')
const overview = ref<TenantOverview | null>(null)
const stores = ref<TenantStore[]>([])
const employees = ref<TenantEmployee[]>([])
const storesLoading = ref(false)
const employeesLoading = ref(false)

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

async function loadOverview() {
  loading.value = true
  try {
    const res: any = await apiTenant.platformOverview(tenantId)
    overview.value = res?.data ?? null
  }
  finally {
    loading.value = false
  }
}

async function loadStores() {
  storesLoading.value = true
  try {
    const res: any = await apiTenant.platformStores(tenantId)
    stores.value = res?.data?.list ?? []
  }
  finally {
    storesLoading.value = false
  }
}

async function loadEmployees() {
  employeesLoading.value = true
  try {
    const res: any = await apiTenant.platformEmployees(tenantId)
    employees.value = res?.data?.list ?? []
  }
  finally {
    employeesLoading.value = false
  }
}

onMounted(() => {
  loadOverview()
  loadStores()
  loadEmployees()
})

const storeColumns = computed<TableColumn<TenantStore>[]>(() => [
  { accessorKey: 'name', header: '门店名称' },
  { accessorKey: 'code', header: '编码' },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue()
      if (v === 'archived' || info.row.original.archived_at) {
        return '已归档'
      }
      return v === 'active' ? '启用' : '停用'
    },
  },
  { accessorKey: 'address', header: '地址' },
  { accessorKey: 'phone', header: '电话' },
])

const employeeColumns = computed<TableColumn<TenantEmployee>[]>(() => [
  { accessorKey: 'employeeNo', header: '工号' },
  { accessorKey: 'name', header: '姓名' },
  { accessorKey: 'title', header: '职位' },
  {
    accessorKey: 'roles',
    header: '角色',
    cell: (info: any) => (info.getValue() as string[] ?? []).join('、') || '-',
  },
  {
    accessorKey: 'stores',
    header: '归属门店',
    cell: (info: any) => (info.getValue() as Array<{ name: string }> ?? [])
      .map(s => s.name).join('、') || '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue()
      if (v === 'active') {
        return '在职'
      }
      return v === 'invited' ? '待入职' : (v === 'disabled' ? '已停用' : '已离职')
    },
  },
])

// ===== 停用/恢复 =====
const statusModal = ref(false)
const statusAction = ref<'suspend' | 'resume'>('suspend')
const statusReason = ref('')
const statusLoading = ref(false)

function openSuspend() {
  statusAction.value = 'suspend'
  statusReason.value = ''
  statusModal.value = true
}

function openResume() {
  statusAction.value = 'resume'
  statusReason.value = ''
  statusModal.value = true
}

async function submitStatus() {
  if (!statusReason.value.trim()) {
    useFaToast().warning('请填写操作原因')
    return
  }
  statusLoading.value = true
  try {
    if (statusAction.value === 'suspend') {
      await apiTenant.suspend(tenantId, statusReason.value.trim())
      useFaToast().success('租户已停用')
    }
    else {
      await apiTenant.resume(tenantId, statusReason.value.trim())
      useFaToast().success('租户已恢复')
    }
    statusModal.value = false
    loadOverview()
  }
  finally {
    statusLoading.value = false
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between">
      <FaButton variant="ghost" size="sm" class="mb-2" @click="router.back()">
        <FaIcon name="i-ri:arrow-left-line" />
        返回
      </FaButton>
    </div>

    <div v-loading="loading">
      <template v-if="overview">
        <div class="p-5 rounded-lg border bg-card">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h2 class="text-xl font-bold truncate">
                  {{ overview.name }}
                </h2>
                <FaTag :variant="STATUS_VARIANT[overview.status] ?? 'secondary'">
                  {{ STATUS_LABEL[overview.status] ?? overview.status }}
                </FaTag>
              </div>
              <div class="text-sm text-muted-foreground mt-1">
                简称：{{ overview.shortName || '-' }} · 标识：{{ overview.slug }}
              </div>
            </div>
            <div class="flex gap-2">
              <FaButton v-if="overview.status === 'suspended'" @click="openResume">
                <FaIcon name="i-ri:play-circle-line" />
                恢复租户
              </FaButton>
              <FaButton v-else variant="destructive" @click="openSuspend">
                <FaIcon name="i-ri:pause-circle-line" />
                停用租户
              </FaButton>
            </div>
          </div>

          <div class="gap-4 grid grid-cols-2 mt-5 sm:grid-cols-4">
            <div class="rounded-md bg-muted p-3">
              <div class="text-xs text-muted-foreground">
                门店数
              </div>
              <div class="text-lg font-semibold mt-1">
                {{ overview.storeCount }}
              </div>
            </div>
            <div class="rounded-md bg-muted p-3">
              <div class="text-xs text-muted-foreground">
                员工数
              </div>
              <div class="text-lg font-semibold mt-1">
                {{ overview.activeEmployeeCount }} / {{ overview.totalEmployeeCount }}
              </div>
            </div>
            <div class="rounded-md bg-muted p-3">
              <div class="text-xs text-muted-foreground">
                试用截止
              </div>
              <div class="text-lg font-semibold mt-1">
                {{ formatTime(overview.trialEndsAt) }}
              </div>
            </div>
            <div class="rounded-md bg-muted p-3">
              <div class="text-xs text-muted-foreground">
                创建时间
              </div>
              <div class="text-lg font-semibold mt-1">
                {{ formatTime(overview.createdAt) }}
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <FaPageMain class="mt-4">
      <FaTabs
        v-model="activeTab" :list="[
          { label: '概览', value: 'overview' },
          { label: '门店', value: 'stores' },
          { label: '人员', value: 'employees' },
        ]" class="mb-4"
      />

      <div v-if="activeTab === 'overview'" class="max-w-160">
        <div class="gap-x-8 gap-y-4 grid grid-cols-2">
          <FaLabel label="医院名称" class="block">
            <FaInput :model-value="overview?.name ?? ''" disabled class="w-full" />
          </FaLabel>
          <FaLabel label="简称" class="block">
            <FaInput :model-value="overview?.shortName ?? ''" disabled class="w-full" />
          </FaLabel>
          <FaLabel label="租户标识(slug)" class="block">
            <FaInput :model-value="overview?.slug ?? ''" disabled class="w-full" />
          </FaLabel>
          <FaLabel label="时区" class="block">
            <FaInput :model-value="overview?.timezone ?? ''" disabled class="w-full" />
          </FaLabel>
          <FaLabel label="货币" class="block">
            <FaInput :model-value="overview?.currency ?? ''" disabled class="w-full" />
          </FaLabel>
          <FaLabel label="区域设置" class="block">
            <FaInput :model-value="overview?.locale ?? ''" disabled class="w-full" />
          </FaLabel>
          <FaLabel label="试用截止" class="block">
            <FaInput :model-value="formatTime(overview?.trialEndsAt)" disabled class="w-full" />
          </FaLabel>
          <FaLabel label="最近更新" class="block">
            <FaInput :model-value="formatTime(overview?.updatedAt)" disabled class="w-full" />
          </FaLabel>
        </div>
      </div>

      <div v-else-if="activeTab === 'stores'">
        <FaTable
          v-loading="storesLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="storeColumns"
          :data="stores"
        />
      </div>

      <div v-else-if="activeTab === 'employees'">
        <FaTable
          v-loading="employeesLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="employeeColumns"
          :data="employees"
        />
      </div>
    </FaPageMain>

    <!-- 停用/恢复确认 -->
    <FaModal v-model="statusModal" :title="statusAction === 'suspend' ? '停用租户' : '恢复租户'" :footer="false" :close-on-click-overlay="false">
      <div class="py-2 space-y-4">
        <div class="text-sm">
          <span class="text-muted-foreground">对象：</span>
          <span class="font-medium">{{ overview?.name }}</span>
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
