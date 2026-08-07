<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { ShiftHandover, ShiftType } from '@/types/inpatient'
import apiInpatient from '@/api/modules/inpatient'
import BusinessEmployeePicker from '@/components/business/EmployeePicker/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { SHIFT_TYPE_LABELS } from '@/types/inpatient'

defineOptions({
  name: 'InpatientHandover',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const submitting = ref(false)

// 交接班列表
const handovers = ref<ShiftHandover[]>([])

// 新建/编辑交接班表单
const form = reactive({
  shiftDate: new Date().toISOString().slice(0, 10),
  shiftType: 'morning' as ShiftType,
  outgoingUser: '',
  incomingUser: '',
  // summary 以文本形式编辑,提交时解析为 JSON
  summaryText: '',
})

/** 班次选项 */
const shiftTypeOptions = computed(() =>
  Object.entries(SHIFT_TYPE_LABELS).map(([value, label]) => ({ value, label })),
)

const tableColumns = computed<TableColumn<ShiftHandover>[]>(() => [
  {
    accessorKey: 'shift_date',
    header: '班次日期',
    cell: (info: any) => info.getValue() ?? '-',
  },
  {
    accessorKey: 'shift_type',
    header: '班次',
    cell: (info: any) => SHIFT_TYPE_LABELS[info.getValue() as keyof typeof SHIFT_TYPE_LABELS] ?? info.getValue(),
  },
  {
    accessorKey: 'outgoing_user',
    header: '交班人',
    cell: (info: any) => info.getValue() ? info.getValue().slice(0, 8) : '-',
  },
  {
    accessorKey: 'incoming_user',
    header: '接班人',
    cell: (info: any) => info.getValue() ? info.getValue().slice(0, 8) : '-',
  },
  {
    accessorKey: 'acknowledged_at',
    header: '确认时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '未确认',
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 160,
    align: 'center',
    fixed: 'right',
  },
])

/**
 * 加载交接班列表
 * 默认查询当前门店当日及以后的交接班记录
 */
async function loadData() {
  if (!tenantStore.currentStoreId) {
    useFaToast().warning('请先选择工作门店')
    return
  }
  loading.value = true
  try {
    const res = await apiInpatient.listHandovers(tenantStore.currentStoreId, form.shiftDate)
    handovers.value = res.data.list
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载交接班列表失败')
  }
  finally {
    loading.value = false
  }
}

/**
 * 创建/保存交接班
 * 走 Hono Command + create_handover RPC,同班次已存在则更新 summary
 */
async function onSubmit() {
  if (!form.shiftDate) {
    useFaToast().warning('请选择班次日期')
    return
  }
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择工作门店')
    return
  }

  // 将文本形式 summary 解析为 JSON;解析失败则包裹为 { note: text }
  let summary: Record<string, unknown> = {}
  const text = form.summaryText.trim()
  if (text) {
    try {
      summary = JSON.parse(text)
    }
    catch {
      summary = { note: text }
    }
  }

  submitting.value = true
  try {
    await apiInpatient.createHandover({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId,
      shiftDate: form.shiftDate,
      shiftType: form.shiftType,
      outgoingUser: form.outgoingUser.trim() || undefined,
      incomingUser: form.incomingUser.trim() || undefined,
      summary,
    })
    useFaToast().success('交接班已保存')
    await loadData()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

/**
 * 查看交接班详情(展示 summary JSON)
 */
function onView(row: ShiftHandover) {
  const summaryStr = JSON.stringify(row.summary ?? {}, null, 2)
  useFaModal().info({
    title: `交接班详情 - ${SHIFT_TYPE_LABELS[row.shift_type]}`,
    content: summaryStr || '(无内容)',
  })
}

/**
 * 加载某条交接班到表单(便于编辑后重新保存)
 */
function onEdit(row: ShiftHandover) {
  form.shiftDate = row.shift_date
  form.shiftType = row.shift_type
  form.outgoingUser = row.outgoing_user ?? ''
  form.incomingUser = row.incoming_user ?? ''
  form.summaryText = Object.keys(row.summary ?? {}).length > 0
    ? JSON.stringify(row.summary, null, 2)
    : ''
}

onMounted(async () => {
  if (tenantStore.currentStoreId) {
    await loadData()
  }
})
</script>

<template>
  <div>
    <FaPageHeader title="交接班" class="mb-0">
      <template #description>
        班次交接记录,同班次多次保存将更新 summary(便于草稿);权限:handover.manage
      </template>
    </FaPageHeader>
    <FaPageMain>
      <!-- 新建/编辑交接班表单 -->
      <div class="mb-4 p-4 border rounded-lg bg-muted/30">
        <div class="mb-3 flex gap-2 items-center">
          <FaIcon name="i-ri:exchange-line" class="text-lg" />
          <span class="font-bold">交接班登记</span>
        </div>
        <div class="gap-3 grid grid-cols-1 items-end md:grid-cols-3">
          <FaLabel label="班次日期">
            <FaInput
              v-model="form.shiftDate"
              type="date"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="班次">
            <FaSelect
              v-model="form.shiftType"
              :options="shiftTypeOptions"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="交班人">
            <BusinessEmployeePicker v-model="form.outgoingUser" value-key="user_id" placeholder="搜索选择交班员工" />
          </FaLabel>
          <FaLabel label="接班人">
            <BusinessEmployeePicker v-model="form.incomingUser" value-key="user_id" placeholder="搜索选择接班员工" />
          </FaLabel>
          <FaLabel label="交接内容(JSON 或文本)" class="md:col-span-3">
            <FaTextarea
              v-model="form.summaryText"
              :rows="4"
              placeholder="可输入 JSON(按宠物汇总)或纯文本备注"
              class="font-mono w-full"
            />
          </FaLabel>
          <div class="flex gap-2 justify-end md:col-span-3">
            <FaButton variant="outline" @click="loadData">
              <FaIcon name="i-ri:refresh-line" />
              刷新
            </FaButton>
            <FaButton type="primary" :loading="submitting" @click="onSubmit">
              <FaIcon name="i-ri:save-line" />
              保存交接班
            </FaButton>
          </div>
        </div>
      </div>

      <!-- 交接班列表 -->
      <div>
        <div class="mb-2 flex gap-2 items-center">
          <FaIcon name="i-ri:list-check" class="text-lg" />
          <span class="text-lg font-bold">交接班记录</span>
          <FaTag variant="outline" size="sm">
            {{ handovers.length }} 条
          </FaTag>
        </div>
        <FaTable
          v-loading="loading"
          table-root-class="rounded-lg overflow-hidden"
          row-key="id"
          stripe
          border
          :columns="tableColumns"
          :data="handovers"
        >
          <template #cell-operation="{ row }">
            <div class="flex-center gap-2">
              <FaButton variant="outline" size="icon-sm" @click="onView(row.original)">
                <FaIcon name="i-ri:eye-line" />
              </FaButton>
              <FaButton variant="outline" size="icon-sm" @click="onEdit(row.original)">
                <FaIcon name="i-ri:edit-line" />
              </FaButton>
            </div>
          </template>
        </FaTable>
      </div>
    </FaPageMain>
  </div>
</template>
