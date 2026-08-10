/**
 * 诊疗方案草稿组合式函数
 * 负责:处方/检验/影像/医嘱四类下单草稿的编辑、校验与提交。
 * 提交遵循"浏览器查询可直连,业务命令走 Hono + PostgreSQL RPC":
 *  - 处方: savePrescription + issuePrescription(数据库事务生成收费与药房任务)
 *  - 检验/影像: createLabOrder / createImagingOrder(后端同步收费与下游任务)
 *  - 医嘱: createMedicalOrder(自动生成护士任务)
 * 所有下单草稿纳入统一 dirty guard,防止切换患者丢失未提交内容。
 */
import type { PrescriptionItemInput } from '@/types/clinical'
import apiClinical from '@/api/modules/clinical'
import apiCompliance from '@/api/modules/compliance'
import apiDiagnostics from '@/api/modules/diagnostics'
import { useAppTenantStore } from '@/store/modules/app/tenant'

/** 检验申请草稿 */
export interface LabDraft {
  catalogItemId: string
  remark: string
  /** 临床问题(检验目的描述,随申请单落库) */
  clinicalQuestion: string
}

/** 影像申请草稿 */
export interface ImagingDraft {
  catalogItemId: string
  imagingType: 'ultrasound' | 'xray' | 'cr' | 'ct' | 'mri' | 'other'
  clinicalQuestion: string
}

/** 医嘱草稿 */
export interface MedicalOrderDraft {
  orderType: 'injection' | 'infusion' | 'treatment' | 'disposal' | 'nursing' | 'medication' | 'other'
  itemName: string
  dosage: string
  frequency: string
  quantity: number
  unit: string
  instructions: string
  /** 计划执行时间(可选,缺省立即执行) */
  scheduledAt: string
  /** 指定执行护士(auth.users.id,空=待分派) */
  assigneeId: string
}

