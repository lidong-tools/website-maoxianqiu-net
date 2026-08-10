<script setup lang="ts">
/**
 * 工作台紧凑表格:按岗位类型生成列配置(队列/任务/收银三类),
 * 状态标签、时效颜色、行级主动作与更多菜单,点击行打开详情抽屉。
 */
import type { TableColumn } from '@fantastic-admin/components'
import type { WorkbenchRole, WorkbenchRow } from '@/types/patient-journey'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import { JOURNEY_SOURCE_TYPE_LABELS, QUEUE_STATUS_VARIANTS } from '@/types/patient-journey'
import { roleStatusLabel, WORKBENCH_ACTION_META } from '../composables/useRoleWorkbench'

const props = withDefaults(defineProps<{
  rows: WorkbenchRow[]
  loading?: boolean
  role: WorkbenchRole
  /** 行级动作 loading 判断 */
  isRowLoading?: (rowId: string, action?: string) => boolean
}>(), {
  loading: false,
  isRowLoading: () => false,
})

const emit = defineEmits<{
  rowClick: [row: WorkbenchRow]
  action: [row: WorkbenchRow, action: string]
}>()

const QUEUE_ROLES: WorkbenchRole[] = ['frontdesk', 'triage', 'doctor', 'manager']
const queueRole = computed(() => QUEUE_ROLES.includes(props.role))

/** 状态标签配色:队列/收银/任务三套映射 */
function statusVariant(status: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (queueRole.value) {
    return QUEUE_STATUS_VARIANTS[status] ?? 'neutral'
  }
  if (props.role === 'cashier') {
    if (status === 'paid') {
      return 'success'
    }
    if (status === 'invoiced') {
      return 'info'
    }
    if (status === 'voided') {
      return 'neutral'
    }
    return 'warning'
  }
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'failed') {
    return 'danger'
  }
  if (status === 'in_progress') {
    return 'info'
  }
  return 'warning'
}

/** 优先级:仅非常规等级突出显示 */
function priorityTag(priority?: string) {
  if (!priority || priority === 'routine') {
    return null
  }
  const map: Record<string, { label: string, variant: 'warning' | 'danger' }> = {
    priority: { label: '优先', variant: 'warning' },
    urgent: { label: '紧急', variant: 'danger' },
    emergency: { label: '急诊', variant: 'danger' },
  }
  return map[priority] ?? null
}

