<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { VeterinarianRegistrationListItem, VeterinarianRegistrationStatus } from '@/types/compliance'
import apiCompliance from '@/api/modules/compliance'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { VET_REG_STATUS_LABELS } from '@/types/compliance'

defineOptions({
  name: 'SystemVeterinarianRegistration',
})

/** 列表展示行(join 员工姓名/工号) */
interface DisplayRow {
  id: string
  employeeName: string
  employeeNo: string
  licenseNo: string
  registrationNo: string
  registrationAuthority: string
  registrationRegion: string
  validFrom: string
  validUntil: string
  status: VeterinarianRegistrationStatus
}

const tenantStore = useAppTenantStore()
const loading = ref(false)
const dataList = ref<VeterinarianRegistrationListItem[]>([])
// 复审审计(S3.1-Fix-Reaudit-v3 §6):computed 而非 ref+onMounted,切租户即时响应,不保留旧 Tenant 快照
const currentTenantId = computed(() => tenantStore.currentTenantId)
/** FINAL-01:平台管理员(无租户成员关系)无法确定租户上下文,平台备案 UI 推迟到 S3.1-2 */
const platformUiDeferred = computed(() => !tenantStore.currentTenantId)

/** 列表列配置 */
const tableColumns = computed<TableColumn<DisplayRow>[]>(() => [
  {
    accessorKey: 'employeeName',
    header: '员工姓名',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'employeeNo',
    header: '工号',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'licenseNo',
    header: '执业牌照号',
  },
  {
    accessorKey: 'registrationNo',
    header: '备案编号',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'registrationAuthority',
    header: '备案机构',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'registrationRegion',
    header: '备案地区',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'validFrom',
    header: '生效日期',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'validUntil',
    header: '失效日期',
    cell: info => info.getValue() ?? '-',
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const v = info.getValue() as VeterinarianRegistrationStatus
      return VET_REG_STATUS_LABELS[v] ?? v
    },
  },
])

/** 新增备案抽屉表单 */
const drawerVisible = ref(false)
const submitting = ref(false)
const form = reactive({
  employeeId: '',
  licenseNo: '',
  registrationNo: '',
  registrationAuthority: '',
  registrationRegion: '',
  validFrom: '',
  validUntil: '',
  status: 'active' as VeterinarianRegistrationStatus,
})

/**
 * 加载备案列表(浏览器直连,RLS 兜底)
 */
async function getDataList() {
  if (!currentTenantId.value) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiCompliance.listVeterinarianRegistrations(currentTenantId.value)
    dataList.value = res.data.list ?? []
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载失败')
  }
  finally {
    loading.value = false
  }
}

/** 行 → 展示结构 */
function toDisplayRow(row: VeterinarianRegistrationListItem): DisplayRow {
  return {
    id: row.id,
    employeeName: row.employees?.name ?? '-',
    employeeNo: row.employees?.employee_no ?? '-',
    licenseNo: row.license_no,
    registrationNo: row.registration_no ?? '-',
    registrationAuthority: row.registration_authority ?? '-',
    registrationRegion: row.registration_region ?? '-',
    validFrom: row.valid_from ?? '-',
    validUntil: row.valid_until ?? '-',
    status: row.status,
  }
}

/** 打开新增备案抽屉并重置表单 */
function openCreate() {
  form.employeeId = ''
  form.licenseNo = ''
  form.registrationNo = ''
  form.registrationAuthority = ''
  form.registrationRegion = ''
  form.validFrom = ''
  form.validUntil = ''
  form.status = 'active'
  drawerVisible.value = true
}

/**
 * 提交备案(走 Hono Command,权限 veterinarian_registration.manage)
 */
