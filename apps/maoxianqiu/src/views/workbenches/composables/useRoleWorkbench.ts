/**
 * 岗位工作台核心组合式函数。
 * 职责:查询参数(状态/关键词/分页)与路由 query 双向同步、服务端请求、
 * 行级动作 loading、命令执行后的乐观更新与后台静默刷新、409 冲突恢复。
 */
import type { WorkbenchRole, WorkbenchRow } from '@/types/patient-journey'
import apiJourney from '@/api/modules/patient-journey'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { useWorkbenchStore } from '@/store/modules/app/workbench'
import { CHARGE_STATUS_LABELS, QUEUE_STATUS_LABELS, TASK_STATUS_LABELS } from '@/types/patient-journey'

/** 主动作展示配置:label 与图标由动作 key 推导 */
export const WORKBENCH_ACTION_META: Record<string, { label: string, icon?: string }> = {
  call: { label: '叫号', icon: 'i-lucide:volume-2' },
  called: { label: '叫号', icon: 'i-lucide:volume-2' },
  in_consultation: { label: '开始接诊', icon: 'i-lucide:stethoscope' },
  waiting: { label: '召回候诊', icon: 'i-lucide:rotate-ccw' },
  open: { label: '查看患者', icon: 'i-lucide:eye' },
  view: { label: '查看患者', icon: 'i-lucide:eye' },
  continue: { label: '继续问诊', icon: 'i-lucide:clipboard-list' },
  triage: { label: '完成分诊', icon: 'i-lucide:clipboard-check' },
  settle: { label: '加入结算', icon: 'i-lucide:banknote' },
  claim: { label: '领取任务', icon: 'i-lucide:hand' },
  start: { label: '开始执行', icon: 'i-lucide:play' },
  complete: { label: '完成任务', icon: 'i-lucide:check' },
}

/** 队列岗位集合(主动作走候诊队列状态机) */
const QUEUE_ROLES: WorkbenchRole[] = ['frontdesk', 'triage', 'doctor', 'manager']

/** 各岗位状态筛选顺序(按岗位工作流固定排列,非对象键顺序) */
export const WORKBENCH_STATUS_TABS: Record<WorkbenchRole, string[]> = {
  frontdesk: ['checked_in', 'triage', 'waiting', 'called', 'missed', 'in_consultation'],
  triage: ['checked_in', 'triage'],
  doctor: ['waiting', 'called', 'in_consultation'],
  nurse: ['pending', 'claimed', 'in_progress', 'failed'],
  lab: ['pending', 'claimed', 'in_progress', 'failed'],
  imaging: ['pending', 'claimed', 'in_progress', 'failed'],
  cashier: ['pending', 'invoiced'],
  pharmacy: ['pending', 'claimed', 'in_progress', 'failed'],
  followup: ['pending', 'claimed', 'in_progress', 'failed'],
  manager: ['checked_in', 'triage', 'waiting', 'called', 'missed', 'in_consultation'],
}

/** 根据岗位选择状态中文映射:队列岗用队列状态,收银用收费状态,其余用任务状态 */
export function roleStatusLabel(role: WorkbenchRole, status: string): string {
  const labels = role === 'cashier'
    ? CHARGE_STATUS_LABELS
    : (QUEUE_ROLES.includes(role) ? QUEUE_STATUS_LABELS : TASK_STATUS_LABELS)
  return labels[status] ?? status
}