/** 等待时长文本 */
function waitText(minutes?: number) {
  if (minutes === undefined || minutes === null) {
    return '-'
  }
  if (minutes < 60) {
    return `${minutes} 分钟`
  }
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`
}

/** 时效颜色:超时/长等待为 danger,接近截止为 warning,否则 muted */
function timingClass(row: WorkbenchRow) {
  const { elapsedMinutes, overdue } = row.timing ?? {}
  if (overdue || (elapsedMinutes ?? 0) >= 60) {
    return 'text-danger'
  }
  if ((elapsedMinutes ?? 0) >= 30) {
    return 'text-warning'
  }
  return 'text-muted-foreground'
}

/** 任务截止时间文本 */
function dueText(row: WorkbenchRow) {
  const dueAt = row.timing?.dueAt ?? row.due_at
  if (!dueAt) {
    return '-'
  }
  const diff = new Date(dueAt).getTime() - Date.now()
  if (diff < 0) {
    return `已超时 ${waitText(Math.ceil(-diff / 60000))}`
  }
  if (diff < 3600000) {
    return `${Math.ceil(diff / 60000)} 分钟后截止`
  }
  return new Date(dueAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 宠物与主人合并单元格:宠物为主信息,主人与电话为次信息 */
function patientCell(row: WorkbenchRow) {
  return h('div', { class: 'leading-tight min-w-0 py-0.5' }, [
    h('div', { class: 'text-sm font-medium truncate' }, `${row.pet?.name ?? '未命名宠物'} · ${row.customer?.name ?? '未知客户'}`),
    h('div', { class: 'text-xs text-muted-foreground truncate' }, row.customer?.phone ?? ''),
  ])
}

/** 主动作展示配置 */
function actionMeta(row: WorkbenchRow) {
  return row.primaryAction ? WORKBENCH_ACTION_META[row.primaryAction] : undefined
}

/** 更多菜单:收银异议作废 / 队列查看患者 */
function moreActions(row: WorkbenchRow) {
  const items: Array<{ label: string, icon?: string, destructive?: boolean, onClick: () => void }> = []
  const allowed = row.allowedActions ?? []
  if (props.role === 'cashier' && allowed.includes('void') && row.status === 'pending') {
    items.push({ label: '异议作废', icon: 'i-lucide:ban', destructive: true, onClick: () => emit('action', row, 'void') })
  }
  const navActions = ['open', 'view', 'continue']
  if (queueRole.value && row.encounter_id && !(row.primaryAction && navActions.includes(row.primaryAction))) {
    items.push({ label: '查看患者', icon: 'i-lucide:eye', onClick: () => emit('action', row, 'open') })
  }
  return items
}

function patientColumn() {
  return {
    id: 'patient',
    header: '宠物/主人',
    minWidth: 180,
    cell: (info: any) => patientCell(info.row.original as WorkbenchRow),
  }
}

function statusColumn() {
  return {
    id: 'status',
    header: '状态',
    width: 110,
    cell: (info: any) => {
      const row = info.row.original as WorkbenchRow
      return h(EntityStatusTag, { label: roleStatusLabel(props.role, row.status), variant: statusVariant(row.status), dot: true })
    },
  }
}

function operationColumn() {
  return {
    id: 'operation',
    header: '操作',
    width: 150,
    align: 'right' as const,
    fixed: 'right' as const,
  }
}

/** 队列类岗位列:队列号、宠物/主人、预约或主诉、优先级、状态、等待时长 */
const queueColumns: TableColumn<WorkbenchRow>[] = [
  {
    id: 'queue_no',
    header: '队列号',
    width: 90,
    cell: (info: any) => {
      const row = info.row.original as WorkbenchRow
      return h('span', { class: 'tabular-nums text-sm' }, row.queue_no ?? row.queue_number ?? '-')
    },
  },
  patientColumn(),
  {
    id: 'subject',
    header: '预约/主诉',
    minWidth: 160,
    cell: (info: any) => {
      const row = info.row.original as WorkbenchRow
      const text = (row as any).appointment?.reason ?? row.display?.subtitle ?? '候诊'
      return h('div', { class: 'text-sm truncate max-w-56' }, text)
    },
  },
  {
    id: 'priority',
    header: '优先级',
    width: 90,
    cell: (info: any) => {
      const tag = priorityTag((info.row.original as WorkbenchRow).priority)
      return tag ? h(EntityStatusTag, { label: tag.label, variant: tag.variant, dot: false }) : h('span', { class: 'text-muted-foreground text-xs' }, '常规')
    },
  },
  statusColumn(),
  {
    id: 'waiting',
    header: '等待时长',
    width: 100,
    cell: (info: any) => {
      const row = info.row.original as WorkbenchRow
      return h('span', { class: `tabular-nums text-sm ${timingClass(row)}` }, waitText(row.timing?.elapsedMinutes))
    },
  },
  operationColumn(),
]

/** 任务类岗位列:任务项目、宠物/主人、来源、优先级、状态、截止、执行人 */
const taskColumns: TableColumn<WorkbenchRow>[] = [
  {
    id: 'task',
    header: '任务项目',
    minWidth: 170,
    cell: (info: any) => {
      const row = info.row.original as WorkbenchRow
      return h('div', { class: 'leading-tight min-w-0' }, [
        h('div', { class: 'text-sm font-medium truncate' }, row.display?.title ?? row.title ?? row.task_type ?? '-'),
        h('div', { class: 'text-xs text-muted-foreground truncate' }, row.display?.subtitle ?? ''),
      ])
    },
  },
  patientColumn(),
  {
    id: 'source',
    header: '来源',
    width: 100,
    cell: (info: any) => {
      const row = info.row.original as WorkbenchRow
      const source = row.display?.sourceLabel ?? row.source_type ?? ''
      return h('span', { class: 'text-xs' }, JOURNEY_SOURCE_TYPE_LABELS[source] ?? (source || '-'))
    },
  },
  {
    id: 'priority',
    header: '优先级',
    width: 90,
    cell: (info: any) => {
      const tag = priorityTag((info.row.original as WorkbenchRow).priority)
      return tag ? h(EntityStatusTag, { label: tag.label, variant: tag.variant, dot: false }) : h('span', { class: 'text-muted-foreground text-xs' }, '常规')
    },
  },
  statusColumn(),
  {
    id: 'due',
    header: '截止时间',
    width: 130,
    cell: (info: any) => {
      const row = info.row.original as WorkbenchRow
      return h('span', { class: `text-sm tabular-nums ${row.timing?.overdue ? 'text-danger' : 'text-muted-foreground'}` }, dueText(row))
    },
  },
  {
    id: 'assignee',
    header: '执行人',
    width: 100,
    cell: (info: any) => {
      const assignee = (info.row.original as WorkbenchRow).assignee
      return h('span', { class: 'text-sm' }, assignee?.name ?? '未指派')
    },
  },
  operationColumn(),
]

/** 收银岗位列:宠物/主人、收费项目、来源单据、金额、状态、创建时间 */
const cashierColumns: TableColumn<WorkbenchRow>[] = [
  patientColumn(),
  {
    id: 'charge',
    header: '收费项目',
    minWidth: 170,
    cell: (info: any) => {
      const row = info.row.original as WorkbenchRow
      return h('div', { class: 'leading-tight min-w-0' }, [
        h('div', { class: 'text-sm font-medium truncate' }, row.display?.title ?? row.item_name ?? '-'),
        h('div', { class: 'text-xs text-muted-foreground truncate' }, row.display?.subtitle ?? ''),
      ])
    },
  },
  {
    id: 'source',
    header: '来源单据',
    width: 130,
    cell: (info: any) => {
      const row = info.row.original as WorkbenchRow
      const sourceLabel = row.display?.sourceLabel ?? row.source_type ?? ''
      const businessNo = row.display?.businessNo ?? row.source_id ?? ''
      return h('div', { class: 'leading-tight' }, [
        h('div', { class: 'text-xs tabular-nums' }, businessNo || '-'),
        h('div', { class: 'text-xs text-muted-foreground' }, JOURNEY_SOURCE_TYPE_LABELS[sourceLabel] ?? (sourceLabel || '')),
      ])
    },
  },
  {
    id: 'amount',
    header: '金额',
    width: 110,
    align: 'right',
    cell: (info: any) => {
      const row = info.row.original as WorkbenchRow
      return h('span', { class: 'text-primary font-semibold tabular-nums' }, `¥${Number(row.amount ?? 0).toFixed(2)}`)
    },
  },
  statusColumn(),
  {
    id: 'created',
    header: '创建时间',
    width: 130,
    cell: (info: any) => {
      const createdAt = (info.row.original as WorkbenchRow).created_at
      return h('span', { class: 'text-xs text-muted-foreground tabular-nums' }, createdAt ? new Date(createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-')
    },
  },
  operationColumn(),
]

/** 响应式:1280 以下隐藏低优先级列(任务来源说明/收银来源单据),操作列始终可见 */
const narrow = ref(false)
function onResize() {
  narrow.value = window.innerWidth < 1280
}
onMounted(() => {
  onResize()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

const tableColumns = computed<TableColumn<WorkbenchRow>[]>(() => {
  const base = props.role === 'cashier'
    ? cashierColumns
    : (queueRole.value ? queueColumns : taskColumns)
  if (!narrow.value) {
    return base
  }
  return base.filter(column => !['source', 'created', 'due'].includes(String(column.id ?? ('accessorKey' in column ? column.accessorKey : undefined) ?? '')))
})
</script>

<template>
  <div v-loading="props.loading" class="flex-1 min-h-0 overflow-auto">
    <FaTable
      table-root-class="overflow-hidden"
      row-key="id"
      stripe
      border
      :columns="tableColumns"
      :data="props.rows"
      @row-click="(row: WorkbenchRow) => emit('rowClick', row)"
    >
      <template #cell-operation="{ row }">
        <div @click.stop>
          <TablePrimaryAction
            v-if="actionMeta(row.original)"
            :primary-label="actionMeta(row.original)!.label"
            :primary-icon="actionMeta(row.original)!.icon"
            :primary-loading="props.isRowLoading(row.original.id, row.original.primaryAction)"
            :more="moreActions(row.original)"
            @primary="emit('action', row.original, row.original.primaryAction!)"
          />
          <span v-else class="text-xs text-muted-foreground">
            -
          </span>
        </div>
      </template>
      <template #empty>
        <FaEmpty description="当前筛选下没有待办" />
      </template>
    </FaTable>
  </div>
</template>
