<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { NursingPlan, NursingTask, NursingTaskStatus } from '@/types/inpatient'
import apiInpatient from '@/api/modules/inpatient'
import BusinessAdmissionPicker from '@/components/business/AdmissionPicker/index.vue'
import BusinessEmployeePicker from '@/components/business/EmployeePicker/index.vue'
import BusinessPetPicker from '@/components/business/PetPicker/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  NURSING_FREQUENCY_LABELS,
  NURSING_TASK_STATUS_LABELS,
  NURSING_TASK_TYPE_LABELS,
} from '@/types/inpatient'

defineOptions({
  name: 'InpatientNursing',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const submitting = ref(false)

// 选中住院 id 用于查护理计划/任务
const selectedAdmissionId = ref('')

// 护理计划与任务
const plans = ref<NursingPlan[]>([])
const tasks = ref<NursingTask[]>([])

const planColumns = computed<TableColumn<NursingPlan>[]>(() => [
  { accessorKey: 'plan_name', header: '计划名称' },
  {
    accessorKey: 'frequency',
    header: '频率',
    cell: info => NURSING_FREQUENCY_LABELS[info.getValue() as keyof typeof NURSING_FREQUENCY_LABELS] ?? info.getValue(),
  },
  { accessorKey: 'start_date', header: '开始日期' },
  {
    accessorKey: 'end_date',
    header: '结束日期',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'is_active',
    header: '启用',
    cell: info => info.getValue() ? '是' : '否',
  },
])

const taskColumns = computed<TableColumn<NursingTask>[]>(() => [
  {
    accessorKey: 'scheduled_at',
    header: '计划时间',
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
  },
  {
    accessorKey: 'task_type',
    header: '任务类型',
    cell: info => NURSING_TASK_TYPE_LABELS[info.getValue() as keyof typeof NURSING_TASK_TYPE_LABELS] ?? info.getValue(),
  },
  {
    accessorKey: 'description',
    header: '描述',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'assigned_to',
    header: '负责人',
    cell: info => (info.getValue() as string | undefined)?.slice(0, 8) ?? '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const v = info.getValue() as NursingTaskStatus
      const label = NURSING_TASK_STATUS_LABELS[v] ?? v
      const colorMap: Record<string, string> = {
        pending: 'default',
        in_progress: 'info',
        done: 'success',
        skipped: 'warning',
      }
      return h('span', {
        class: `inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-${colorMap[v] ?? 'default'}-100 text-${colorMap[v] ?? 'default'}-700`,
      }, label)
    },
  },
  {
    accessorKey: 'completed_at',
    header: '完成时间',
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 200,
    align: 'center',
    fixed: 'right',
  },
])

const newPlan = reactive({
  planName: '',
  frequency: 'daily' as NursingPlan['frequency'],
  petId: '',
  endDate: '',
})

const newTask = reactive({
  taskType: 'medication' as NursingTask['task_type'],
  description: '',
  scheduledAt: '',
  assignedTo: '',
})

/** 加载护理计划与任务 */
async function loadData() {
  if (!selectedAdmissionId.value) {
    plans.value = []
    tasks.value = []
    return
  }
  loading.value = true
  try {
    const [plansRes, tasksRes] = await Promise.all([
      apiInpatient.listNursingPlans(selectedAdmissionId.value),
      apiInpatient.listNursingTasks(selectedAdmissionId.value),
    ])
    plans.value = plansRes.data.list
    tasks.value = tasksRes.data.list
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '加载护理数据失败')
  }
  finally {
    loading.value = false
  }
}

