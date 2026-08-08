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
  <div>
    <EntityPageHeader compact title="店铺管理" description="管理各宠物医院门店信息;归档门店不可用于业务,可恢复" />
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="关键词" class="col-span-1">
              <FaInput
                v-model="search.keyword"
                placeholder="店铺名称/编码"
                clearable
                class="w-full"
                @keydown.enter="getDataList"
                @clear="getDataList"
              />
            </FaLabel>
            <FaLabel label="显示已归档" class="col-span-1">
              <FaSwitch v-model="includeArchived" @change="getDataList" />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton variant="outline" @click="search.keyword = ''; getDataList()">
                重置
              </FaButton>
              <FaButton type="primary" @click="getDataList">
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
            新增店铺
          </FaButton>
        </template>
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
    </FaPageMain>
  </div>
</template>
