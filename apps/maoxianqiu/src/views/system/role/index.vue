<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiRole from '@/api/modules/role'
import RoleForm from './components/RoleForm.vue'

defineOptions({
  name: 'SystemRole',
})

interface RoleItem {
  id: string
  code: string
  name: string
  description: string
  permissions: string[]
  permission_codes: string[]
  is_system: boolean
}

const loading = ref(false)
const dataList = ref<RoleItem[]>([])

const tableColumns = computed<TableColumn<RoleItem>[]>(() => [
  { accessorKey: 'name', header: '角色名称' },
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'description', header: '描述' },
  {
    // MXQ-3010:显示聚合权限码数量
    accessorKey: 'permission_codes',
    header: '权限',
    cell: (info: any) => {
      const codes = info.getValue() ?? info.row.original.permissions ?? []
      return `${codes.length} 项`
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

function getDataList() {
  loading.value = true
  apiRole.list().then((res: any) => {
    loading.value = false
    dataList.value = res.data ?? []
  })
}

onMounted(getDataList)

const formRef = ref<InstanceType<typeof RoleForm>>()
const editId = ref('')

const { open: openModal, update: updateModal } = useFaModal().create({
  destroyOnClose: true,
  closeOnClickOverlay: false,
  closeOnPressEscape: false,
  beforeClose: (action, done) => {
    if (action === 'confirm') {
      formRef.value?.submit().then((success) => {
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
  content: () => h(RoleForm, {
    ref: formRef,
    id: editId.value,
  }),
})

function onCreate() {
  editId.value = ''
  updateModal({
    title: '新增角色',
  })
  openModal()
}

function onEdit(row: RoleItem) {
  editId.value = row.id
  updateModal({
    title: '编辑角色',
  })
  openModal()
}

function onDel(row: RoleItem) {
  useFaModal().confirm({
    title: '确认信息',
    content: `确认删除角色「${row.name}」吗？`,
    onConfirm: () => {
      apiRole.delete(row.id).then(() => {
        getDataList()
        useFaToast().success('删除成功')
      })
    },
  })
}
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="角色管理" class="mb-0">
      <template #description>
        配置角色与权限;内置角色(店长/店员/收银员等)不可删除
      </template>
    </FaPageHeader>
    <FaPageMain>
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
            新增角色
          </FaButton>
        </template>
        <template #cell-operation="{ row }">
          <div class="flex-center gap-2">
            <FaButton variant="outline" size="icon-sm" @click="onEdit(row.original)">
              <FaIcon name="i-ri:edit-line" />
            </FaButton>
            <FaDropdown
              v-if="!row.original.is_system"
              :items="[[
                { label: '删除', variant: 'destructive', handle: () => onDel(row.original) },
              ]]"
            >
              <FaButton variant="outline" size="icon-sm">
                <FaIcon name="i-ri:more-line" />
              </FaButton>
            </FaDropdown>
          </div>
        </template>
      </FaTable>
    </FaPageMain>
  </div>
</template>
