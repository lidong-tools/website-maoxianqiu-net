<script setup lang="ts">
import apiBilling from '@/api/modules/billing'
import apiClinical from '@/api/modules/clinical'
import apiDiagnostics from '@/api/modules/diagnostics'
import apiInventory from '@/api/modules/inventory'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'WorkbenchHome',
})

const router = useRouter()
const tenantStore = useAppTenantStore()

const loading = ref(false)
const todayCount = ref(0)
const waitingCount = ref(0)
const unpaidCount = ref(0)
const criticalCount = ref(0)
const taskCount = ref(0)
const nearExpiryCount = ref(0)
const todayAppointments = ref<any[]>([])

const todayStart = computed(() => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
})
const todayEnd = computed(() => {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d.toISOString()
})

async function loadWorkbench() {
  loading.value = true
  const storeId = tenantStore.currentStoreId || undefined
  try {
    const [aptRes, waitRes, invRes, critRes, taskRes, expiryRes] = await Promise.allSettled([
      apiClinical.listAppointments({ storeId, dateFrom: todayStart.value, dateTo: todayEnd.value, pageSize: 20 }),
      apiClinical.listWaiting(storeId),
      apiBilling.listInvoices({ storeId, status: 'pending', limit: 1 }),
      apiDiagnostics.listCriticalAlerts({ storeId, status: 'pending', page: 1, pageSize: 1 }),
      apiClinical.listNurseTasks({ storeId, status: 'pending', page: 1, pageSize: 1 }),
      apiInventory.listNearExpiryByView(storeId),
    ])
    if (aptRes.status === 'fulfilled') {
      todayCount.value = aptRes.value.data?.total ?? (aptRes.value.data?.list?.length ?? 0)
      todayAppointments.value = aptRes.value.data?.list ?? []
    }
    if (waitRes.status === 'fulfilled') {
      waitingCount.value = (waitRes.value.data?.list ?? []).length
    }
    if (invRes.status === 'fulfilled') {
      unpaidCount.value = invRes.value.data?.total ?? 0
    }
    if (critRes.status === 'fulfilled') {
      criticalCount.value = critRes.value.data?.total ?? (critRes.value.data?.list?.length ?? 0)
    }
    if (taskRes.status === 'fulfilled') {
      taskCount.value = taskRes.value.data?.total ?? 0
    }
    if (expiryRes.status === 'fulfilled') {
      nearExpiryCount.value = expiryRes.value.length ?? 0
    }
  }
  finally {
    loading.value = false
  }
}

const quickActions = [
  { label: '新建客户', icon: 'i-lucide:user-plus', to: '/crm/customer/new' },
  { label: '快速收银', icon: 'i-lucide:banknote', to: '/billing/cashier' },
  { label: '预约管理', icon: 'i-lucide:calendar', to: '/clinical/appointment' },
  { label: '医生工作台', icon: 'i-lucide:stethoscope', to: '/clinical/workbench' },
  { label: '候诊队列', icon: 'i-lucide:users', to: '/clinical/waiting' },
  { label: '检验工作台', icon: 'i-lucide:test-tube', to: '/diagnostics/lab' },
]

// P0-06:切店后按新门店重载工作台 KPI
useStoreScopedPage({
  load: loadWorkbench,
})

