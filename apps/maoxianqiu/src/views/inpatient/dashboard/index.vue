<script setup lang="ts">
import type { CageStatusView } from '@/types/inpatient'
import apiInpatient from '@/api/modules/inpatient'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { CAGE_STATUS_COLORS, CAGE_STATUS_LABELS, CAGE_TYPE_LABELS, ROOM_TYPE_LABELS } from '@/types/inpatient'

defineOptions({
  name: 'InpatientDashboard',
})

const tenantStore = useAppTenantStore()
const router = useRouter()
const loading = ref(false)
const cageStatusList = ref<CageStatusView[]>([])

// 占用笼位详情 Drawer
const detailVisible = ref(false)
const detailCage = ref<CageStatusView | null>(null)
const detailPetName = ref('')
const detailCustomerName = ref('')
const detailDoctorName = ref('')

/**
 * 点击笼位卡片:占用 → 打开详情 Drawer;空闲/维护/清洁 → 跳入院登记
 * @param cage 笼位状态视图记录
 */
async function onCageClick(cage: CageStatusView) {
  if (cage.cage_status !== 'occupied' || !cage.current_admission_id) {
    router.push('/inpatient/admission')
    return
  }
  await openCageDetail(cage)
}

/**
 * 打开占用笼位详情 Drawer,补查宠物/主人/主治医生名称
 * @param cage 笼位状态视图记录
 */
async function openCageDetail(cage: CageStatusView) {
  detailCage.value = cage
  detailPetName.value = ''
  detailCustomerName.value = ''
  detailDoctorName.value = ''
  detailVisible.value = true
  // 并行补查关联名称
  const queries: Array<PromiseLike<unknown>> = []
  if (cage.pet_id) {
    queries.push(supabase.from('pets').select('name').eq('id', cage.pet_id).maybeSingle()
      .then(({ data }) => { detailPetName.value = (data as any)?.name ?? '' }))
  }
  if (cage.customer_id) {
    queries.push(supabase.from('customers').select('name').eq('id', cage.customer_id).maybeSingle()
      .then(({ data }) => { detailCustomerName.value = (data as any)?.name ?? '' }))
  }
  if (cage.doctor_id) {
    queries.push(supabase.from('employees').select('name').eq('id', cage.doctor_id).maybeSingle()
      .then(({ data }) => { detailDoctorName.value = (data as any)?.name ?? '' }))
  }
  await Promise.allSettled(queries)
}

/**
 * 跳转到指定住院子页面
 * @param path 目标路径
 */
function goTo(path: string) {
  detailVisible.value = false
  router.push(path)
}

/** 占用笼位详情项(宠物/主人/主治医生/入院时间/入院原因/日费率) */
const cageDetailItems = computed(() => {
  const cage = detailCage.value
  if (!cage) {
    return []
  }
  return [
    { label: '宠物', value: detailPetName.value || (cage.pet_id ? '未知' : '-') },
    { label: '主人', value: detailCustomerName.value || (cage.customer_id ? '未知' : '-') },
    { label: '主治医生', value: detailDoctorName.value || (cage.doctor_id ? '未知' : '-') },
    { label: '入院时间', value: cage.admitted_at ? new Date(cage.admitted_at).toLocaleString('zh-CN') : '-' },
    { label: '入院原因', value: cage.admission_reason || '-' },
    { label: '日费率', value: cage.daily_rate > 0 ? `¥${cage.daily_rate}/日` : '-' },
  ]
})

/** 按房间分组的笼位状态 */
interface RoomGroup {
  room_id: string
  room_name: string
  room_code: string | null
  room_floor: string | null
  room_type: CageStatusView['room_type']
  cages: CageStatusView[]
  available_count: number
  occupied_count: number
  total_count: number
}

