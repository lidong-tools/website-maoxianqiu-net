<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiApp from '@/api/modules/app'
import apiStore from '@/api/modules/store'
import apiUser from '@/api/modules/user'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import PasswordForm from './components/PasswordForm.vue'
import RoleChangeForm from './components/RoleChangeForm.vue'
import UserForm from './components/UserForm.vue'

defineOptions({
  name: 'SystemUser',
})

/**
 * MXQ-3010:员工模型适配
 * 新模型 employees 含 assignments:employee_store_assignments 和 roles:employee_role_assignments
 * 兼容旧模型 store_members(profiles/roles/stores 扁平结构)
 */
interface EmployeeAssignment {
  id: string
  store_id: string
  is_primary: boolean
  stores: { id: string, name: string, code: string } | null
}

interface EmployeeRoleAssignment {
  id: string
  role_id: string
  store_id: string | null
  roles: { id: string, code: string, name: string } | null
}

interface EmployeeItem {
  id: string
  tenant_id: string
  user_id: string
  employee_no: string
  name: string
  phone: string | null
  email: string | null
  title: string | null
  status: string
  assignments?: EmployeeAssignment[]
  roles?: EmployeeRoleAssignment[]
}

interface LegacyMembershipItem {
  id: string
  user_id: string
  store_id: string
  role_id: string
  status: string
  profiles?: {
    id: string
    account: string
    real_name: string
    phone: string
    avatar: string
    status: string
  }
  roles?: { code: string, name: string }
  stores?: { name: string, code: string }
}

/** 列表统一渲染行:新模型(employee)与旧模型(membership)归一为同一结构 */
interface DisplayRow {
  id: string
  userId: string
  account: string
  name: string
  phone: string
  storeName: string
  roleName: string
  status: string
  isNewModel: boolean
  employee?: EmployeeItem
  membership?: LegacyMembershipItem
}

const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<Array<EmployeeItem | LegacyMembershipItem>>([])
const useNewModel = ref(false)

const isAdmin = ref(false)
// 复审审计(S3.1-Fix-Reaudit-v3 §6):computed 而非 ref+onMounted,切租户即时响应,不保留旧 Tenant 快照
const currentTenantId = computed(() => tenantStore.currentTenantId)
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const currentStoreId = ref('')
const search = ref({
  keyword: '',
})

/** 统一渲染:把新/旧模型行归一为显示字段 */
function displayRow(row: EmployeeItem | LegacyMembershipItem): DisplayRow {
  if ('employee_no' in row) {
    // 新模型
    const emp = row as EmployeeItem
    const primaryAssignment = emp.assignments?.find(a => a.is_primary) ?? emp.assignments?.[0]
    const primaryRole = emp.roles?.[0]
    return {
      id: emp.id,
      userId: emp.user_id,
      account: emp.email ?? emp.employee_no,
      name: emp.name,
      phone: emp.phone ?? '-',
      storeName: primaryAssignment?.stores?.name ?? '-',
      roleName: primaryRole?.roles?.name ?? '-',
      status: emp.status,
      isNewModel: true,
      employee: emp,
    }
  }
  // 旧模型
  const legacy = row as LegacyMembershipItem
  return {
    id: legacy.id,
    userId: legacy.user_id,
    account: legacy.profiles?.account ?? '-',
    name: legacy.profiles?.real_name ?? '-',
    phone: legacy.profiles?.phone ?? '-',
    storeName: legacy.stores?.name ?? '-',
    roleName: legacy.roles?.name ?? '-',
    status: legacy.profiles?.status ?? 'active',
    isNewModel: false,
    membership: legacy,
  }
}

const tableColumns = computed<TableColumn<DisplayRow>[]>(() => [
  {
    accessorKey: 'account',
    header: '账号',
  },
  {
    accessorKey: 'name',
    header: '姓名',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'phone',
    header: '手机号',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'storeName',
    header: '门店',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'roleName',
    header: '角色',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const v = info.getValue() as string
      const map: Record<string, string> = {
        active: '启用',
        disabled: '停用',
        resigned: '离职',
        invited: '邀请中',
      }
      return map[v] ?? v
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 120,
    align: 'center',
    fixed: 'right',
  },
])

