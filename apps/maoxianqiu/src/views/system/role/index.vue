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
  <!-- 标准布局:外层固定高度 + 白底卡片(无筛选/分页,保留表格工具栏) -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告 #8) -->
    <!--
    <EntityPageHeader compact title="角色管理" description="配置角色与权限;内置角色(店长/店员/收银员等)不可删除" />
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
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
        </div>
      </div>
    </div>
  </div>
</template>
