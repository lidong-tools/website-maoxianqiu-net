<script setup lang="ts">
/**
 * 岗位工作台首页:全高"工具栏 + 状态筛选 + 紧凑表格 + 右侧详情抽屉"布局。
 * 路由 params 承载岗位,query 承载 status/keyword/page/pageSize(由 useRoleWorkbench 同步)。
 */
import type { WorkbenchRole, WorkbenchRow } from '@/types/patient-journey'
import apiJourney from '@/api/modules/patient-journey'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { useWorkbenchStore } from '@/store/modules/app/workbench'
import { WORKBENCH_ROLE_CODES, WORKBENCH_ROLE_LABELS, WORKBENCH_ROLE_PERMISSION_ALTERNATIVES } from '@/types/patient-journey'
import WorkbenchDetailDrawer from './components/WorkbenchDetailDrawer.vue'
import WorkbenchTable from './components/WorkbenchTable.vue'
import WorkbenchToolbar from './components/WorkbenchToolbar.vue'
import { useRoleWorkbench } from './composables/useRoleWorkbench'

defineOptions({ name: 'RoleWorkbench' })

const route = useRoute()
const router = useRouter()
const tenantStore = useAppTenantStore()
const workbenchStore = useWorkbenchStore()

/** 详情抽屉 */
const drawerVisible = ref(false)
const detailRow = ref<WorkbenchRow | null>(null)
/** 收银异议作废弹窗 */
const voidVisible = ref(false)
const voidReason = ref('')
const voidTarget = ref<WorkbenchRow | null>(null)
const voidLoading = ref(false)
/** 分诊保存中 */
const triageSaving = ref(false)

const currentRoleCodes = computed(() => {
  const tenant = tenantStore.context?.tenants.find(item => item.id === tenantStore.currentTenantId)
  const store = tenant?.stores.find(item => item.id === tenantStore.currentStoreId)
  return new Set([...(tenant?.roles ?? []), ...(store?.roles ?? [])])
})
const hasRecognizedRole = computed(() => (Object.values(WORKBENCH_ROLE_CODES) as string[][])
  .flat()
  .some(code => currentRoleCodes.value.has(code)))
const availableRoles = computed(() => (Object.keys(WORKBENCH_ROLE_LABELS) as WorkbenchRole[])
  .filter((workbenchRole) => {
    const roleMatched = WORKBENCH_ROLE_CODES[workbenchRole].some(code => currentRoleCodes.value.has(code))
    if (hasRecognizedRole.value) {
      return roleMatched
    }
    return WORKBENCH_ROLE_PERMISSION_ALTERNATIVES[workbenchRole]
      .some(permission => tenantStore.effectivePermissions.includes(permission))
  }))
const role = computed<WorkbenchRole>(() => {
  const candidate = route.params.role as WorkbenchRole
  if (availableRoles.value.includes(candidate)) {
    return candidate
  }
  if (availableRoles.value.includes(workbenchStore.activeRole)) {
    return workbenchStore.activeRole
  }
  return availableRoles.value[0] ?? 'frontdesk'
})
const roleOptions = computed(() => availableRoles.value.map(value => ({ value, label: WORKBENCH_ROLE_LABELS[value] })))

/** 岗位切换:持久化偏好并跳转路由,筛选重置由 useRoleWorkbench 的 role watch 完成 */
function switchRole(value: WorkbenchRole) {
  if (!availableRoles.value.includes(value)) {
    return
  }
  workbenchStore.selectRole(value)
  apiJourney.savePreference(value).catch(() => undefined)
  router.replace(`/workbenches/${value}`)
}

/** 打开详情抽屉(点击表格行) */
function openDrawer(row: WorkbenchRow) {
  detailRow.value = row
  drawerVisible.value = true
}

/** 无可用岗位时刷新角色权限上下文 */
async function refreshRoleContext() {
  try {
    await tenantStore.initContext()
  }
  catch {
    useFaToast().error('岗位权限刷新失败')
  }
}

/** 工作台核心组合式函数(查询参数/请求/行级 loading/局部更新) */
const {
  loading,
  rows,
  counts,
  total,
  page,
  pageSize,
  status,
  searchKeyword,
  allCount,
  isRowLoading,
  load,
  refresh,
  setStatus,
  setPage,
  setPageSize,
  runRowAction,
} = useRoleWorkbench({
  getRole: () => role.value,
  ready: () => availableRoles.value.length > 0,
  /** 查看患者:跳转病历页 */
  onOpenEncounter: (row) => {
    if (row.encounter_id) {
      router.push(`/clinical/encounter/${row.encounter_id}`)
    }
  },
  /** 加入结算:跳转收银台并携带就诊上下文 */
  onSettle: (row) => {
    router.push({ path: '/billing/cashier', query: { encounterId: row.encounter_id } })
  },
  /** 完成分诊:打开详情抽屉录入分诊 */
  onTriage: (row) => {
    openDrawer(row)
  },
  /** 次要动作:异议作废需二次确认 */
  onSecondaryAction: (row) => {
    voidTarget.value = row
    voidReason.value = ''
    voidVisible.value = true
  },
})