/** 按房间分组并统计房态 */
const groupedByRoom = computed<RoomGroup[]>(() => {
  const map = new Map<string, RoomGroup>()
  for (const cage of cageStatusList.value) {
    const key = cage.room_id
    if (!map.has(key)) {
      map.set(key, {
        room_id: cage.room_id,
        room_name: cage.room_name ?? '未分配房间',
        room_code: cage.room_code,
        room_floor: cage.room_floor,
        room_type: cage.room_type,
        cages: [],
        available_count: 0,
        occupied_count: 0,
        total_count: 0,
      })
    }
    const group = map.get(key)!
    group.cages.push(cage)
    group.total_count += 1
    if (cage.cage_status === 'available') {
      group.available_count += 1
    }
    else if (cage.cage_status === 'occupied') {
      group.occupied_count += 1
    }
  }
  return Array.from(map.values())
})

/** 整体房态统计 */
const summary = computed(() => {
  const total = cageStatusList.value.length
  const available = cageStatusList.value.filter(c => c.cage_status === 'available').length
  const occupied = cageStatusList.value.filter(c => c.cage_status === 'occupied').length
  const maintenance = cageStatusList.value.filter(c => c.cage_status === 'maintenance').length
  const cleaning = cageStatusList.value.filter(c => c.cage_status === 'cleaning').length
  return { total, available, occupied, maintenance, cleaning }
})

/** 加载房态看板(直连视图,RLS 按门店过滤) */
async function loadCageStatus() {
  loading.value = true
  try {
    cageStatusList.value = await apiInpatient.listCageStatus(tenantStore.currentStoreId || undefined)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载房态看板失败')
  }
  finally {
    loading.value = false
  }
}

/** 房态状态对应的 Tag 变体 */
function statusTagVariant(status: CageStatusView['cage_status']) {
  const color = CAGE_STATUS_COLORS[status]
  if (color === 'success') {
    return 'default'
  }
  if (color === 'destructive') {
    return 'destructive'
  }
  if (color === 'warning') {
    return 'outline'
  }
  return 'secondary'
}

/** 笼位卡片的状态样式(bg-card 底色 + 按状态叠加浅色背景与边框) */
function cageCardClass(status: CageStatusView['cage_status']) {
  const statusClass: Record<CageStatusView['cage_status'], string> = {
    available: 'border-success bg-success-50',
    occupied: 'border-destructive bg-destructive-50',
    maintenance: 'border-warning bg-warning-50',
    cleaning: 'border-info bg-info-50',
  }
  return statusClass[status] ?? 'bg-card'
}

onMounted(loadCageStatus)

