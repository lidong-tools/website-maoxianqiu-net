<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- 工作台动作守卫使用单行提前返回 */
import type { WorkbenchRole, WorkbenchRow } from '@/types/patient-journey'
import apiJourney from '@/api/modules/patient-journey'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { useWorkbenchStore } from '@/store/modules/app/workbench'
import { WORKBENCH_ROLE_CODES, WORKBENCH_ROLE_LABELS, WORKBENCH_ROLE_PERMISSION_ALTERNATIVES } from '@/types/patient-journey'

defineOptions({ name: 'RoleWorkbench' })

const route = useRoute()
const router = useRouter()
const tenantStore = useAppTenantStore()
const workbenchStore = useWorkbenchStore()
const loading = ref(false)
const rows = ref<WorkbenchRow[]>([])
const counts = ref<Record<string, number>>({})
const voidVisible = ref(false)
const voidReason = ref('')
const voidTarget = ref<WorkbenchRow | null>(null)
const actionLoading = ref(false)
const triageVisible = ref(false)
const triageTarget = ref<WorkbenchRow | null>(null)
const triageForm = reactive({
  weightKg: 0,
  temperatureC: 0,
  heartRate: 0,
  respiratoryRate: 0,
  painScore: 0,
  acuity: 'routine',
  allergyNotes: '',
  chiefComplaint: '',
  notes: '',
})

const currentRoleCodes = computed(() => {
  const tenant = tenantStore.context?.tenants.find(item => item.id === tenantStore.currentTenantId)
  const store = tenant?.stores.find(item => item.id === tenantStore.currentStoreId)
  return new Set([...(tenant?.roles ?? []), ...(store?.roles ?? [])])
})
const hasRecognizedRole = computed(() => (Object.values(WORKBENCH_ROLE_CODES) as string[][])
  .flat().some(code => currentRoleCodes.value.has(code)))
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
  if (availableRoles.value.includes(candidate)) { return candidate }
  if (availableRoles.value.includes(workbenchStore.activeRole)) { return workbenchStore.activeRole }
  return availableRoles.value[0] ?? 'frontdesk'
})
const roleOptions = computed(() => availableRoles.value.map(value => ({ value, label: WORKBENCH_ROLE_LABELS[value] })))

const kpis = computed(() => Object.entries(counts.value).map(([status, value]) => ({ status, value })))

/** 由服务端返回当前门店、当前岗位的数据，页面不自行跨表拼装。 */
async function load() {
  if (!tenantStore.currentStoreId || !availableRoles.value.length) { return }
  loading.value = true
  try {
    const data = await apiJourney.getWorkbench(role.value, tenantStore.currentStoreId)
    rows.value = data.list
    counts.value = data.counts
    workbenchStore.selectRole(role.value)
  }
  catch (error: any) {
    useFaToast().error(error?.message || '工作台加载失败')
  }
  finally {
    loading.value = false
  }
}

async function refreshRoleContext() {
  loading.value = true
  try {
    await tenantStore.initContext()
    if (availableRoles.value.length) {
      await load()
    }
  }
  finally {
    loading.value = false
  }
}

function switchRole(value: unknown) {
  if (typeof value !== 'string' || !availableRoles.value.includes(value as WorkbenchRole)) {
    return
  }
  const nextRole = value as WorkbenchRole
  workbenchStore.selectRole(nextRole)
  apiJourney.savePreference(nextRole).catch(() => undefined)
  router.replace(`/workbenches/${nextRole}`)
}

function primaryAction(row: WorkbenchRow): { label: string, action: string } | null {
  if (role.value === 'cashier') { return row.status === 'pending' ? { label: '加入结算', action: 'settle' } : null }
  if (['frontdesk', 'doctor', 'manager'].includes(role.value)) {
    if (row.status === 'waiting') { return { label: '叫号', action: 'called' } }
    if (row.status === 'called') { return { label: '开始接诊', action: 'in_consultation' } }
    if (row.status === 'missed') { return { label: '召回候诊', action: 'waiting' } }
    if (row.encounter_id) { return { label: '查看患者', action: 'open' } }
    return null
  }
  if (role.value === 'triage') { return { label: '完成分诊', action: 'triage' } }
  if (row.status === 'pending') { return { label: '领取任务', action: 'claim' } }
  if (row.status === 'claimed') { return { label: '开始执行', action: 'start' } }
  if (row.status === 'in_progress') { return { label: '完成任务', action: 'complete' } }
  if (row.status === 'failed') { return { label: '重新领取', action: 'claim' } }
  return null
}

