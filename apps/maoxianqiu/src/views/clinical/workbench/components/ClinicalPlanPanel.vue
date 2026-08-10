<script setup lang="ts">
/* eslint-disable style/max-statements-per-line -- 状态 variant 映射使用单行提前返回 */
import type { ImagingDraft, LabDraft, MedicalOrderDraft } from '../composables/useClinicalPlanDraft'
/**
 * ClinicalPlanPanel — 右侧诊疗方案区
 * FaTabs 固定四个页签(处方/检验/影像/医嘱),标题带当前数量。
 * 每个页签:上方已下项目紧凑列表(中文状态/数量/金额) + 下方快速编辑器。
 */
import type { PrescriptionItemInput } from '@/types/clinical'
import type { EncounterWorkspace } from '@/types/patient-journey'
import {
  MEDICAL_ORDER_STATUS_COLORS,
  MEDICAL_ORDER_STATUS_LABELS,
  MEDICAL_ORDER_TYPE_LABELS,
  PRESCRIPTION_STATUS_COLORS,
  PRESCRIPTION_STATUS_LABELS,
} from '@/types/clinical'
import DiagnosticOrderEditor from './DiagnosticOrderEditor.vue'
import MedicalOrderEditor from './MedicalOrderEditor.vue'
import PrescriptionEditor from './PrescriptionEditor.vue'

defineOptions({
  name: 'WorkbenchClinicalPlanPanel',
})

const props = defineProps<{
  workspace: EncounterWorkspace
  readonly: boolean
  // 处方草稿
  prescriptionItems: PrescriptionItemInput[]
  prescriptionSubmitting: boolean
  // 检验/影像草稿
  labDraft: LabDraft
  imagingDraft: ImagingDraft
  diagnosticSubmitting: boolean
  // 医嘱草稿
  medicalOrderDraft: MedicalOrderDraft
  medicalOrderSubmitting: boolean
}>()

const emit = defineEmits<{
  addPrescription: []
  removePrescription: [index: number]
  updatePrescription: [index: number, field: string, value: unknown]
  submitPrescription: []
  updateLab: [field: string, value: unknown]
  submitLab: []
  updateImaging: [field: string, value: unknown]
  submitImaging: []
  updateMedicalOrder: [field: string, value: unknown]
  submitMedicalOrder: []
  /** 用药安全阻断豁免:同屏填写原因并提交(服务端写豁免审计) */
  overrideCheck: [payload: { checkId: string, reason: string }]
}>()

const activeTab = ref('prescription')

/** 各阻断检查的豁免原因输入(按 check id 暂存) */
const overrideReasons = reactive<Record<string, string>>({})

const TABS = computed(() => [
  { label: `处方(${props.workspace.prescriptions.length})`, value: 'prescription' },
  { label: `检验(${props.workspace.labOrders.length})`, value: 'lab' },
  { label: `影像(${props.workspace.imagingOrders.length})`, value: 'imaging' },
  { label: `医嘱(${props.workspace.medicalOrders.length})`, value: 'medicalOrder' },
])

/** 检验状态中文映射(常见状态兜底) */
const LAB_STATUS_LABELS: Record<string, string> = {
  requested: '待采样',
  collected: '已采样',
  testing: '检验中',
  completed: '已完成',
  published: '已发布',
  cancelled: '已取消',
}

/** 影像状态中文映射 */
const IMAGING_STATUS_LABELS: Record<string, string> = {
  requested: '待排程',
  scheduled: '已排程',
  in_progress: '执行中',
  performed: '已执行',
  reported: '已出报告',
  reviewed: '已审核',
  published: '已发布',
  cancelled: '已取消',
}

/** 处方状态色(variant 映射) */
function statusVariant(key: string, map: Record<string, string>): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  const color = map[key] ?? 'default'
  if (color === 'success') { return 'success' }
  if (color === 'warning') { return 'warning' }
  if (color === 'danger') { return 'danger' }
  if (color === 'info') { return 'info' }
  return 'neutral'
}

/** 处方已下项目摘要 */
const prescriptionView = computed(() => {
  return props.workspace.prescriptions.flatMap((rx) => {
    const items = rx.items ?? []
    if (!items.length) {
      return [{
        id: rx.id,
        name: rx.name ?? '未命名处方',
        status: rx.status,
        qty: 1,
        amount: 0,
      }]
    }
    return items.map((item: any) => ({
      id: `${rx.id}:${item.id}`,
      name: item.drug_name ?? rx.name ?? '未命名',
      status: rx.status,
      qty: Number(item.quantity ?? 1),
      amount: 0,
    }))
  })
})
</script>

