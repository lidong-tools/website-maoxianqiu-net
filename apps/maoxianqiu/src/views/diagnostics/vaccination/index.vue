<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { VaccinationRecord, VaccineCertificate } from '@/types/diagnostics'
import apiDiagnostics from '@/api/modules/diagnostics'
import BusinessCustomerPicker from '@/components/business/CustomerPicker/index.vue'
import BusinessPetPicker from '@/components/business/PetPicker/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { VACCINATION_STATUS_COLORS, VACCINATION_STATUS_LABELS } from '@/types/diagnostics'

defineOptions({
  name: 'DiagnosticsVaccination',
})

interface VaccinationRow {
  id: string
  pet_id: string
  customer_id: string
  dose_no: number
  scheduled_date: string | null
  administered_date: string | null
  batch_no: string | null
  manufacturer: string | null
  status: VaccinationRecord['status']
  next_due_date: string | null
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const submitting = ref(false)
const dataList = ref<VaccinationRow[]>([])
const certificates = ref<VaccineCertificate[]>([])

const search = ref({
  status: '',
  petId: '',
})

const tableColumns = computed<TableColumn<VaccinationRow>[]>(() => [
  {
    accessorKey: 'pet_id',
    header: '宠物 ID',
    cell: info => (info.getValue() as string | undefined)?.slice(0, 8),
  },
  {
    accessorKey: 'customer_id',
    header: '客户 ID',
    cell: info => (info.getValue() as string | undefined)?.slice(0, 8),
  },
  {
    accessorKey: 'dose_no',
    header: '剂次',
    cell: info => `第 ${info.getValue()} 针`,
  },
  {
    accessorKey: 'scheduled_date',
    header: '计划日期',
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleDateString('zh-CN') : '-',
  },
  {
    accessorKey: 'administered_date',
    header: '接种日期',
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleDateString('zh-CN') : '-',
  },
  {
    accessorKey: 'batch_no',
    header: '批号',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'manufacturer',
    header: '厂家',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const v = info.getValue() as VaccinationRecord['status']
      const label = VACCINATION_STATUS_LABELS[v] ?? v
      const color = VACCINATION_STATUS_COLORS[v] ?? 'default'
      return h('span', {
        class: `inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-${color}-100 text-${color}-700`,
      }, label)
    },
  },
  {
    accessorKey: 'next_due_date',
    header: '下次到期',
    cell: info => info.getValue() ? new Date(info.getValue() as string).toLocaleDateString('zh-CN') : '-',
  },
  {
    id: 'operation',
    header: '操作',
    width: 200,
    align: 'center',
    fixed: 'right',
  },
])

const vaccForm = reactive({
  customerId: '',
  petId: '',
  doseNo: 1,
  scheduledDate: '',
  batchNo: '',
  manufacturer: '',
  remark: '',
})

/** 加载疫苗接种列表 */
async function loadVaccinations() {
  loading.value = true
  try {
    const res = await apiDiagnostics.listVaccinations({
      storeId: tenantStore.currentStoreId || undefined,
      status: (search.value.status || undefined) as VaccinationRecord['status'] | undefined,
      petId: search.value.petId.trim() || undefined,
    })
    dataList.value = res.data.list as VaccinationRow[]
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '加载疫苗接种列表失败')
  }
  finally {
    loading.value = false
  }
}

/** 加载疫苗证明列表(展示已签发证明) */
async function loadCertificates() {
  try {
    const res = await apiDiagnostics.listCertificates({
      storeId: tenantStore.currentStoreId || undefined,
    })
    certificates.value = res.data.list
  }
  catch {
    // 错误已由全局拦截器提示
  }
}

