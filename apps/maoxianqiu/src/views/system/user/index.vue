<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiApp from '@/api/modules/app'
import apiStore from '@/api/modules/store'
import apiUser from '@/api/modules/user'
import PasswordForm from './components/PasswordForm.vue'
import RoleChangeForm from './components/RoleChangeForm.vue'
import UserForm from './components/UserForm.vue'

defineOptions({
  name: 'SystemUser',
})

interface MembershipItem {
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
  roles?: {
    code: string
    name: string
  }
  stores?: {
    name: string
    code: string
  }
}

const { pagination, getParams, onSizeChange, onCurrentChange } = usePagination()

const loading = ref(false)
const dataList = ref<MembershipItem[]>([])

const isAdmin = ref(false)
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const currentStoreId = ref('')
const search = ref({
  keyword: '',
})

const tableColumns = computed<TableColumn<MembershipItem>[]>(() => [
  {
    accessorKey: 'profiles',
    header: '账号',
    cell: (info: any) => info.getValue()?.account ?? '',
  },
  {
    accessorKey: 'profiles',
    header: '姓名',
    cell: (info: any) => info.getValue()?.real_name ?? '-',
  },
  {
    accessorKey: 'profiles',
    header: '手机号',
    cell: (info: any) => info.getValue()?.phone ?? '-',
  },
  {
    accessorKey: 'stores',
    header: '店铺',
    cell: (info: any) => info.getValue()?.name ?? '-',
  },
  {
    accessorKey: 'roles',
    header: '角色',
    cell: (info: any) => info.getValue()?.name ?? '-',
  },
  {
    accessorKey: 'profiles',
    header: '状态',
    cell: (info: any) => (info.getValue()?.status === 'active' ? '启用' : '停用'),
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
  const res: any = await apiApp.profile()
  const memberships = res.data.memberships ?? []
  isAdmin.value = memberships.some((item: any) => item.roles?.code === 'system_admin')

  if (isAdmin.value) {
    const storeRes: any = await apiStore.list()
    const stores = storeRes.data.list ?? []
    storeOptions.value = [
      { label: '全部店铺', value: '' },
      ...stores.map((store: any) => ({ label: store.name, value: store.id })),
    ]
  }
  else {
    storeOptions.value = memberships
      .filter((item: any) => item.roles?.code === 'store_manager')
      .map((item: any) => ({ label: item.stores?.name ?? '', value: item.store_id }))
  }

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
  apiUser.list(params).then((res: any) => {
    loading.value = false
    dataList.value = res.data.list
    pagination.value.total = res.data.total
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

// 新增用户
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

function onEditUser(row: MembershipItem) {
  userEditId.value = row.user_id
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

function onChangeRole(row: MembershipItem) {
  roleProps.value.membershipId = row.id
  roleProps.value.roleId = row.role_id
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

function onResetPassword(row: MembershipItem) {
  passwordUserId.value = row.user_id
  updatePasswordModal({
    title: '重置密码',
  })
  openPasswordModal()
}

// 启用/禁用
function onToggleStatus(row: MembershipItem) {
  const next = row.profiles?.status === 'active' ? 'disabled' : 'active'
  useFaModal().confirm({
    title: '确认信息',
    content: `确认${next === 'active' ? '启用' : '停用'}账号「${row.profiles?.account}」吗？`,
    onConfirm: () => {
      apiUser.update({
        id: row.user_id,
        status: next,
      }).then(() => {
        getDataList()
        useFaToast().success('操作成功')
      })
    },
  })
}

// 移除成员
function onRemoveMember(row: MembershipItem) {
  useFaModal().confirm({
    title: '确认信息',
    content: `确认将「${row.profiles?.account}」移出「${row.stores?.name ?? ''}」吗？`,
    onConfirm: () => {
      apiUser.membershipRemove(row.id).then(() => {
        getDataList()
        useFaToast().success('已移除')
      })
    },
  })
}
</script>

<template>
  <div>
    <FaPageHeader title="用户管理" class="mb-0">
      <template #description>
        维护店铺成员与角色;店长管理本店成员,运维管理员可跨店铺管理
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="店铺" class="col-span-1">
              <FaSelect v-model="currentStoreId" :options="storeOptions" class="w-full" @change="currentChange()" />
            </FaLabel>
            <FaLabel label="关键词" class="col-span-1">
              <FaInput
                v-model="search.keyword"
                placeholder="账号/姓名"
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
        :data="dataList"
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
                { label: row.original.profiles?.status === 'active' ? '停用账号' : '启用账号', handle: () => onToggleStatus(row.original) },
                { label: '移出店铺', variant: 'destructive', handle: () => onRemoveMember(row.original) },
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