/** 保存分诊(抽屉内表单) */
async function confirmTriage(row: WorkbenchRow, form: { weightKg: number, temperatureC: number, heartRate: number, respiratoryRate: number, painScore: number, acuity: string, allergyNotes: string, chiefComplaint: string, notes: string }) {
  triageSaving.value = true
  try {
    await apiJourney.saveTriage(row.id, role.value, {
      ...(form.weightKg > 0 ? { weightKg: form.weightKg } : {}),
      ...(form.temperatureC > 0 ? { temperatureC: form.temperatureC } : {}),
      ...(form.heartRate > 0 ? { heartRate: form.heartRate } : {}),
      ...(form.respiratoryRate > 0 ? { respiratoryRate: form.respiratoryRate } : {}),
      painScore: form.painScore,
      acuity: form.acuity,
      allergyNotes: form.allergyNotes,
      chiefComplaint: form.chiefComplaint,
      notes: form.notes,
      riskFlags: [],
    })
    drawerVisible.value = false
    useFaToast().success('分诊完成，患者已进入候诊并记录操作人')
    await load(true)
  }
  catch (error: any) {
    useFaToast().error(error?.message || '分诊保存失败')
  }
  finally {
    triageSaving.value = false
  }
}

/** 收银异议作废(二次确认) */
async function confirmVoid() {
  if (!voidTarget.value || !voidReason.value.trim()) {
    useFaToast().error('请填写客户异议或作废原因')
    return
  }
  voidLoading.value = true
  try {
    await apiJourney.voidChargeItem(voidTarget.value.id, voidReason.value.trim())
    voidVisible.value = false
    useFaToast().success('条目已作废，原记录和操作留痕已保留')
    await load(true)
  }
  catch (error: any) {
    useFaToast().error(error?.message || '作废失败')
  }
  finally {
    voidLoading.value = false
  }
}
</script>

<template>
  <!-- 绝对定位占满父容器,与回访任务等列表页保持内容区高度一致 -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <!-- 无可用岗位提示 -->
      <div v-if="!availableRoles.length" class="p-4 border rounded-lg bg-card">
        <div class="flex flex-wrap gap-4 items-center justify-between">
          <div class="text-sm text-muted-foreground">
            当前门店没有返回岗位或对应业务权限。请先刷新岗位信息；仍为空时，需要管理员为该员工分配门店岗位。
          </div>
          <FaButton :loading="loading" @click="refreshRoleContext">
            <FaIcon name="i-lucide:refresh-cw" />刷新岗位权限
          </FaButton>
        </div>
      </div>

      <!-- 主工作区:工具栏 + 状态筛选 + 紧凑表格 + 分页(同一卡片) -->
      <div v-else class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <WorkbenchToolbar
          :role="role"
          :role-options="roleOptions"
          :role-disabled="!availableRoles.length"
          :loading="loading"
          :counts="counts"
          :all-count="allCount"
          :total="total"
          :status="status"
          :search-keyword="searchKeyword"
          @update:role="switchRole"
          @update:status="setStatus"
          @update:search-keyword="searchKeyword = $event"
          @refresh="refresh"
        />
        <WorkbenchTable
          :rows="rows"
          :loading="loading"
          :role="role"
          :is-row-loading="isRowLoading"
          @row-click="openDrawer"
          @action="(row, action) => runRowAction(row, action)"
        />
        <FaPagination
          :page="page"
          :size="pageSize"
          :total="total"
          class="mt-2 px-4 pb-3 shrink-0"
          @page-change="setPage"
          @size-change="setPageSize"
        />
      </div>

      <!-- 右侧详情抽屉 -->
      <WorkbenchDetailDrawer
        v-model:visible="drawerVisible"
        :row="detailRow"
        :role="role"
        :is-row-loading="isRowLoading"
        :triage-saving="triageSaving"
        @action="(row, action) => runRowAction(row, action)"
        @save-triage="confirmTriage"
      />

      <!-- 收银异议作废 -->
      <FaModal v-model="voidVisible" title="作废待付款条目" :loading="voidLoading" @confirm="confirmVoid">
        <div class="space-y-3">
          <div class="text-sm text-amber-800 p-3 rounded-md bg-amber-50">
            该操作不会删除条目。系统将保留原金额、来源医嘱、作废原因、收银员身份和操作时间。
          </div>
          <FaLabel label="客户异议 / 作废原因（必填）">
            <FaTextarea v-model="voidReason" :maxlength="2000" placeholder="例如：客户对该检查项目有异议，经沟通确认本次不执行" />
          </FaLabel>
        </div>
      </FaModal>
    </div>
  </div>
</template>