async function onSubmit() {
  if (!form.employeeId) {
    useFaToast().warning('请选择员工')
    return
  }
  if (!form.licenseNo.trim()) {
    useFaToast().warning('请填写执业牌照号')
    return
  }
  if (submitting.value) {
    return
  }
  submitting.value = true
  try {
    await apiCompliance.upsertVeterinarianRegistration({
      employeeId: form.employeeId,
      licenseNo: form.licenseNo.trim(),
      registrationNo: form.registrationNo || undefined,
      registrationAuthority: form.registrationAuthority || undefined,
      registrationRegion: form.registrationRegion || undefined,
      validFrom: form.validFrom || undefined,
      validUntil: form.validUntil || undefined,
      status: form.status,
    })
    drawerVisible.value = false
    useFaToast().success('备案已保存')
    getDataList()
  }
  catch (e: any) {
    useFaToast().error(e?.message || '保存失败')
  }
  finally {
    submitting.value = false
  }
}

// 复审审计 §6:切租户时重载数据,避免残留旧租户数据
watch(currentTenantId, () => {
  getDataList()
})

onMounted(() => {
  // 审计 S3.1 P0-03:统一使用全局 Tenant Store 上下文,不再自行从 memberships 推导当前租户。
  // 平台管理员(platform_user_roles,无租户成员关系)不依赖 memberships——跨租户维护备案的
  // 专用 UI 推迟到 S3.1-2 提供(platform UI deferred)。
  getDataList()
})
</script>

<template>
  <!-- 标准布局:外层固定高度 + 白底卡片(无筛选/分页,保留表格工具栏) -->
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告 #8) -->
    <!--
    <EntityPageHeader compact title="执业兽医备案" description="管理执业兽医备案信息(牌照/备案编号/有效期/电子签名资质)" />
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <!-- 平台上下文提示(收缩,不占滚动区) -->
        <div v-if="platformUiDeferred" class="px-4 pt-3 border-b shrink-0">
          <div class="pb-3 text-sm text-amber-700 px-4 py-3 border border-amber-200 rounded-md bg-amber-50">
            当前账号无租户成员关系,无法确定租户上下文。平台管理员跨租户维护执业兽医备案的界面将在 S3.1-2 提供(platform UI deferred)。
          </div>
        </div>
        <!-- 表格区(flex-1 撑满,内部滚动) -->
        <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="tableColumns"
            :data="dataList.map(toDisplayRow)"
          >
            <template #toolbar>
              <PermissionButton permission="veterinarian_registration.manage" @click="openCreate">
                新增备案
              </PermissionButton>
            </template>
          </FaTable>
        </div>
      </div>
    </div>

    <FaDrawer v-model="drawerVisible" title="新增备案" :width="560">
      <div class="space-y-3">
        <FaLabel label="员工">
          <EmployeePicker v-model="form.employeeId" class="w-full" />
        </FaLabel>
        <FaLabel label="执业牌照号">
          <FaInput v-model="form.licenseNo" placeholder="执业牌照号" class="w-full" />
        </FaLabel>
        <FaLabel label="备案编号">
          <FaInput v-model="form.registrationNo" placeholder="备案编号" class="w-full" />
        </FaLabel>
        <FaLabel label="备案机构">
          <FaInput v-model="form.registrationAuthority" placeholder="备案机构" class="w-full" />
        </FaLabel>
        <FaLabel label="备案地区">
          <FaInput v-model="form.registrationRegion" placeholder="备案地区" class="w-full" />
        </FaLabel>
        <div class="gap-3 grid grid-cols-2">
          <FaLabel label="生效日期">
            <FaInput v-model="form.validFrom" type="date" class="w-full" />
          </FaLabel>
          <FaLabel label="失效日期">
            <FaInput v-model="form.validUntil" type="date" class="w-full" />
          </FaLabel>
        </div>
        <FaLabel label="状态">
          <FaSelect
            v-model="form.status"
            :options="[
              { label: '有效', value: 'active' },
              { label: '停用', value: 'inactive' },
              { label: '过期', value: 'expired' },
            ]"
            class="w-full"
          />
        </FaLabel>
      </div>
      <template #footer>
        <div class="flex gap-2 justify-end">
          <FaButton variant="outline" @click="drawerVisible = false">
            取消
          </FaButton>
          <FaButton type="primary" :loading="submitting" @click="onSubmit">
            保存
          </FaButton>
        </div>
      </template>
    </FaDrawer>
  </div>
</template>
