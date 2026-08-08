<script setup lang="ts">
/**
 * FollowupDetailDrawer — 回访任务详情抽屉(S3.1-AGENT-04)
 * 展示客户/宠物/来源/负责人/计划时间/结果,并提供:
 *   pending      → 开始 / 取消
 *   in_progress  → 登记结果 / 取消
 * 任何状态变更后通过 changed 事件通知父组件刷新列表。
 */
import type { FollowupResultCode, FollowupTaskRecord } from '@/types/customer'
import apiCustomer from '@/api/modules/customer'
import { FOLLOWUP_CHANNEL_LABELS, FOLLOWUP_RESULT_LABELS, FOLLOWUP_SOURCE_LABELS, FOLLOWUP_STATUS_LABELS, FOLLOWUP_TASK_TYPE_LABELS } from '@/types/customer'

defineOptions({
  name: 'FollowupDetailDrawer',
})

const router = useRouter()

const props = defineProps<{
  taskId: string
}>()

const emit = defineEmits<{
  changed: [task: FollowupTaskRecord]
}>()

const model = defineModel<boolean>({ default: false })

const loading = ref(false)
const task = ref<FollowupTaskRecord | null>(null)
const submitting = ref(false)
/** 操作模式:view=只读 complete=登记结果 cancel=取消 */
const mode = ref<'view' | 'complete' | 'cancel'>('view')

const completeForm = ref({
  resultCode: 'contacted' as FollowupResultCode,
  resultNote: '',
  nextFollowupAt: '',
})

const cancelReason = ref('')

watch(model, (val) => {
  if (val) {
    mode.value = 'view'
    load()
  }
})

async function load() {
  loading.value = true
  try {
    const res: any = await apiCustomer.getFollowup(props.taskId)
    task.value = res.data as FollowupTaskRecord
  }
  catch (e: any) {
    useFaToast().error('加载失败', { description: e?.message })
  }
  finally {
    loading.value = false
  }
}

function openComplete() {
  completeForm.value = {
    resultCode: 'contacted',
    resultNote: '',
    nextFollowupAt: '',
  }
  mode.value = 'complete'
}

function openCancel() {
  cancelReason.value = ''
  mode.value = 'cancel'
}

