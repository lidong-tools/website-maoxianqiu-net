<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { DiagReminder } from '@/types/diagnostics'
import apiDiagnostics from '@/api/modules/diagnostics'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { DIAG_REMINDER_STATUS_LABELS, DIAG_REMINDER_TYPE_LABELS } from '@/types/diagnostics'

defineOptions({
  name: 'DiagnosticsReminder',
})

interface ReminderRow {
  id: string
  pet_id: string
  customer_id: string
  reminder_type: DiagReminder['reminder_type']
  due_date: string
  status: DiagReminder['status']
  created_at: string
  sent_at: string | null
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const scanning = ref(false)
const dataList = ref<ReminderRow[]>([])

const search = ref({
  status: '',
  reminderType: '',
})

const tableColumns = computed<TableColumn<ReminderRow>[]>(() => [
  {
    accessorKey: 'pet_id',
    header: '宠物 ID',
    cell: (info: any) => info.getValue()?.slice(0, 8),
  },
  {
    accessorKey: 'customer_id',
    header: '客户 ID',
    cell: (info: any) => info.getValue()?.slice(0, 8),
  },
  {
    accessorKey: 'reminder_type',
    header: '类型',
    cell: (info: any) => {
      const v = info.getValue() as DiagReminder['reminder_type']
      return DIAG_REMINDER_TYPE_LABELS[v] ?? v
    },
  },
  {
    accessorKey: 'due_date',
    header: '到期日期',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleDateString('zh-CN') : '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info: any) => {
      const v = info.getValue() as DiagReminder['status']
      const label = DIAG_REMINDER_STATUS_LABELS[v] ?? v
      const colorMap: Record<string, string> = {
        pending: 'warning',
        sent: 'success',
        cancelled: 'default',
      }
      const color = colorMap[v] ?? 'default'
      return h('span', {
        class: `inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-${color}-100 text-${color}-700`,
      }, label)
    },
  },
  {
    accessorKey: 'created_at',
    header: '创建时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'sent_at',
    header: '发送时间',
    cell: (info: any) => info.getValue() ? new Date(info.getValue()).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 120,
    align: 'center',
    fixed: 'right',
  },
])

/** 加载提醒列表 */
async function loadReminders() {
  loading.value = true
  try {
    const res = await apiDiagnostics.listReminders({
      storeId: tenantStore.currentStoreId || undefined,
      status: (search.value.status || undefined) as DiagReminder['status'] | undefined,
      reminderType: (search.value.reminderType || undefined) as DiagReminder['reminder_type'] | undefined,
    })
    dataList.value = res.data.list as ReminderRow[]
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载提醒列表失败')
  }
  finally {
    loading.value = false
  }
}

/** 扫描到期提醒(MXQ-10004,走 scan_diag_reminders RPC) */
async function onScan() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择工作租户')
    return
  }
  scanning.value = true
  try {
    const res = await apiDiagnostics.scanReminders(
      tenantStore.currentTenantId,
      tenantStore.currentStoreId || undefined,
      7,
    )
    const result = res.data
    useFaToast().success(`扫描完成:扫描 ${result.scanned_count} 条,新增提醒 ${result.inserted_count} 条`)
    await loadReminders()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    scanning.value = false
  }
}

/** 取消提醒(仅 pending 状态) */
function onCancel(row: ReminderRow) {
  if (row.status !== 'pending') {
    useFaToast().warning('仅「待发送」状态可取消')
    return
  }
  useFaModal().confirm({
    title: '取消提醒',
    content: `确认取消该${DIAG_REMINDER_TYPE_LABELS[row.reminder_type]}提醒吗?`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.cancelReminder(row.id)
        useFaToast().success('已取消')
        await loadReminders()
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

onMounted(async () => {
  await loadReminders()
})
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="到期提醒" class="mb-0">
      <template #description>
        疫苗/驱虫到期提醒;扫描走 scan_diag_reminders RPC,幂等生成;支持取消待发送提醒
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="类型" class="col-span-1">
              <FaSelect
                v-model="search.reminderType"
                :options="[
                  { label: '全部', value: '' },
                  { label: '疫苗', value: 'vaccine' },
                  { label: '驱虫', value: 'deworming' },
                ]"
                class="w-full"
                @change="loadReminders()"
              />
            </FaLabel>
            <FaLabel label="状态" class="col-span-1">
              <FaSelect
                v-model="search.status"
                :options="[
                  { label: '全部', value: '' },
                  { label: '待发送', value: 'pending' },
                  { label: '已发送', value: 'sent' },
                  { label: '已取消', value: 'cancelled' },
                ]"
                class="w-full"
                @change="loadReminders()"
              />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton type="primary" :loading="scanning" @click="onScan">
                <FaIcon name="i-ri:radar-line" />
                扫描到期提醒(RPC)
              </FaButton>
              <FaButton @click="loadReminders">
                <FaIcon name="i-ri:refresh-line" />
                刷新
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
        <template #cell-operation="{ row }">
          <div class="flex-center gap-2">
            <FaButton
              v-if="row.original.status === 'pending'"
              variant="destructive"
              size="sm"
              @click="onCancel(row.original)"
            >
              <FaIcon name="i-ri:close-line" />
              取消
            </FaButton>
          </div>
        </template>
      </FaTable>
    </FaPageMain>
  </div>
</template>
