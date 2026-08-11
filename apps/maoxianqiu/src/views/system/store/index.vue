<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiStore from '@/api/modules/store'
import StoreForm from './components/StoreForm.vue'

defineOptions({
  name: 'SystemStore',
})

const router = useRouter()

interface StoreItem {
  id: string
  name: string
  code: string
  address: string
  phone: string
  status: string
  archived_at: string | null
  tenant_id?: string
}

const loading = ref(false)
const dataList = ref<StoreItem[]>([])
const includeArchived = ref(false)
const search = ref({
  keyword: '',
})

const tableColumns = computed<TableColumn<StoreItem>[]>(() => [
  { accessorKey: 'name', header: '店铺名称' },
  { accessorKey: 'code', header: '编码' },
  { accessorKey: 'address', header: '地址' },
  { accessorKey: 'phone', header: '电话' },
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
  {
    id: 'operation',
    header: '操作',
    width: 140,
    align: 'center',
    fixed: 'right',
  },
])

function getDataList() {
  loading.value = true
  apiStore.list({
    keyword: search.value.keyword,
    includeArchived: includeArchived.value,
  }).then((res: any) => {
    loading.value = false
    dataList.value = res.data.list ?? []
  })
}

onMounted(getDataList)

const formRef = ref<InstanceType<typeof StoreForm>>()
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
  content: () => h(StoreForm, {
    ref: formRef,
    id: editId.value,
  }),
})

function onCreate() {
  editId.value = ''
  updateModal({
    title: '新增店铺',
  })
  openModal()
}

function onEdit(row: StoreItem) {
  editId.value = row.id
  updateModal({
    title: '编辑店铺',
  })
  openModal()
}

/** S3.1-A:门店详情页(概览/人员) */
function goDetail(row: StoreItem) {
  router.push({ name: 'systemStoreDetail', params: { id: row.id } })
}

/**
 * MXQ-3008:归档门店(替代物理删除)
 * 走 Hono Command + archive_store RPC
 */
function onArchive(row: StoreItem) {
  useFaModal().confirm({
    title: '确认归档',
    content: `确认归档店铺「${row.name}」吗？归档后不可用于业务,可在"显示已归档"中恢复。`,
    onConfirm: () => {
      apiStore.archive(row.id).then(() => {
        getDataList()
        useFaToast().success('已归档')
      })
    },
  })
}

/**
 * MXQ-3008:恢复门店
 * 走 Hono Command + restore_store RPC
 */
function onRestore(row: StoreItem) {
  useFaModal().confirm({
    title: '确认恢复',
    content: `确认恢复店铺「${row.name}」吗？`,
    onConfirm: () => {
      apiStore.restore(row.id).then(() => {
        getDataList()
        useFaToast().success('已恢复')
      })
    },
  })
}
</script>

<template>
  <!-- 标准布局:外层固定高度 + 白底卡片,FaSearchBar 展开为卡片内联布局(左筛选右按钮) -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告 #8) -->
    <!--
    <EntityPageHeader compact title="店铺管理" description="管理各宠物医院门店信息;归档门店不可用于业务,可恢复" />
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 筛选区:左筛选控件,右功能按钮 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 flex flex-wrap gap-3 items-center">
            <FaInput
              v-model="search.keyword"
              placeholder="店铺名称/编码"
              class="w-64"
              clearable
              @keydown.enter="getDataList"
              @clear="getDataList"
            />
            <div class="flex gap-2 items-center">
              <span class="text-sm text-muted-foreground">显示已归档</span>
              <FaSwitch v-model="includeArchived" @change="getDataList" />
            </div>
            <FaButton size="sm" @click="onCreate">
              新增店铺
            </FaButton>
            <div class="ml-auto flex gap-2 items-center">
              <FaButton size="sm" variant="outline" @click="search.keyword = ''; getDataList()">
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
            <template #cell-operation="{ row }">
              <div class="flex-center gap-2">
                <FaButton variant="outline" size="icon-sm" title="详情" @click="goDetail(row.original)">
                  <FaIcon name="i-ri:eye-line" />
                </FaButton>
                <FaButton variant="outline" size="icon-sm" title="编辑" @click="onEdit(row.original)">
                  <FaIcon name="i-ri:edit-line" />
                </FaButton>
                <FaDropdown
                  :items="[[
                    row.original.archived_at
                      ? { label: '恢复', handle: () => onRestore(row.original) }
                      : { label: '归档', variant: 'destructive', handle: () => onArchive(row.original) },
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