export function useRoleWorkbench(options: {
  getRole: () => WorkbenchRole
  /** 是否就绪(存在可用岗位),未就绪时不请求 */
  ready: () => boolean
  /** 命令之外的 UI 动作回调:查看患者/加入结算/完成分诊 */
  onOpenEncounter?: (row: WorkbenchRow) => void
  onSettle?: (row: WorkbenchRow) => void
  onTriage?: (row: WorkbenchRow) => void
  /** 次要动作回调(异议作废等需要二次确认的动作) */
  onSecondaryAction?: (row: WorkbenchRow, action: string) => void
}) {
  const route = useRoute()
  const router = useRouter()
  const tenantStore = useAppTenantStore()
  const workbenchStore = useWorkbenchStore()

  const loading = ref(false)
  const rows = ref<WorkbenchRow[]>([])
  const counts = ref<Record<string, number>>({})
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(50)
  /** 当前状态筛选:'' 表示全部 */
  const status = ref('')
  /** 已生效的搜索词(防抖后) */
  const keyword = ref('')
  /** 搜索输入框即时值,经防抖写入 keyword */
  const searchKeyword = ref('')
  /** 强制刷新令牌:点击刷新时递增以绕过 watch 去重 */
  const requestToken = ref(0)
  /** 行级动作 loading:rowId -> action */
  const rowLoading = ref<Record<string, string>>({})

  const role = computed(() => options.getRole())
  const isQueueRole = computed(() => QUEUE_ROLES.includes(role.value))

  /** 全部待办数量(各状态之和) */
  const allCount = computed(() => Object.values(counts.value).reduce((sum, value) => sum + value, 0))

  /** 从路由 query 恢复筛选上下文(刷新/前进后退后保留) */
  function readQuery() {
    const query = route.query
    status.value = typeof query.status === 'string' ? query.status : ''
    keyword.value = typeof query.keyword === 'string' ? query.keyword : ''
    searchKeyword.value = keyword.value
    page.value = Number(query.page) > 0 ? Number(query.page) : 1
    pageSize.value = Number(query.pageSize) > 0 ? Number(query.pageSize) : 50
  }

  /** 将当前筛选上下文写入路由 query */
  function writeQuery() {
    const query: Record<string, string> = {}
    if (status.value) {
      query.status = status.value
    }
    if (keyword.value) {
      query.keyword = keyword.value
    }
    if (page.value > 1) {
      query.page = String(page.value)
    }
    if (pageSize.value !== 50) {
      query.pageSize = String(pageSize.value)
    }
    router.replace({ query })
  }

  /** 加载工作台数据:silent 为真时后台静默刷新,不遮挡列表 */
  async function load(silent = false) {
    if (!options.ready() || !tenantStore.currentStoreId) {
      return
    }
    if (!silent) {
      loading.value = true
    }
    try {
      const data = await apiJourney.getWorkbench(role.value, {
        storeId: tenantStore.currentStoreId,
        status: status.value || undefined,
        keyword: keyword.value || undefined,
        page: page.value,
        pageSize: pageSize.value,
      })
      rows.value = data.list
      counts.value = data.counts
      total.value = data.total
      page.value = data.page
      workbenchStore.selectRole(role.value)
    }
    catch (error: any) {
      useFaToast().error(error?.message || '工作台加载失败')
    }
    finally {
      loading.value = false
    }
  }

  /** 切换状态筛选:重置到第一页并同步路由 */
  function setStatus(value: string) {
    if (value === status.value) {
      return
    }
    status.value = value
    page.value = 1
    writeQuery()
  }

  /** 设置分页 */
  function setPage(value: number) {
    if (value === page.value) {
      return
    }
    page.value = value
    writeQuery()
  }

  function setPageSize(value: number) {
    pageSize.value = value
    page.value = 1
    writeQuery()
  }

  /** 强制刷新:只重载数据,不重置筛选上下文 */
  function refresh() {
    requestToken.value += 1
  }

  /** 单行动作是否在执行中 */
  function isRowLoading(rowId: string, action?: string) {
    if (!action) {
      return Boolean(rowLoading.value[rowId])
    }
    return rowLoading.value[rowId] === action
  }

  /** 执行队列/任务状态命令 */
  async function executeStateCommand(row: WorkbenchRow, action: string) {
    const roleValue = role.value
    if (QUEUE_ROLES.includes(roleValue)) {
      // 队列命令:call/called → 叫号,in_consultation/start → 开始接诊,waiting → 召回候诊
      const target = action === 'call' ? 'called' : action === 'start' ? 'in_consultation' : action
      await apiJourney.transitionQueue(row.id, roleValue, target)
    }
    else {
      // 任务命令:claim/start/complete
      await apiJourney.transitionTask(row.id, roleValue, action)
    }
  }

  /** 预测命令成功后的行状态,用于乐观更新 */
  function predictNextStatus(action: string): string {
    if (QUEUE_ROLES.includes(role.value)) {
      if (action === 'call' || action === 'called') {
        return 'called'
      }
      if (action === 'start' || action === 'in_consultation') {
        return 'in_consultation'
      }
      if (action === 'waiting') {
        return 'waiting'
      }
    }
    else if (action === 'claim') {
      return 'claimed'
    }
    else if (action === 'start') {
      return 'in_progress'
    }
    else if (action === 'complete') {
      return 'completed'
    }
    return ''
  }

  /** 乐观更新当前行:状态仍属于当前筛选则更新,否则移除该行 */
  function applyLocalUpdate(row: WorkbenchRow, action: string) {
    const nextStatus = predictNextStatus(action)
    if (!nextStatus) {
      return
    }
    if (!status.value || status.value === nextStatus) {
      rows.value = rows.value.map(item => item.id === row.id ? { ...item, status: nextStatus } : item)
    }
    else {
      rows.value = rows.value.filter(item => item.id !== row.id)
      total.value = Math.max(0, total.value - 1)
    }
    // 状态数量联动:旧状态减一,新状态加一
    if (nextStatus !== row.status) {
      counts.value = {
        ...counts.value,
        [row.status]: Math.max(0, (counts.value[row.status] ?? 1) - 1),
        [nextStatus]: (counts.value[nextStatus] ?? 0) + 1,
      }
    }
  }

  /** 执行单行主动作:命令成功先乐观更新,再后台静默刷新计数与当前页 */
  async function runRowAction(row: WorkbenchRow, action: string) {
    if (rowLoading.value[row.id]) {
      return
    }
    // UI 型动作(跳转/分诊表单)不占用行级 loading,交由 index.vue 回调处理
    if (action === 'open' || action === 'view' || action === 'continue') {
      if (options.onOpenEncounter) {
        options.onOpenEncounter(row)
      }
      return
    }
    if (action === 'settle') {
      if (options.onSettle) {
        options.onSettle(row)
      }
      return
    }
    if (action === 'triage') {
      if (options.onTriage) {
        options.onTriage(row)
      }
      return
    }
    if (action === 'void') {
      if (options.onSecondaryAction) {
        options.onSecondaryAction(row, action)
      }
      return
    }
    rowLoading.value = { ...rowLoading.value, [row.id]: action }
    try {
      await executeStateCommand(row, action)
      useFaToast().success('操作已完成并记录留痕')
      applyLocalUpdate(row, action)
      await load(true)
    }
    catch (error: any) {
      // 409 状态冲突:刷新该行最新状态,提示用户重新确认
      if (error?.response?.status === 409) {
        useFaToast().error('数据已变更,请刷新后重新确认操作')
        await load(true)
      }
      else {
        useFaToast().error(error?.message || '操作失败')
      }
    }
    finally {
      const { [row.id]: _removed, ...rest } = rowLoading.value
      rowLoading.value = rest
    }
  }

  /** 切换岗位时重置筛选上下文(恢复默认全部状态) */
  function resetContext() {
    status.value = ''
    keyword.value = ''
    searchKeyword.value = ''
    page.value = 1
    writeQuery()
  }

  // 从路由恢复上下文(刷新/前进后退),须在 watch 之前执行以保证首次加载参数正确
  readQuery()

  // 搜索防抖:300ms 后生效并重置到第一页(搜索由服务端执行,不允许前端过滤)
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  watch(searchKeyword, () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      keyword.value = searchKeyword.value
      page.value = 1
      writeQuery()
    }, 300)
  })

  // 岗位切换:重置筛选,主 watch 因 role 变化触发重新加载
  watch(role, (next, prev) => {
    if (next !== prev) {
      resetContext()
    }
  })

  // 岗位/门店/可用岗位/筛选参数/强制刷新令牌变化时重新加载
  watch(
    [
      () => role.value,
      () => tenantStore.currentStoreId,
      () => options.ready(),
      status,
      keyword,
      page,
      pageSize,
      requestToken,
    ],
    () => { load() },
    { immediate: true },
  )

  // 浏览器前进/后退或从专业页返回时,从路由 query 恢复筛选上下文
  watch(() => route.query, () => {
    readQuery()
  })

  return {
    loading,
    rows,
    counts,
    total,
    page,
    pageSize,
    status,
    keyword,
    searchKeyword,
    allCount,
    isQueueRole,
    rowLoading,
    isRowLoading,
    load,
    refresh,
    setStatus,
    setPage,
    setPageSize,
    runRowAction,
  }
}