<template>
  <div class="flex flex-1 flex-col min-h-0">
    <FaTabs v-model="activeTab" :list="TABS" class="shrink-0" />

    <FaScrollArea class="flex-1 min-h-0">
      <div class="p-2 space-y-2">
        <!-- ===== 用药安全阻断与豁免(同屏闭环:填写原因→override→审计→刷新) ===== -->
        <div
          v-if="!readonly && workspace.medicationSafety.hasBlocking"
          class="p-2 border border-red-200 rounded-md bg-red-50/60 space-y-1.5 dark:bg-red-950/20"
        >
          <div class="text-xs text-red-600 font-medium flex gap-1 items-center">
            <FaIcon name="i-lucide:shield-alert" />
            用药安全阻断({{ workspace.medicationSafety.blockingChecks.length }})—— 须逐项豁免后方可提交
          </div>
          <div
            v-for="check in workspace.medicationSafety.blockingChecks"
            :key="check.id"
            class="text-xs space-y-1"
          >
            <div class="text-foreground">
              {{ check.message_snapshot }}
            </div>
            <div class="flex gap-1.5">
              <FaInput
                v-model="overrideReasons[check.id]"
                size="sm"
                placeholder="填写豁免原因(必填)"
                class="flex-1"
                @keyup.enter="emit('overrideCheck', { checkId: check.id, reason: overrideReasons[check.id] })"
              />
              <FaButton
                size="sm"
                variant="outline"
                :disabled="!overrideReasons[check.id]?.trim()"
                @click="emit('overrideCheck', { checkId: check.id, reason: overrideReasons[check.id] })"
              >
                豁免
              </FaButton>
            </div>
          </div>
        </div>

        <!-- ===== 处方页签 ===== -->
        <template v-if="activeTab === 'prescription'">
          <div v-if="prescriptionView.length" class="space-y-1.5">
            <div
              v-for="item in prescriptionView"
              :key="item.id"
              class="text-xs p-2 border rounded-md flex gap-2 items-center justify-between"
            >
              <span class="font-medium truncate">{{ item.name }}</span>
              <div class="flex shrink-0 gap-1.5 items-center">
                <span class="text-muted-foreground">×{{ item.qty }}</span>
                <EntityStatusTag
                  :label="PRESCRIPTION_STATUS_LABELS[item.status as keyof typeof PRESCRIPTION_STATUS_LABELS] ?? item.status"
                  :variant="statusVariant(item.status, PRESCRIPTION_STATUS_COLORS)"
                  :dot="false"
                />
              </div>
            </div>
          </div>
          <EmptyState v-else compact title="暂无处方" />
          <PrescriptionEditor
            :items="prescriptionItems"
            :submitting="prescriptionSubmitting"
            :readonly="readonly"
            class="mt-2"
            @add="emit('addPrescription')"
            @remove="emit('removePrescription', $event)"
            @update="(idx, field, val) => emit('updatePrescription', idx, field, val)"
            @submit="emit('submitPrescription')"
          />
        </template>

        <!-- ===== 检验页签 ===== -->
        <template v-else-if="activeTab === 'lab'">
          <div v-if="workspace.labOrders.length" class="space-y-1.5">
            <div
              v-for="lo in workspace.labOrders"
              :key="lo.id"
              class="text-xs p-2 border rounded-md flex gap-2 items-center justify-between"
            >
              <span class="font-medium truncate">{{ lo.order_no }}</span>
              <EntityStatusTag
                :label="LAB_STATUS_LABELS[lo.status as string] ?? lo.status"
                :variant="statusVariant(lo.status as string, { requested: 'warning', completed: 'success', cancelled: 'default', collected: 'info', testing: 'info', published: 'success' })"
                :dot="false"
              />
            </div>
          </div>
          <EmptyState v-else compact title="暂无检验申请" />
          <DiagnosticOrderEditor
            mode="lab"
            :draft="labDraft"
            :submitting="diagnosticSubmitting"
            :readonly="readonly"
            class="mt-2"
            @update="(field, val) => emit('updateLab', field, val)"
            @submit="emit('submitLab')"
          />
        </template>

        <!-- ===== 影像页签 ===== -->
        <template v-else-if="activeTab === 'imaging'">
          <div v-if="workspace.imagingOrders.length" class="space-y-1.5">
            <div
              v-for="io in workspace.imagingOrders"
              :key="io.id"
              class="text-xs p-2 border rounded-md flex gap-2 items-center justify-between"
            >
              <span class="font-medium truncate">{{ io.order_no }}</span>
              <EntityStatusTag
                :label="IMAGING_STATUS_LABELS[io.status as string] ?? io.status"
                :variant="statusVariant(io.status as string, { requested: 'warning', published: 'success', cancelled: 'default', in_progress: 'info' })"
                :dot="false"
              />
            </div>
          </div>
          <EmptyState v-else compact title="暂无影像申请" />
          <DiagnosticOrderEditor
            mode="imaging"
            :draft="imagingDraft"
            :submitting="diagnosticSubmitting"
            :readonly="readonly"
            class="mt-2"
            @update="(field, val) => emit('updateImaging', field, val)"
            @submit="emit('submitImaging')"
          />
        </template>

        <!-- ===== 医嘱页签 ===== -->
        <template v-else>
          <div v-if="workspace.medicalOrders.length" class="space-y-1.5">
            <div
              v-for="mo in workspace.medicalOrders"
              :key="mo.id"
              class="text-xs p-2 border rounded-md flex gap-2 items-center justify-between"
            >
              <span class="font-medium truncate">
                {{ MEDICAL_ORDER_TYPE_LABELS[mo.order_type as keyof typeof MEDICAL_ORDER_TYPE_LABELS] ?? mo.order_type }}
                · {{ mo.item_name }}
              </span>
              <EntityStatusTag
                :label="MEDICAL_ORDER_STATUS_LABELS[mo.status as keyof typeof MEDICAL_ORDER_STATUS_LABELS] ?? mo.status"
                :variant="statusVariant(mo.status, MEDICAL_ORDER_STATUS_COLORS)"
                :dot="false"
              />
            </div>
          </div>
          <EmptyState v-else compact title="暂无医嘱" />
          <MedicalOrderEditor
            :draft="medicalOrderDraft"
            :submitting="medicalOrderSubmitting"
            :readonly="readonly"
            class="mt-2"
            @update="(field, val) => emit('updateMedicalOrder', field, val)"
            @submit="emit('submitMedicalOrder')"
          />
        </template>
      </div>
    </FaScrollArea>
  </div>
</template>