export function useClinicalPlanDraft() {
  const tenantStore = useAppTenantStore()

  // ===== 处方草稿 =====
  const prescriptionDraft = ref<PrescriptionItemInput[]>([])
  const prescriptionSubmitting = ref(false)

  function emptyPrescriptionItem(): PrescriptionItemInput {
    return { catalogItemId: '', drugName: '', dosage: '', frequency: '', quantity: 1, unit: '', instructions: '' }
  }

  /** 重置处方草稿为一行空行 */
  function resetPrescriptionDraft() {
    prescriptionDraft.value = [emptyPrescriptionItem()]
  }

  function addPrescriptionItem() {
    prescriptionDraft.value.push(emptyPrescriptionItem())
  }

  function removePrescriptionItem(index: number) {
    prescriptionDraft.value.splice(index, 1)
    if (!prescriptionDraft.value.length) {
      addPrescriptionItem()
    }
  }

  /** 逐字段更新处方行(由 PrescriptionEditor emit 驱动,避免子组件直接改 props) */
  function updatePrescriptionItem(index: number, field: string, value: unknown) {
    const item = prescriptionDraft.value[index]
    if (item) {
      (item as unknown as Record<string, unknown>)[field] = value
    }
  }

  /** 有效处方行:已选价目 + 有药名 + 数量为正 */
  const validPrescriptionItems = computed(() =>
    prescriptionDraft.value.filter(item => item.catalogItemId && item.drugName && Number(item.quantity) > 0),
  )

  /** 保存并开具处方;开具成功后由数据库事务生成待收费项和药房任务 */
  async function submitPrescription(encounterId: string): Promise<boolean> {
    if (!validPrescriptionItems.value.length) {
      useFaToast().warning('请至少选择一种药品并填写有效数量')
      return false
    }
    prescriptionSubmitting.value = true
    try {
      const saved = await apiClinical.savePrescription({ encounterId, items: validPrescriptionItems.value })
      await apiCompliance.issuePrescription(saved.data.id, {})
      resetPrescriptionDraft()
      useFaToast().success('处方已开具,药品费用已同步到客户待付款')
      return true
    }
    catch (error: any) {
      useFaToast().error(error?.message || '开具处方失败')
      return false
    }
    finally {
      prescriptionSubmitting.value = false
    }
  }

  // ===== 检验草稿 =====
  const labDraft = reactive<LabDraft>({ catalogItemId: '', remark: '', clinicalQuestion: '' })
  const diagnosticSubmitting = ref(false)

  function resetLabDraft() {
    labDraft.catalogItemId = ''
    labDraft.remark = ''
    labDraft.clinicalQuestion = ''
  }

  /** 逐字段更新检验草稿(由 DiagnosticOrderEditor emit 驱动) */
  function updateLabDraft(field: string, value: unknown) {
    ;(labDraft as unknown as Record<string, unknown>)[field] = value
  }

  /** 创建检验申请并同步收费、执行岗位任务和操作留痕 */
  async function submitLab(encounterId: string, customerId: string, petId: string): Promise<boolean> {
    if (!labDraft.catalogItemId || !tenantStore.currentTenantId) {
      useFaToast().warning('请选择检验价目')
      return false
    }
    diagnosticSubmitting.value = true
    try {
      await apiDiagnostics.createLabOrder({
        tenantId: tenantStore.currentTenantId,
        storeId: tenantStore.currentStoreId || undefined,
        encounterId,
        customerId,
        petId,
        catalogItemId: labDraft.catalogItemId,
        remark: labDraft.remark || undefined,
        clinicalQuestion: labDraft.clinicalQuestion || undefined,
      })
      resetLabDraft()
      useFaToast().success('检验申请已创建,费用已同步到客户待付款')
      return true
    }
    catch (error: any) {
      useFaToast().error(error?.message || '创建检验申请失败')
      return false
    }
    finally {
      diagnosticSubmitting.value = false
    }
  }

  // ===== 影像草稿 =====
  const imagingDraft = reactive<ImagingDraft>({ catalogItemId: '', imagingType: 'other', clinicalQuestion: '' })

  function resetImagingDraft() {
    imagingDraft.catalogItemId = ''
    imagingDraft.imagingType = 'other'
    imagingDraft.clinicalQuestion = ''
  }

  /** 逐字段更新影像草稿(由 DiagnosticOrderEditor emit 驱动) */
  function updateImagingDraft(field: string, value: unknown) {
    ;(imagingDraft as unknown as Record<string, unknown>)[field] = value
  }

  /** 创建影像申请并同步收费、执行岗位任务和操作留痕 */
  async function submitImaging(encounterId: string, customerId: string, petId: string): Promise<boolean> {
    if (!imagingDraft.catalogItemId || !tenantStore.currentTenantId) {
      useFaToast().warning('请选择影像价目')
      return false
    }
    diagnosticSubmitting.value = true
    try {
      await apiDiagnostics.createImagingOrder({
        tenantId: tenantStore.currentTenantId,
        storeId: tenantStore.currentStoreId || undefined,
        encounterId,
        customerId,
        petId,
        imagingType: imagingDraft.imagingType,
        catalogItemId: imagingDraft.catalogItemId,
        clinicalQuestion: imagingDraft.clinicalQuestion || undefined,
      })
      resetImagingDraft()
      useFaToast().success('影像申请已创建,费用已同步到客户待付款')
      return true
    }
    catch (error: any) {
      useFaToast().error(error?.message || '创建影像申请失败')
      return false
    }
    finally {
      diagnosticSubmitting.value = false
    }
  }

  // ===== 医嘱草稿 =====
  const medicalOrderDraft = reactive<MedicalOrderDraft>({
    orderType: 'treatment',
    itemName: '',
    dosage: '',
    frequency: '',
    quantity: 1,
    unit: '',
    instructions: '',
    scheduledAt: '',
    assigneeId: '',
  })
  const medicalOrderSubmitting = ref(false)

  function resetMedicalOrderDraft() {
    medicalOrderDraft.orderType = 'treatment'
    medicalOrderDraft.itemName = ''
    medicalOrderDraft.dosage = ''
    medicalOrderDraft.frequency = ''
    medicalOrderDraft.quantity = 1
    medicalOrderDraft.unit = ''
    medicalOrderDraft.instructions = ''
    medicalOrderDraft.scheduledAt = ''
    medicalOrderDraft.assigneeId = ''
  }

  /** 逐字段更新医嘱草稿(由 MedicalOrderEditor emit 驱动) */
  function updateMedicalOrderDraft(field: string, value: unknown) {
    ;(medicalOrderDraft as unknown as Record<string, unknown>)[field] = value
  }

  /** 开立医嘱并自动生成护士任务 */
  async function submitMedicalOrder(encounterId: string, customerId: string, petId: string): Promise<boolean> {
    if (!medicalOrderDraft.itemName || !tenantStore.currentTenantId) {
      useFaToast().warning('请填写医嘱项目')
      return false
    }
    medicalOrderSubmitting.value = true
    try {
      await apiClinical.createMedicalOrder({
        tenantId: tenantStore.currentTenantId,
        storeId: tenantStore.currentStoreId || undefined,
        encounterId,
        customerId,
        petId,
        orderType: medicalOrderDraft.orderType,
        itemName: medicalOrderDraft.itemName,
        dosage: medicalOrderDraft.dosage || undefined,
        frequency: medicalOrderDraft.frequency || undefined,
        quantity: medicalOrderDraft.quantity,
        unit: medicalOrderDraft.unit || undefined,
        instructions: medicalOrderDraft.instructions || undefined,
        scheduledAt: medicalOrderDraft.scheduledAt || undefined,
        assigneeId: medicalOrderDraft.assigneeId || undefined,
      })
      resetMedicalOrderDraft()
      useFaToast().success('医嘱已开立,护士任务已生成')
      return true
    }
    catch (error: any) {
      useFaToast().error(error?.message || '开立医嘱失败')
      return false
    }
    finally {
      medicalOrderSubmitting.value = false
    }
  }

  // ===== 整体 dirty 判定与重置 =====
  /** 是否存在未提交的下单草稿(纳入统一 dirty guard) */
  const planDirty = computed(() =>
    validPrescriptionItems.value.length > 0
    || Boolean(labDraft.catalogItemId)
    || Boolean(imagingDraft.catalogItemId)
    || Boolean(medicalOrderDraft.itemName),
  )

  /** 清空全部草稿(切店/结束时调用) */
  function resetPlanDraft() {
    resetPrescriptionDraft()
    resetLabDraft()
    resetImagingDraft()
    resetMedicalOrderDraft()
  }

  return {
    // 处方
    prescriptionDraft,
    prescriptionSubmitting,
    validPrescriptionItems,
    resetPrescriptionDraft,
    addPrescriptionItem,
    removePrescriptionItem,
    updatePrescriptionItem,
    submitPrescription,
    // 检验
    labDraft,
    resetLabDraft,
    updateLabDraft,
    submitLab,
    // 影像
    imagingDraft,
    resetImagingDraft,
    updateImagingDraft,
    submitImaging,
    // 医嘱
    medicalOrderDraft,
    medicalOrderSubmitting,
    resetMedicalOrderDraft,
    updateMedicalOrderDraft,
    submitMedicalOrder,
    // 整体
    diagnosticSubmitting,
    planDirty,
    resetPlanDraft,
  }
}