async function runPrimary(row: WorkbenchRow) {
  const command = primaryAction(row)
  if (!command) { return }
  if (command.action === 'open' && row.encounter_id) {
    router.push(`/clinical/encounter/${row.encounter_id}`)
    return
  }
  if (command.action === 'settle') {
    router.push({ path: '/billing/cashier', query: { encounterId: row.encounter_id } })
    return
  }
  if (command.action === 'triage') {
    triageTarget.value = row
    triageVisible.value = true
    return
  }
  actionLoading.value = true
  try {
    if (['called', 'in_consultation', 'waiting'].includes(command.action)) {
      await apiJourney.transitionQueue(row.id, role.value, command.action)
    }
    else {
      await apiJourney.transitionTask(row.id, role.value, command.action)
    }
    useFaToast().success('操作已完成并记录留痕')
    await load()
  }
  catch (error: any) {
    useFaToast().error(error?.message || '操作失败')
  }
  finally {
    actionLoading.value = false
  }
}

async function confirmTriage() {
  if (!triageTarget.value) { return }
  actionLoading.value = true
  try {
    await apiJourney.saveTriage(triageTarget.value.id, role.value, {
      ...(triageForm.weightKg > 0 ? { weightKg: triageForm.weightKg } : {}),
      ...(triageForm.temperatureC > 0 ? { temperatureC: triageForm.temperatureC } : {}),
      ...(triageForm.heartRate > 0 ? { heartRate: triageForm.heartRate } : {}),
      ...(triageForm.respiratoryRate > 0 ? { respiratoryRate: triageForm.respiratoryRate } : {}),
      painScore: triageForm.painScore,
      acuity: triageForm.acuity,
      allergyNotes: triageForm.allergyNotes,
      chiefComplaint: triageForm.chiefComplaint,
      notes: triageForm.notes,
      riskFlags: [],
    })
    triageVisible.value = false
    useFaToast().success('分诊完成，患者已进入候诊并记录操作人')
    await load()
  }
  catch (error: any) {
    useFaToast().error(error?.message || '分诊保存失败')
  }
  finally {
    actionLoading.value = false
  }
}

function askVoid(row: WorkbenchRow) {
  voidTarget.value = row
  voidReason.value = ''
  voidVisible.value = true
}

/** 收银异议只能作废待付款条目，保留原记录、原因、操作人和时间。 */
async function confirmVoid() {
  if (!voidTarget.value || !voidReason.value.trim()) {
    useFaToast().error('请填写客户异议或作废原因')
    return
  }
  actionLoading.value = true
  try {
    await apiJourney.voidChargeItem(voidTarget.value.id, voidReason.value.trim())
    voidVisible.value = false
    useFaToast().success('条目已作废，原记录和操作留痕已保留')
    await load()
  }
  catch (error: any) {
    useFaToast().error(error?.message || '作废失败')
  }
  finally {
    actionLoading.value = false
  }
}

function displayName(row: WorkbenchRow) {
  return `${row.pet?.name ?? '未命名宠物'} · ${row.customer?.name ?? '未知客户'}`
}

function waitMinutes(row: WorkbenchRow) {
  const time = row.checked_in_at ?? row.created_at
  return time ? Math.max(0, Math.floor((Date.now() - new Date(time).getTime()) / 60000)) : 0
}

watch([
  () => route.params.role,
  () => tenantStore.currentStoreId,
  () => availableRoles.value.join(','),
], load, { immediate: true })
</script>

