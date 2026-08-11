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
const sending = ref(false)
const dataList = ref<ReminderRow[]>([])

/** F-R-1:勾选待发送的提醒行(批量发送) */
const selectionRows = ref<ReminderRow[]>([])

const search = ref({
  status: '',
  reminderType: '',
})

const tableColumns = computed<TableColumn<ReminderRow>[]>(() => [
  // F-R-1:多选列(批量发送所选)
  {
    type: 'selection',
    fixed: 'left',
    width: 48,
  },
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

/**
 * 批量发送所选提醒(F-R-1:3.8.1-01 疫苗提醒一体化发送)
 * 走 Hono Command(api/routes/diagnostics.ts#/reminders/send):
 * Hono 以 service role 复用 engine.ts sendMessage 真实发送(scene=vaccine_reminder),
 * 成功回写 diag_reminders.status='sent'、sent_at;非 pending/无手机号/失败计入 failures 不中断
 */
function onSendSelected() {
  const rows = selectionRows.value.filter(r => r.status === 'pending')
  if (!rows.length) {
    useFaToast().warning('请先勾选「待发送」状态的提醒')
    return
  }
  useFaModal().confirm({
    title: '批量发送提醒',
    content: `确认为选中的 ${rows.length} 条提醒发送短信吗?发送后状态更新为「已发送」。`,
    onConfirm: async () => {
      sending.value = true
      try {
        const res = await apiDiagnostics.sendReminders(rows.map(r => r.id))
        const result = res.data
        const parts = [`成功 ${result.sentCount} 条`]
        if (result.failedCount > 0) {
          parts.push(`失败 ${result.failedCount} 条`)
        }
        useFaToast().success(`发送完成:${parts.join(', ')}`)
        selectionRows.value = []
        await loadReminders()
      }
      catch {
        // 错误已由全局拦截器提示
      }
      finally {
        sending.value = false
      }
    },
  })
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

// P0-06:切店后重载到期提醒(避免旧门店数据残留)
useStoreScopedPage({
  load: loadReminders,
})
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告 #8) -->
    <!--
    <EntityPageHeader compact title="到期提醒" description="疫苗/驱虫到期提醒;扫描走 scan_diag_reminders RPC,幂等生成;支持取消待发送提醒" />
    -->

    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 筛选区:左为筛选控件,右为功能按钮 -->
        <div class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 flex flex-wrap gap-3 items-center">
            <FaSelect
              v-model="search.reminderType"
              :options="[
                { label: '全部', value: '' },
                { label: '疫苗', value: 'vaccine' },
                { label: '驱虫', value: 'deworming' },
              ]"
              class="w-40"
              @change="loadReminders()"
            />
            <FaSelect
              v-model="search.status"
              :options="[
                { label: '全部', value: '' },
                { label: '待发送', value: 'pending' },
                { label: '已发送', value: 'sent' },
                { label: '已取消', value: 'cancelled' },
              ]"
              class="w-40"
              @change="loadReminders()"
            />
            <div class="ml-auto flex gap-2 items-center">
              <FaButton type="primary" :loading="scanning" @click="onScan">
                <FaIcon name="i-ri:radar-line" />
                扫描到期提醒(RPC)
              </FaButton>
              <!-- F-R-1:批量发送所选(engine.ts 真实发送) -->
              <FaButton type="success" :loading="sending" :disabled="!selectionRows.length" @click="onSendSelected">
                <FaIcon name="i-ri:send-plane-line" />
                发送所选({{ selectionRows.length }})
              </FaButton>
              <FaButton @click="loadReminders">
                <FaIcon name="i-ri:refresh-line" />
                刷新
              </FaButton>
            </div>
          </div>
        </div>

        <!-- 表格区 -->
        <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            table-root-class="overflow-hidden"
            row-key="id"
            selectable
            multiple
            stripe
            border
            :columns="tableColumns"
            :data="dataList"
            @selection-change="selectionRows = $event"
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
        </div>
      </div>
    </div>
  </div>
</template>
