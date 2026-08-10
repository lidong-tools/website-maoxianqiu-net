<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { Warehouse } from '@/types/inventory'
import apiStore from '@/api/modules/store'
import apiInventory from '@/api/modules/inventory'

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
const { auth } = useAppAuth()

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

// ===== 仓库 Tab =====
const warehouses = ref<Warehouse[]>([])
const warehousesLoading = ref(false)

async function loadWarehouses() {
  warehousesLoading.value = true
  try {
    const res: any = await apiInventory.listWarehouses(storeId)
    warehouses.value = res?.data?.list ?? []
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载仓库失败')
  }
  finally {
    warehousesLoading.value = false
  }
}

const warehouseColumns = computed<TableColumn<Warehouse>[]>(() => [
  { accessorKey: 'name', header: '仓库名称' },
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'is_default', header: '类型' },
  { accessorKey: 'is_active', header: '状态' },
  {
    id: 'operation',
    header: '操作',
    width: 160,
    align: 'center',
    fixed: 'right',
  },
])

const warehouseFormVisible = ref(false)
const warehouseEditingId = ref('')
const warehouseSubmitting = ref(false)
const warehouseForm = reactive({
  name: '',
  code: '',
  isDefault: false,
})

function openWarehouseCreate() {
  warehouseEditingId.value = ''
  Object.assign(warehouseForm, { name: '', code: '', isDefault: false })
  warehouseFormVisible.value = true
}

function openWarehouseEdit(row: Warehouse) {
  warehouseEditingId.value = row.id
  Object.assign(warehouseForm, {
    name: row.name,
    code: row.code,
    isDefault: row.is_default,
  })
  warehouseFormVisible.value = true
}

async function submitWarehouse() {
  if (!detail.value?.tenant_id) {
    useFaToast().warning('门店信息加载中,请稍后再试')
    return
  }
  if (!warehouseForm.name.trim()) {
    useFaToast().warning('请填写仓库名称')
    return
  }
  if (!warehouseForm.code.trim()) {
    useFaToast().warning('请填写仓库编码')
    return
  }
  warehouseSubmitting.value = true
  const payload = {
    tenantId: detail.value.tenant_id,
    storeId,
    name: warehouseForm.name.trim(),
    code: warehouseForm.code.trim(),
    isDefault: warehouseForm.isDefault,
  }
  try {
    if (warehouseEditingId.value) {
      await apiInventory.updateWarehouse({ ...payload, id: warehouseEditingId.value })
      useFaToast().success('仓库已更新')
    }
    else {
      await apiInventory.createWarehouse(payload)
      useFaToast().success('仓库已创建')
    }
    warehouseFormVisible.value = false
    await loadWarehouses()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
  finally {
    warehouseSubmitting.value = false
  }
}

async function toggleWarehouseStatus(row: Warehouse) {
  if (!detail.value?.tenant_id) {
    useFaToast().warning('门店信息加载中,请稍后再试')
    return
  }
  const next = !row.is_active
  try {
    await apiInventory.setWarehouseStatus({
      id: row.id,
      tenantId: detail.value.tenant_id,
      storeId,
      isActive: next,
    })
    useFaToast().success(next ? '已启用' : '已停用')
    await loadWarehouses()
  }
  catch {
    // 错误已由 axios 拦截器统一提示
  }
}

onMounted(() => {
  loadDetail()
  loadEmployees()
  loadWarehouses()
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
          { label: '仓库', value: 'warehouses' },
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

      <div v-if="activeTab === 'warehouses'">
        <div class="mb-3 flex items-center justify-between">
          <div class="text-sm text-muted-foreground">
            仓库为门店级库存归属,每门店仅一个默认仓库;停用后不可用于入库/发药/调拨等业务
          </div>
          <FaButton v-if="auth('inventory.manage')" type="primary" @click="openWarehouseCreate">
            <FaIcon name="i-ri:add-line" />
            新增仓库
          </FaButton>
        </div>
        <FaTable
          v-loading="warehousesLoading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="warehouseColumns"
          :data="warehouses"
          empty-text="暂无仓库"
        >
          <template #cell-is_default="{ value }">
            <span v-if="value" class="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs text-green-600">
              默认仓库
            </span>
            <span v-else class="text-muted-foreground text-sm">普通仓库</span>
          </template>
          <template #cell-is_active="{ value }">
            <FaTag :variant="value ? 'default' : 'secondary'">
              {{ value ? '启用' : '停用' }}
            </FaTag>
          </template>
          <template #cell-operation="{ row }">
            <div class="flex-center gap-1">
              <FaButton
                variant="outline"
                size="sm"
                :disabled="!auth('inventory.manage')"
                @click="openWarehouseEdit(row.original)"
              >
                编辑
              </FaButton>
              <FaButton
                variant="outline"
                size="sm"
                :disabled="!auth('inventory.manage')"
                :class="row.original.is_active ? 'text-red-600' : 'text-green-600'"
                @click="toggleWarehouseStatus(row.original)"
              >
                {{ row.original.is_active ? '停用' : '启用' }}
              </FaButton>
            </div>
          </template>
        </FaTable>
      </div>
    </FaPageMain>

    <!-- 新增/编辑仓库弹窗 -->
    <FaModal
      v-model="warehouseFormVisible"
      :title="warehouseEditingId ? '编辑仓库' : '新增仓库'"
      :footer="false"
      :close-on-click-overlay="false"
    >
      <div class="py-2 space-y-4">
        <FaLabel label="仓库名称 *" class="block">
          <FaInput v-model="warehouseForm.name" placeholder="如 药房仓 / 耗材仓 / 零售仓" class="w-full" />
        </FaLabel>
        <FaLabel label="仓库编码 *" class="block">
          <FaInput v-model="warehouseForm.code" placeholder="同一门店内唯一,如 WH-DRUG" class="w-full" />
        </FaLabel>
        <FaLabel label="设为默认仓库" class="block">
          <div class="flex items-center gap-2">
            <FaSwitch v-model="warehouseForm.isDefault" />
            <span class="text-sm text-muted-foreground">每门店仅一个默认仓库</span>
          </div>
        </FaLabel>
        <div class="pt-2 flex gap-2 justify-end">
          <FaButton variant="outline" @click="warehouseFormVisible = false">
            取消
          </FaButton>
          <FaButton :loading="warehouseSubmitting" @click="submitWarehouse">
            保存
          </FaButton>
        </div>
      </div>
    </FaModal>
  </div>
</template>