// P0-06:切店后重载房态看板(避免旧门店笼位数据残留)
useStoreScopedPage({
  load: loadCageStatus,
})
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- TODO: 暂不展示页头(标题/描述/刷新) -->
    <!-- <EntityPageHeader compact>
      title="房态看板" description="按房间分组 · 实时在院情况"
      <template #actions>
        <FaButton size="sm" variant="outline" @click="loadCageStatus">
          <FaIcon name="i-lucide:refresh-cw" />
          刷新
        </FaButton>
      </template>
    </EntityPageHeader> -->

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0">
      <!-- 整体房态统计卡片 -->
      <div class="gap-3 grid grid-cols-2 md:grid-cols-5">
        <div class="bg-card p-3 text-center border rounded-lg">
          <div class="text-2xl font-bold">
            {{ summary.total }}
          </div>
          <div class="text-xs text-muted-foreground">
            笼位总数
          </div>
        </div>
        <div class="bg-card text-success p-3 text-center border rounded-lg">
          <div class="text-2xl font-bold">
            {{ summary.available }}
          </div>
          <div class="text-xs">
            空闲
          </div>
        </div>
        <div class="bg-card text-destructive p-3 text-center border rounded-lg">
          <div class="text-2xl font-bold">
            {{ summary.occupied }}
          </div>
          <div class="text-xs">
            占用
          </div>
        </div>
        <div class="bg-card text-warning p-3 text-center border rounded-lg">
          <div class="text-2xl font-bold">
            {{ summary.maintenance }}
          </div>
          <div class="text-xs">
            维护中
          </div>
        </div>
        <div class="bg-card text-info p-3 text-center border rounded-lg">
          <div class="text-2xl font-bold">
            {{ summary.cleaning }}
          </div>
          <div class="text-xs">
            清洁中
          </div>
        </div>
      </div>

      <!-- 按房间分组的笼位卡片 -->
      <div v-loading="loading" class="flex-1 min-h-0 overflow-auto space-y-4">
        <div
          v-for="room in groupedByRoom"
          :key="room.room_id"
          class="bg-card p-4 border rounded-lg"
        >
          <div class="mb-3 flex items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaIcon name="i-ri:door-line" class="text-lg" />
              <span class="text-base font-bold">{{ room.room_name }}</span>
              <FaTag variant="outline" size="sm">
                {{ room.room_type ? ROOM_TYPE_LABELS[room.room_type] : '普通房' }}
              </FaTag>
              <span v-if="room.room_floor" class="text-xs text-muted-foreground">
                {{ room.room_floor }} 楼
              </span>
            </div>
            <div class="text-xs flex gap-2">
              <FaTag variant="default" size="sm">
                空闲 {{ room.available_count }}
              </FaTag>
              <FaTag variant="destructive" size="sm">
                占用 {{ room.occupied_count }}
              </FaTag>
              <FaTag variant="outline" size="sm">
                总数 {{ room.total_count }}
              </FaTag>
            </div>
          </div>
          <div class="gap-2 grid grid-cols-2 lg:grid-cols-6 md:grid-cols-4">
            <div
              v-for="cage in room.cages"
              :key="cage.cage_id"
              class="p-2 border rounded cursor-pointer transition hover:shadow"
              :class="cageCardClass(cage.cage_status)"
              @click="onCageClick(cage)"
            >
              <div class="text-sm font-bold truncate">
                {{ cage.cage_name }}
              </div>
              <div class="text-xs text-muted-foreground">
                {{ CAGE_TYPE_LABELS[cage.cage_type] }}
              </div>
              <div class="mt-1">
                <FaTag :variant="statusTagVariant(cage.cage_status)" size="sm">
                  {{ CAGE_STATUS_LABELS[cage.cage_status] }}
                </FaTag>
              </div>
              <div v-if="cage.cage_status === 'occupied' && cage.admitted_at" class="text-xs text-muted-foreground mt-1">
                入院: {{ new Date(cage.admitted_at).toLocaleDateString('zh-CN') }}
              </div>
              <div v-if="cage.daily_rate > 0" class="text-xs mt-1">
                ¥{{ cage.daily_rate }}/日
              </div>
            </div>
          </div>
        </div>
        <div v-if="!loading && cageStatusList.length === 0" class="text-muted-foreground py-8 text-center">
          当前门店暂无笼位数据,请先在「住院管理 → 房间笼位」中维护房间与笼位
        </div>
      </div>
    </div>

    <!-- 占用笼位详情 Drawer -->
    <FaDrawer v-model="detailVisible" title="笼位详情" :width="420">
      <div v-if="detailCage" class="text-sm space-y-3">
        <div class="flex items-center justify-between">
          <div class="font-bold text-base">
            {{ detailCage.cage_name }}
          </div>
          <FaTag :variant="statusTagVariant(detailCage.cage_status)" size="sm">
            {{ CAGE_STATUS_LABELS[detailCage.cage_status] }}
          </FaTag>
        </div>
        <FaDescriptions :column="1" :items="cageDetailItems" />
        <FaDivider />
        <div class="text-xs text-muted-foreground">
          点击下方按钮跳转到对应功能页继续处理
        </div>
        <div class="flex gap-2 flex-wrap">
          <FaButton type="primary" size="sm" @click="goTo('/inpatient/settlement')">
            <FaIcon name="i-ri:bank-card-line" />
            去结算
          </FaButton>
          <FaButton variant="outline" size="sm" @click="goTo('/inpatient/nursing')">
            <FaIcon name="i-ri:nurse-line" />
            看护理
          </FaButton>
          <FaButton variant="outline" size="sm" @click="goTo('/inpatient/progress-notes')">
            <FaIcon name="i-ri:file-list-3-line" />
            看病程
          </FaButton>
          <FaButton variant="ghost" size="sm" @click="goTo('/inpatient/admission')">
            <FaIcon name="i-ri:swap-box-line" />
            入院/换房
          </FaButton>
        </div>
      </div>
    </FaDrawer>
  </div>
</template>
