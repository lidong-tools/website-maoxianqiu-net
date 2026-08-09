<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { ChurnRiskRecord } from '@/api/modules/crmGrowth'
import apiCrmGrowth from '@/api/modules/crmGrowth'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'CrmChurn',
})

const tenantStore = useAppTenantStore()

/** 当前租户 id(空时返回 '') */
function tenantId(): string {
  return tenantStore.currentTenantId || ''
}

/** 校验已选择租户,未选择时提示并返回 false */
function requireTenant(): boolean {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户与门店')
    return false
  }
  return true
}

// ===== 列表 =====
const list = ref<ChurnRiskRecord[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const level = ref<'high' | 'medium' | 'low' | ''>('')
const loading = ref(false)
const refreshing = ref(false)

const LEVEL_META: Record<string, { label: string, color: string, textColor: string }> = {
  high: { label: '高危', color: '#f5222d', textColor: 'text-red-600' },
  medium: { label: '中危', color: '#fa8c16', textColor: 'text-orange-600' },
  low: { label: '低危', color: '#52c41a', textColor: 'text-green-600' },
}

/** 将 explanation 数组渲染为可读原因文本 */
function explanationText(row: ChurnRiskRecord): string {
  if (!row.explanation?.length) {
    return '暂无原因'
  }
  return row.explanation.map(e => `${e.text} +${e.points}`).join('; ')
}

const columns = computed<TableColumn<ChurnRiskRecord>[]>(() => [
  {
    accessorKey: 'customers.name',
    header: '客户',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'customers.phone',
    header: '手机号',
    cell: info => (info.getValue() as string | null) ?? '-',
  },
  {
    accessorKey: 'score',
    header: '风险评分',
    width: 110,
    cell: info => {
      const v = Number(info.getValue())
      const lv = String(info.row.original.level)
      const cls = lv === 'high' ? 'text-red-600 font-bold' : lv === 'medium' ? 'text-orange-600 font-bold' : 'text-green-600'
      return h('span', { class: cls }, v)
    },
  },
  {
    accessorKey: 'level',
    header: '风险等级',
    width: 100,
    cell: info => {
      const lv = String(info.getValue())
      const meta = LEVEL_META[lv] ?? { label: lv, color: '#999' }
      return h('span', {
        class: 'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs',
        style: { color: meta.color, border: `1px solid ${meta.color}`, background: `${meta.color}14` },
      }, meta.label)
    },
  },
  {
    accessorKey: 'explanation',
    header: '原因(可解释评分)',
    cell: info => explanationText(info.getValue() as ChurnRiskRecord),
  },
  {
    accessorKey: 'calculated_at',
    header: '计算时间',
    cell: info => String(info.getValue() ?? '-').slice(0, 19).replace('T', ' '),
  },
])

/** 加载流失风险列表 */
async function loadChurn() {
  if (!requireTenant()) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiCrmGrowth.listChurn({
      tenantId: tenantId(),
      level: level.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    })
    list.value = res?.data?.list ?? []
    total.value = res?.data?.total ?? 0
  }
  catch (e) {
    useFaToast().error('加载流失预警失败', { description: e instanceof Error ? e.message : '' })
  }
  finally {
    loading.value = false
  }
}

/** 批量重算流失评分(服务端 RPC,规则版本随迁移固定) */
async function refreshChurn() {
  if (!requireTenant()) {
    return
  }
  refreshing.value = true
  try {
    const res: any = await apiCrmGrowth.refreshChurn({ tenantId: tenantId() })
    useFaToast().success(`重算完成,共评估 ${res?.data?.evaluated ?? 0} 位客户`)
    await loadChurn()
  }
  catch (e) {
    useFaToast().error(`重算失败: ${e instanceof Error ? e.message : ''}`)
  }
  finally {
    refreshing.value = false
  }
}

onMounted(() => {
  loadChurn()
})
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告) -->
    <!--
    <EntityPageHeader compact title="流失预警">
      <template #description>
        规则 + 评分判断客户流失风险(默认按租户整体,不因当前门店误判);评分 >=60 高危 / >=35 中危,可解释原因。
      </template>
    </EntityPageHeader>
    -->
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="border rounded-lg bg-card flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
        <div class="px-4 py-3 border-b flex shrink-0 justify-between items-center">
          <div class="flex gap-2 items-center">
            <FaSelect
              v-model="level"
              :options="[
                { label: '全部等级', value: '' },
                { label: '高危', value: 'high' },
                { label: '中危', value: 'medium' },
                { label: '低危', value: 'low' },
              ]"
              class="w-36"
              @change="page = 1; loadChurn()"
            />
            <span class="text-sm text-muted-foreground">
              共 {{ total }} 位客户
            </span>
          </div>
          <FaButton size="sm" variant="outline" :loading="refreshing" @click="refreshChurn">
            <FaIcon name="i-ri:refresh-line" />
            重算评分
          </FaButton>
        </div>
        <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
          <FaTable
            class="h-full min-h-0"
            table-root-class="overflow-hidden"
            row-key="id"
            stripe
            border
            :columns="columns"
            :data="list"
            empty-text="暂无流失风险客户"
          />
        </div>
        <FaPagination
          :page="page"
          :size="pageSize"
          :total="total"
          class="mt-2 px-4 pb-3 shrink-0"
          @page-change="p => { page = p; loadChurn() }"
          @size-change="s => { pageSize = s; page = 1; loadChurn() }"
        />
      </div>
    </div>
  </div>
</template>