<template>
  <div class="p-4 space-y-4">
    <FaCard>
      <div class="flex flex-wrap gap-3 items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold">
            {{ availableRoles.length ? WORKBENCH_ROLE_LABELS[role] : '岗位' }}工作台
          </h1>
          <p class="text-sm text-muted-foreground mt-1">
            同一患者旅程 · 岗位任务协同 · 每步操作自动留痕
          </p>
        </div>
        <div class="flex gap-2 items-center">
          <span class="text-sm text-muted-foreground">当前操作岗位</span>
          <FaSelect :model-value="availableRoles.length ? role : undefined" :options="roleOptions" :disabled="!availableRoles.length" placeholder="暂无可用岗位" class="w-36" @update:model-value="switchRole" />
          <FaButton variant="outline" :loading="loading" @click="load">
            <FaIcon name="i-lucide:refresh-cw" />刷新
          </FaButton>
        </div>
      </div>
    </FaCard>

    <FaCard v-if="!availableRoles.length" title="尚未识别到可用岗位">
      <div class="flex flex-wrap gap-4 items-center justify-between">
        <div class="text-sm text-muted-foreground">
          当前门店没有返回岗位或对应业务权限。请先刷新岗位信息；仍为空时，需要管理员为该员工分配门店岗位。
        </div>
        <FaButton :loading="loading" @click="refreshRoleContext">
          <FaIcon name="i-lucide:refresh-cw" />刷新岗位权限
        </FaButton>
      </div>
    </FaCard>

    <div v-if="availableRoles.length" class="gap-3 grid grid-cols-2 lg:grid-cols-5">
      <FaCard v-for="item in kpis" :key="item.status">
        <div class="text-xs text-muted-foreground">
          {{ item.status }}
        </div>
        <div class="text-2xl font-semibold mt-1">
          {{ item.value }}
        </div>
      </FaCard>
      <FaCard v-if="!kpis.length">
        <div class="text-sm text-muted-foreground">
          当前无待办
        </div>
      </FaCard>
    </div>

    <FaCard v-if="availableRoles.length" title="患者与任务队列">
      <div v-loading="loading" class="min-h-40 space-y-2">
        <div v-for="row in rows" :key="row.id" class="p-3 border rounded-lg flex gap-3 items-center justify-between">
          <div class="min-w-0">
            <div class="font-medium truncate">
              {{ displayName(row) }}
            </div>
            <div class="text-sm text-muted-foreground mt-1">
              {{ (row.queue_no ?? row.queue_number) ? `队列 ${row.queue_no ?? row.queue_number}` : (row.item_name ?? row.title ?? row.task_type) }}
              · {{ row.status }} · 等待 {{ waitMinutes(row) }} 分钟
            </div>
            <div v-if="role === 'cashier'" class="text-primary font-semibold mt-1">
              ¥{{ Number(row.amount ?? 0).toFixed(2) }} · 来源 {{ row.source_type ?? '-' }}
            </div>
            <div v-if="row.assignee" class="text-xs text-muted-foreground mt-1">
              执行人：{{ row.assignee.name }}（{{ row.assignee.employee_no }}）
            </div>
          </div>
          <div class="flex shrink-0 gap-2">
            <FaButton v-if="row.encounter_id" variant="outline" size="sm" @click="router.push(`/clinical/encounter/${row.encounter_id}`)">
              患者上下文
            </FaButton>
            <FaButton v-if="role === 'cashier' && row.status === 'pending'" variant="outline" size="sm" @click="askVoid(row)">
              异议作废
            </FaButton>
            <FaButton v-if="primaryAction(row)" size="sm" :loading="actionLoading" @click="runPrimary(row)">
              {{ primaryAction(row)?.label }}
            </FaButton>
          </div>
        </div>
        <div v-if="!loading && !rows.length" class="text-sm text-muted-foreground py-12 text-center">
          当前岗位没有待办患者
        </div>
      </div>
    </FaCard>

    <FaModal v-model:visible="voidVisible" title="作废待付款条目" :loading="actionLoading" @confirm="confirmVoid">
      <div class="space-y-3">
        <div class="text-sm text-amber-800 p-3 rounded-md bg-amber-50">
          该操作不会删除条目。系统将保留原金额、来源医嘱、作废原因、收银员身份和操作时间。
        </div>
        <FaLabel label="客户异议 / 作废原因（必填）">
          <FaTextarea v-model="voidReason" :maxlength="2000" placeholder="例如：客户对该检查项目有异议，经沟通确认本次不执行" />
        </FaLabel>
      </div>
    </FaModal>
    <FaModal v-model:visible="triageVisible" title="分诊评估" :loading="actionLoading" @confirm="confirmTriage">
      <div class="gap-3 grid grid-cols-2">
        <FaLabel label="体重（kg）">
          <FaNumberField v-model="triageForm.weightKg" :min="0.01" :step="0.1" />
        </FaLabel>
        <FaLabel label="体温（℃）">
          <FaNumberField v-model="triageForm.temperatureC" :min="20" :max="50" :step="0.1" />
        </FaLabel>
        <FaLabel label="心率">
          <FaNumberField v-model="triageForm.heartRate" :min="1" />
        </FaLabel>
        <FaLabel label="呼吸频率">
          <FaNumberField v-model="triageForm.respiratoryRate" :min="1" />
        </FaLabel>
        <FaLabel label="疼痛评分">
          <FaNumberField v-model="triageForm.painScore" :min="0" :max="10" />
        </FaLabel>
        <FaLabel label="分诊等级">
          <FaSelect
            v-model="triageForm.acuity" :options="[
              { label: '常规', value: 'routine' }, { label: '优先', value: 'priority' },
              { label: '紧急', value: 'urgent' }, { label: '急诊', value: 'emergency' },
            ]"
          />
        </FaLabel>
        <FaLabel label="主诉" class="col-span-2">
          <FaTextarea v-model="triageForm.chiefComplaint" />
        </FaLabel>
        <FaLabel label="过敏与风险" class="col-span-2">
          <FaTextarea v-model="triageForm.allergyNotes" />
        </FaLabel>
        <FaLabel label="分诊备注" class="col-span-2">
          <FaTextarea v-model="triageForm.notes" />
        </FaLabel>
      </div>
    </FaModal>
  </div>
</template>