onMounted(async () => {
  // 审计 S3.1 P0-03:currentTenantId 统一取自全局 Tenant Store(与顶部工具栏上下文一致),
  // 不再以 memberships[0] 作为当前租户决策来源。

  // 账号级角色判断(管理员可管理全部门店),仅影响表单门店下拉,不作租户决策
  const res: any = await apiApp.profile()
  const memberships = res.data.memberships ?? []
  // 兼容新模型 memberships(含 roles 数组对象)与旧模型(roles 是 {code,name})
  isAdmin.value = memberships.some((item: any) => {
    const roleCode = item.roles?.code ?? (Array.isArray(item.roles) ? item.roles[0]?.code : null)
    return roleCode === 'system_admin'
  })

  if (isAdmin.value) {
    const storeRes: any = await apiStore.list()
    const stores = storeRes.data.list ?? []
    storeOptions.value = [
      { label: '全部门店', value: '' },
      ...stores.map((store: any) => ({ label: store.name, value: store.id })),
    ]
  }
  else {
    storeOptions.value = memberships
      .filter((item: any) => {
        const roleCode = item.roles?.code ?? (Array.isArray(item.roles) ? item.roles[0]?.code : null)
        return roleCode === 'store_manager' || roleCode === 'tenant_manager'
      })
      .map((item: any) => ({ label: item.stores?.name ?? '', value: item.store_id }))
  }

  currentStoreId.value = storeOptions.value[0]?.value ?? ''
  getDataList()
})

// 复审审计 §6:切租户时重置门店筛选并重载,避免残留旧租户数据
watch(currentTenantId, () => {
  currentStoreId.value = storeOptions.value[0]?.value ?? ''
  getDataList()
})

function getDataList() {
  loading.value = true
  const params: any = {
    ...getParams(),
    ...(search.value.keyword && { keyword: search.value.keyword }),
  }
  if (currentStoreId.value) {
    params.storeId = currentStoreId.value
  }
  if (currentTenantId.value) {
    params.tenantId = currentTenantId.value
  }
  apiUser.list(params).then((res: any) => {
    loading.value = false
    dataList.value = res.data.list ?? []
    pagination.value.total = res.data.total
    // 检测是否新模型(行含 employee_no 字段)
    useNewModel.value = dataList.value.length > 0 && 'employee_no' in dataList.value[0]
  })
}

function sizeChange(size: number) {
  onSizeChange(size).then(() => getDataList())
}

function currentChange(page = 1) {
  onCurrentChange(page).then(() => getDataList())
}

function searchReset() {
  search.value.keyword = ''
  currentChange()
}

// 新增/编辑用户
const userFormRef = ref<InstanceType<typeof UserForm>>()
const userEditId = ref('')
const { open: openUserModal, update: updateUserModal } = useFaModal().create({
  destroyOnClose: true,
  closeOnClickOverlay: false,
  closeOnPressEscape: false,
  beforeClose: (action, done) => {
    if (action === 'confirm') {
      userFormRef.value?.submit().then((success) => {
        if (!success) {
          return
        }
        getDataList()
        done()
      })
    }
    else {
      done()
    }
  },
  content: () => h(UserForm, {
    ref: userFormRef,
    id: userEditId.value,
    storeId: currentStoreId.value,
    storeOptions: storeOptions.value.filter((item) => {
      return isAdmin.value ? item.value !== '' : true
    }),
  }),
})

function onCreate() {
  userEditId.value = ''
  updateUserModal({
    title: '新增用户',
  })
  openUserModal()
}

function onEditUser(row: DisplayRow) {
  userEditId.value = row.userId
  updateUserModal({
    title: '编辑用户',
  })
  openUserModal()
}

// 改角色
const roleFormRef = ref<InstanceType<typeof RoleChangeForm>>()
const roleProps = ref({
  membershipId: '',
  roleId: '',
})
const { open: openRoleModal, update: updateRoleModal } = useFaModal().create({
  destroyOnClose: true,
  closeOnClickOverlay: false,
  closeOnPressEscape: false,
  beforeClose: (action, done) => {
    if (action === 'confirm') {
      roleFormRef.value?.submit().then((success) => {
        if (!success) {
          return
        }
        getDataList()
        done()
      })
    }
    else {
      done()
    }
  },
  content: () => h(RoleChangeForm, {
    ref: roleFormRef,
    membershipId: roleProps.value.membershipId,
    roleId: roleProps.value.roleId,
  }),
})

function onChangeRole(row: DisplayRow) {
  roleProps.value.membershipId = row.id
  roleProps.value.roleId = row.isNewModel
    ? (row.employee?.roles?.[0]?.role_id ?? '')
    : (row.membership?.role_id ?? '')
  updateRoleModal({
    title: '修改角色',
  })
  openRoleModal()
}