onMounted(loadWorkbench)
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 注释掉标题和描述区域(UI界面-人工测试报告 #8) -->
    <!--
    <EntityPageHeader compact title="工作台" :description="`毛线球宠物医院管理系统 · ${appAccountStore.isLogin ? appAccountStore.account : '未登录'}`">
      <template #actions>
        <FaButton size="sm" variant="outline" :loading="loading" @click="loadWorkbench">
          <FaIcon name="i-lucide:refresh-cw" />
          刷新
        </FaButton>
      </template>
    </EntityPageHeader>
    -->

    <div v-loading="loading" class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <!-- KPI -->
      <div class="gap-4 grid grid-cols-2 xl:grid-cols-4">
        <div class="p-3 border rounded-lg bg-card cursor-pointer transition hover:bg-gray-50" @click="router.push('/clinical/appointment')">
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted-foreground">今日预约</span>
            <FaIcon name="i-lucide:calendar" class="text-muted-foreground" />
          </div>
          <div class="text-2xl font-semibold mt-1 tabular-nums">
            {{ todayCount }}
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card cursor-pointer transition hover:bg-gray-50" @click="router.push('/clinical/waiting')">
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted-foreground">候诊</span>
            <FaIcon name="i-lucide:users" class="text-amber-500" />
          </div>
          <div class="text-2xl font-semibold mt-1 tabular-nums">
            {{ waitingCount }}
          </div>
        </div>
        <div class="p-3 border rounded-lg bg-card cursor-pointer transition hover:bg-gray-50" @click="router.push('/billing/invoices')">
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted-foreground">未收费</span>
            <FaIcon name="i-lucide:wallet" class="text-blue-500" />
          </div>
          <div class="text-2xl font-semibold mt-1 tabular-nums">
            {{ unpaidCount }}
          </div>
        </div>
        <div
          class="p-3 border rounded-lg bg-card cursor-pointer transition hover:bg-gray-50"
          :class="criticalCount > 0 ? 'border-red-200 bg-red-50' : ''"
          @click="router.push('/diagnostics/critical-values')"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted-foreground">危急值待确认</span>
            <FaIcon name="i-lucide:siren" :class="criticalCount > 0 ? 'text-red-600' : 'text-muted-foreground'" />
          </div>
          <div class="text-2xl font-semibold mt-1 tabular-nums" :class="criticalCount > 0 ? 'text-red-600' : ''">
            {{ criticalCount }}
          </div>
        </div>
      </div>

      <div class="flex-1 gap-4 grid min-h-0 lg:grid-cols-3">
        <!-- 今日预约 / 候诊 -->
        <div class="border rounded-lg bg-card flex flex-col min-h-0">
          <div class="px-4 py-2.5 border-b flex items-center justify-between">
            <span class="text-sm font-medium">今日预约({{ todayAppointments.length }})</span>
            <FaButton size="sm" variant="ghost" @click="router.push('/clinical/appointment')">
              全部
            </FaButton>
          </div>
          <div class="p-3 flex-1 min-h-0 overflow-auto">
            <div
              v-for="a in todayAppointments.slice(0, 8)"
              :key="a.id"
              class="mb-2 p-2.5 border rounded-md flex items-center justify-between"
            >
              <div>
                <div class="text-xs font-medium">
                  {{ new Date(a.scheduled_start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }} · {{ a.reason ?? '未填写原因' }}
                </div>
                <div class="text-xs text-muted-foreground">
                  {{ a.status }}
                </div>
              </div>
            </div>
            <EmptyState v-if="!todayAppointments.length" compact title="今日暂无预约" />
          </div>
        </div>

        <!-- 待处理任务 -->
        <div class="border rounded-lg bg-card flex flex-col min-h-0">
          <div class="px-4 py-2.5 border-b flex items-center justify-between">
            <span class="text-sm font-medium">待处理任务</span>
            <FaButton size="sm" variant="ghost" @click="router.push('/clinical/nurse-tasks')">
              全部
            </FaButton>
          </div>
          <div class="p-3 flex-1 min-h-0 overflow-auto">
            <div class="mb-2 p-2.5 border rounded-md flex items-center justify-between">
              <div>
                <div class="text-xs font-medium">
                  护士任务
                </div>
                <div class="text-xs text-muted-foreground">
                  待执行
                </div>
              </div>
              <span class="text-lg font-semibold tabular-nums">{{ taskCount }}</span>
            </div>
            <div class="mb-2 p-2.5 border border-orange-200 rounded-md bg-orange-50 flex items-center justify-between">
              <div>
                <div class="text-xs font-medium">
                  库存预警
                </div>
                <div class="text-xs text-orange-600/70">
                  近效期
                </div>
              </div>
              <span class="text-lg text-orange-600 font-semibold tabular-nums">{{ nearExpiryCount }}</span>
            </div>
          </div>
        </div>

        <!-- 快捷操作 -->
        <div class="border rounded-lg bg-card flex flex-col min-h-0">
          <div class="text-sm font-medium px-4 py-2.5 border-b">
            快捷操作
          </div>
          <div class="p-3 gap-2 grid grid-cols-2">
            <button
              v-for="action in quickActions"
              :key="action.to"
              type="button"
              class="p-3 border rounded-lg flex flex-col gap-1.5 h-24 transition items-center justify-center hover:bg-gray-50"
              @click="router.push(action.to)"
            >
              <FaIcon :name="action.icon" class="text-xl text-primary" />
              <span class="text-xs font-medium">{{ action.label }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
