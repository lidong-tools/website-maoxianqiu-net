<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiStore from '@/api/modules/store'

defineOptions({
  name: 'SystemStoreDetail',
})

interface StoreDetail {
  id: string
  name: string
  code: string | null
  status: string
  address: string
  phone: string
  timezone: string | null
  business_hours?: unknown
  archived_at: string | null
  created_at: string
  tenant_id: string
  tenantName?: string
}

interface StoreEmployee {
  id: string
  employeeNo: string
  name: string
  phone: string | null
  email: string | null
  title: string | null
  status: string
  createdAt: string
  isPrimary: boolean
  roles: string[]
}

const route = useRoute()
const router = useRouter()
const storeId = route.params.id as string

const loading = ref(false)
const activeTab = ref('overview')
const detail = ref<StoreDetail | null>(null)
const employees = ref<StoreEmployee[]>([])
const employeesLoading = ref(false)

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

async function loadDetail() {
  loading.value = true
  try {
    const res: any = await apiStore.detail(storeId)
    detail.value = res?.data ?? null
  }
  finally {
    loading.value = false
  }
}

async function loadEmployees() {
  employeesLoading.value = true
  try {
    const res: any = await apiStore.employees(storeId)
    employees.value = res?.data?.list ?? []
  }
  finally {
    employeesLoading.value = false
  }
}

onMounted(() => {
  loadDetail()
  loadEmployees()
})

const employeeColumns = computed<TableColumn<StoreEmployee>[]>(() => [
  {
    accessorKey: 'employeeNo',
    header: '工号',
  },
  {
    accessorKey: 'name',
    header: '姓名',
  },
  { accessorKey: 'title', header: '职位' },
  {
    accessorKey: 'roles',
    header: '角色',
    cell: (info: any) => (info.getValue() as string[] ?? []).join('、') || '-',
  },
  {
    accessorKey: 'isPrimary',
    header: '主力门店',
    cell: (info: any) => (info.getValue() ? '是' : '-'),
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
      <template v-if="detail">
        <div class="p-5 rounded-lg border bg-card">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h2 class="text-xl font-bold truncate">
                  {{ detail.name }}
                </h2>
                <FaTag :variant="detail.archived_at ? 'secondary' : 'default'">
                  {{ detail.archived_at ? '已归档' : '启用' }}
                </FaTag>
              </div>
              <div class="text-sm text-muted-foreground mt-1">
                {{ detail.code || '-' }}
                <span v-if="detail.tenantName"> · {{ detail.tenantName }}</span>
              </div>
            </div>
          </div>

          <div class="gap-x-8 gap-y-4 grid grid-cols-2 mt-5 sm:grid-cols-3">
            <FaLabel label="地址" class="block">
              <FaInput :model-value="detail.address || '-'" disabled class="w-full" />
            </FaLabel>
            <FaLabel label="电话" class="block">
              <FaInput :model-value="detail.phone || '-'" disabled class="w-full" />
            </FaLabel>
            <FaLabel label="时区" class="block">
              <FaInput :model-value="detail.timezone || '-'" disabled class="w-full" />
            </FaLabel>
            <FaLabel label="创建时间" class="block">
              <FaInput :model-value="formatTime(detail.created_at)" disabled class="w-full" />
            </FaLabel>
          </div>
        </div>
      </template>
    </div>

    <FaPageMain class="mt-4">
      <FaTabs
        v-model="activeTab" :list="[
          { label: '概览', value: 'overview' },
          { label: '人员', value: 'employees' },
        ]" class="mb-4"
      />

      <div v-if="activeTab === 'employees'">
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
  </div>
</template>