// 重置密码
const passwordFormRef = ref<InstanceType<typeof PasswordForm>>()
const passwordUserId = ref('')
const { open: openPasswordModal, update: updatePasswordModal } = useFaModal().create({
  destroyOnClose: true,
  closeOnClickOverlay: false,
  closeOnPressEscape: false,
  beforeClose: (action, done) => {
    if (action === 'confirm') {
      passwordFormRef.value?.submit().then((success) => {
        if (!success) {
          return
        }
        done()
      })
    }
    else {
      done()
    }
  },
  content: () => h(PasswordForm, {
    ref: passwordFormRef,
    id: passwordUserId.value,
  }),
})

function onResetPassword(row: DisplayRow) {
  passwordUserId.value = row.userId
  updatePasswordModal({
    title: '重置密码',
  })
  openPasswordModal()
}

/**
 * MXQ-3010:启用/停用员工
 * 新模型走 setStatus RPC;旧模型走 profiles.update
 */
function onToggleStatus(row: DisplayRow) {
  const next = row.status === 'active' ? 'disabled' : 'active'
  useFaModal().confirm({
    title: '确认信息',
    content: `确认${next === 'active' ? '启用' : '停用'}账号「${row.account}」吗？`,
    onConfirm: () => {
      if (row.isNewModel) {
        // 新模型:走 setStatus RPC
        apiUser.setStatus({
          employeeId: row.id,
          status: next as 'active' | 'disabled',
        }).then(() => {
          getDataList()
          useFaToast().success('操作成功')
        })
      }
      else {
        // 旧模型:直连 profiles.update
        apiUser.update({
          id: row.userId,
          status: next,
        }).then(() => {
          getDataList()
          useFaToast().success('操作成功')
        })
      }
    },
  })
}

/**
 * MXQ-3010:移除成员
 * 新模型:取消门店分配(removeStore RPC)
 * 旧模型:删除 store_members 记录
 */
function onRemoveMember(row: DisplayRow) {
  useFaModal().confirm({
    title: '确认信息',
    content: `确认将「${row.account}」移出「${row.storeName}」吗？`,
    onConfirm: () => {
      if (row.isNewModel && currentStoreId.value) {
        apiUser.removeStore({
          employeeId: row.id,
          storeId: currentStoreId.value,
        }).then(() => {
          getDataList()
          useFaToast().success('已移除')
        })
      }
      else if (!row.isNewModel) {
        // 旧模型:通过 store_members 删除(暂保留直连,RLS 兜底)
        useFaToast().info('旧模型数据请通过数据库管理')
      }
    },
  })
}
</script>

<template>
  <div>
    <EntityPageHeader compact title="用户管理" description="维护员工档案与门店角色分配;店长管理本店成员,运维管理员可跨门店管理" />
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="门店" class="col-span-1">
              <FaSelect v-model="currentStoreId" :options="storeOptions" class="w-full" @change="currentChange()" />
            </FaLabel>
            <FaLabel label="关键词" class="col-span-1">
              <FaInput
                v-model="search.keyword"
                placeholder="账号/姓名/工号"
                clearable
                class="w-full"
                @keydown.enter="currentChange()"
                @clear="currentChange()"
              />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton variant="outline" @click="searchReset()">
                重置
              </FaButton>
              <FaButton type="primary" @click="currentChange()">
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
        :data="dataList.map(displayRow)"
      >
        <template #toolbar>
          <FaButton @click="onCreate">
            新增用户
          </FaButton>
        </template>
        <template #cell-operation="{ row }">
          <div class="flex-center gap-2">
            <FaDropdown
              :items="[[
                { label: '编辑资料', handle: () => onEditUser(row.original) },
                { label: '修改角色', handle: () => onChangeRole(row.original) },
                { label: '重置密码', handle: () => onResetPassword(row.original) },
                { label: row.original.status === 'active' ? '停用账号' : '启用账号', handle: () => onToggleStatus(row.original) },
                { label: '移出门店', variant: 'destructive', handle: () => onRemoveMember(row.original) },
              ]]"
            >
              <FaButton variant="outline" size="icon-sm">
                <FaIcon name="i-ri:more-line" />
              </FaButton>
            </FaDropdown>
          </div>
        </template>
      </FaTable>
      <FaPagination :page="pagination.page" :size="pagination.size" :total="pagination.total" class="mt-2" @page-change="currentChange" @size-change="sizeChange" />
    </FaPageMain>
  </div>
</template>