/** 创建护理计划 */
async function onCreatePlan() {
  if (!selectedAdmissionId.value || !newPlan.planName || !newPlan.petId) {
    useFaToast().warning('请选择住院记录、宠物并填写计划名称')
    return
  }
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择工作门店')
    return
  }
  submitting.value = true
  try {
    await apiInpatient.createNursingPlan({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId,
      admissionId: selectedAdmissionId.value,
      petId: newPlan.petId.trim(),
      planName: newPlan.planName,
      frequency: newPlan.frequency,
      endDate: newPlan.endDate || undefined,
    })
    useFaToast().success('护理计划已创建')
    newPlan.planName = ''
    newPlan.petId = ''
    newPlan.endDate = ''
    await loadData()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

/** 创建护理任务 */
async function onCreateTask() {
  if (!selectedAdmissionId.value || !newTask.scheduledAt) {
    useFaToast().warning('请选择住院记录并填写计划时间')
    return
  }
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择工作门店')
    return
  }
  submitting.value = true
  try {
    // 从护理计划中取 pet_id(若没有计划,需要用户填写;此处从已加载的计划取第一条)
    const petId = plans.value[0]?.pet_id ?? ''
    if (!petId) {
      useFaToast().warning('请先创建护理计划或选择宠物')
      return
    }
    await apiInpatient.createNursingTask({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId,
      admissionId: selectedAdmissionId.value,
      petId,
      taskType: newTask.taskType,
      description: newTask.description || undefined,
      scheduledAt: new Date(newTask.scheduledAt).toISOString(),
      assignedTo: newTask.assignedTo.trim() || undefined,
    })
    useFaToast().success('护理任务已创建')
    newTask.description = ''
    newTask.scheduledAt = ''
    newTask.assignedTo = ''
    await loadData()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

/** 开始执行任务(pending → in_progress) */
async function onStartTask(row: NursingTask) {
  if (row.status !== 'pending') {
    useFaToast().warning('仅「待执行」状态可开始')
    return
  }
  try {
    await apiInpatient.updateNursingTaskStatus(row.id, 'in_progress')
    useFaToast().success('任务已开始')
    await loadData()
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

/** 完成任务(in_progress → done) */
async function onCompleteTask(row: NursingTask) {
  if (row.status !== 'in_progress') {
    useFaToast().warning('仅「执行中」状态可完成')
    return
  }
  try {
    await apiInpatient.updateNursingTaskStatus(row.id, 'done')
    useFaToast().success('任务已完成')
    await loadData()
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

/** 跳过任务(pending → skipped) */
async function onSkipTask(row: NursingTask) {
  if (row.status !== 'pending') {
    useFaToast().warning('仅「待执行」状态可跳过')
    return
  }
  useFaModal().confirm({
    title: '跳过任务',
    content: '确认跳过此护理任务？',
    onConfirm: async () => {
      try {
        await apiInpatient.updateNursingTaskStatus(row.id, 'skipped')
        useFaToast().success('任务已跳过')
        await loadData()
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

onMounted(() => {
  // 不预加载,等用户填写住院 ID 后查询
})
</script>

<template>
  <div>
    <FaPageHeader title="护理管理" class="mb-0">
      <template #description>
        维护住院宠物的护理计划与任务,状态机:pending → in_progress → done;pending → skipped
      </template>
    </FaPageHeader>
    <FaPageMain>
      <!-- 选择住院记录 -->
      <div class="mb-4 p-4 border rounded-lg bg-muted/30">
        <div class="gap-3 grid grid-cols-1 items-end md:grid-cols-3">
          <FaLabel label="住院记录">
            <BusinessAdmissionPicker v-model="selectedAdmissionId" placeholder="搜索选择住院记录" />
          </FaLabel>
          <div class="flex gap-2">
            <FaButton type="primary" @click="loadData">
              <FaIcon name="i-ri:search-line" />
              查询
            </FaButton>
          </div>
        </div>
      </div>

      <div v-if="selectedAdmissionId" v-loading="loading">
        <!-- 新建护理计划 -->
        <div class="mb-4 p-4 border rounded-lg">
          <div class="mb-3 flex gap-2 items-center">
            <FaIcon name="i-ri:clipboard-line" class="text-lg" />
            <span class="font-bold">新建护理计划</span>
          </div>
          <div class="gap-3 grid grid-cols-1 items-end md:grid-cols-4">
            <FaLabel label="计划名称">
              <FaInput v-model="newPlan.planName" placeholder="如:术后观察" class="w-full" />
            </FaLabel>
            <FaLabel label="宠物">
              <BusinessPetPicker v-model="newPlan.petId" placeholder="搜索选择宠物" class="w-full" />
            </FaLabel>
            <FaLabel label="频率">
              <FaSelect v-model="newPlan.frequency" class="w-full" :options="Object.entries(NURSING_FREQUENCY_LABELS).map(([value, label]) => ({ label, value }))" />
            </FaLabel>
            <FaLabel label="结束日期(可选)">
              <FaInput v-model="newPlan.endDate" type="date" class="w-full" />
            </FaLabel>
            <div class="flex col-span-full justify-end">
              <FaButton type="primary" :loading="submitting" @click="onCreatePlan">
                <FaIcon name="i-ri:add-line" />
                创建计划
              </FaButton>
            </div>
          </div>
        </div>

        <!-- 护理计划表格 -->
        <div class="mb-6">
          <div class="mb-2 flex gap-2 items-center">
            <FaIcon name="i-ri:list-check" class="text-lg" />
            <span class="text-lg font-bold">护理计划</span>
            <FaTag variant="outline" size="sm">
              {{ plans.length }} 项
            </FaTag>
          </div>
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="planColumns"
            :data="plans"
          />
        </div>

        <!-- 新建护理任务 -->
        <div class="mb-4 p-4 border rounded-lg">
          <div class="mb-3 flex gap-2 items-center">
            <FaIcon name="i-ri:task-line" class="text-lg" />
            <span class="font-bold">新建护理任务</span>
          </div>
          <div class="gap-3 grid grid-cols-1 items-end md:grid-cols-4">
            <FaLabel label="任务类型">
              <FaSelect v-model="newTask.taskType" class="w-full" :options="Object.entries(NURSING_TASK_TYPE_LABELS).map(([value, label]) => ({ label, value }))" />
            </FaLabel>
            <FaLabel label="计划时间">
              <FaInput v-model="newTask.scheduledAt" type="datetime-local" class="w-full" />
            </FaLabel>
            <FaLabel label="负责人(可选)">
              <BusinessEmployeePicker v-model="newTask.assignedTo" value-key="user_id" placeholder="搜索选择员工" />
            </FaLabel>
            <FaLabel label="描述">
              <FaInput v-model="newTask.description" placeholder="任务描述" class="w-full" />
            </FaLabel>
            <div class="flex col-span-full justify-end">
              <FaButton type="primary" :loading="submitting" @click="onCreateTask">
                <FaIcon name="i-ri:add-line" />
                创建任务
              </FaButton>
            </div>
          </div>
        </div>

        <!-- 护理任务表格 -->
        <div>
          <div class="mb-2 flex gap-2 items-center">
            <FaIcon name="i-ri:checkbox-multiple-line" class="text-lg" />
            <span class="text-lg font-bold">护理任务</span>
            <FaTag variant="outline" size="sm">
              {{ tasks.length }} 项
            </FaTag>
          </div>
          <FaTable
            table-root-class="rounded-lg overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="taskColumns"
            :data="tasks"
          >
            <template #cell-operation="{ row }">
              <div class="flex-center gap-2">
                <FaButton
                  v-if="row.original.status === 'pending'"
                  variant="outline"
                  size="sm"
                  @click="onStartTask(row.original)"
                >
                  <FaIcon name="i-ri:play-line" />
                  开始
                </FaButton>
                <FaButton
                  v-if="row.original.status === 'in_progress'"
                  variant="default"
                  size="sm"
                  @click="onCompleteTask(row.original)"
                >
                  <FaIcon name="i-ri:check-line" />
                  完成
                </FaButton>
                <FaButton
                  v-if="row.original.status === 'pending'"
                  variant="outline"
                  size="sm"
                  @click="onSkipTask(row.original)"
                >
                  <FaIcon name="i-ri:skip-forward-line" />
                  跳过
                </FaButton>
              </div>
            </template>
          </FaTable>
        </div>
      </div>
      <div v-else class="text-muted-foreground py-12 text-center">
        请先输入住院 ID 查询护理数据
      </div>
    </FaPageMain>
  </div>
</template>
