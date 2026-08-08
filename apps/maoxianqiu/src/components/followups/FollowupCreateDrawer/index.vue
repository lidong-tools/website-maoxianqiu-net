<script setup lang="ts">
/**
 * FollowupCreateDrawer — 新建回访任务抽屉(S3.1-AGENT-04)
 * 仅支持手动创建;encounter/discharge 自动触发由对应域 Owner 集成。
 * 成功后通过 created 事件通知父组件刷新列表。
 */
import type { CreateFollowupInput, FollowupChannel, FollowupTaskRecord, FollowupTaskType } from '@/types/customer'
import apiCustomer from '@/api/modules/customer'

defineOptions({
  name: 'FollowupCreateDrawer',
})

const props = withDefaults(defineProps<{
  tenantId: string
  storeId?: string
  /** 从客户详情进入时预填客户 */
  presetCustomerId?: string
}>(), {
  storeId: undefined,
  presetCustomerId: undefined,
})

const emit = defineEmits<{
  created: [task: FollowupTaskRecord]
}>()

const model = defineModel<boolean>({ default: false })

const submitting = ref(false)
const form = ref<{
  customerId: string
  petId: string
  taskType: FollowupTaskType
  scheduledAt: string
  assigneeEmployeeId: string
  channel: FollowupChannel | ''
}>({
  customerId: '',
  petId: '',
  taskType: 'customer_care',
  scheduledAt: '',
  assigneeEmployeeId: '',
  channel: '',
})

watch(model, (val) => {
  if (val) {
    form.value = {
      customerId: props.presetCustomerId ?? '',
      petId: '',
      taskType: 'customer_care',
      scheduledAt: toLocalInput(),
      assigneeEmployeeId: '',
      channel: '',
    }
  }
})

function toLocalInput(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function onSubmit() {
  if (!form.value.customerId) {
    useFaToast().warning('请选择客户')
    return
  }
  if (!form.value.scheduledAt) {
    useFaToast().warning('请选择计划时间')
    return
  }
  if (submitting.value) {
    return
  }

  submitting.value = true
  try {
    const input: CreateFollowupInput = {
      tenantId: props.tenantId,
      storeId: props.storeId || undefined,
      customerId: form.value.customerId,
      petId: form.value.petId || undefined,
      taskType: form.value.taskType,
      scheduledAt: form.value.scheduledAt,
      assigneeEmployeeId: form.value.assigneeEmployeeId || undefined,
      channel: form.value.channel || undefined,
      sourceType: 'manual',
    }
    const res: any = await apiCustomer.createFollowup(input)
    useFaToast().success('回访任务已创建')
    model.value = false
    emit('created', res.data as FollowupTaskRecord)
  }
  catch (e: any) {
    useFaToast().error('创建失败', { description: e?.message })
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <FaDrawer v-model="model" title="新建回访" :width="560">
    <div class="flex flex-col gap-4">
      <FaLabel label="客户" required>
        <BusinessCustomerPicker v-model="form.customerId" :disabled="!!presetCustomerId" />
      </FaLabel>
      <FaLabel label="宠物">
        <BusinessPetPicker v-model="form.petId" :customer-id="form.customerId || undefined" placeholder="选择宠物(可留空)" />
      </FaLabel>
      <FaLabel label="任务类型">
        <FaSelect
          v-model="form.taskType"
          :options="[
            { label: '诊后回访', value: 'post_visit' },
            { label: '出院回访', value: 'post_discharge' },
            { label: '用药跟进', value: 'medication' },
            { label: '复诊提醒', value: 'recheck' },
            { label: '关怀回访', value: 'customer_care' },
            { label: '其他', value: 'other' },
          ]"
        />
      </FaLabel>
      <FaLabel label="计划时间" required>
        <FaInput v-model="form.scheduledAt" type="datetime-local" class="w-full" />
      </FaLabel>
      <FaLabel label="负责人">
        <BusinessEmployeePicker v-model="form.assigneeEmployeeId" placeholder="选择负责人(可留空)" />
      </FaLabel>
      <FaLabel label="回访渠道">
        <FaSelect
          v-model="form.channel"
          :options="[
            { label: '电话', value: 'phone' },
            { label: '微信', value: 'wechat' },
            { label: '短信', value: 'sms' },
            { label: '当面', value: 'in_person' },
            { label: '其他', value: 'other' },
          ]"
          placeholder="选择渠道(可留空)"
        />
      </FaLabel>
    </div>
    <template #footer>
      <div class="flex gap-2 justify-end">
        <FaButton variant="outline" @click="model = false">
          取消
        </FaButton>
        <FaButton type="primary" :loading="submitting" @click="onSubmit">
          创建
        </FaButton>
      </div>
    </template>
  </FaDrawer>
</template>