/** 提交创建疫苗接种 */
async function onCreate() {
  if (!vaccForm.customerId || !vaccForm.petId) {
    useFaToast().warning('请选择客户与宠物')
    return
  }
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择工作租户')
    return
  }

  submitting.value = true
  try {
    await apiDiagnostics.createVaccination({
      tenantId: tenantStore.currentTenantId,
      storeId: tenantStore.currentStoreId || undefined,
      customerId: vaccForm.customerId.trim(),
      petId: vaccForm.petId.trim(),
      doseNo: vaccForm.doseNo,
      scheduledDate: vaccForm.scheduledDate || undefined,
      batchNo: vaccForm.batchNo.trim() || undefined,
      manufacturer: vaccForm.manufacturer.trim() || undefined,
      remark: vaccForm.remark.trim() || undefined,
    })
    useFaToast().success('已创建疫苗接种计划')
    vaccForm.customerId = ''
    vaccForm.petId = ''
    vaccForm.doseNo = 1
    vaccForm.scheduledDate = ''
    vaccForm.batchNo = ''
    vaccForm.manufacturer = ''
    vaccForm.remark = ''
    await loadVaccinations()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

/** 标记已接种(scheduled→administered) */
function onAdminister(row: VaccinationRow) {
  if (row.status !== 'scheduled') {
    useFaToast().warning('仅「已计划」状态可标记接种')
    return
  }
  useFaModal().confirm({
    title: '确认接种',
    content: `确认将宠物 ${row.pet_id.slice(0, 8)} 的第 ${row.dose_no} 针标记为已接种吗?`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.updateVaccination(row.id, { status: 'administered' })
        useFaToast().success('已标记接种')
        await loadVaccinations()
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

/** 跳过接种(scheduled→skipped) */
function onSkip(row: VaccinationRow) {
  if (row.status !== 'scheduled') {
    useFaToast().warning('仅「已计划」状态可跳过')
    return
  }
  useFaModal().confirm({
    title: '跳过接种',
    content: `确认跳过宠物 ${row.pet_id.slice(0, 8)} 的第 ${row.dose_no} 针吗?`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.updateVaccination(row.id, { status: 'skipped' })
        useFaToast().success('已跳过')
        await loadVaccinations()
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

/** 签发疫苗证明(MXQ-10005,走 RPC) */
function onIssueCertificate(row: VaccinationRow) {
  if (row.status !== 'administered') {
    useFaToast().warning('仅「已接种」状态可签发证明')
    return
  }
  useFaModal().confirm({
    title: '签发疫苗证明',
    content: `确认为宠物 ${row.pet_id.slice(0, 8)} 的第 ${row.dose_no} 针签发疫苗证明吗?(走 issue_vaccine_certificate RPC)`,
    onConfirm: async () => {
      try {
        await apiDiagnostics.issueCertificate({ vaccinationId: row.id })
        useFaToast().success('证明已签发')
        await loadCertificates()
      }
      catch {
        // 错误已由全局拦截器提示
      }
    },
  })
}

onMounted(async () => {
  await Promise.all([loadVaccinations(), loadCertificates()])
})
</script>

<template>
  <div>
    <FaPageHeader :show="false" title="疫苗接种管理" class="mb-0">
      <template #description>
        疫苗接种计划 → 接种 → 签发证明;支持跳过、逾期标记;证明签发走 RPC 事务化
      </template>
    </FaPageHeader>
    <FaPageMain>
      <!-- 创建接种计划表单 -->
      <div class="mb-4 p-4 border rounded-lg bg-muted/30">
        <div class="mb-3 flex gap-2 items-center">
          <FaIcon name="i-ri:syringe-line" class="text-lg" />
          <span class="font-bold">创建接种计划</span>
          <span class="text-xs text-muted-foreground">(RLS 须 vaccine.manage 权限)</span>
        </div>
        <div class="gap-3 grid grid-cols-1 md:grid-cols-3">
          <FaLabel label="客户">
            <BusinessCustomerPicker v-model="vaccForm.customerId" placeholder="搜索选择客户" />
          </FaLabel>
          <FaLabel label="宠物">
            <BusinessPetPicker v-model="vaccForm.petId" :customer-id="vaccForm.customerId || undefined" placeholder="搜索选择宠物" />
          </FaLabel>
          <FaLabel label="剂次">
            <FaInput v-model.number="vaccForm.doseNo" type="number" min="1" class="w-full" />
          </FaLabel>
          <FaLabel label="计划日期">
            <FaInput v-model="vaccForm.scheduledDate" type="date" class="w-full" />
          </FaLabel>
          <FaLabel label="批号">
            <FaInput v-model="vaccForm.batchNo" placeholder="疫苗批号" class="w-full" />
          </FaLabel>
          <FaLabel label="厂家">
            <FaInput v-model="vaccForm.manufacturer" placeholder="生产厂家" class="w-full" />
          </FaLabel>
          <FaLabel label="备注" class="md:col-span-2">
            <FaInput v-model="vaccForm.remark" placeholder="备注信息" class="w-full" />
          </FaLabel>
          <div class="flex items-end">
            <FaButton type="primary" :loading="submitting" @click="onCreate">
              <FaIcon name="i-ri:add-line" />
              创建计划
            </FaButton>
          </div>
        </div>
      </div>

      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="gap-x-8 gap-y-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            <FaLabel label="状态" class="col-span-1">
              <FaSelect
                v-model="search.status"
                :options="[
                  { label: '全部', value: '' },
                  { label: '已计划', value: 'scheduled' },
                  { label: '已接种', value: 'administered' },
                  { label: '已跳过', value: 'skipped' },
                  { label: '已逾期', value: 'overdue' },
                ]"
                class="w-full"
                @change="loadVaccinations()"
              />
            </FaLabel>
            <FaLabel label="宠物" class="col-span-1">
              <BusinessPetPicker v-model="search.petId" placeholder="按宠物筛选" />
            </FaLabel>
            <div class="flex gap-2 col-end--1 justify-end">
              <FaButton type="primary" @click="loadVaccinations">
                <FaIcon name="i-ri:refresh-line" />
                刷新
              </FaButton>
            </div>
          </div>
        </template>
      </FaSearchBar>
      <div class="mx--4 my-3 border-t border-t-dashed" />

      <FaTable
        v-loading="loading"
        table-root-class="rounded-lg overflow-hidden"
        row-key="id"
        stripe
        border
        :columns="tableColumns"
        :data="dataList"
      >
        <template #cell-operation="{ row }">
          <div class="flex-center gap-2">
            <FaButton
              v-if="row.original.status === 'scheduled'"
              variant="outline"
              size="sm"
              @click="onAdminister(row.original)"
            >
              <FaIcon name="i-ri:check-line" />
              接种
            </FaButton>
            <FaButton
              v-if="row.original.status === 'scheduled'"
              variant="outline"
              size="sm"
              @click="onSkip(row.original)"
            >
              <FaIcon name="i-ri:skip-forward-line" />
              跳过
            </FaButton>
            <FaButton
              v-if="row.original.status === 'administered'"
              variant="outline"
              size="sm"
              @click="onIssueCertificate(row.original)"
            >
              <FaIcon name="i-ri:award-line" />
              签发证明
            </FaButton>
          </div>
        </template>
      </FaTable>

      <!-- 已签发证明列表 -->
      <div v-if="certificates.length > 0" class="mt-6">
        <div class="mb-2 flex gap-2 items-center">
          <FaIcon name="i-ri:award-line" class="text-lg" />
          <span class="font-bold">已签发疫苗证明</span>
          <span class="text-xs text-muted-foreground">({{ certificates.length }} 条)</span>
        </div>
        <div class="gap-3 grid grid-cols-1 lg:grid-cols-3 md:grid-cols-2">
          <div
            v-for="cert in certificates"
            :key="cert.id"
            class="p-3 border rounded-lg bg-muted/20"
          >
            <div class="mb-1 flex items-center justify-between">
              <span class="text-sm font-bold font-mono">{{ cert.certificate_no }}</span>
              <span
                class="text-xs px-2 py-0.5 rounded inline-flex items-center"
                :class="cert.status === 'issued' ? 'bg-success-100 text-success-700' : 'bg-default-100 text-default-700'"
              >
                {{ cert.status === 'issued' ? '已签发' : '已撤销' }}
              </span>
            </div>
            <div class="text-xs text-muted-foreground">
              签发日期:{{ new Date(cert.issued_date).toLocaleDateString('zh-CN') }}
            </div>
            <div class="text-xs text-muted-foreground">
              宠物 ID:{{ cert.pet_id.slice(0, 8) }}
            </div>
          </div>
        </div>
      </div>
    </FaPageMain>
  </div>
</template>