function toLocalInput(iso?: string): string {
  if (!iso) {
    return ''
  }
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function onStart() {
  if (submitting.value) {
    return
  }
  submitting.value = true
  try {
    const res: any = await apiCustomer.startFollowup(props.taskId)
    task.value = res.data as FollowupTaskRecord
    useFaToast().success('已开始回访')
    emit('changed', task.value)
  }
  catch (e: any) {
    useFaToast().error('操作失败', { description: e?.message })
  }
  finally {
    submitting.value = false
  }
}

async function onComplete() {
  if (!completeForm.value.resultCode && !completeForm.value.resultNote.trim()) {
    useFaToast().warning('请登记回访结果')
    return
  }
  if (submitting.value) {
    return
  }
  submitting.value = true
  try {
    const res: any = await apiCustomer.completeFollowup(props.taskId, {
      resultCode: completeForm.value.resultCode,
      resultNote: completeForm.value.resultNote.trim() || undefined,
      nextFollowupAt: completeForm.value.nextFollowupAt || undefined,
    })
    task.value = res.data as FollowupTaskRecord
    mode.value = 'view'
    useFaToast().success('回访已完成')
    emit('changed', task.value)
  }
  catch (e: any) {
    useFaToast().error('操作失败', { description: e?.message })
  }
  finally {
    submitting.value = false
  }
}

async function onCancel() {
  if (!cancelReason.value.trim()) {
    useFaToast().warning('请填写取消原因')
    return
  }
  if (submitting.value) {
    return
  }
  submitting.value = true
  try {
    const res: any = await apiCustomer.cancelFollowup(props.taskId, cancelReason.value.trim())
    task.value = res.data as FollowupTaskRecord
    mode.value = 'view'
    useFaToast().success('回访已取消')
    emit('changed', task.value)
  }
  catch (e: any) {
    useFaToast().error('操作失败', { description: e?.message })
  }
  finally {
    submitting.value = false
  }
}

const sourceLink = computed(() => {
  const t = task.value
  if (!t?.source_id) {
    return null
  }
  if (t.source_type === 'encounter') {
    return { path: `/clinical/encounter/${t.source_id}`, label: '查看就诊' }
  }
  return null
})

function onField(label: string, value: string) {
  return { label, value: value || '-' }
}
</script>

<template>
  <FaDrawer v-model="model" title="回访任务详情" :width="620">
    <div v-loading="loading" class="flex flex-col gap-4">
      <template v-if="task">
        <!-- 状态与主操作 -->
        <div class="flex items-center gap-2">
          <BusinessEntityStatusTag
            :label="FOLLOWUP_STATUS_LABELS[task.status] ?? task.status"
            :variant="task.status === 'completed' ? 'success' : task.status === 'cancelled' ? 'neutral' : task.status === 'in_progress' ? 'info' : 'warning'"
            dot
          />
          <span v-if="task.scheduled_at" class="text-sm text-muted-foreground">
            计划:{{ toLocalInput(task.scheduled_at) }}
          </span>
        </div>

        <!-- 基本信息 -->
        <div class="gap-3 grid grid-cols-2">
          <div v-for="f in [
            onField('客户', task.customer_name ?? task.customer_id),
            onField('宠物', task.pet_name ?? ''),
            onField('来源', FOLLOWUP_SOURCE_LABELS[task.source_type] ?? task.source_type),
            onField('任务类型', FOLLOWUP_TASK_TYPE_LABELS[task.task_type] ?? task.task_type),
            onField('负责人', task.assignee_name ?? ''),
            onField('渠道', task.channel ? (FOLLOWUP_CHANNEL_LABELS[task.channel] ?? task.channel) : ''),
          ]" :key="f.label" class="flex flex-col gap-0.5">
            <span class="text-xs text-muted-foreground">{{ f.label }}</span>
            <span class="text-sm">{{ f.value }}</span>
          </div>
        </div>

        <!-- 结果(已完成后) -->
        <div v-if="task.status === 'completed'" class="border rounded-lg bg-muted/40 p-3">
          <div class="text-xs text-muted-foreground mb-1">回访结果</div>
          <div class="text-sm">
            {{ task.result_code ? (FOLLOWUP_RESULT_LABELS[task.result_code] ?? task.result_code) : '' }}
            {{ task.result_note ? ` · ${task.result_note}` : '' }}
          </div>
          <div v-if="task.next_followup_at" class="text-sm text-muted-foreground mt-1">
            下次回访:{{ toLocalInput(task.next_followup_at) }}
          </div>
          <div v-if="task.completed_at" class="text-xs text-muted-foreground mt-1">
            完成于 {{ toLocalInput(task.completed_at) }}
          </div>
        </div>

        <!-- 取消原因(已取消后) -->
        <div v-if="task.status === 'cancelled' && task.cancel_reason" class="border rounded-lg bg-muted/40 p-3">
          <div class="text-xs text-muted-foreground mb-1">取消原因</div>
          <div class="text-sm">{{ task.cancel_reason }}</div>
        </div>

        <!-- 登记结果表单 -->
        <div v-if="mode === 'complete'" class="border rounded-lg p-3 flex flex-col gap-3">
          <div class="text-sm font-medium">登记回访结果</div>
          <FaLabel label="结果">
            <FaSelect
              v-model="completeForm.resultCode"
              :options="[
                { label: '已联系', value: 'contacted' },
                { label: '未接通', value: 'unreachable' },
                { label: '已改期', value: 'rescheduled' },
                { label: '其他', value: 'other' },
              ]"
            />
          </FaLabel>
          <FaLabel label="备注">
            <FaInput v-model="completeForm.resultNote" type="textarea" :rows="3" placeholder="回访沟通记录(可留空)" />
          </FaLabel>
          <FaLabel label="下次回访(可留空)">
            <FaInput v-model="completeForm.nextFollowupAt" type="datetime-local" class="w-full" />
          </FaLabel>
          <div class="flex gap-2 justify-end">
            <FaButton variant="outline" size="sm" @click="mode = 'view'">
              返回
            </FaButton>
            <FaButton type="primary" size="sm" :loading="submitting" @click="onComplete">
              确认完成
            </FaButton>
          </div>
        </div>

        <!-- 取消表单 -->
        <div v-if="mode === 'cancel'" class="border rounded-lg p-3 flex flex-col gap-3">
          <div class="text-sm font-medium">取消回访</div>
          <FaLabel label="取消原因" required>
            <FaInput v-model="cancelReason" type="textarea" :rows="3" placeholder="必填,请说明取消原因" />
          </FaLabel>
          <div class="flex gap-2 justify-end">
            <FaButton variant="outline" size="sm" @click="mode = 'view'">
              返回
            </FaButton>
            <FaButton variant="destructive" size="sm" :loading="submitting" @click="onCancel">
              确认取消
            </FaButton>
          </div>
        </div>

        <!-- 主操作区 -->
        <div v-if="mode === 'view'" class="flex gap-2">
          <template v-if="task.status === 'pending'">
            <FaButton type="primary" size="sm" :loading="submitting" @click="onStart">
              开始回访
            </FaButton>
            <FaButton variant="outline" size="sm" @click="openCancel">
              取消
            </FaButton>
          </template>
          <template v-else-if="task.status === 'in_progress'">
            <FaButton type="primary" size="sm" @click="openComplete">
              登记结果
            </FaButton>
            <FaButton variant="outline" size="sm" @click="openCancel">
              取消
            </FaButton>
          </template>
        </div>

        <!-- 深链 -->
        <div class="border-t pt-3 flex flex-wrap gap-2">
          <FaButton variant="ghost" size="sm" @click="router.push(`/crm/customer/${task.customer_id}`)">
            <FaIcon name="i-lucide:user-round" />
            查看客户
          </FaButton>
          <FaButton v-if="task.pet_id" variant="ghost" size="sm" @click="router.push(`/crm/pet/${task.pet_id}`)">
            <FaIcon name="i-lucide:paw-print" />
            查看宠物
          </FaButton>
          <FaButton v-if="sourceLink" variant="ghost" size="sm" @click="router.push(sourceLink.path)">
            <FaIcon name="i-lucide:clipboard-list" />
            {{ sourceLink.label }}
          </FaButton>
        </div>
      </template>
      <FaEmptyState v-else-if="!loading" description="未找到回访任务" />
    </div>
  </FaDrawer>
</template>
